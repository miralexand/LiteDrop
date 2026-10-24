'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const buildDir = path.join(projectRoot, 'build');
const publicDir = path.join(projectRoot, 'public');
const bundleFile = path.join(buildDir, 'server.cjs');
const stagedPublicDir = path.join(buildDir, 'public');

async function main() {
  await fsp.mkdir(buildDir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [path.join(projectRoot, 'src', 'server.js')],
    outfile: bundleFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'warning',
    sourcemap: false,
    legalComments: 'none',
    metafile: true,
  });

  const outputs = Object.entries(result.metafile.outputs || {});
  const bundleSize = outputs.reduce((sum, [, info]) => sum + (info.bytes || 0), 0);

  await fsp.rm(stagedPublicDir, { recursive: true, force: true });
  await fsp.cp(publicDir, stagedPublicDir, { recursive: true });

  const assets = [];
  const walk = async (dir, prefix) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        assets.push(`public/${relative}`);
      }
    }
  };
  await walk(stagedPublicDir, '');

  console.log(`已生成服务端包：${path.relative(projectRoot, bundleFile)} (${Math.round(bundleSize / 1024)} KB)`);
  console.log(`已暂存前端资源：${assets.length} 个文件 -> ${path.relative(projectRoot, stagedPublicDir)}`);
}

main().catch((error) => {
  console.error('构建资源失败：');
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
