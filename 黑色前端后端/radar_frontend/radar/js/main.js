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
  const checkUrl = `ws://${location.hostname}:5000`;
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
if (_urlKey) {
  // 有 key → 隐藏入口页，显示地图
  document.getElementById('landingOverlay').classList.add('hidden');
} else {
  // 无 key → 自动填充上次房间号
  try {
    const saved = localStorage.getItem('lastRoomKey');
    if (saved) document.getElementById('landingKey').value = saved;
  } catch(e) {}
  document.getElementById('landingKey').focus();
}

currentMapInfo = MAPS[0];
initLeaflet(MAPS[0]);
if (_urlKey) connectWs();
