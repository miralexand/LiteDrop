'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  info: null,
  files: [],
  stats: { count: 0, totalSize: 0 },
  tunnel: null,
  security: null,
  securityBusy: false,
  mode: 'full',
  to: '',
  search: '',
  queue: [],
  activeUploads: 0,
  finishedNotified: false,
  confirmResolve: null,
  pollTimer: null,
  lastFocused: null,
};

const els = {
  app: $('#app'),
  heroTitle: $('#heroTitle'),
  heroCopy: $('#heroCopy'),
  dropzone: $('#dropzone'),
  dropTitle: $('#dropTitle'),
  dropSubtitle: $('#dropSubtitle'),
  pickButton: $('#pickButton'),
  fileInput: $('#fileInput'),
  targetHint: $('#targetHint'),
  limitHint: $('#limitHint'),
  uploadQueue: $('#uploadQueue'),
  lanPill: $('#lanPill'),
  lanLabel: $('#lanLabel'),
  tunnelPill: $('#tunnelPill'),
  tunnelLabel: $('#tunnelLabel'),
  networkButton: $('#networkButton'),
  versionLabel: $('#versionLabel'),
  localUrlLabel: $('#localUrlLabel'),
  securityPanel: $('#securityPanel'),
  securityToggle: $('#securityToggle'),
  securityToggleLabel: $('#securityToggleLabel'),
  securityOff: $('#securityOff'),
  securityOn: $('#securityOn'),
  securityAddressList: $('#securityAddressList'),
  securityFingerprint: $('#securityFingerprint'),
  securityError: $('#securityError'),
  securityErrorMessage: $('#securityErrorMessage'),
  sharePanel: $('#sharePanel'),
  tunnelBadge: $('#tunnelBadge'),
  tunnelIdle: $('#tunnelIdle'),
  tunnelStarting: $('#tunnelStarting'),
  tunnelRunning: $('#tunnelRunning'),
  tunnelError: $('#tunnelError'),
  tunnelErrorMessage: $('#tunnelErrorMessage'),
  tunnelUrl: $('#tunnelUrl'),
  tunnelShareUrl: $('#tunnelShareUrl'),
  startTunnelButton: $('#startTunnelButton'),
  cancelTunnelButton: $('#cancelTunnelButton'),
  stopTunnelButton: $('#stopTunnelButton'),
  retryTunnelButton: $('#retryTunnelButton'),
  fileCount: $('#fileCount'),
  librarySummary: $('#librarySummary'),
  library: $('#library'),
  fileList: $('#fileList'),
  emptyState: $('#emptyState'),
  searchInput: $('#searchInput'),
  refreshButton: $('#refreshButton'),
  toastStack: $('#toastStack'),
  offlineBanner: $('#offlineBanner'),
  networkModal: $('#networkModal'),
  addressList: $('#addressList'),
  confirmModal: $('#confirmModal'),
  confirmTitle: $('#confirmTitle'),
  confirmMessage: $('#confirmMessage'),
  confirmCancel: $('#confirmCancel'),
  confirmOk: $('#confirmOk'),
  tunnelDisclaimerModal: $('#tunnelDisclaimerModal'),
  disclaimerAgree: $('#disclaimerAgree'),
  disclaimerConfirm: $('#disclaimerConfirm'),
  previewModal: $('#previewModal'),
  previewBody: $('#previewBody'),
  previewClose: $('#previewClose'),
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function icon(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits).replace(/\.0+$/, '')} ${units[unit]}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${time}`;
  if (isYesterday) return `昨天 ${time}`;
  const dateText = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? `${dateText} ${time}` : `${date.getFullYear()}年${dateText}`;
}

function kindIcon(kind) {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'audio';
  if (kind === 'pdf') return 'pdf';
  if (kind === 'archive') return 'archive';
  if (kind === 'code') return 'code';
  if (kind === 'document') return 'file';
  return 'file';
}

function toast(message, type = 'info') {
  const element = document.createElement('div');
  element.className = `toast is-${type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'}`;
  element.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span>${escapeHtml(message)}</span>`;
  els.toastStack.append(element);
  setTimeout(() => {
    element.classList.add('is-leaving');
    setTimeout(() => element.remove(), 200);
  }, 3400);
}

function markOnline(online) {
  els.offlineBanner.hidden = online;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      cache: 'no-store',
      ...options,
    });
  } catch {
    markOnline(false);
    throw new Error('无法连接到本地服务');
  }
  markOnline(true);
  const contentType = response.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    throw new Error((data && data.error) || `请求失败（${response.status}）`);
  }
  return data || {};
}

function applyMode() {
  if (state.mode !== 'upload') return;
  document.body.classList.add('mode-upload');
  const target = state.to ? `「${state.to}」` : '本机';
  els.heroTitle.textContent = '把文件轻投到';
  const accent = document.createElement('span');
  accent.className = 'accent';
  accent.textContent = target;
  els.heroTitle.append(accent);
  els.heroCopy.textContent = '文件会直接保存在对方的电脑上，投完即可离开。';
  els.dropTitle.textContent = '把文件投到这里';
  els.dropSubtitle.textContent = '或点击选择文件，选好后自动开始轻投';
  document.title = '轻投文件 · LiteDrop';
}

function updateTargetHint() {
  els.targetHint.textContent = state.to ? `投递至 uploads/${state.to}/` : '投递至 uploads/';
}

function renderInfo() {
  const info = state.info;
  if (!info) return;
  els.versionLabel.textContent = `v${info.server.version}`;
  els.localUrlLabel.textContent = info.network.localhost;
  els.limitHint.textContent = `单个文件最大 ${formatSize(info.uploads.maxFileSize)}`;
  els.lanPill.className = 'status-pill is-online';
  els.lanLabel.textContent = '局域网';
  updateTargetHint();
  if (!info.cloudflared.found) {
    els.startTunnelButton.disabled = true;
    els.startTunnelButton.textContent = '未找到 cloudflared';
    els.startTunnelButton.title = '请把 cloudflared.exe 放到 LiteDrop.exe 同目录';
  } else {
    els.startTunnelButton.disabled = false;
    els.startTunnelButton.textContent = '开启公网隧道';
    els.startTunnelButton.removeAttribute('title');
  }
  state.security = info.security || state.security;
  renderSecurity();
  renderAddresses();
}

function copyRow(label, value) {
  const row = document.createElement('div');
  row.className = 'address-item';
  const main = document.createElement('div');
  main.className = 'address-main';
  const labelEl = document.createElement('span');
  labelEl.className = 'address-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'address-value';
  valueEl.textContent = value;
  main.append(labelEl, valueEl);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button small';
  button.dataset.copyValue = value;
  button.setAttribute('aria-label', `复制 ${value}`);
  button.innerHTML = icon('copy');
  row.append(main, button);
  return row;
}

function renderAddresses() {
  if (!state.info) return;
  els.addressList.replaceChildren();
  els.addressList.append(copyRow('本机访问', state.info.network.localhost));

  const security = state.security || state.info.security;
  const encryptedUrls = security && security.active && Array.isArray(security.urls) ? security.urls : [];
  if (encryptedUrls.length) {
    for (const item of encryptedUrls) {
      els.addressList.append(copyRow(`局域网 · ${item.name}（加密）`, item.url));
    }
  } else {
    for (const item of state.info.network.addresses) {
      els.addressList.append(
        copyRow(`局域网 · ${item.name}`, `http://${item.address}:${state.info.server.port}`)
      );
    }
  }

  if (!state.info.network.addresses.length) {
    const note = document.createElement('div');
    note.className = 'modal-copy';
    note.textContent = '未检测到可用的局域网 IPv4 地址，请检查网络连接。';
    els.addressList.append(note);
  }
}

function renderSecurity() {
  if (!els.securityPanel) return;
  const security = state.security || (state.info && state.info.security);
  const active = Boolean(security && security.active);
  const error = security && security.error ? String(security.error) : '';

  els.lanLabel.textContent = active ? '局域网加密' : '局域网';
  els.securityToggle.setAttribute('aria-checked', active ? 'true' : 'false');
  els.securityToggle.disabled = state.securityBusy;
  els.securityToggleLabel.textContent = state.securityBusy
    ? '处理中...'
    : active
      ? '已开启'
      : '已关闭';

  els.securityOff.hidden = active;
  els.securityOn.hidden = !active;
  els.securityError.hidden = !error;
  els.securityErrorMessage.textContent = error;

  els.securityAddressList.replaceChildren();
  if (active && security && Array.isArray(security.urls)) {
    for (const item of security.urls) {
      els.securityAddressList.append(copyRow(`局域网 · ${item.name}（加密）`, item.url));
    }
    if (!security.urls.length) {
      const note = document.createElement('div');
      note.className = 'modal-copy';
      note.textContent = '未检测到可用的局域网 IPv4 地址，请检查网络连接。';
      els.securityAddressList.append(note);
    }
  }

  const fingerprint = active && security && security.cert ? security.cert.fingerprint256 : '';
  els.securityFingerprint.textContent = fingerprint;
  els.securityFingerprint.title = fingerprint;
}

async function loadInfo() {
  try {
    const data = await api('/api/info');
    state.info = data;
    renderInfo();
    markOnline(true);
  } catch (error) {
    markOnline(false);
    els.lanPill.className = 'status-pill is-error';
    els.lanLabel.textContent = '服务未连接';
    throw error;
  }
}

async function loadFiles({ quiet = false } = {}) {
  if (state.mode === 'upload') return;
  try {
    const data = await api('/api/files');
    state.files = data.files || [];
    state.stats = data.stats || { count: 0, totalSize: 0 };
    renderFiles();
    markOnline(true);
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
    throw error;
  }
}

function fileRow(file, index) {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.id = file.id;
  row.style.animationDelay = `${Math.min(index * 32, 260)}ms`;

  const canPreview = Boolean(file.previewUrl);
  const thumbTag = canPreview ? 'button' : 'div';
  const thumbAttrs = canPreview
    ? `type="button" data-action="preview" title="预览 ${escapeHtml(file.name)}"`
    : '';
  let thumbContent = icon(kindIcon(file.kind));
  if (file.kind === 'image' && file.previewUrl) {
    thumbContent = `<img src="${escapeHtml(file.previewUrl)}" alt="" loading="lazy" decoding="async">`;
  }

  const dir = file.dir
    ? `<span class="file-dir">${icon('folder')}${escapeHtml(file.dir)}</span>`
    : '';

  row.innerHTML = `
    <${thumbTag} class="file-thumb kind-${escapeHtml(file.kind || 'other')}" ${thumbAttrs}>
      ${thumbContent}
    </${thumbTag}>
    <div class="file-main">
      <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
      <div class="file-meta">
        ${dir}
        <span class="file-size">${escapeHtml(formatSize(file.size))}</span>
        <span>${escapeHtml(formatDate(file.uploadedAt))}</span>
      </div>
    </div>
    <div class="file-actions">
      ${canPreview ? `<button class="icon-button" type="button" data-action="preview" aria-label="预览" title="预览">${icon('eye')}</button>` : ''}
      <a class="icon-button" href="${escapeHtml(file.downloadUrl)}" download="${escapeHtml(file.name)}" aria-label="下载" title="下载">${icon('download')}</a>
      <button class="icon-button danger" type="button" data-action="delete" aria-label="删除" title="删除">${icon('trash')}</button>
    </div>
  `;

  const image = row.querySelector('img');
  if (image) {
    image.addEventListener('error', () => {
      const thumb = row.querySelector('.file-thumb');
      thumb.classList.remove('kind-image');
      thumb.classList.add('kind-other');
      thumb.innerHTML = icon('file');
    });
  }
  return row;
}

function renderFiles() {
  const query = state.search.trim().toLowerCase();
  const filtered = query
    ? state.files.filter((file) => {
        return (
          file.name.toLowerCase().includes(query) ||
          (file.dir || '').toLowerCase().includes(query)
        );
      })
    : state.files;

  els.fileCount.textContent = String(state.stats.count || state.files.length);
  els.librarySummary.textContent = state.files.length
    ? `${state.files.length} 个文件 · 共 ${formatSize(state.stats.totalSize)}`
    : '还没有文件';

  els.fileList.replaceChildren();
  for (let index = 0; index < filtered.length; index += 1) {
    els.fileList.append(fileRow(filtered[index], index));
  }

  const showEmpty = filtered.length === 0;
  els.emptyState.hidden = !showEmpty;
  els.fileList.hidden = showEmpty;

  if (showEmpty) {
    const emptyTitle = $('h3', els.emptyState);
    const emptyCopy = $('p', els.emptyState);
    if (state.files.length && query) {
      emptyTitle.textContent = '没有匹配的投递';
      emptyCopy.textContent = '换个关键词试试，或清空搜索条件。';
    } else {
      emptyTitle.textContent = '还没有投递';
      emptyCopy.textContent = '文件投进来后会出现在这里，可随时下载或删除。';
    }
  }
}

function openModal(id) {
  state.lastFocused = document.activeElement;
  els[id].hidden = false;
  document.body.style.overflow = 'hidden';
  const target = els[id].querySelector('button, [href], input');
  if (target) target.focus({ preventScroll: true });
}

function closeModal(id) {
  els[id].hidden = true;
  if ($$('.modal-layer:not([hidden])').length === 0) {
    document.body.style.overflow = '';
    if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
      state.lastFocused.focus({ preventScroll: true });
    }
    state.lastFocused = null;
  }
}

function closeAllModals() {
  for (const layer of $$('.modal-layer')) layer.hidden = true;
  document.body.style.overflow = '';
}

function confirmDialog({ title, message, confirmText = '删除' }) {
  return new Promise((resolve) => {
    closeAllModals();
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOk.textContent = confirmText;
    state.confirmResolve = resolve;
    openModal('confirmModal');
    els.confirmCancel.focus({ preventScroll: true });
  });
}

function settleConfirm(value) {
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  closeModal('confirmModal');
  if (resolve) resolve(value);
}

async function requestDelete(id) {
  const file = state.files.find((item) => item.id === id);
  if (!file) return;
  const confirmed = await confirmDialog({
    title: '删除文件',
    message: `确定要删除这次投递「${file.name}」吗？删除后无法恢复。`,
    confirmText: '删除',
  });
  if (!confirmed) return;
  try {
    await api(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('文件已删除', 'success');
    await loadFiles({ quiet: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openPreview(id) {
  const file = state.files.find((item) => item.id === id);
  if (!file || !file.previewUrl) return;
  els.previewBody.replaceChildren();
  if (file.kind === 'image') {
    const image = document.createElement('img');
    image.src = file.previewUrl;
    image.alt = file.name;
    els.previewBody.append(image);
  } else if (file.kind === 'video') {
    const video = document.createElement('video');
    video.src = file.previewUrl;
    video.controls = true;
    video.autoplay = true;
    els.previewBody.append(video);
  } else if (file.kind === 'audio') {
    const audio = document.createElement('audio');
    audio.src = file.previewUrl;
    audio.controls = true;
    els.previewBody.append(audio);
  } else if (file.kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = file.previewUrl;
    frame.title = file.name;
    els.previewBody.append(frame);
  } else {
    return;
  }
  openModal('previewModal');
}

function closePreview() {
  els.previewBody.replaceChildren();
  closeModal('previewModal');
}

async function copyText(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    toast('已复制到剪贴板', 'success');
  } catch {
    toast('复制失败，请手动选择链接', 'error');
  }
}

function setTunnel(tunnel, notify = true) {
  const previous = state.tunnel ? state.tunnel.state : null;
  state.tunnel = tunnel;
  renderTunnel();
  if (notify && previous === 'starting' && tunnel.state === 'running') {
    toast('公网隧道已开启', 'success');
  } else if (notify && previous === 'starting' && tunnel.state === 'error') {
    toast(tunnel.error || '隧道连接失败', 'error');
  }
}

function renderTunnel() {
  const tunnel = state.tunnel || { state: 'stopped', cloudflared: { found: false } };
  const current = tunnel.state || 'stopped';

  const badgeClass =
    current === 'running'
      ? 'is-online'
      : current === 'starting' || current === 'stopping'
        ? 'is-pending'
        : current === 'error'
          ? 'is-error'
          : '';
  els.tunnelBadge.className = `tunnel-state-badge ${badgeClass}`.trim();
  els.tunnelBadge.textContent =
    current === 'running'
      ? '已开启'
      : current === 'starting'
        ? '连接中'
        : current === 'stopping'
          ? '停止中'
          : current === 'error'
            ? '连接异常'
            : '未开启';

  els.tunnelIdle.hidden = !(current === 'stopped' || current === 'stopping');
  els.tunnelStarting.hidden = !(current === 'starting' || current === 'stopping');
  els.tunnelRunning.hidden = current !== 'running';
  els.tunnelError.hidden = current !== 'error';

  const known = state.info && state.info.cloudflared ? state.info.cloudflared.found : false;
  const found = tunnel.cloudflared ? tunnel.cloudflared.found : known;
  els.startTunnelButton.disabled = !found;
  if (!found && current === 'stopped') {
    els.startTunnelButton.textContent = '未找到 cloudflared';
    els.startTunnelButton.title = '请把 cloudflared.exe 放到 LiteDrop.exe 同目录';
  } else if (current === 'stopped') {
    els.startTunnelButton.textContent = '开启公网隧道';
    els.startTunnelButton.removeAttribute('title');
  }

  if (current === 'running') {
    els.tunnelUrl.textContent = tunnel.url || '';
    els.tunnelUrl.href = tunnel.url || '#';
    els.tunnelShareUrl.textContent = tunnel.shareUrl || '';
    els.tunnelShareUrl.href = tunnel.shareUrl || '#';
  }

  if (current === 'error') {
    els.tunnelErrorMessage.textContent = tunnel.error || '未知错误，请稍后重试。';
  }

  els.tunnelPill.className = 'status-pill';
  if (current === 'running') {
    els.tunnelPill.classList.add('is-online');
    els.tunnelLabel.textContent = '公网已开启';
  } else if (current === 'starting' || current === 'stopping') {
    els.tunnelPill.classList.add('is-pending');
    els.tunnelLabel.textContent = '公网连接中';
  } else if (current === 'error') {
    els.tunnelPill.classList.add('is-error');
    els.tunnelLabel.textContent = '公网异常';
  } else {
    els.tunnelLabel.textContent = '公网未开启';
  }
}

async function loadTunnel(notify = false) {
  try {
    const data = await api('/api/tunnel');
    setTunnel(data.tunnel, notify);
    markOnline(true);
  } catch {
    markOnline(false);
  }
}

function scheduleTunnelPoll() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    state.pollTimer = null;
    if (document.hidden) {
      scheduleTunnelPoll();
      return;
    }
    await loadTunnel(true);
    if (state.tunnel && ['starting', 'stopping'].includes(state.tunnel.state)) {
      scheduleTunnelPoll();
    }
  }, 1400);
}

function requestStartTunnel() {
  if (state.tunnel && ['starting', 'running'].includes(state.tunnel.state)) return;
  els.disclaimerAgree.checked = false;
  els.disclaimerConfirm.disabled = true;
  openModal('tunnelDisclaimerModal');
}

async function acceptTunnelDisclaimer() {
  if (!els.disclaimerAgree.checked) return;
  closeModal('tunnelDisclaimerModal');
  await startTunnel();
}

async function startTunnel() {
  if (state.tunnel && ['starting', 'running'].includes(state.tunnel.state)) return;
  try {
    const data = await api('/api/tunnel/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: state.to }),
    });
    setTunnel(data.tunnel, false);
    toast('正在建立公网隧道', 'info');
    scheduleTunnelPoll();
  } catch (error) {
    toast(error.message, 'error');
    await loadTunnel(false);
  }
}

async function stopTunnel() {
  try {
    const data = await api('/api/tunnel/stop', { method: 'POST' });
    setTunnel(data.tunnel, false);
    toast('公网隧道已停止', 'success');
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

function isLocalHostname(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

function applySecurity(security) {
  state.security = security || null;
  if (state.info) state.info.security = state.security;
  renderSecurity();
  renderAddresses();
}

async function loadSecurity() {
  try {
    const data = await api('/api/security');
    applySecurity(data.security);
  } catch {
    // The offline banner already reflects connection failures.
  }
}

async function toggleSecurity() {
  if (state.securityBusy) return;
  const security = state.security || (state.info && state.info.security);
  const active = Boolean(security && security.active);
  state.securityBusy = true;
  renderSecurity();
  try {
    const data = await api(`/api/security/${active ? 'disable' : 'enable'}`, { method: 'POST' });
    applySecurity(data.security);
    toast(active ? '局域网加密已关闭' : '局域网加密已开启', 'success');

    const hostname = window.location.hostname;
    const suffix = `${window.location.pathname}${window.location.search}`;
    if (!active && data.security.active && window.location.protocol === 'http:' && !isLocalHostname(hostname)) {
      window.location.replace(`https://${hostname}:${data.security.httpsPort}${suffix}`);
      return;
    }
    if (active && !data.security.active && window.location.protocol === 'https:' && state.info) {
      window.location.replace(`http://${hostname}:${state.info.server.port}${suffix}`);
      return;
    }
  } catch (error) {
    toast(error.message, 'error');
    await loadSecurity();
  } finally {
    state.securityBusy = false;
    renderSecurity();
  }
}

async function refreshFiles() {
  try {
    await loadFiles({ quiet: true });
    toast('投递记录已刷新', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function statusLabel(item) {
  if (item.status === 'queued') return '等待中';
  if (item.status === 'uploading') return `${item.progress}%`;
  if (item.status === 'done') return '已投递';
  if (item.status === 'error') return '失败';
  return '';
}

function renderQueue() {
  const rows = state.queue.map((item) => {
    const statusIcon = item.status === 'done' ? 'check' : item.status === 'error' ? 'alert' : 'file';
    const rowClass =
      item.status === 'done' ? 'is-done' : item.status === 'error' ? 'is-error' : '';
    return `
      <div class="upload-item ${rowClass}" data-upload-key="${escapeHtml(item.key)}">
        <div class="upload-item-icon">${icon(statusIcon)}</div>
        <div class="upload-item-main">
          <div class="upload-item-top">
            <span class="upload-item-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</span>
            <span class="upload-item-size">${escapeHtml(formatSize(item.file.size))}</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${item.progress}%"></div></div>
        </div>
        <div class="upload-item-status">${escapeHtml(statusLabel(item))}</div>
      </div>
    `;
  });
  els.uploadQueue.innerHTML = rows.join('');
  els.uploadQueue.hidden = state.queue.length === 0;
  for (const item of state.queue) {
    if (item.status === 'error' && item.error) {
      const row = Array.from(els.uploadQueue.children).find(
        (element) => element.dataset.uploadKey === item.key
      );
      if (row) row.querySelector('.upload-item-status').title = item.error;
    }
  }
}

function updateQueueItem(item) {
  const row = Array.from(els.uploadQueue.children).find(
    (element) => element.dataset.uploadKey === item.key
  );
  if (!row) {
    renderQueue();
    return;
  }
  row.classList.toggle('is-done', item.status === 'done');
  row.classList.toggle('is-error', item.status === 'error');
  row.querySelector('.progress-fill').style.width = `${item.progress}%`;
  row.querySelector('.upload-item-status').textContent = statusLabel(item);
  if (item.error) row.querySelector('.upload-item-status').title = item.error;
  const statusIcon = item.status === 'done' ? 'check' : item.status === 'error' ? 'alert' : 'file';
  row.querySelector('.upload-item-icon').innerHTML = icon(statusIcon);
}

function uploadItem(item) {
  const xhr = new XMLHttpRequest();
  const endpoint = state.to ? `/api/upload?to=${encodeURIComponent(state.to)}` : '/api/upload';
  xhr.open('POST', endpoint);
  xhr.timeout = 0;
  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    item.progress = Math.min(99, Math.round((event.loaded / event.total) * 100));
    updateQueueItem(item);
  });
  xhr.addEventListener('load', () => {
    state.activeUploads = Math.max(0, state.activeUploads - 1);
    let data = null;
    try {
      data = JSON.parse(xhr.responseText);
    } catch {
      data = null;
    }
    if (xhr.status >= 200 && xhr.status < 300) {
      item.status = 'done';
      item.progress = 100;
      item.result = data;
      updateQueueItem(item);
      setTimeout(() => {
        const index = state.queue.indexOf(item);
        if (index >= 0) {
          state.queue.splice(index, 1);
          renderQueue();
        }
      }, 4200);
    } else {
      item.status = 'error';
      item.error = (data && data.error) || `投递失败（${xhr.status}）`;
      updateQueueItem(item);
    }
    pumpQueue();
  });
  xhr.addEventListener('error', () => {
    state.activeUploads = Math.max(0, state.activeUploads - 1);
    item.status = 'error';
    item.error = '网络连接中断';
    updateQueueItem(item);
    pumpQueue();
  });
  xhr.addEventListener('abort', () => {
    state.activeUploads = Math.max(0, state.activeUploads - 1);
    item.status = 'error';
    item.error = '投递已取消';
    updateQueueItem(item);
    pumpQueue();
  });
  const form = new FormData();
  form.append('files', item.file, item.file.name);
  xhr.send(form);
}

function finishUploadsIfIdle() {
  if (state.activeUploads > 0) return;
  if (state.queue.some((item) => item.status === 'queued' || item.status === 'uploading')) return;
  if (state.finishedNotified) return;
  state.finishedNotified = true;
  const done = state.queue.filter((item) => item.status === 'done').length;
  const failed = state.queue.filter((item) => item.status === 'error').length;
  if (done || failed) {
    if (failed) {
      toast(`已轻投 ${done} 个文件，${failed} 个失败`, 'error');
    } else {
      toast(`已轻投 ${done} 个文件`, 'success');
    }
    if (state.mode !== 'upload') loadFiles({ quiet: true }).catch(() => {});
  }
  setTimeout(() => {
    state.finishedNotified = false;
  }, 1200);
}

function pumpQueue() {
  while (state.activeUploads < 3) {
    const next = state.queue.find((item) => item.status === 'queued');
    if (!next) break;
    next.status = 'uploading';
    next.progress = 0;
    state.activeUploads += 1;
    updateQueueItem(next);
    uploadItem(next);
  }
  if (state.activeUploads === 0) finishUploadsIfIdle();
}

function enqueueFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file && typeof file.size === 'number');
  if (!files.length) return;
  state.finishedNotified = false;
  for (const file of files) {
    state.queue.push({
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      progress: 0,
      status: 'queued',
      error: '',
      result: null,
    });
  }
  renderQueue();
  els.uploadQueue.hidden = false;
  pumpQueue();
}

function bindUpload() {
  els.pickButton.addEventListener('click', (event) => {
    event.stopPropagation();
    els.fileInput.click();
  });

  els.dropzone.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    els.fileInput.click();
  });

  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });

  els.fileInput.addEventListener('change', () => {
    enqueueFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  let dragDepth = 0;
  els.dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth += 1;
    els.dropzone.classList.add('is-dragging');
  });
  els.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    els.dropzone.classList.add('is-dragging');
  });
  els.dropzone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropzone.classList.remove('is-dragging');
  });
  els.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    els.dropzone.classList.remove('is-dragging');
    enqueueFiles(event.dataTransfer.files);
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    if (!event.target.closest('#dropzone')) event.preventDefault();
  });

  document.addEventListener('paste', (event) => {
    const files = event.clipboardData && event.clipboardData.files;
    if (files && files.length) {
      event.preventDefault();
      enqueueFiles(files);
    }
  });
}

function bindEvents() {
  bindUpload();

  els.networkButton.addEventListener('click', () => openModal('networkModal'));
  els.securityToggle.addEventListener('click', toggleSecurity);
  els.startTunnelButton.addEventListener('click', requestStartTunnel);
  els.retryTunnelButton.addEventListener('click', requestStartTunnel);
  els.disclaimerAgree.addEventListener('change', () => {
    els.disclaimerConfirm.disabled = !els.disclaimerAgree.checked;
  });
  els.disclaimerConfirm.addEventListener('click', acceptTunnelDisclaimer);
  els.cancelTunnelButton.addEventListener('click', stopTunnel);
  els.stopTunnelButton.addEventListener('click', stopTunnel);
  els.refreshButton.addEventListener('click', refreshFiles);

  els.searchInput.addEventListener('input', () => {
    state.search = els.searchInput.value;
    renderFiles();
  });

  els.fileList.addEventListener('click', (event) => {
    const actionElement = event.target.closest('[data-action]');
    if (!actionElement) return;
    const row = actionElement.closest('.file-row');
    if (!row) return;
    const action = actionElement.dataset.action;
    if (action === 'delete') requestDelete(row.dataset.id);
    if (action === 'preview') openPreview(row.dataset.id);
  });

  document.addEventListener('click', (event) => {
    const copyTarget = event.target.closest('[data-copy-target]');
    if (copyTarget) {
      const target = document.getElementById(copyTarget.dataset.copyTarget);
      if (target) copyText(target.textContent.trim());
      return;
    }
    const copyValue = event.target.closest('[data-copy-value]');
    if (copyValue) {
      copyText(copyValue.dataset.copyValue);
      return;
    }
    const closeButton = event.target.closest('[data-close-modal]');
    if (closeButton) {
      closeModal(closeButton.dataset.closeModal);
    }
  });

  for (const layer of $$('.modal-layer')) {
    layer.addEventListener('click', (event) => {
      if (event.target !== layer) return;
      if (layer === els.confirmModal && state.confirmResolve) {
        settleConfirm(false);
      } else if (layer === els.previewModal) {
        closePreview();
      } else {
        closeModal(layer.id);
      }
    });
  }

  els.confirmCancel.addEventListener('click', () => settleConfirm(false));
  els.confirmOk.addEventListener('click', () => settleConfirm(true));
  els.previewClose.addEventListener('click', closePreview);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.previewModal.hidden) {
      closePreview();
    } else if (!els.confirmModal.hidden) {
      settleConfirm(false);
    } else if (!els.tunnelDisclaimerModal.hidden) {
      closeModal('tunnelDisclaimerModal');
    } else if (!els.networkModal.hidden) {
      closeModal('networkModal');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.mode !== 'upload') {
      loadFiles({ quiet: true }).catch(() => {});
      loadTunnel(false);
    }
  });

  window.addEventListener('online', () => {
    loadInfo().catch(() => {});
    if (state.mode !== 'upload') {
      loadFiles({ quiet: true }).catch(() => {});
      loadTunnel(false);
    }
  });

  window.addEventListener('offline', () => markOnline(false));

  setInterval(() => {
    if (!document.hidden && state.mode !== 'upload') loadTunnel(false);
  }, 9000);
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  state.mode = params.get('mode') === 'upload' ? 'upload' : 'full';
  state.to = (params.get('to') || '').trim();
  applyMode();
  bindEvents();

  try {
    await loadInfo();
  } catch {
    markOnline(false);
  }

  if (state.mode !== 'upload') {
    try {
      await loadFiles({ quiet: true });
    } catch {
      // The offline banner already reflects the failure.
    }
    await loadTunnel(false);
  }

  if (state.info) {
    els.limitHint.textContent = `单个文件最大 ${formatSize(state.info.uploads.maxFileSize)}`;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
