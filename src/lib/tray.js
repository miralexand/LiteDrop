'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TRAY_SCRIPT = String.raw`$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:baseUrl = {{BASE_URL}}
$script:token = {{TOKEN}}
$script:uploadsDir = {{UPLOADS_DIR}}

function New-TrayIcon {
  $bmp = [System.Drawing.Bitmap]::new(64, 64)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $rect = [System.Drawing.Rectangle]::new(4, 4, 56, 56)
  $road = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = 32
  $road.AddArc(4, 4, $d, $d, 180, 90)
  $road.AddArc(28, 4, $d, $d, 270, 90)
  $road.AddArc(28, 28, $d, $d, 0, 90)
  $road.AddArc(4, 28, $d, $d, 90, 90)
  $road.CloseFigure()

  $from = [System.Drawing.Color]::FromArgb(255, 74, 168, 255)
  $to = [System.Drawing.Color]::FromArgb(255, 0, 102, 214)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $from, $to, 45)
  $g.FillPath($brush, $road)

  $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $points = [System.Drawing.Point[]]@(
    [System.Drawing.Point]::new(14, 31),
    [System.Drawing.Point]::new(50, 16),
    [System.Drawing.Point]::new(39, 49),
    [System.Drawing.Point]::new(28, 36)
  )
  $g.FillPolygon($white, $points)

  $foldPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 0, 113, 227), 2.4)
  $foldPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $foldPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($foldPen, 50, 16, 28, 36)
  $g.DrawLine($foldPen, 28, 36, 25, 44)

  $brush.Dispose()
  $white.Dispose()
  $foldPen.Dispose()
  $g.Dispose()
  $handle = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle)
  $bmp.Dispose()
  return $icon
}

$script:notify = [System.Windows.Forms.NotifyIcon]::new()
$script:notify.Icon = New-TrayIcon
$script:notify.Text = '轻投 LiteDrop'
$script:notify.Visible = $true

$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$openItem = $menu.Items.Add('打开面板')
$openItem.add_Click({ Start-Process $script:baseUrl })
$folderItem = $menu.Items.Add('打开文件目录')
$folderItem.add_Click({ Start-Process $script:uploadsDir })
$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
$quitItem = $menu.Items.Add('退出轻投')
$quitItem.add_Click({
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($script:baseUrl + '/api/app/quit') -Headers @{ 'X-Tray-Token' = $script:token } -TimeoutSec 4 | Out-Null
  } catch {}
  $script:notify.Visible = $false
  $script:context.ExitThread()
})
$script:notify.ContextMenuStrip = $menu
$script:notify.add_DoubleClick({ Start-Process $script:baseUrl })

$script:context = [System.Windows.Forms.ApplicationContext]::new()
$script:misses = 0
$script:timer = [System.Windows.Forms.Timer]::new()
$script:timer.Interval = 5000
$script:timer.add_Tick({
  try {
    Invoke-WebRequest -UseBasicParsing -Uri ($script:baseUrl + '/api/health') -TimeoutSec 2 | Out-Null
    $script:misses = 0
  } catch {
    $script:misses += 1
    if ($script:misses -ge 3) {
      $script:notify.Visible = $false
      $script:context.ExitThread()
    }
  }
})
$script:timer.Start()

$script:notify.ShowBalloonTip(3500, '轻投 LiteDrop', '轻投正在后台运行，双击托盘图标打开面板。', [System.Windows.Forms.ToolTipIcon]::Info)

[System.Windows.Forms.Application]::Run($script:context)

$script:timer.Stop()
$script:timer.Dispose()
$script:notify.Visible = $false
$script:notify.Dispose()
$menu.Dispose()
Remove-Item -LiteralPath $PSCommandPath -Force
`;

function psQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

function startTray({ port, uploadsDir, token, logger }) {
  if (process.platform !== 'win32') return null;

  const scriptPath = path.join(os.tmpdir(), `litedrop-tray-${process.pid}.ps1`);
  const script = TRAY_SCRIPT.replace('{{BASE_URL}}', psQuote(`http://127.0.0.1:${port}`))
    .replace('{{TOKEN}}', psQuote(token))
    .replace('{{UPLOADS_DIR}}', psQuote(uploadsDir));

  fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');

  let stopped = false;
  let child;
  try {
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
      ],
      {
        windowsHide: true,
        stdio: 'ignore',
      }
    );
  } catch (error) {
    fs.rmSync(scriptPath, { force: true });
    throw error;
  }

  child.on('error', (error) => {
    if (!stopped) logger.warn(`托盘图标启动失败：${error.message}`);
  });
  child.on('exit', (code) => {
    if (!stopped && code) logger.warn(`托盘图标已退出（退出码 ${code}）`);
  });

  return {
    child,
    scriptPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      const closed = new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('close', resolve);
        setTimeout(resolve, 1500).unref();
      });
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      await closed;
      try {
        fs.rmSync(scriptPath, { force: true });
      } catch {
        setTimeout(() => fs.rm(scriptPath, { force: true }, () => {}), 1000).unref();
      }
    },
    killNow() {
      stopped = true;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      try {
        fs.rmSync(scriptPath, { force: true });
      } catch {
        // Retried on the next graceful shutdown.
      }
    },
  };
}

module.exports = { startTray };
