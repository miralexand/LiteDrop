'use strict';

const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('./errors');

const MIME_BY_EXTENSION = {
  '.7z': 'application/x-7z-compressed',
  '.avi': 'video/x-msvideo',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.heic': 'image/heic',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rar': 'application/vnd.rar',
  '.rtf': 'application/rtf',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip',
};

const KIND_BY_EXTENSION = {
  image: ['.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp'],
  video: ['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm'],
  audio: ['.flac', '.m4a', '.mp3', '.ogg', '.wav'],
  pdf: ['.pdf'],
  archive: ['.7z', '.gz', '.rar', '.tar', '.zip'],
  document: ['.csv', '.doc', '.docx', '.md', '.ppt', '.pptx', '.rtf', '.txt', '.xls', '.xlsx'],
  code: ['.css', '.html', '.js', '.json', '.xml'],
};

function decodeOriginalName(name) {
  if (typeof name !== 'string') return '未命名文件';
  if (/[\u0100-\uFFFF]/.test(name)) return name;
  if (!/[\u0080-\u00FF]/.test(name)) return name;
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch {
    return name;
  }
}

function cleanBaseName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, ' ')
    .trim()
    .slice(0, 240);
}

function sanitizeSegment(segment) {
  if (segment === '.' || segment === '..') {
    throw new HttpError(400, '上传目录不合法', 'INVALID_TARGET');
  }
  let value = String(segment)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!value) {
    throw new HttpError(400, '上传目录不合法', 'INVALID_TARGET');
  }
  if (value.length > 64) value = value.slice(0, 64);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(value)) {
    value = `_${value}`;
  }
  return value;
}

function sanitizeSubdir(input) {
  if (input === undefined || input === null) return '';
  const raw = String(input).trim();
  if (!raw) return '';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length > 4) {
    throw new HttpError(400, '上传目录最多支持 4 层', 'INVALID_TARGET');
  }
  return parts.map(sanitizeSegment).join('/');
}

function safeExtension(originalName) {
  const ext = path.extname(cleanBaseName(originalName)).toLowerCase();
  if (!ext || ext.length > 16) return '';
  return /^\.[a-z0-9]+$/i.test(ext) ? ext : '';
}

function uniqueId() {
  return crypto.randomUUID();
}

function idForRelativePath(relativePath) {
  return crypto.createHash('sha1').update(relativePath.replace(/\\/g, '/')).digest('hex').slice(0, 24);
}

function mimeForName(name) {
  return MIME_BY_EXTENSION[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

function kindForName(name, mime) {
  const ext = path.extname(String(name)).toLowerCase();
  for (const [kind, extensions] of Object.entries(KIND_BY_EXTENSION)) {
    if (extensions.includes(ext)) return kind;
  }
  if (mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('text/')) return 'document';
  }
  return 'other';
}

function resolveInside(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, '文件路径不合法', 'INVALID_PATH');
  }
  return target;
}

function relativeStoragePath(dir, storedName) {
  return [dir, storedName].filter(Boolean).join('/');
}

module.exports = {
  decodeOriginalName,
  cleanBaseName,
  sanitizeSubdir,
  safeExtension,
  uniqueId,
  idForRelativePath,
  mimeForName,
  kindForName,
  resolveInside,
  relativeStoragePath,
  MIME_BY_EXTENSION,
};
