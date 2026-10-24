'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const util = require('util');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const contentDisposition = require('content-disposition');

const { createConfig } = require('./lib/config');
const { FileStore } = require('./lib/store');
const { Tunnel } = require('./lib/tunnel');
const { SecurityManager } = require('./lib/security');
const { startTray } = require('./lib/tray');
const { getNetworkInfo } = require('./lib/network');
const { HttpError, asyncRoute } = require('./lib/errors');
const {
  decodeOriginalName,
  cleanBaseName,
  sanitizeSubdir,
  safeExtension,
  uniqueId,
  mimeForName,
  kindForName,
} = require('./lib/paths');

const config = createConfig();

function setupPackagedLogging(currentConfig) {
  const keepConsole = process.env.LITEDROP_CONSOLE === '1' || process.env.GATHERBOX_CONSOLE === '1';
  if (!currentConfig.isPackaged || process.platform !== 'win32' || keepConsole) {
    return;
  }
  const logFile =
    process.env.LITEDROP_LOG_FILE ||
    process.env.GATHERBOX_LOG_FILE ||
    path.join(currentConfig.baseDir, 'litedrop.log');
  const write = (...args) => {
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${util.format(...args)}\n`, 'utf8');
    } catch {
      // Logging must never break the server.
    }
  };
  console.log = write;
  console.warn = write;
  console.error = write;
}

setupPackagedLogging(config);

const trayToken = crypto.randomBytes(18).toString('hex');
let requestShutdown = null;

const useColor = Boolean(process.stdout && process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const logger = {
  info: (message) => console.log(`${paint('90', new Date().toLocaleTimeString('zh-CN', { hour12: false }))} ${message}`),
  warn: (message) => console.warn(`${paint('33', '警告')} ${message}`),
  error: (message) => console.error(`${paint('31', '错误')} ${message}`),
};

let seaModule = null;
try {
  seaModule = require('node:sea');
} catch {
  seaModule = null;
}

const isSea = Boolean(seaModule && typeof seaModule.isSea === 'function' && seaModule.isSea());

const staticFiles = {
  '/': { asset: 'public/index.html', type: 'text/html; charset=utf-8', index: true },
  '/index.html': { asset: 'public/index.html', type: 'text/html; charset=utf-8', index: true },
  '/styles.css': { asset: 'public/styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { asset: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/favicon.svg': { asset: 'public/favicon.svg', type: 'image/svg+xml' },
};

function readAsset(assetKey) {
  if (isSea) {
    try {
      return seaModule.getAsset(assetKey, 'utf8');
    } catch (error) {
      logger.warn(`无法读取内嵌资源 ${assetKey}：${error.message}`);
    }
  }
  return fs.readFileSync(path.join(config.projectRoot, assetKey), 'utf8');
}

function sendStatic(res, file) {
  const body = readAsset(file.asset);
  res.setHeader('Content-Type', file.type);
  res.setHeader('Cache-Control', file.index ? 'no-store' : 'public, max-age=300');
  res.send(body);
}

function clientIp(req) {
  const raw = req.socket.remoteAddress || req.ip || '';
  return String(raw).replace(/^::ffff:/, '');
}

function publicRecord(record) {
  const kind = kindForName(record.name, record.mime);
  return {
    id: record.id,
    name: record.name,
    size: Number(record.size) || 0,
    uploadedAt: record.uploadedAt,
    dir: record.dir || '',
    mime: record.mime || mimeForName(record.name),
    kind,
    recovered: Boolean(record.recovered),
    url: `/api/files/${encodeURIComponent(record.id)}/raw`,
    downloadUrl: `/api/files/${encodeURIComponent(record.id)}/download`,
    previewUrl:
      kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf'
        ? `/api/files/${encodeURIComponent(record.id)}/raw`
        : null,
  };
}

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch {
    // Opening the browser is a convenience; never fail startup because of it.
  }
}

function showFatalError(message) {
  if (process.platform !== 'win32' || !config.isPackaged) return;
  try {
    const safeMessage = String(message || '启动失败').slice(0, 2000);
    const encodedText = Buffer.from(safeMessage, 'utf8').toString('base64');
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedText}'))`,
      "[System.Windows.Forms.MessageBox]::Show($text, 'LiteDrop', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null",
    ].join('; ');
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The error is already written to the log file.
  }
}

function printBanner(network, securityStatus) {
  const line = paint('36', '─'.repeat(58));
  console.log('');
  console.log(line);
  console.log(`${paint('1;36', '  轻投  LiteDrop')}  ${paint('90', `v${config.version}`)}`);
  console.log(paint('90', '  局域网文件轻投递站 · 轻轻一投，就送达'));
  console.log(line);
  console.log(`  本机访问   ${paint('1;32', network.localhost)}`);
  if (network.lanUrls.length) {
    console.log('  局域网访问');
    for (const url of network.lanUrls) {
      console.log(`             ${paint('32', url)}`);
    }
  } else {
    console.log(`  ${paint('33', '未检测到可用的局域网 IPv4 地址')}`);
  }
  if (securityStatus && securityStatus.active) {
    console.log(`  加密访问   ${paint('1;36', `HTTPS :${securityStatus.httpsPort}`)}`);
    for (const item of securityStatus.urls) {
      console.log(`             ${paint('36', item.url)}`);
    }
  } else {
    console.log(`  加密访问   ${paint('90', '未开启（可选）')}`);
  }
  console.log(`  直达轻投   ${paint('36', `${network.localhost}/?mode=upload`)}`);
  console.log(`  文件目录   ${config.uploadsDir}`);
  console.log(`  cloudflared ${config.cloudflaredPath || '自动查找'}`);
  console.log(line);
  console.log(`  ${paint('90', '按 Ctrl+C 停止服务')}`);
  console.log('');
}

async function main() {
  const store = new FileStore({
    uploadsDir: config.uploadsDir,
    metadataFile: config.metadataFile,
    logger,
  });
  await store.init();

  const tunnel = new Tunnel({
    port: config.port,
    baseDir: config.baseDir,
    configuredPath: config.cloudflaredPath,
    logger,
  });

  const security = new SecurityManager({
    dataDir: config.dataDir,
    certDir: config.certDir,
    settingsFile: config.securityFile,
    port: config.port,
    httpsPort: config.httpsPort,
    host: config.host,
    logger,
  });
  await security.init();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
    );
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use((req, res, next) => {
    if (!security.isActive() || req.secure) {
      next();
      return;
    }
    const remote = clientIp(req);
    if (remote === '127.0.0.1' || remote === '::1') {
      next();
      return;
    }
    let hostname = req.hostname || 'localhost';
    if (hostname.includes(':') && !hostname.startsWith('[')) {
      hostname = `[${hostname}]`;
    }
    const target = `https://${hostname}:${security.httpsPort}${req.originalUrl}`;
    if (req.path.startsWith('/api/')) {
      res.status(426).json({
        ok: false,
        error: '局域网已启用加密传输，请通过 HTTPS 访问',
        code: 'HTTPS_REQUIRED',
        httpsUrl: target,
      });
      return;
    }
    res.redirect(307, target);
  });

  app.use(express.json({ limit: '1mb' }));

  app.get(
    '/api/health',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, version: config.version, uptime: process.uptime() });
    })
  );

  app.get(
    '/api/info',
    asyncRoute(async (req, res) => {
      const network = getNetworkInfo(config.port);
      res.json({
        ok: true,
        server: {
          name: config.appName,
          nameEn: config.appNameEn,
          version: config.version,
          port: config.port,
          host: config.host,
          platform: config.platform,
          hostname: config.hostname,
        },
        network,
        uploads: {
          directory: 'uploads',
          maxFileSize: config.maxFileSize,
          maxFilesPerRequest: config.maxFilesPerRequest,
        },
        share: {
          uploadUrl: `/?mode=upload`,
          localUploadUrl: `${network.localhost}/?mode=upload`,
        },
        security: security.status(network),
        tunnel: tunnel.getStatus(),
        cloudflared: tunnel.cloudflaredInfo,
      });
    })
  );

  app.get(
    '/api/security',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, security: security.status(getNetworkInfo(config.port)) });
    })
  );

  app.post(
    '/api/security/enable',
    asyncRoute(async (req, res) => {
      try {
        await security.enable(app);
      } catch (error) {
        throw new HttpError(500, `开启加密失败：${error.message}`, 'SECURITY_ENABLE_FAILED');
      }
      res.json({ ok: true, security: security.status(getNetworkInfo(config.port)) });
    })
  );

  app.post(
    '/api/security/disable',
    asyncRoute(async (req, res) => {
      try {
        await security.disable();
      } catch (error) {
        throw new HttpError(500, `关闭加密失败：${error.message}`, 'SECURITY_DISABLE_FAILED');
      }
      res.json({ ok: true, security: security.status(getNetworkInfo(config.port)) });
    })
  );

  app.get(
    '/api/files',
    asyncRoute(async (req, res) => {
      const files = store.list().map(publicRecord);
      res.json({ ok: true, files, stats: store.stats() });
    })
  );

  const storage = multer.diskStorage({
    destination(req, file, callback) {
      try {
        const to = sanitizeSubdir(req.query.to);
        req.litedropTo = to;
        const directory = to ? path.join(config.uploadsDir, ...to.split('/')) : config.uploadsDir;
        fs.mkdir(directory, { recursive: true }, (error) => callback(error, directory));
      } catch (error) {
        callback(error);
      }
    },
    filename(req, file, callback) {
      const originalName = decodeOriginalName(file.originalname);
      const id = uniqueId();
      file.litedropId = id;
      callback(null, `${id}${safeExtension(originalName)}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: config.maxFileSize,
      files: config.maxFilesPerRequest,
      fields: 20,
    },
  });

  app.post(
    '/api/upload',
    upload.any(),
    asyncRoute(async (req, res) => {
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        throw new HttpError(400, '没有收到文件', 'NO_FILES');
      }
      const to = req.litedropTo ?? sanitizeSubdir(req.query.to);
      const now = new Date().toISOString();
      const records = files.map((file) => {
        const originalName = cleanBaseName(decodeOriginalName(file.originalname)) || file.filename;
        return {
          id: file.litedropId || path.parse(file.filename).name,
          name: originalName,
          storedName: file.filename,
          dir: to,
          size: file.size,
          mime: file.mimetype || mimeForName(originalName),
          uploadedAt: now,
          ip: clientIp(req),
          recovered: false,
        };
      });
      await store.addMany(records);
      logger.info(
        `收到 ${records.length} 个投递${to ? `（${to}）` : ''}：${records
          .map((record) => record.name)
          .join('、')}`
      );
      res.status(201).json({
        ok: true,
        files: records.map(publicRecord),
        target: to,
      });
    })
  );

  app.get(
    '/api/files/:id/download',
    asyncRoute(async (req, res) => {
      const record = store.get(req.params.id);
      if (!record) throw new HttpError(404, '文件不存在', 'NOT_FOUND');
      const absolute = store.absolutePath(record);
      res.download(absolute, record.name, { headers: { 'X-Content-Type-Options': 'nosniff' } }, (error) => {
        if (error && !res.headersSent) {
          res.status(error.code === 'ENOENT' ? 404 : 500).json({
            ok: false,
            error: error.code === 'ENOENT' ? '文件不存在' : '下载失败',
          });
        }
      });
    })
  );

  app.get(
    '/api/files/:id/raw',
    asyncRoute(async (req, res) => {
      const record = store.get(req.params.id);
      if (!record) throw new HttpError(404, '文件不存在', 'NOT_FOUND');
      const absolute = store.absolutePath(record);
      res.setHeader('Content-Type', record.mime || mimeForName(record.name));
      res.setHeader('Content-Disposition', contentDisposition(record.name, { type: 'inline' }));
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.sendFile(absolute, (error) => {
        if (error && !res.headersSent) {
          res.status(error.code === 'ENOENT' ? 404 : 500).end();
        }
      });
    })
  );

  app.delete(
    '/api/files/:id',
    asyncRoute(async (req, res) => {
      const record = await store.remove(req.params.id);
      if (!record) throw new HttpError(404, '文件不存在', 'NOT_FOUND');
      logger.info(`删除文件：${record.name}`);
      res.json({ ok: true, id: req.params.id });
    })
  );

  app.get(
    '/api/tunnel',
    asyncRoute(async (req, res) => {
      res.json({ ok: true, tunnel: tunnel.getStatus() });
    })
  );

  app.post(
    '/api/tunnel/start',
    asyncRoute(async (req, res) => {
      const to = sanitizeSubdir(req.body && req.body.to);
      if (tunnel.state === 'starting' || tunnel.state === 'running') {
        res.json({ ok: true, tunnel: tunnel.getStatus() });
        return;
      }
      const status = tunnel.start(to);
      res.status(202).json({ ok: true, tunnel: status });
    })
  );

  app.post(
    '/api/tunnel/stop',
    asyncRoute(async (req, res) => {
      const status = await tunnel.stop();
      res.json({ ok: true, tunnel: status });
    })
  );

  app.post(
    '/api/app/quit',
    asyncRoute(async (req, res) => {
      const remote = clientIp(req);
      const token = String(req.get('x-tray-token') || '');
      const localRequest = remote === '127.0.0.1' || remote === '::1';
      if (!localRequest || token !== trayToken) {
        throw new HttpError(403, '无权执行该操作', 'FORBIDDEN');
      }
      res.json({ ok: true });
      if (requestShutdown) {
        setTimeout(() => requestShutdown('托盘退出'), 80);
      }
    })
  );

  app.get('/api/*', (req, res) => {
    res.status(404).json({ ok: false, error: '接口不存在' });
  });

  for (const [urlPath, file] of Object.entries(staticFiles)) {
    if (urlPath === '/') continue;
    app.get(urlPath, (req, res) => sendStatic(res, file));
  }

  app.get('*', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (path.extname(req.path)) {
      res.status(404).type('text/plain; charset=utf-8').send('Not found');
      return;
    }
    sendStatic(res, staticFiles['/']);
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: '未找到' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE: `单个文件超过大小限制（${Math.round(config.maxFileSize / 1024 / 1024)} MB）`,
        LIMIT_FILE_COUNT: `一次最多上传 ${config.maxFilesPerRequest} 个文件`,
        LIMIT_FIELD_COUNT: '表单字段过多',
      };
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({ ok: false, error: messages[error.code] || error.message, code: error.code });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ ok: false, error: error.message, code: error.code });
      return;
    }
    logger.error(error.stack || error.message);
    res.status(500).json({ ok: false, error: '服务器内部错误' });
  });

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const securityStatus = await security.restore(app);
  const network = getNetworkInfo(config.port);
  printBanner(network, securityStatus);

  if (config.openBrowser) {
    openBrowser(network.localhost);
  }

  let tray = null;
  if (config.isPackaged && config.trayEnabled && process.platform === 'win32') {
    try {
      tray = startTray({
        port: config.port,
        uploadsDir: config.uploadsDir,
        token: trayToken,
        logger,
      });
      logger.info('已启动系统托盘，可双击托盘图标打开面板');
    } catch (error) {
      logger.warn(`托盘图标启动失败：${error.message}`);
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭服务...`);
    if (tray) await tray.stop();
    await security.close();
    tunnel.killNow();
    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 2500).unref();
    });
    process.exit(0);
  };

  requestShutdown = shutdown;

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => {
    if (tray) tray.killNow();
    tunnel.killNow();
  });
  process.on('uncaughtException', (error) => {
    logger.error(error.stack || error.message);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (error) => {
    logger.error(error && error.stack ? error.stack : String(error));
  });

  server.on('error', (error) => {
    logger.error(`服务运行失败：${error.message}`);
  });

  return { server, store, tunnel, security, tray };
}

main().catch((error) => {
  const message =
    error.code === 'EADDRINUSE'
      ? `端口 ${config.port} 已被占用。请关闭占用程序，或使用 --port 指定其他端口。`
      : error.stack || error.message;
  logger.error(message);
  showFatalError(message);
  if (config.isPackaged && process.stdin && process.stdin.isTTY) {
    try {
      process.stdout.write('\n按回车键退出...');
    } catch {
      // No console is attached.
    }
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else {
    process.exit(1);
  }
});
