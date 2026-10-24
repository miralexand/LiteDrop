'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

function env(name) {
  return process.env[`LITEDROP_${name}`] || process.env[`GATHERBOX_${name}`];
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '-p' || item === '--port') {
      args.port = argv[i + 1];
      i += 1;
    } else if (item.startsWith('--port=')) {
      args.port = item.slice('--port='.length);
    } else if (item === '--host') {
      args.host = argv[i + 1];
      i += 1;
    } else if (item.startsWith('--host=')) {
      args.host = item.slice('--host='.length);
    } else if (item === '--https-port') {
      args.httpsPort = argv[i + 1];
      i += 1;
    } else if (item.startsWith('--https-port=')) {
      args.httpsPort = item.slice('--https-port='.length);
    } else if (item === '--cloudflared') {
      args.cloudflared = argv[i + 1];
      i += 1;
    } else if (item.startsWith('--cloudflared=')) {
      args.cloudflared = item.slice('--cloudflared='.length);
    } else if (item === '--no-open') {
      args.noOpen = true;
    } else if (item === '--no-tray') {
      args.noTray = true;
    } else if (item === '--help' || item === '-h') {
      args.help = true;
    } else if (item === '--version' || item === '-v') {
      args.version = true;
    } else {
      args._.push(item);
    }
  }
  return args;
}

function toInteger(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isPackagedExecutable() {
  if (process.pkg || process.nexe) return true;
  const executable = path.basename(process.execPath || '').toLowerCase();
  return !['node', 'node.exe', 'nodejs', 'nodejs.exe'].includes(executable);
}

function detectBaseDir() {
  if (env('HOME')) {
    return path.resolve(env('HOME'));
  }
  if (isPackagedExecutable()) {
    return path.dirname(process.execPath);
  }
  return path.resolve(__dirname, '..', '..');
}

function loadVersion() {
  try {
    return require('../../package.json').version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function createConfig(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const baseDir = detectBaseDir();
  const packageRoot = path.resolve(__dirname, '..', '..');
  const defaultMaxFileSize = 20 * 1024 * 1024 * 1024;
  const maxFileSize = toInteger(
    env('MAX_FILE_SIZE') || args['max-file-size'],
    defaultMaxFileSize
  );
  const port = toInteger(env('PORT') || process.env.PORT || args.port, 3456);
  const fallbackHttpsPort = port < 65535 ? port + 1 : 8443;
  let httpsPort = toInteger(env('HTTPS_PORT') || args.httpsPort, fallbackHttpsPort);
  if (httpsPort === port) httpsPort = fallbackHttpsPort;

  const config = {
    appName: '轻投',
    appNameEn: 'LiteDrop',
    version: loadVersion(),
    args,
    isPackaged: isPackagedExecutable(),
    baseDir,
    projectRoot: packageRoot,
    publicDir: path.join(packageRoot, 'public'),
    uploadsDir: path.join(baseDir, 'uploads'),
    dataDir: path.join(baseDir, 'data'),
    metadataFile: path.join(baseDir, 'data', 'library.json'),
    certDir: path.join(baseDir, 'data', 'certs'),
    securityFile: path.join(baseDir, 'data', 'security.json'),
    host: args.host || env('HOST') || '0.0.0.0',
    port,
    httpsPort,
    openBrowser: !args.noOpen && env('NO_OPEN') !== '1',
    trayEnabled: !args.noTray && env('NO_TRAY') !== '1',
    maxFileSize,
    maxFilesPerRequest: 200,
    cloudflaredPath: args.cloudflared || env('CLOUDFLARED') || '',
    platform: process.platform,
    hostname: os.hostname(),
  };

  config.publicFileOverrides = {
    '/': path.join(config.publicDir, 'index.html'),
    '/index.html': path.join(config.publicDir, 'index.html'),
    '/styles.css': path.join(config.publicDir, 'styles.css'),
    '/app.js': path.join(config.publicDir, 'app.js'),
    '/favicon.svg': path.join(config.publicDir, 'favicon.svg'),
  };

  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });

  return config;
}

module.exports = { createConfig, parseArgs };
