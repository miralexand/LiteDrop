'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const selfsigned = require('selfsigned');
const { getLocalAddresses } = require('./network');

function describeCertificate(certPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    return {
      subject: x509.subject,
      issuer: x509.issuer,
      fingerprint256: x509.fingerprint256,
      validFrom: x509.validFrom,
      validTo: x509.validTo,
      subjectAltName: x509.subjectAltName || '',
    };
  } catch {
    return null;
  }
}

class SecurityManager {
  constructor({ dataDir, certDir, settingsFile, port, httpsPort, host, logger }) {
    this.dataDir = dataDir;
    this.certDir = certDir;
    this.settingsFile = settingsFile;
    this.port = port;
    this.httpsPort = httpsPort;
    this.host = host;
    this.logger = logger;
    this.keyFile = path.join(certDir, 'litedrop-key.pem');
    this.certFile = path.join(certDir, 'litedrop-cert.pem');
    this.enabled = false;
    this.server = null;
    this.key = null;
    this.cert = null;
    this.certInfo = null;
    this.error = null;
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.certDir, { recursive: true });
    await this.loadSettings();
    if (this.enabled) {
      try {
        await this.ensureCertificate();
      } catch (error) {
        this.error = `加密证书准备失败：${error.message}`;
        this.logger.error(this.error);
      }
    }
  }

  async loadSettings() {
    try {
      const raw = await fsp.readFile(this.settingsFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.enabled = Boolean(parsed && parsed.enabled);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(`读取加密设置失败，已按默认关闭处理：${error.message}`);
      }
      this.enabled = false;
    }
  }

  async saveSettings() {
    const payload = JSON.stringify({ version: 1, enabled: this.enabled }, null, 2);
    const temp = `${this.settingsFile}.tmp`;
    await fsp.writeFile(temp, payload, 'utf8');
    try {
      await fsp.rename(temp, this.settingsFile);
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
      await fsp.rm(this.settingsFile, { force: true });
      await fsp.rename(temp, this.settingsFile);
    }
  }

  async ensureCertificate() {
    if (this.key && this.cert && this.certInfo) return;
    try {
      if (fs.existsSync(this.keyFile) && fs.existsSync(this.certFile)) {
        const [key, cert] = await Promise.all([
          fsp.readFile(this.keyFile, 'utf8'),
          fsp.readFile(this.certFile, 'utf8'),
        ]);
        const info = describeCertificate(cert);
        if (!info) throw new Error('证书内容无法解析');
        const keyObject = crypto.createPrivateKey(key);
        const x509 = new crypto.X509Certificate(cert);
        if (!x509.checkPrivateKey(keyObject)) {
          throw new Error('证书与私钥不匹配');
        }
        this.key = key;
        this.cert = cert;
        this.certInfo = info;
        return;
      }
    } catch (error) {
      this.logger.warn(`读取加密证书失败，将重新生成：${error.message}`);
    }
    await this.generateCertificate();
  }

  async generateCertificate() {
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      { type: 7, ip: '::1' },
    ];
    const hostname = os.hostname();
    if (hostname) {
      altNames.push({ type: 2, value: hostname });
      altNames.push({ type: 2, value: `${hostname}.local` });
    }
    for (const address of getLocalAddresses()) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(address.address)) {
        altNames.push({ type: 7, ip: address.address });
      }
    }

    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: 'LiteDrop Local' }],
      {
        days: 3650,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames },
        ],
      }
    );

    await fsp.writeFile(this.keyFile, pems.private, { encoding: 'utf8', mode: 0o600 });
    await fsp.writeFile(this.certFile, pems.cert, { encoding: 'utf8', mode: 0o644 });
    this.key = pems.private;
    this.cert = pems.cert;
    this.certInfo = describeCertificate(pems.cert);
    if (this.certInfo) {
      this.logger.info(`已生成局域网加密证书：${this.certInfo.fingerprint256}`);
    }
  }

  async start(app) {
    if (this.server) return this.status();
    await this.ensureCertificate();

    const server = https.createServer(
      {
        key: this.key,
        cert: this.cert,
        minVersion: 'TLSv1.2',
      },
      app
    );

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.httpsPort, this.host);
    });

    this.server = server;
    this.error = null;
    server.on('error', (error) => {
      this.error = `加密服务运行失败：${error.message}`;
      this.logger.error(this.error);
    });
    this.logger.info(`局域网加密已开启：https://<本机IP>:${this.httpsPort}`);
    return this.status();
  }

  async enable(app) {
    try {
      await this.start(app);
      this.enabled = true;
      this.error = null;
      await this.saveSettings();
      return this.status();
    } catch (error) {
      this.enabled = false;
      this.error = `开启加密失败：${error.message}`;
      await this.saveSettings().catch(() => {});
      throw error;
    }
  }

  async disable() {
    this.enabled = false;
    await this.stop();
    this.error = null;
    await this.saveSettings();
    return this.status();
  }

  async restore(app) {
    if (!this.enabled) return this.status();
    try {
      await this.start(app);
    } catch (error) {
      this.error = `加密服务启动失败：${error.message}`;
      this.logger.error(this.error);
    }
    return this.status();
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 2000).unref();
    });
    this.logger.info('局域网加密已关闭');
  }

  async close() {
    await this.stop();
  }

  isActive() {
    return Boolean(this.server);
  }

  buildUrl(hostname) {
    return `https://${hostname}:${this.httpsPort}`;
  }

  status(network) {
    const addresses = network ? network.addresses : getLocalAddresses();
    return {
      enabled: this.enabled,
      active: this.isActive(),
      httpsPort: this.httpsPort,
      error: this.error,
      localUrl: this.buildUrl('localhost'),
      urls: addresses.map((item) => ({
        name: item.name,
        address: item.address,
        url: this.buildUrl(item.address),
      })),
      cert: this.certInfo,
    };
  }
}

module.exports = { SecurityManager };
