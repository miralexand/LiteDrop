'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { HttpError } = require('./errors');
const { sanitizeSubdir } = require('./paths');

const TRYCLOUDFLARE_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}

class Tunnel {
  constructor({ port, baseDir, configuredPath, logger, startTimeoutMs = 30000 }) {
    this.port = port;
    this.baseDir = baseDir;
    this.configuredPath = configuredPath;
    this.logger = logger;
    this.startTimeoutMs = startTimeoutMs;
    this.state = 'stopped';
    this.url = null;
    this.shareUrl = null;
    this.error = null;
    this.startedAt = null;
    this.logs = [];
    this.child = null;
    this.startTimer = null;
    this.stopping = false;
    this.to = '';
    this.resolvedPath = null;
  }

  resolveCloudflared() {
    if (this.resolvedPath && fs.existsSync(this.resolvedPath)) return this.resolvedPath;
    const candidates = [];
    if (this.configuredPath) candidates.push(this.configuredPath);
    candidates.push(
      path.join(this.baseDir, 'cloudflared.exe'),
      path.join(this.baseDir, 'cloudflared'),
      path.join(this.baseDir, 'bin', 'cloudflared.exe'),
      path.join(this.baseDir, 'bin', 'cloudflared')
    );

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          this.resolvedPath = candidate;
          return candidate;
        }
      } catch {
        // Try the next candidate.
      }
    }

    const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
      const result = spawnSync(lookup, ['cloudflared'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0) {
        const first = String(result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean);
        if (first && fs.existsSync(first)) {
          this.resolvedPath = first;
          return first;
        }
      }
    } catch {
      // Not found on PATH.
    }
    return null;
  }

  get cloudflaredInfo() {
    const found = this.resolveCloudflared();
    return { found: Boolean(found), path: found || null };
  }

  getStatus() {
    return {
      state: this.state,
      url: this.url,
      shareUrl: this.shareUrl,
      error: this.error,
      to: this.to,
      startedAt: this.startedAt,
      elapsedSeconds: this.startedAt ? Math.max(0, Math.round((Date.now() - this.startedAt) / 1000)) : 0,
      cloudflared: this.cloudflaredInfo,
      logs: this.logs.slice(-8),
    };
  }

  pushLog(line) {
    const clean = stripAnsi(line).trim();
    if (!clean) return;
    this.logs.push(clean);
    if (this.logs.length > 60) this.logs.splice(0, this.logs.length - 60);
    if (process.env.LITEDROP_DEBUG === '1' || process.env.GATHERBOX_DEBUG === '1') {
      this.logger.info(`[cloudflared] ${clean}`);
    }
  }

  handleOutput(chunk) {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.pushLog(line);
      if (!this.url) {
        const match = text.match(TRYCLOUDFLARE_PATTERN) || line.match(TRYCLOUDFLARE_PATTERN);
        if (match) this.setRunning(match[0]);
      }
    }
  }

  setRunning(url) {
    if (this.state === 'running' && this.url === url) return;
    this.url = url.replace(/\/$/, '');
    const query = this.to ? `&to=${encodeURIComponent(this.to)}` : '';
    this.shareUrl = `${this.url}/?mode=upload${query}`;
    this.state = 'running';
    this.startedAt = this.startedAt || Date.now();
    this.error = null;
    this.clearStartTimer();
    this.logger.info(`公网隧道已开启：${this.url}`);
    this.logger.info(`轻投分享地址：${this.shareUrl}`);
  }

  clearStartTimer() {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  start(to = '') {
    if (this.state === 'starting' || this.state === 'running') {
      return this.getStatus();
    }
    if (this.child) {
      this.killNow();
    }
    const cloudflared = this.resolveCloudflared();
    if (!cloudflared) {
      this.state = 'error';
      this.error =
        '未找到 cloudflared。请把 cloudflared.exe 放在 LiteDrop.exe 同一目录，或通过 --cloudflared 指定路径。';
      throw new HttpError(400, this.error, 'CLOUDFLARED_NOT_FOUND');
    }

    this.to = sanitizeSubdir(to);
    this.state = 'starting';
    this.url = null;
    this.shareUrl = null;
    this.error = null;
    this.startedAt = null;
    this.logs = [];
    this.stopping = false;
    this.resolvedPath = cloudflared;

    const target = `http://127.0.0.1:${this.port}`;
    this.logger.info(`正在启动 Cloudflare 快速隧道：${target}`);
    try {
      this.child = spawn(
        cloudflared,
        ['tunnel', '--no-autoupdate', '--url', target],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1' },
        }
      );
    } catch (error) {
      this.state = 'error';
      this.error = `无法启动 cloudflared：${error.message}`;
      throw new HttpError(500, this.error, 'CLOUDFLARED_START_FAILED');
    }

    const child = this.child;
    child.stdout.on('data', (chunk) => this.handleOutput(chunk));
    child.stderr.on('data', (chunk) => this.handleOutput(chunk));
    child.on('error', (error) => {
      if (this.stopping) return;
      this.state = 'error';
      this.error = `cloudflared 运行失败：${error.message}`;
      this.clearStartTimer();
      this.logger.error(this.error);
    });
    child.on('close', (code, signal) => {
      this.clearStartTimer();
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        this.state = 'stopped';
        return;
      }
      if (this.state === 'running') {
        this.state = 'error';
        this.error = `公网隧道已断开（退出码 ${code ?? '未知'}${signal ? `，信号 ${signal}` : ''}）。`;
      } else if (this.state === 'starting') {
        this.state = 'error';
        const lastLog = this.logs.slice(-3).join(' ');
        this.error = `Cloudflare 隧道启动失败（退出码 ${code ?? '未知'}）。${lastLog}`.trim();
      }
      this.logger.error(this.error || 'cloudflared 已退出');
    });

    this.startTimer = setTimeout(() => {
      if (this.state !== 'starting') return;
      this.state = 'error';
      this.error = '连接 Cloudflare 超时，请检查网络后重试。';
      this.logger.error(this.error);
      this.stop().catch(() => {});
    }, this.startTimeoutMs);

    return this.getStatus();
  }

  killChild(child) {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      child.once('close', finish);
      const timer = setTimeout(finish, 2500);
      if (process.platform === 'win32') {
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch {
          try {
            child.kill();
          } catch {
            // Already gone.
          }
        }
      } else {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
      }
    });
  }

  async stop() {
    if (!this.child && this.state === 'stopped') return this.getStatus();
    this.stopping = true;
    this.clearStartTimer();
    const child = this.child;
    this.child = null;
    if (child) {
      this.state = 'stopping';
      await this.killChild(child);
    }
    this.state = 'stopped';
    this.url = null;
    this.shareUrl = null;
    this.error = null;
    this.startedAt = null;
    this.to = '';
    this.logger.info('公网隧道已停止');
    return this.getStatus();
  }

  killNow() {
    this.stopping = true;
    this.clearStartTimer();
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // Best effort during shutdown.
    }
  }
}

module.exports = { Tunnel };
