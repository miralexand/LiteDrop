'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

const exeFlag = process.argv.indexOf('--exe');
const testedExecutable =
  exeFlag >= 0
    ? path.resolve(process.argv[exeFlag + 1] || path.join(projectRoot, 'dist', 'LiteDrop.exe'))
    : null;
const testCommand = testedExecutable || process.execPath;
const testArgs = testedExecutable
  ? ['--no-open']
  : [path.join(projectRoot, 'src', 'server.js'), '--no-open'];

function pass(message) {
  console.log(`  ok   ${message}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function request(port, method, pathname, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`请求超时：${method} ${pathname}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function httpsRequest(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: pathname,
        rejectUnauthorized: false,
        headers: { Connection: 'close' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`HTTPS 请求超时：${pathname}`)));
    req.end();
  });
}

function json(response) {
  return JSON.parse(response.body.toString('utf8'));
}

function multipartBody(parts) {
  const boundary = `----LiteDropSmoke${Date.now().toString(16)}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType || 'application/octet-stream'}\r\n\r\n`
        )
      );
      chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data)));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(String(part.value)));
      chunks.push(Buffer.from('\r\n'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port, child, getLogs) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务进程提前退出（退出码 ${child.exitCode}）\n${getLogs()}`);
    }
    try {
      const response = await request(port, 'GET', '/api/health');
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await delay(150);
  }
  throw new Error(`等待服务启动超时\n${getLogs()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill();
  await Promise.race([closed, delay(3000)]);
  if (child.exitCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Best effort.
    }
  }
}

async function main() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'litedrop-smoke-'));
  const port = await getFreePort();
  let child = null;
  let logs = '';

  try {
    child = spawn(testCommand, testArgs, {
      cwd: testedExecutable ? path.dirname(testedExecutable) : projectRoot,
      env: {
        ...process.env,
        LITEDROP_HOME: home,
        LITEDROP_PORT: String(port),
        LITEDROP_NO_OPEN: '1',
        LITEDROP_NO_TRAY: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const collect = (chunk) => {
      logs += chunk.toString('utf8');
      if (logs.length > 20000) logs = logs.slice(-20000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    await waitForServer(port, child, () => logs);
    pass(`服务已启动：http://127.0.0.1:${port}`);

    const health = await request(port, 'GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(json(health).ok, true);
    pass('健康检查');

    const info = json(await request(port, 'GET', '/api/info'));
    assert.strictEqual(info.ok, true);
    assert.strictEqual(info.server.port, port);
    assert.ok(info.uploads.maxFileSize > 0);
    assert.ok(Array.isArray(info.network.lanUrls));
    assert.ok(info.tunnel && typeof info.tunnel.state === 'string');
    pass('服务信息与网络地址');

    const index = await request(port, 'GET', '/');
    assert.strictEqual(index.status, 200);
    assert.ok(index.body.toString('utf8').includes('LiteDrop'));
    assert.ok(String(index.headers['content-security-policy'] || '').includes("default-src 'self'"));
    pass('首页静态资源与安全响应头');

    const sharePage = await request(port, 'GET', '/?mode=upload&to=%E6%9D%A5%E6%BA%90A');
    assert.strictEqual(sharePage.status, 200);
    pass('分享直达页面');

    const firstContent = 'hello litedrop 你好\r\n';
    const firstUpload = multipartBody([
      {
        name: 'files',
        filename: '测试 文档.txt',
        contentType: 'text/plain',
        data: Buffer.from(firstContent, 'utf8'),
      },
    ]);
    const uploadResponse = await request(port, 'POST', '/api/upload', {
      headers: { 'Content-Type': firstUpload.contentType },
      body: firstUpload.body,
    });
    assert.strictEqual(uploadResponse.status, 201, uploadResponse.body.toString('utf8'));
    const uploadData = json(uploadResponse);
    assert.strictEqual(uploadData.files.length, 1);
    const firstFile = uploadData.files[0];
    assert.strictEqual(firstFile.name, '测试 文档.txt');
    assert.strictEqual(firstFile.size, Buffer.byteLength(firstContent));
    assert.strictEqual(firstFile.dir, '');
    assert.strictEqual(firstFile.kind, 'document');
    pass(`上传文件并保留原始文件名：${firstFile.name}`);

    const list = json(await request(port, 'GET', '/api/files'));
    assert.strictEqual(list.files.some((file) => file.id === firstFile.id), true);
    assert.strictEqual(list.stats.count, 1);
    pass('文件列表与统计');

    const download = await request(port, 'GET', `/api/files/${firstFile.id}/download`);
    assert.strictEqual(download.status, 200);
    assert.strictEqual(download.body.toString('utf8'), firstContent);
    pass('文件下载');

    const raw = await request(port, 'GET', `/api/files/${firstFile.id}/raw`);
    assert.strictEqual(raw.status, 200);
    assert.ok(String(raw.headers['content-type'] || '').startsWith('text/plain'));
    pass('文件在线预览');

    const subUpload = multipartBody([
      {
        name: 'files',
        filename: 'note.md',
        contentType: 'text/markdown',
        data: Buffer.from('# demo\n', 'utf8'),
      },
    ]);
    const subResponse = await request(
      port,
      'POST',
      `/api/upload?to=${encodeURIComponent('来源 A/子目录')}`,
      {
        headers: { 'Content-Type': subUpload.contentType },
        body: subUpload.body,
      }
    );
    assert.strictEqual(subResponse.status, 201, subResponse.body.toString('utf8'));
    const subFile = json(subResponse).files[0];
    assert.strictEqual(subFile.dir, '来源 A/子目录');
    assert.strictEqual(subFile.kind, 'document');
    const storedPath = path.join(home, 'uploads', '来源 A', '子目录');
    const storedEntries = await fsp.readdir(storedPath);
    assert.ok(storedEntries.some((name) => name.startsWith(subFile.id)));
    pass('按 to 参数上传到子目录');

    const traversal = multipartBody([
      {
        name: 'files',
        filename: 'evil.txt',
        contentType: 'text/plain',
        data: Buffer.from('evil', 'utf8'),
      },
    ]);
    const traversalResponse = await request(port, 'POST', '/api/upload?to=..%2Fevil', {
      headers: { 'Content-Type': traversal.contentType },
      body: traversal.body,
    });
    assert.strictEqual(traversalResponse.status, 400);
    assert.strictEqual(json(traversalResponse).ok, false);
    pass('拒绝目录穿越');

    const tunnel = json(await request(port, 'GET', '/api/tunnel'));
    assert.strictEqual(tunnel.ok, true);
    assert.strictEqual(tunnel.tunnel.state, 'stopped');
    pass('隧道状态接口');

    const securityOff = json(await request(port, 'GET', '/api/security'));
    assert.strictEqual(securityOff.ok, true);
    assert.strictEqual(securityOff.security.enabled, false);
    assert.strictEqual(securityOff.security.active, false);
    assert.ok(securityOff.security.httpsPort > 0);
    assert.notStrictEqual(securityOff.security.httpsPort, port);
    pass('局域网加密默认关闭');

    const enableSecurity = await request(port, 'POST', '/api/security/enable', {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(enableSecurity.status, 200, enableSecurity.body.toString('utf8'));
    const securityOn = json(enableSecurity).security;
    assert.strictEqual(securityOn.active, true);
    assert.ok(securityOn.cert && securityOn.cert.fingerprint256);

    const httpsHealth = await httpsRequest(securityOn.httpsPort, '/api/health');
    assert.strictEqual(httpsHealth.status, 200);
    assert.strictEqual(json(httpsHealth).ok, true);
    const infoWithSecurity = json(await request(port, 'GET', '/api/info'));
    assert.strictEqual(infoWithSecurity.security.active, true);
    assert.strictEqual(infoWithSecurity.security.httpsPort, securityOn.httpsPort);
    pass('局域网加密可开启并通过 HTTPS 提供服务');

    const disableSecurity = await request(port, 'POST', '/api/security/disable', {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(disableSecurity.status, 200);
    assert.strictEqual(json(disableSecurity).security.active, false);
    let httpsClosed = false;
    try {
      await httpsRequest(securityOn.httpsPort, '/api/health');
    } catch {
      httpsClosed = true;
    }
    assert.strictEqual(httpsClosed, true);
    pass('局域网加密可关闭并停止 HTTPS 监听');

    const missingApi = await request(port, 'GET', '/api/not-exist');
    assert.strictEqual(missingApi.status, 404);
    assert.strictEqual(json(missingApi).ok, false);
    pass('未知接口返回 JSON 404');

    const removed = await request(port, 'DELETE', `/api/files/${firstFile.id}`);
    assert.strictEqual(removed.status, 200);
    const afterDelete = json(await request(port, 'GET', '/api/files'));
    assert.strictEqual(afterDelete.files.some((file) => file.id === firstFile.id), false);
    const remaining = await fsp.readdir(path.join(home, 'uploads'));
    assert.strictEqual(remaining.some((name) => name.startsWith(firstFile.id)), false);
    pass('删除文件并清理磁盘');

    console.log('\n冒烟测试全部通过。');
  } finally {
    await stopChild(child);
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\n冒烟测试失败：');
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
