# 轻投 · LiteDrop

[![Build](https://github.com/miralexand/LiteDrop/actions/workflows/build.yml/badge.svg)](https://github.com/miralexand/LiteDrop/actions/workflows/build.yml)

轻投是一个轻量的局域网文件投递站：双击启动后，同一 Wi-Fi 下的手机、平板、电脑打开网页即可把文件拖进来；文件直接保存在本机，不上传云端。蓝白配色的界面、系统托盘常驻、可选 HTTPS 加密和 Cloudflare 临时公网隧道，让它适合临时收图、收作业、收素材等场景。

## 功能

- **局域网投递**：拖拽、点击选择、多文件上传，显示实时进度
- **文件管理**：文件列表、搜索、在线预览、下载、删除
- **分享直达**：`/?mode=upload` 打开即上传，`&to=xxx` 可投递到子目录
- **可选局域网加密**：一键开启 HTTPS，局域网 HTTP 自动跳转加密地址，默认关闭
- **公网隧道**：调用 Cloudflare Quick Tunnel 生成临时分享地址，支持启停；开启前需确认免责提醒
- **Windows 单文件 exe**：Node SEA 打包，无控制台运行，常驻系统托盘
- **Android WebView APK**：内置 `onShowFileChooser`，支持手机网页选择文件上传
- **明亮蓝白 UI**：纸飞机品牌元素，桌面端与移动端自适应

## 快速开始

### 直接运行

需要以下文件位于同一目录：

```text
LiteDrop.exe
cloudflared.exe   # 可选，用于公网隧道
```

双击 `LiteDrop.exe` 后会自动打开 `http://localhost:3456`，并在系统托盘常驻。右键托盘图标可以打开面板、打开上传目录或退出轻投。

> 仓库不提交 exe/apk 等构建产物，请从 Releases 下载或参考下方自行构建。exe 运行日志位于同目录的 `litedrop.log`。

### 从源码运行

环境要求：Node.js 20+（推荐 22 LTS）。

```bash
npm install
npm start          # 启动并自动打开浏览器
npm run dev        # 启动但不自动打开浏览器
```

默认监听 `0.0.0.0:3456`，启动后终端会打印本机与局域网访问地址。

## 地址与参数

| 地址 | 用途 |
| --- | --- |
| `http://localhost:3456/` | 本机完整面板 |
| `http://<局域网IP>:3456/` | 局域网完整面板 |
| `/?mode=upload` | 只显示上传界面 |
| `/?mode=upload&to=xxx` | 上传到 `uploads/xxx/` 子目录 |

常用启动参数：

| 参数 | 说明 |
| --- | --- |
| `--port <端口>` | HTTP 端口，默认 `3456` |
| `--https-port <端口>` | 加密 HTTPS 端口，默认 HTTP 端口 + 1 |
| `--host <地址>` | 监听地址，默认 `0.0.0.0` |
| `--cloudflared <路径>` | 指定 `cloudflared` 可执行文件 |
| `--no-open` | 启动时不自动打开浏览器 |
| `--no-tray` | 不启用系统托盘（打包版） |

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `LITEDROP_PORT` | HTTP 端口 |
| `LITEDROP_HTTPS_PORT` | HTTPS 端口 |
| `LITEDROP_HOST` | 监听地址 |
| `LITEDROP_HOME` | 数据根目录，默认为程序所在目录 |
| `LITEDROP_NO_OPEN=1` | 禁止自动打开浏览器 |
| `LITEDROP_NO_TRAY=1` | 禁止托盘 |
| `LITEDROP_CLOUDFLARED` | `cloudflared` 路径 |
| `LITEDROP_LOG_FILE` | 打包版日志文件路径 |
| `LITEDROP_DEBUG=1` | 输出 cloudflared 调试日志 |

旧的 `GATHERBOX_*` 环境变量仍可作为兼容回退。

## 局域网加密传输

加密功能默认关闭，由用户在面板中的「局域网加密」开关决定是否启用。

开启后：

- 自动生成自签名证书，保存在 `data/certs/`
- 启动 HTTPS 服务，默认使用 HTTP 端口 + 1
- 局域网设备访问 HTTP 地址时自动 `307` 跳转到 HTTPS
- 本机回环地址和 Cloudflare 隧道内部连接不受影响
- 面板会显示加密访问地址与证书指纹
- 设置持久化到 `data/security.json`，下次启动自动恢复

由于使用自签名证书，首次访问时浏览器会提示证书不受信任，确认「继续前往」即可。若局域网 IP 发生变化，可能需要重新开启加密以适配新的地址。

## 构建

```bash
npm install
npm run smoke        # 服务端冒烟测试
npm run smoke:exe    # 已构建 exe 的冒烟测试
npm run build        # 构建 exe + apk
```

单独构建：

```bash
npm run build:assets # esbuild 打包服务端并暂存前端资源
npm run build:exe    # 生成 dist/LiteDrop.exe
npm run build:apk    # 生成 dist/LiteDrop.apk
```

构建说明：

- **exe**：使用 Node SEA + postject 注入单文件，并切换为 Windows GUI 子系统，运行时无控制台、驻留托盘。构建时需要 Node.js，结果约 80 MB。
- **APK**：需要 Android SDK Platform 34、Build Tools 34、JDK 17+ 和 Gradle 8.7+。首次构建会自动写入 `android/local.properties`。
- 如果项目根目录存在 `cloudflared.exe`，构建 exe 时会一并复制到 `dist/`。

### GitHub Actions 自动构建

推送代码到 `main`、手动触发 workflow，或推送 `v*` 标签时，GitHub Actions 会自动构建：

| 产物 | 说明 |
| --- | --- |
| `LiteDrop-windows` | `LiteDrop.exe` + `cloudflared.exe` |
| `LiteDrop-android` | `LiteDrop.apk` |

在仓库的 **Actions → Build** 中下载构建产物。推送形如 `v1.0.0` 的标签时，还会自动创建 GitHub Release 并附上三个分发文件。

## 数据目录

```text
uploads/              # 上传的文件
data/library.json     # 文件索引
data/security.json    # 加密开关
data/certs/           # 自签名证书与私钥
litedrop.log          # 打包版运行日志
```

这些运行时文件不会提交到 Git。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/info` | 服务、网络、加密与隧道信息 |
| `GET` | `/api/files` | 文件列表与统计 |
| `POST` | `/api/upload` | 上传文件，支持 `?to=子目录` |
| `GET` | `/api/files/:id/download` | 下载文件 |
| `GET` | `/api/files/:id/raw` | 在线预览文件 |
| `DELETE` | `/api/files/:id` | 删除文件 |
| `GET` | `/api/security` | 加密状态 |
| `POST` | `/api/security/enable` | 开启局域网加密 |
| `POST` | `/api/security/disable` | 关闭局域网加密 |
| `GET` | `/api/tunnel` | 隧道状态 |
| `POST` | `/api/tunnel/start` | 开启公网隧道 |
| `POST` | `/api/tunnel/stop` | 停止公网隧道 |

## 项目结构

```text
src/
  server.js           # Express 服务、路由、启动与关闭
  lib/
    config.js         # 参数与环境变量
    store.js          # 文件索引与磁盘同步
    paths.js          # 路径、文件名与 MIME 处理
    tunnel.js         # cloudflared 隧道管理
    security.js       # 可选 HTTPS 与证书管理
    tray.js           # Windows 系统托盘
    network.js        # 局域网地址探测
public/               # 原生 HTML/CSS/JS 前端
android/              # Android WebView 壳工程
scripts/              # 冒烟测试与 exe/apk 构建脚本
```

## 安全提示

轻投面向可信局域网内的临时文件投递，默认没有账号与权限系统。请勿直接暴露在公网环境；如需长期公网访问，建议在前面增加反向代理、认证和访问控制。Cloudflare Quick Tunnel 地址也是临时的，关闭隧道后即失效。
