'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const {
  idForRelativePath,
  mimeForName,
  resolveInside,
  relativeStoragePath,
} = require('./paths');

class FileStore {
  constructor({ uploadsDir, metadataFile, logger }) {
    this.uploadsDir = uploadsDir;
    this.metadataFile = metadataFile;
    this.logger = logger;
    this.files = [];
    this.byId = new Map();
    this.saveChain = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.uploadsDir, { recursive: true });
    await fsp.mkdir(path.dirname(this.metadataFile), { recursive: true });
    await this.load();
    await this.reconcile();
  }

  async load() {
    let raw;
    try {
      raw = await fsp.readFile(this.metadataFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const files = Array.isArray(parsed) ? parsed : parsed.files;
      if (!Array.isArray(files)) throw new Error('metadata.files is not an array');
      this.files = files.filter((record) => this.isValidRecord(record));
      this.reindex();
    } catch (error) {
      this.logger.warn(`文件索引损坏，已备份并重新建立：${error.message}`);
      const backup = `${this.metadataFile}.corrupt-${Date.now()}`;
      try {
        await fsp.rename(this.metadataFile, backup);
      } catch {
        // Ignore backup failures; an empty index is still usable.
      }
      this.files = [];
      this.reindex();
    }
  }

  isValidRecord(record) {
    return Boolean(
      record &&
        typeof record.id === 'string' &&
        typeof record.storedName === 'string' &&
        typeof record.name === 'string'
    );
  }

  reindex() {
    this.byId = new Map(this.files.map((record) => [record.id, record]));
  }

  async reconcile() {
    const seen = new Set();
    let changed = false;
    const walk = async (dir, depth, prefix) => {
      if (depth > 4) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(abs, depth + 1, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        seen.add(rel);
        if (this.files.some((item) => relativeStoragePath(item.dir, item.storedName) === rel)) {
          continue;
        }
        try {
          const stat = await fsp.stat(abs);
          const dirName = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
          const record = {
            id: idForRelativePath(rel),
            name: entry.name,
            storedName: entry.name,
            dir: dirName,
            size: stat.size,
            mime: mimeForName(entry.name),
            uploadedAt: stat.mtime.toISOString(),
            recovered: true,
          };
          this.files.push(record);
          changed = true;
        } catch {
          // The file may vanish while scanning; ignore it.
        }
      }
    };

    await walk(this.uploadsDir, 0, '');

    const before = this.files.length;
    this.files = this.files.filter((record) => {
      const rel = relativeStoragePath(record.dir, record.storedName);
      return seen.has(rel) || this.files.length === 0 ? seen.has(rel) : false;
    });
    if (this.files.length !== before) changed = true;
    this.reindex();
    if (changed) {
      await this.save();
      this.logger.info(`已同步本机文件索引：共 ${this.files.length} 个文件`);
    }
  }

  list() {
    return this.files
      .slice()
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  }

  stats() {
    return this.files.reduce(
      (accumulator, record) => {
        accumulator.count += 1;
        accumulator.totalSize += Number(record.size) || 0;
        return accumulator;
      },
      { count: 0, totalSize: 0 }
    );
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  absolutePath(record) {
    return resolveInside(this.uploadsDir, relativeStoragePath(record.dir, record.storedName));
  }

  async addMany(records) {
    if (!records.length) return [];
    for (const record of records) {
      if (this.byId.has(record.id)) {
        record.id = `${record.id}-${Date.now().toString(36)}`;
      }
      this.files.push(record);
      this.byId.set(record.id, record);
    }
    await this.save();
    return records;
  }

  async remove(id) {
    const record = this.byId.get(id);
    if (!record) return null;
    const absolute = this.absolutePath(record);
    try {
      await fsp.unlink(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.files = this.files.filter((item) => item.id !== id);
    this.byId.delete(id);
    await this.save();
    return record;
  }

  save() {
    this.saveChain = this.saveChain
      .catch(() => {})
      .then(async () => {
        const payload = JSON.stringify(
          { version: 1, updatedAt: new Date().toISOString(), files: this.files },
          null,
          2
        );
        const temp = `${this.metadataFile}.tmp`;
        await fsp.writeFile(temp, payload, 'utf8');
        try {
          await fsp.rename(temp, this.metadataFile);
        } catch (error) {
          if (error.code !== 'EPERM' && error.code !== 'EEXIST') throw error;
          await fsp.rm(this.metadataFile, { force: true });
          await fsp.rename(temp, this.metadataFile);
        }
      });
    return this.saveChain;
  }
}

module.exports = { FileStore };
