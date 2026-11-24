// ============================================================
// 启动入口
// ============================================================

// Landing page: 无 key 参数时显示入口页，有 key 时隐藏
function goRadar() {
  const key = (document.getElementById('landingKey').value || '').trim();
  if (!key) { document.getElementById('landingKey').focus(); return; }
  const errEl = document.getElementById('landingError');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  const btn = document.getElementById('landingBtn');
  if (btn) { btn.disabled = true; btn.textContent = '验证中...'; }

  // 先连 relay 验证房间是否有数据源
  const checkUrl = RadarEndpoints.relay();
  const checkWs = new WebSocket(checkUrl);
  const timeout = setTimeout(() => {
    checkWs.close();
    if (btn) { btn.disabled = false; btn.textContent = '进入'; }
    if (errEl) { errEl.textContent = '连接超时，请稍后重试'; errEl.style.display = ''; }
  }, 5000);

  checkWs.onopen = () => {
    checkWs.send(JSON.stringify({ action: 'auth', role: 'check', key: key }));
  };
  checkWs.onmessage = (e) => {
    clearTimeout(timeout);
    try {
      const msg = JSON.parse(e.data);
      checkWs.close();
      if (msg.ok && msg.pub) {
        // 有效房间 → 缓存房间号并跳转进入
        try { localStorage.setItem('lastRoomKey', key); } catch(e) {}
        window.location.href = window.location.pathname + '?key=' + encodeURIComponent(key);
      } else {
        if (btn) { btn.disabled = false; btn.textContent = '进入'; }
        if (errEl) { errEl.textContent = '房间无效，数据源未连接'; errEl.style.display = ''; }
      }
    } catch (ex) {
      if (btn) { btn.disabled = false; btn.textContent = '进入'; }
    }
  };
  checkWs.onerror = () => {
    clearTimeout(timeout);
    if (btn) { btn.disabled = false; btn.textContent = '进入'; }
    if (errEl) { errEl.textContent = '无法连接服务器'; errEl.style.display = ''; }
  };
}
// 回车键触发
document.getElementById('landingKey').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') goRadar();
});

const _urlKey = new URLSearchParams(window.location.search).get('key');
const _urlReplay = _isReplayUrl();
if (_urlKey || _urlReplay) {
  document.getElementById('landingOverlay').classList.add('hidden');
} else {
  try {
    const saved = localStorage.getItem('lastRoomKey');
    if (saved) document.getElementById('landingKey').value = saved;
  } catch(e) {}
  document.getElementById('landingKey').focus();
}

currentMapInfo = MAPS[0];
initLeaflet(MAPS[0]);
if (_urlReplay) {
  _initReplay();
} else if (_urlKey) {
  connectWs();
}

// 隐私模式：从后端拉取
(async function loadPrivacyMode() {
  try {
    const base = RadarEndpoints.api('');
    const r = await fetch(base + '/api/privacy_mode', { mode: 'cors' });
    const j = await r.json();
    if (j.ok) _privacyMode = !!j.enabled;
  } catch(e) {}
})();

// 动态加载浏览器标题 + 图标 (admin 后台可改, 持久化到 theme_names.json + localStorage 防 F5 闪烁)
(async function loadDynamicBrand() {
  try {
    const base = RadarEndpoints.api('');
    const r = await fetch(base + '/api/theme_names', { mode: 'cors' });
    const j = await r.json();
    if (!j.ok) return;
    let theme = location.pathname.startsWith('/_white/') ? 'white' :
                location.pathname.startsWith('/_black/') ? 'black' : 'black';
    if (theme === 'black' && !location.pathname.startsWith('/_black/')) {
      try {
        const r2 = await fetch(base + '/api/theme', { mode: 'cors' });
        const j2 = await r2.json();
        if (j2.ok && (j2.theme === 'white' || j2.theme === 'black')) theme = j2.theme;
      } catch(e) {}
    }
    // localStorage 记录当前主题, 下次 F5 inline script 立刻知道用哪个 key
    try { localStorage.setItem('admin_current_theme', theme); } catch(e) {}
    // 标题
    const name = j[theme];
    if (name && typeof name === 'string') {
      document.title = name;
      try { localStorage.setItem('admin_brand_title_' + theme, name); } catch(e) {}
    }
    // 图标 (favicon)
    const iconUrl = j[theme === 'white' ? 'iconWhite' : 'iconBlack'];
    if (iconUrl && typeof iconUrl === 'string') {
      document.querySelectorAll("link[rel*='icon']").forEach(l => l.remove());
      const link = document.createElement('link');
      link.rel = 'icon'; link.href = iconUrl;
      document.head.appendChild(link);
      try { localStorage.setItem('admin_brand_icon_' + theme, iconUrl); } catch(e) {}
    } else {
      // 用户没自定义 → 清缓存, 下次 F5 用 HTML 自带 favicon
      try { localStorage.removeItem('admin_brand_icon_' + theme); } catch(e) {}
    }
  } catch(e) { console.warn('[Brand] load failed:', e); }
})();

// 顶层错误兜底: 一处 JS 异常不让后续渲染全停; 同时把错误推到 console 便于排查
window.addEventListener('error', (e) => {
  console.error('[GlobalError]', e.message, 'at', e.filename + ':' + e.lineno, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[UnhandledRejection]', e.reason);
});
