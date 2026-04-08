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
  const checkUrl = `ws://${location.hostname}:5000`;
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
if (_urlKey) {
  // 有 key → 隐藏入口页和背景，显示地图
  const overlay = document.getElementById('landingOverlay');
  const bg = document.getElementById('bgContainer');
  const langSwitch = document.getElementById('langSwitch');
  if (overlay) overlay.style.display = 'none';
  if (bg) bg.style.display = 'none';
  if (langSwitch) langSwitch.style.display = 'none';
} else {
  // 无 key → 显示背景和入口页，初始化语言，自动填充上次房间号
  const bg = document.getElementById('bgContainer');
  const langSwitch = document.getElementById('langSwitch');
  if (bg) bg.style.display = 'block';
  if (langSwitch) langSwitch.style.display = 'flex';
  
  // 默认英文
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
if (_urlKey) connectWs();
