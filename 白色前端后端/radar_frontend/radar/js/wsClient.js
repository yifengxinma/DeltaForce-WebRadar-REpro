// ============================================================
// WebSocket 客户端（自动重连）
// ============================================================
let ws = null;
let wsUrl = 'ws://localhost:12345';
let wsReconnectTimer = null;
let wsManualClose = false;
let _relayKey = ''; // 中继模式 key
let _isRelayMode = false;
let _wsRecvRate = 0;
let _wsRecvWindow = 0;
function _fmtRate(b) { return b>=1048576?(b/1048576).toFixed(1)+' MB/s':b>=1024?(b/1024).toFixed(1)+' KB/s':b+' B/s'; }
setInterval(() => {
  _wsRecvRate = _wsRecvWindow;
  _wsRecvWindow = 0;
  const el = document.getElementById('stSize');
  if (el) el.textContent = _fmtRate(_wsRecvRate);
}, 1000);

function setConn(ok, msg) {
  document.getElementById('connDot').className = 'conn-dot' + (ok ? ' ok' : ' err');
  document.getElementById('connText').textContent = msg || (ok ? '已连接' : '未连接');
  // 已连接且有数据源时隐藏地图切换tabs和相邻分隔线
  const isReceiving = ok && msg && msg.indexOf('人在线') >= 0;
  const tabs = document.getElementById('mapTabs');
  if (tabs) tabs.style.display = isReceiving ? 'none' : '';
  // 隐藏tabs两侧的分隔线
  document.querySelectorAll('.topbar-sep').forEach(sep => {
    sep.style.display = isReceiving ? 'none' : '';
  });
}

let _lastMapName = '';
const _entityJsonCache = {};


function handleEntityMessage(type, data) {
  if (!leafletMap) return;

  // 非游戏地图时：清空所有缓存，不渲染任何实体
  if (type === 'self' && data && data.map !== undefined) {
    const mapKey = resolveMapKey(data.map);
    if (!mapKey) {
      // 大厅/主菜单等非游戏地图 → 每次都清空，不写入缓存
      if (data.map !== _lastMapName) {
        _lastMapName = data.map;
      }
      _entityCache.players = []; _entityCache.items = [];
      _entityCache.containers = []; _entityCache.exits = [];
      _entityCache.boxes = []; _entityCache.self = null;
      clearEntityLayers();
      const ps = document.getElementById('panelStats');
      if (ps) ps.style.display = 'none';
      const sb = document.getElementById('spectateBar');
      if (sb) sb.classList.remove('show');
      const pc = document.getElementById('playerCounter');
      if (pc) pc.classList.remove('show');
      return; // 不写入缓存，不渲染
    }
    // 已知游戏地图 → 自动切换 + 显示统计面板
    if (!currentMapInfo || currentMapInfo.id !== mapKey) {
      const info = MAP_PREFIX_TABLE.find(m => m.key === mapKey);
      switchMap(mapKey);
      showToast('自动切换: ' + (info ? info.name : mapKey));
    }
    _lastMapName = data.map;
    const ps = document.getElementById('panelStats');
    if (ps) ps.style.display = '';
    const sb = document.getElementById('spectateBar');
    if (sb) sb.classList.add('show');
    const pc = document.getElementById('playerCounter');
    if (pc) pc.classList.add('show');
  }

  // 快速比较：数据无变化时跳过渲染（减少无意义重绘）
  const _newJson = JSON.stringify(data);
  if (_entityJsonCache[type] === _newJson) return; // 数据完全相同，跳过
  _entityJsonCache[type] = _newJson;
  _entityCache[type] = data;
  _updateLerpData();
  _scheduleCanvasRender();
}

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  wsManualClose = false;

  // 检查 URL 参数中的 key，有则使用中继模式
  const urlParams = new URLSearchParams(window.location.search);
  _relayKey = urlParams.get('key') || '';
  _isRelayMode = !!_relayKey;

  if (_isRelayMode) {
    // 中继模式: 直连 relay 服务器 (与前端同IP, 端口5000)
    wsUrl = `ws://${location.hostname}:5000`;
  } else {
    // 本地模式
    const host = (document.getElementById('cfgHost')||{}).value || 'localhost';
    const port = (document.getElementById('cfgPort')||{}).value || '12345';
    wsUrl = `ws://${host}:${port}`;
  }

  setConn(false, '连接中...');
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    if (_isRelayMode) {
      // 发送认证消息
      ws.send(JSON.stringify({ action: 'auth', role: 'sub', key: _relayKey }));
      setConn(true, '中继认证中...');
    } else {
      setConn(true, '已连接: ' + wsUrl);
    }
    clearTimeout(wsReconnectTimer);
    const btn = document.getElementById('btnPoll');
    if (btn) btn.textContent = '断开';
  };

  ws.binaryType = 'arraybuffer';
  async function _processWsMsg(rawData) {
    try {
      const _rawSize = (rawData instanceof ArrayBuffer) ? rawData.byteLength : (typeof rawData === 'string' ? rawData.length : 0);
      _wsRecvWindow += _rawSize;
      let jsonStr;
      if (rawData instanceof ArrayBuffer) {
        const data = new Uint8Array(rawData);
        const mode = (data[0] === 0x78) ? 'deflate' : 'deflate-raw';
        try {
          const ds = new DecompressionStream(mode);
          const writer = ds.writable.getWriter();
          writer.write(data); writer.close();
          const reader = ds.readable.getReader();
          const chunks = []; let total = 0;
          while (true) { const {value, done} = await reader.read(); if (done) break; chunks.push(value); total += value.byteLength; }
          const out = new Uint8Array(total); let off = 0;
          for (const c of chunks) { out.set(c, off); off += c.byteLength; }
          jsonStr = new TextDecoder().decode(out);
        } catch(e1) {
          try { jsonStr = new TextDecoder().decode(new Uint8Array(rawData)); }
          catch(e2) { console.error('[WS] decompress failed:', e1); return; }
        }
      } else {
        jsonStr = rawData;
      }
      const msg = JSON.parse(jsonStr);
      // 中继模式: 处理认证响应和状态消息
      if (msg.ok !== undefined) {
        // 认证响应
        if (msg.ok) {
          if (msg.pub) {
            setConn(true, `${msg.subs||1}人在线`);
          } else {
            // 无数据源 → 回到入口页，提示密钥无效
            wsManualClose = true;
            ws.close();
            setConn(false, '密钥无效');
            const overlay = document.getElementById('landingOverlay');
            if (overlay) overlay.classList.remove('hidden');
            const errEl = document.getElementById('landingError');
            if (errEl) { errEl.textContent = '当前密钥无效，数据源未连接'; errEl.style.display = ''; }
            return;
          }
        }
        else { console.error('[Relay] Auth failed:', msg.error); ws.close(); }
        return;
      }
      if (msg.type === 'subCount') {
        // 在线人数更新（收到 subCount 说明连接正常）
        setConn(true, `${msg.data||1}人在线`);
        return;
      }
      if (msg.type === 'status') {
        // 发布者断开通知 → 清空所有绘制内容
        if (msg.data && !msg.data.connected) {
          setConn(true, '等待数据源...');
          _entityCache.self = null;
          _entityCache.players = []; _entityCache.items = [];
          _entityCache.containers = []; _entityCache.exits = [];
          _entityCache.boxes = [];
          clearEntityLayers();
          _scheduleCanvasRender();
        }
        return;
      }
      // 本地模式: key 过滤；中继模式不需要（服务器已按 key 路由）
      if (!_isRelayMode) {
        const _cfgKey = (document.getElementById('cfgKey')||{}).value || '';
        if (_cfgKey && msg.key !== _cfgKey) return;
      }
      // relay 已做定速推送，直接处理
      if (msg.type) {
        handleEntityMessage(msg.type, msg.data);
      } else {
        if (msg.self)       _entityCache.self       = msg.self;
        if (msg.players)    _entityCache.players    = msg.players;
        if (msg.items)      _entityCache.items      = msg.items;
        if (msg.containers) _entityCache.containers = msg.containers;
        if (msg.exits)      _entityCache.exits      = msg.exits;
        if (msg.boxes)      _entityCache.boxes      = msg.boxes;
        _updateLerpData();
        _scheduleCanvasRender();
      }
    } catch(err) { console.error('[WS] parse error:', err.message); }
  }
  ws.onmessage = async (e) => {
    _processWsMsg(e.data);
  };

  ws.onclose = () => {
    setConn(false, '连接断开');
    const btn = document.getElementById('btnPoll');
    if (btn) btn.textContent = '断开';
    // 断开时清空绘制数据
    _entityCache.self = null;
    _entityCache.players = []; _entityCache.items = [];
    _entityCache.containers = []; _entityCache.exits = [];
    _entityCache.boxes = [];
    clearEntityLayers();
    _scheduleCanvasRender();
    if (!wsManualClose) {
      wsReconnectTimer = setTimeout(connectWs, 3000);
      document.getElementById('wsStatusText').textContent = '3秒后重连...';
    }
  };

  ws.onerror = () => setConn(false, '连接错误');
}

function disconnectWs() {
  wsManualClose = true;
  clearTimeout(wsReconnectTimer);
  if (ws) { ws.close(); ws = null; }
  setConn(false, '已手动断开');
  document.getElementById('btnPoll').textContent = '连接';
}

function applyWsCfg() {
  disconnectWs();
  wsManualClose = false;
  setTimeout(connectWs, 100);
  showToast('正在重连...');
}

// ── 后台标签页自动断开/重连（节省流量+避免数据堆积）──
let _visibilityDisconnected = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // 标签页切到后台 → 断开 WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      _visibilityDisconnected = true;
      wsManualClose = true;
      clearTimeout(wsReconnectTimer);
      ws.close();
      ws = null;
    }
  } else {
    // 标签页切回前台 → 自动重连
    if (_visibilityDisconnected) {
      _visibilityDisconnected = false;
      wsManualClose = false;
      setTimeout(connectWs, 300);
    }
  }
});
