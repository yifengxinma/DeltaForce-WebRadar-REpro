// ============================================================
// 启动入口与入场界面动画逻辑
// ============================================================

// --- 语言切换逻辑 ---
const i18n = {
  en: {
    title: "Holo Tactical Radar",
    desc: "Connect to encrypted channel, sync battlefield status",
    placeholder: "Enter Room ID",
    btn: "Establish Connection",
    hint: "End-to-end encrypted communication",
    errEmpty: "Please enter a valid Room ID",
    errTimeout: "Connection timeout, please retry",
    errInvalid: "Invalid room, please let the host enter the game!",
    errNet: "Unable to connect to server"
  },
  zh: {
    title: "全息战术雷达",
    desc: "接入加密频道，实时同步战场态势",
    placeholder: "请输入房间号",
    btn: "建立安全连接",
    hint: "终端通信已采用端到端加密",
    errEmpty: "请输入有效房间号",
    errTimeout: "连接超时，请稍后重试",
    errInvalid: "当前房间无效,请让主端进入游戏！",
    errNet: "无法连接服务器"
  }
};

let currentLang = 'en';

function setLang(lang) {
  currentLang = lang;
  document.getElementById('btnEn').classList.toggle('active', lang === 'en');
  document.getElementById('btnZh').classList.toggle('active', lang === 'zh');
  
  if (document.getElementById('tTitle')) document.getElementById('tTitle').innerText = i18n[lang].title;
  if (document.getElementById('tDesc')) document.getElementById('tDesc').innerText = i18n[lang].desc;
  if (document.getElementById('landingKey')) document.getElementById('landingKey').placeholder = i18n[lang].placeholder;
  if (document.getElementById('tBtn')) document.getElementById('tBtn').innerText = i18n[lang].btn;
  if (document.getElementById('tHint')) document.getElementById('tHint').innerText = i18n[lang].hint;
  
  const errEl = document.getElementById('landingError');
  if (errEl && errEl.style.opacity === '1') {
    // 粗略匹配下错误类型
    if (errEl.innerText.includes('timeout') || errEl.innerText.includes('超时')) errEl.innerText = i18n[lang].errTimeout;
    else if (errEl.innerText.includes('source') || errEl.innerText.includes('数据源')) errEl.innerText = i18n[lang].errInvalid;
    else if (errEl.innerText.includes('server') || errEl.innerText.includes('服务器')) errEl.innerText = i18n[lang].errNet;
    else errEl.innerText = i18n[lang].errEmpty;
  }
}

function showError(msgKey) {
  const errEl = document.getElementById('landingError');
  if (errEl) {
    errEl.innerText = i18n[currentLang][msgKey];
    errEl.style.opacity = '1';
  }
  const btn = document.getElementById('landingBtn');
  if (btn) btn.classList.remove('btn-loading');
}

// --- 验证进入房间逻辑 ---
function goRadarNew() {
  const key = (document.getElementById('landingKey').value || '').trim();
  const errEl = document.getElementById('landingError');
  const btn = document.getElementById('landingBtn');

  if (!key) { 
    showError('errEmpty'); 
    document.getElementById('landingKey').focus(); 
    return; 
  }
  
  if (errEl) errEl.style.opacity = '0';
  if (btn) btn.classList.add('btn-loading'); // 开启 Loading 旋转动画

  // 连 relay 验证房间是否有数据源
  const checkUrl = RadarEndpoints.relay();
  const checkWs = new WebSocket(checkUrl);
  
  const timeout = setTimeout(() => {
    checkWs.close();
    showError('errTimeout');
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
        // 验证通过，触发炫酷白屏转场动画
        try { localStorage.setItem('lastRoomKey', key); } catch(e) {}
        playEnterAnimation(key);
      } else {
        showError('errInvalid');
      }
    } catch (ex) {
      showError('errInvalid');
    }
  };

  checkWs.onerror = () => {
    clearTimeout(timeout);
    showError('errNet');
  };
}

function playEnterAnimation(key) {
  const card = document.getElementById('landingCard');
  const circle = document.getElementById('transitionCircle');
  const bg = document.getElementById('bgContainer');
  const overlay = document.getElementById('landingOverlay');
  const langSwitch = document.getElementById('langSwitch');
  
  if(card) card.classList.add('card-exit');
  if(langSwitch) langSwitch.style.opacity = '0';
  
  setTimeout(() => {
    if(circle) circle.classList.add('circle-expand');
    if(bg) bg.style.opacity = '0';
    
    // 屏幕全白时，切换底层并刷新页面带参数
    setTimeout(() => {
      overlay.style.display = 'none';
      window.location.href = window.location.pathname + '?key=' + encodeURIComponent(key);
    }, 400); 

  }, 400);
}

// 回车键在 HTML 中已绑定 onkeydown="if(event.key==='Enter') goRadarNew()"

const _urlKey = new URLSearchParams(window.location.search).get('key');
const _urlReplay = _isReplayUrl();
if (_urlKey || _urlReplay) {
  const overlay = document.getElementById('landingOverlay');
  const bg = document.getElementById('bgContainer');
  const langSwitch = document.getElementById('langSwitch');
  if (overlay) overlay.style.display = 'none';
  if (bg) bg.style.display = 'none';
  if (langSwitch) langSwitch.style.display = 'none';
} else {
  const bg = document.getElementById('bgContainer');
  const langSwitch = document.getElementById('langSwitch');
  if (bg) bg.style.display = 'block';
  if (langSwitch) langSwitch.style.display = 'flex';
  
  setLang('en');

  try {
    const saved = localStorage.getItem('lastRoomKey');
    if (saved) document.getElementById('landingKey').value = saved;
  } catch(e) {}
  setTimeout(() => {
    if(document.getElementById('landingKey')) document.getElementById('landingKey').focus();
  }, 100);
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
    let theme = location.pathname.startsWith('/_black/') ? 'black' :
                location.pathname.startsWith('/_white/') ? 'white' : 'white';
    if (theme === 'white' && !location.pathname.startsWith('/_white/')) {
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

// 保险: HTML 里的 onclick="goRadarNew()" 万一被旧缓存覆盖, 这里也兜底绑一次
(function bindLandingBtnFallback() {
  try {
    const btn = document.getElementById('landingBtn');
    const inp = document.getElementById('landingKey');
    if (btn && !btn._goRadarBound) {
      btn._goRadarBound = true;
      btn.addEventListener('click', function() {
        if (typeof goRadarNew === 'function') goRadarNew();
      });
    }
    if (inp && !inp._goRadarBound) {
      inp._goRadarBound = true;
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && typeof goRadarNew === 'function') goRadarNew();
      });
    }
  } catch (e) { console.warn('[Landing] bind fallback:', e); }
})();

(async function _loadLandingText() {
  try {
    const r = await fetch(RadarEndpoints.api('/api/theme_names'), { mode: 'cors', cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (!d.ok || !d.landing) return;
    const lt = d.landing['white'] || {};
    if (lt.zh) {
      if (lt.zh.title) i18n.zh.title = lt.zh.title;
      if (lt.zh.desc)  i18n.zh.desc  = lt.zh.desc;
      if (lt.zh.btn)   i18n.zh.btn   = lt.zh.btn;
      if (lt.zh.hint)  i18n.zh.hint  = lt.zh.hint;
    }
    if (lt.en) {
      if (lt.en.title) i18n.en.title = lt.en.title;
      if (lt.en.desc)  i18n.en.desc  = lt.en.desc;
      if (lt.en.btn)   i18n.en.btn   = lt.en.btn;
      if (lt.en.hint)  i18n.en.hint  = lt.en.hint;
    }
    setLang(currentLang);
  } catch (e) { /* silent */ }
})();
