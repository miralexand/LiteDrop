'use strict';

const fs = require('fs');
const path = require('path');
const { inject } = require('./vendor/postject-api');

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function setWindowsGuiSubsystem(executable) {
  const fd = fs.openSync(executable, 'r+');
  try {
    const dosHeader = Buffer.alloc(64);
    fs.readSync(fd, dosHeader, 0, dosHeader.length, 0);
    if (dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('目标文件不是有效的 PE 可执行文件');
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peSignature = Buffer.alloc(4);
    fs.readSync(fd, peSignature, 0, 4, peOffset);
    if (peSignature.toString('ascii', 0, 4) !== 'PE\u0000\u0000') {
      throw new Error('未找到 PE 头');
    }
    const optionalHeaderOffset = peOffset + 24;
    const subsystemOffset = optionalHeaderOffset + 68;
    const current = Buffer.alloc(2);
    fs.readSync(fd, current, 0, 2, subsystemOffset);
    if (current.readUInt16LE(0) !== 2) {
      fs.writeSync(fd, Buffer.from([2, 0]), 0, 2, subsystemOffset);
      console.log('已切换为 Windows GUI 子系统（无控制台，托盘运行）');
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const [executable, blob] = process.argv.slice(2);
  if (!executable || !blob) {
    throw new Error('用法：node scripts/inject-sea.js <目标 exe> <sea-prep.blob>');
  }
  const target = path.resolve(executable);
  const blobPath = path.resolve(blob);
  const resource = await fs.promises.readFile(blobPath);
  await inject(target, 'NODE_SEA_BLOB', resource, {
    sentinelFuse: SENTINEL_FUSE,
    overwrite: true,
  });
  console.log(`已注入 SEA 资源：${path.basename(target)} (${Math.round(resource.length / 1024)} KB)`);
  const keepConsole =
    process.env.LITEDROP_KEEP_CONSOLE === '1' || process.env.GATHERBOX_KEEP_CONSOLE === '1';
  if (process.platform === 'win32' && !keepConsole) {
    setWindowsGuiSubsystem(target);
  }
}

main().catch((error) => {
  console.error('注入 SEA 资源失败：');
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
