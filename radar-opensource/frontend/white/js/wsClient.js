// ============================================================
// WebSocket 客户端（自动重连）
// ============================================================
let ws = null;
let wsUrl = RadarEndpoints.local();
let wsReconnectTimer = null;
let wsManualClose = false;
let _wsConnecting = false; // 互斥锁: await fetch 期间不让重复创建
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

function _hideLandingWait() {
  const overlay = document.getElementById('landingOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.classList.remove('translucent');
  }
  const errEl = document.getElementById('landingError');
  if (errEl) errEl.style.display = 'none';
}

// O(1) 数组指纹: 用 length + 首/中/尾元素的关键坐标和血量做 hash,
// 比 JSON.stringify 全量(可能几十 KB)便宜 100×。对游戏实体足够稳定。
function _fingerprint(data) {
  if (!Array.isArray(data)) {
    // 非数组直接 stringify (size 小)
    try { return JSON.stringify(data); } catch (e) { return String(data); }
  }
  const n = data.length;
  if (n === 0) return '0';
  const f = data[0] || {};
  const m = data[(n >> 1)] || {};
  const l = data[n - 1] || {};
  // 关键字段: x/y/h(玩家血量) 或 v/q(物品价值/品质) 或 z(z 坐标)
  const sig = (e) => ((e.x|0) + ',' + (e.y|0) + ',' + (e.h|0) + ',' + (e.v|0) + ',' + (e.q|0));
  return n + '|' + sig(f) + '|' + sig(m) + '|' + sig(l);
}

// 切图 / 回大厅：清掉实体缓存、插值、指纹和画布，避免残留绘制
function _wipeRadarDrawings() {
  _entityCache.self = null;
  _entityCache.players = [];
  _entityCache.bots = [];
  _entityCache.items = [];
  _entityCache.containers = [];
  _entityCache.exits = [];
  _entityCache.boxes = [];
  _entityCache.doors = [];
  for (const k in _entityJsonCache) delete _entityJsonCache[k];
  if (typeof _lerpCache !== 'undefined') {
    _lerpCache.clear();
    _lerpSelfCache = null;
  }
  clearEntityLayers();
  if (typeof _scheduleCanvasRender === 'function') _scheduleCanvasRender();
}

function _setMatchHud(inMatch) {
  const ps = document.getElementById('panelStats');
  if (ps) ps.style.display = inMatch ? '' : 'none';
  const sb = document.getElementById('spectateBar');
  if (sb) sb.classList.toggle('show', !!inMatch);
  const pc = document.getElementById('playerCounter');
  if (pc) pc.classList.toggle('show', !!inMatch);
}

function handleEntityMessage(type, data) {
  if (!leafletMap) return;

  // 非游戏地图时：清空所有缓存，不渲染任何实体
  if (type === 'self' && data && data.map !== undefined) {
    const mapKey = resolveMapKey(data.map);
    if (!mapKey) {
      _lastMapName = data.map || '';
      _wipeRadarDrawings();
      _setMatchHud(false);
      return;
    }
    if (_lastMapName && data.map !== _lastMapName) {
      _wipeRadarDrawings();
    }
    tryAutoSwitchMap(data.map);
    _lastMapName = data.map;
    _setMatchHud(true);
  }

  // 仅静态实体用指纹跳过重绘（items/containers 等）
  // players/bots/self 每帧必更新——首/中/尾指纹会漏检中段移动，造成人机「坐标变了网页不动」
  if (type !== 'self' && type !== 'players' && type !== 'bots') {
    const _newFp = _fingerprint(data);
    if (_entityJsonCache[type] === _newFp) return;
    _entityJsonCache[type] = _newFp;
  }
  _entityCache[type] = data;
  // bots/items 等不测间隔；只有 players 驱动插值时钟
  if (type === 'self' || type === 'players') _updateLerpData(type);
  _scheduleCanvasRender();
}

async function _processWsMsg(rawData) {
  try {
    if (!_replayMode && ws && ws.readyState === WebSocket.OPEN) {
      const _ct = document.getElementById('connText');
      const _txt = (_ct && _ct.textContent) || '';
      if (/断开|错误|连接中\.\.\.|手动断开|等待数据源/.test(_txt)) {
        setConn(true, '已连接 (1人在线)');
      }
    }
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
    if (msg.ok !== undefined) {
      if (msg.ok) {
        if (msg.pub) {
          setConn(true, `${msg.subs||1}人在线`);
          _hideLandingWait();
        } else {
          const _isPreview = new URLSearchParams(location.search).get('preview') === '1';
          if (_isPreview) {
            wsManualClose = true;
            if (ws) ws.close();
            setConn(false, '预览模式: 房间无数据 (主端未启动 EXE)');
            return;
          }
          // 房间有效但 EXE 未上线：勿设 wsManualClose，关掉后由 onclose 每 2 秒重连
          setConn(true, '等待数据源... (保留上次画面)');
          const overlay = document.getElementById('landingOverlay');
          if (overlay) {
            overlay.classList.remove('hidden');
            overlay.classList.add('translucent');
          }
          const errEl = document.getElementById('landingError');
          if (errEl) { errEl.textContent = '当前房间无数据源 (主端未启动 EXE)，2秒后自动重试…'; errEl.style.display = ''; }
          if (ws) { try { ws.close(); } catch (e) {} }
          return;
        }
      }
      else { console.error('[Relay] Auth failed:', msg.error); if (ws) ws.close(); }
      return;
    }
    if (msg.type === 'subCount') {
      setConn(true, `${msg.data||1}人在线`);
      return;
    }
    if (msg.type === 'status') {
      if (msg.data) {
        if (msg.data.connected) {
          setConn(true, '已连接 (1人在线)');
          _hideLandingWait();
        } else {
          // EXE 掉线但观看 WS 仍在；后端 pub 重连后会推 connected:true，无需刷新
          setConn(true, '等待数据源... (保留上次画面)');
          for (const k in _entityJsonCache) delete _entityJsonCache[k];
        }
      }
      return;
    }
    if (!_isRelayMode && !_replayMode) {
      const _cfgKey = (document.getElementById('cfgKey')||{}).value || '';
      if (_cfgKey && msg.key !== _cfgKey) return;
    }
    if (msg.type) {
      if (msg.type === 'mapName') {
        const name = msg.data || '';
        const key = resolveMapKey(name);
        if (name !== _lastMapName) {
          _wipeRadarDrawings();
          _lastMapName = name;
        }
        if (key) {
          tryAutoSwitchMap(name);
          _setMatchHud(true);
        } else {
          _setMatchHud(false);
        }
        return;
      }
      handleEntityMessage(msg.type, msg.data);
    } else {
      if (msg.self && msg.self.map !== undefined && !resolveMapKey(msg.self.map)) {
        _lastMapName = msg.self.map || '';
        _wipeRadarDrawings();
        _setMatchHud(false);
        return;
      }
      if (msg.self) {
        if (_lastMapName && msg.self.map && msg.self.map !== _lastMapName) {
          _wipeRadarDrawings();
        }
        if (msg.self.map) {
          tryAutoSwitchMap(msg.self.map);
          _lastMapName = msg.self.map;
          _setMatchHud(true);
        }
        _entityCache.self = msg.self;
      }
      if (msg.players)    _entityCache.players    = msg.players;
      if (msg.bots)       _entityCache.bots       = msg.bots;
      if (msg.items)      _entityCache.items      = msg.items;
      if (msg.containers) _entityCache.containers = msg.containers;
      if (msg.exits)      _entityCache.exits      = msg.exits;
      if (msg.boxes)      _entityCache.boxes      = msg.boxes;
      if (msg.doors)      _entityCache.doors      = msg.doors;
      _updateLerpData('players');
      _scheduleCanvasRender();
    }
  } catch(err) { console.error('[WS] parse error:', err.message); }
}

async function connectWs() {
  if (_wsConnecting) return; // await fetch 期间被反复触发会重复 new WebSocket, 锁住
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  _wsConnecting = true;
  try {
  wsManualClose = false;

  // 检查 URL 参数中的 key，有则使用中继模式
  const urlParams = new URLSearchParams(window.location.search);
  _relayKey = urlParams.get('key') || '';
  _isRelayMode = !!_relayKey;

  // 预览模式 (?preview=1) 先查后端开关, 关闭就不连 WS (省带宽)
  const _isPreview = urlParams.get('preview') === '1';
  if (_isPreview) {
    try {
      const r = await fetch(RadarEndpoints.api('/api/preview_status'), { mode: 'cors' });
      const j = await r.json();
      if (!j.enabled) {
        setConn(false, '预览已关闭 (请联系管理员启动)');
        if (typeof showPreviewDisabledNotice === 'function') showPreviewDisabledNotice();
        else {
          const div = document.createElement('div');
          div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:24px 32px;background:rgba(20,20,30,0.95);color:#fff;border-radius:12px;z-index:10000;max-width:400px;text-align:center;font-size:14px;line-height:1.7;border:1px solid rgba(255,255,255,0.1);box-shadow:0 16px 64px rgba(0,0,0,0.5)';
          div.innerHTML = '<b style="font-size:18px;color:#FF453A">预览功能已关闭</b><br><br>管理员未启动预览模式<br>请联系管理员在后台启动「预览」开关<br><br><small style="color:#888">(此状态下不连接 WS, 节省带宽)</small>';
          document.body.appendChild(div);
        }
        return;
      }
    } catch (e) {
      console.error('[Preview] 查询状态失败, 跳过检查继续连接:', e);
    }
  }

  if (_isRelayMode) {
    // 中继模式：使用前端部署配置中的 WebSocket 地址
    wsUrl = RadarEndpoints.relay();
  } else {
    // 本地模式
    const host = (document.getElementById('cfgHost')||{}).value || '';
    const port = (document.getElementById('cfgPort')||{}).value || '';
    wsUrl = RadarEndpoints.local(host, port);
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
  // 有序队列：binary 解压是 async，并行 onmessage 会乱序并把 _wsInterval 测成几 ms
  ws._msgQ = [];
  ws._msgBusy = false;
  const _drainWs = async () => {
    if (ws._msgBusy) return;
    ws._msgBusy = true;
    try {
      while (ws._msgQ.length) {
        await _processWsMsg(ws._msgQ.shift());
      }
    } finally {
      ws._msgBusy = false;
      if (ws._msgQ.length) _drainWs();
    }
  };
  ws.onmessage = (e) => {
    ws._msgQ.push(e.data);
    _drainWs();
  };

  ws.onclose = () => {
    setConn(false, _isRelayMode ? '等待数据源... (保留上次画面)' : '连接断开 (保留上次画面)');
    const btn = document.getElementById('btnPoll');
    if (btn) btn.textContent = '断开';
    // 不清 _entityCache - 重连后旧画面保留显示，等新数据自动覆盖
    //   (静态实体 EXE 那边 1.5s 推一次，立刻清会有 1.5s 空窗)
    //   地图切换由 handleEntityMessage 检测 mapKey 变化自动清空
    // 但清 JSON cache: 确保重连后相同数据也触发一次完整渲染
    for (const k in _entityJsonCache) delete _entityJsonCache[k];
    if (!wsManualClose) {
      // 房间号模式 2 秒重连；本地模式也统一 2 秒
      wsReconnectTimer = setTimeout(connectWs, 2000);
      const sb = document.getElementById('wsStatusText');
      if (sb) sb.textContent = '2秒后重连...';
    }
  };

  ws.onerror = () => setConn(false, '连接错误');
  } finally { _wsConnecting = false; }
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

// ══════════════════════════════════════════════════════════
// 回放模式 (Replay Player)
// ══════════════════════════════════════════════════════════
let _replayMode = false;
let _replayData = null;
let _replayIdx = 0;
let _replayPlaying = false;
let _replayTimer = null;
let _replaySpeed = 1;
let _replayDuration = 0;

function _isReplayUrl() {
  const p = new URLSearchParams(window.location.search);
  return !!(p.get('replay') || p.get('share'));
}

function _fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function _showLoadingOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'rpLoadOverlay';
  overlay.innerHTML = `
    <div style="background:var(--panel,#fff);border:1px solid var(--border,#ddd);border-radius:12px;padding:24px 32px;min-width:320px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.15)">
      <div style="font-size:15px;color:var(--t1,#222);margin-bottom:14px">加载回放数据...</div>
      <div style="background:var(--border,#ddd);border-radius:6px;height:10px;overflow:hidden;margin-bottom:10px">
        <div id="rpLoadFill" style="height:100%;background:var(--accent,#4a9eff);border-radius:6px;width:0%;transition:width .2s"></div>
      </div>
      <div id="rpLoadText" style="font-size:12px;color:var(--t2,#888);font-variant-numeric:tabular-nums">0 B / ???</div>
    </div>`;
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.3);backdrop-filter:blur(4px)';
  document.body.appendChild(overlay);
  return {
    update(loaded, total) {
      const fill = document.getElementById('rpLoadFill');
      const text = document.getElementById('rpLoadText');
      if (total > 0 && fill) fill.style.width = Math.min(100, loaded / total * 100) + '%';
      if (text) text.textContent = _fmtBytes(loaded) + ' / ' + (total > 0 ? _fmtBytes(total) : '???');
    },
    remove() { overlay.remove(); }
  };
}

async function _initReplay() {
  _replayMode = true;
  const p = new URLSearchParams(window.location.search);
  const replayId = p.get('replay');
  const shareToken = p.get('share');

  setConn(false, '加载回放数据...');
  document.getElementById('landingOverlay')?.classList.add('hidden');

  const loader = _showLoadingOverlay();

  try {
    // 同域优先（nginx 反代 /api/share/）
    const adminBase = RadarEndpoints.api('');
    let url;
    const headers = {};
    if (shareToken) {
      url = adminBase + '/api/share/' + encodeURIComponent(shareToken);
    } else {
      url = RadarEndpoints.api('/api/recording/') + encodeURIComponent(replayId);
      const t = localStorage.getItem('admin_token');
      if (t && new URL(url, location.href).origin === location.origin) headers['Authorization'] = 'Bearer ' + t;
    }

    const res = await fetch(url, { headers, mode: 'cors' });
    const total = parseInt(res.headers.get('content-length') || '0', 10);
    let loaded = 0;
    let bodyText = '';

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        chunks.push(decoder.decode(value, { stream: true }));
        loader.update(loaded, total);
      }
      bodyText = chunks.join('');
      if (!total) loader.update(loaded, loaded);
    } else {
      bodyText = await res.text();
      loader.update(bodyText.length, bodyText.length);
    }

    let data = JSON.parse(bodyText);
    
    if (data.ok && data.externalUrl) {
      loader.update(0, 0);
      setConn(false, '从外链加载回放数据...');
      const extRes = await fetch(data.externalUrl, { mode: 'cors' });
      const extTotal = parseInt(extRes.headers.get('content-length') || '0', 10);
      let extLoaded = 0;
      let extBody = '';
      if (extRes.body && typeof extRes.body.getReader === 'function') {
        const reader = extRes.body.getReader();
        const decoder = new TextDecoder();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          extLoaded += value.byteLength;
          chunks.push(decoder.decode(value, { stream: true }));
          loader.update(extLoaded, extTotal);
        }
        extBody = chunks.join('');
      } else {
        extBody = await extRes.text();
      }
      data = { ok: true, recording: JSON.parse(extBody) };
    }

    loader.remove();

    if (!data.ok || !data.recording || !data.recording.messages) {
      setConn(false, '回放数据不存在或已过期');
      return;
    }
    _replayData = data.recording;
    _replayDuration = _replayData.metadata?.duration || (_replayData.messages.length > 0 ? _replayData.messages[_replayData.messages.length - 1].timestamp : 0);

    setConn(true, '回放就绪 · ' + (_replayData.messages.length) + ' 条消息');
    _buildReplayUI();
    _startReplay();
  } catch (e) {
    loader.remove();
    setConn(false, '加载回放失败: ' + e.message);
  }
}

function _buildReplayUI() {
  const tabs = document.getElementById('mapTabs');
  if (tabs) tabs.style.display = 'none';
  document.querySelectorAll('.topbar-sep').forEach(sep => { sep.style.display = 'none'; });

  const _rpBarH = 50;
  const style = document.createElement('style');
  style.textContent = `
    #rpWrap{position:fixed;bottom:0;left:0;right:0;z-index:9999;transition:transform .3s ease}
    #rpWrap.collapsed{transform:translateY(100%)}
    #rpToggle{position:absolute;top:-30px;right:16px;background:var(--panel,#fff);border:1px solid var(--border,#ddd);border-bottom:none;border-radius:6px 6px 0 0;padding:3px 12px;cursor:pointer;color:var(--t2,#888);font-size:12px;z-index:10000;user-select:none}
    #rpToggle:hover{color:var(--t1,#222)}
    #replayBar{background:var(--panel,#fff);border-top:1px solid var(--border,#ddd);padding:8px 16px;display:flex;align-items:center;gap:10px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
    #rpProgress{flex:1;height:12px;background:var(--border,#ddd);border-radius:6px;cursor:pointer;position:relative;overflow:visible;min-width:80px}
    #rpFill{height:100%;background:var(--accent,#4a9eff);border-radius:6px;width:0%;transition:width 0.1s linear;position:relative}
    #rpFill::after{content:'';position:absolute;right:-7px;top:50%;transform:translateY(-50%);width:14px;height:14px;background:#fff;border:2px solid var(--accent,#4a9eff);border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,0.15);transition:transform .15s}
    #rpProgress:hover #rpFill::after{transform:translateY(-50%) scale(1.3)}
    #rpProgress.dragging #rpFill{transition:none}
    #rpSpeed{background:var(--bg,#f5f5f5);border:1px solid var(--border,#ddd);border-radius:6px;color:var(--t1,#222);padding:4px 4px;font-size:12px;cursor:pointer;width:52px;flex-shrink:0;text-align:center;-webkit-appearance:none;appearance:none}
    body.rp-bar-open .team-float{bottom:${_rpBarH + 14}px !important;transition:bottom .3s ease}
    body.rp-bar-open .ann-fab{bottom:${_rpBarH + 20}px !important;transition:bottom .3s ease}
    body.rp-bar-open #toast{bottom:${_rpBarH + 20}px !important;transition:bottom .3s ease}
    body.rp-bar-open .spectate-bar{bottom:${_rpBarH + 20}px !important;transition:bottom .3s ease}
  `;
  document.head.appendChild(style);
  document.body.classList.add('rp-bar-open');

  const wrap = document.createElement('div');
  wrap.id = 'rpWrap';
  wrap.innerHTML = `
    <button id="rpToggle">▼ 收起</button>
    <div id="replayBar">
      <button id="rpPlayBtn" style="background:var(--accent,#4a9eff);color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:16px;cursor:pointer;font-weight:600;min-width:40px;flex-shrink:0">⏸</button>
      <div id="rpProgress"><div id="rpFill"></div></div>
      <span id="rpTime" style="font-size:12px;color:var(--t2,#888);min-width:90px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0;white-space:nowrap">00:00 / 00:00</span>
      <select id="rpSpeed">
        <option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option><option value="4">4x</option><option value="8">8x</option>
      </select>
    </div>`;
  document.body.appendChild(wrap);

  document.getElementById('rpPlayBtn').onclick = _toggleReplay;
  document.getElementById('rpSpeed').onchange = function() { _replaySpeed = parseFloat(this.value) || 1; };

  const toggleBtn = document.getElementById('rpToggle');
  toggleBtn.onclick = function(e) {
    e.stopPropagation();
    const w = document.getElementById('rpWrap');
    w.classList.toggle('collapsed');
    const collapsed = w.classList.contains('collapsed');
    this.textContent = collapsed ? '▲ 展开' : '▼ 收起';
    document.body.classList.toggle('rp-bar-open', !collapsed);
  };

  const prog = document.getElementById('rpProgress');
  let dragging = false;
  function seekFromEvent(e) {
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const rect = prog.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
    _seekReplay(ratio);
  }
  prog.addEventListener('mousedown', function(e) { dragging = true; prog.classList.add('dragging'); seekFromEvent(e); e.preventDefault(); });
  document.addEventListener('mousemove', function(e) { if (dragging) seekFromEvent(e); });
  document.addEventListener('mouseup', function() { if (dragging) { dragging = false; prog.classList.remove('dragging'); } });
  prog.addEventListener('touchstart', function(e) { dragging = true; prog.classList.add('dragging'); seekFromEvent(e); e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', function(e) { if (dragging) seekFromEvent(e); });
  document.addEventListener('touchend', function() { if (dragging) { dragging = false; prog.classList.remove('dragging'); } });

  _updateReplayTime(0);
}

function _fmtReplayTime(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function _updateReplayTime(currentTs) {
  const el = document.getElementById('rpTime');
  if (el) el.textContent = _fmtReplayTime(currentTs) + ' / ' + _fmtReplayTime(_replayDuration);
  const fill = document.getElementById('rpFill');
  if (fill && _replayDuration > 0) fill.style.width = Math.min(100, currentTs / _replayDuration * 100) + '%';
}

function _startReplay() {
  _replayPlaying = true;
  _replayIdx = 0;
  const btn = document.getElementById('rpPlayBtn');
  if (btn) btn.textContent = '⏸';
  _scheduleReplayNext();
}

function _toggleReplay() {
  if (_replayPlaying) {
    _replayPlaying = false;
    if (_replayTimer) { clearTimeout(_replayTimer); _replayTimer = null; }
    const btn = document.getElementById('rpPlayBtn');
    if (btn) btn.textContent = '▶';
  } else {
    if (_replayIdx >= _replayData.messages.length) {
      _replayIdx = 0;
      for (const k in _entityJsonCache) delete _entityJsonCache[k];
    }
    _replayPlaying = true;
    const btn = document.getElementById('rpPlayBtn');
    if (btn) btn.textContent = '⏸';
    _scheduleReplayNext();
  }
}

function _scheduleReplayNext() {
  if (!_replayPlaying || !_replayData || _replayIdx >= _replayData.messages.length) {
    if (_replayIdx >= (_replayData?.messages?.length || 0)) {
      _replayPlaying = false;
      const btn = document.getElementById('rpPlayBtn');
      if (btn) btn.textContent = '↻';
      setConn(true, '回放结束');
    }
    return;
  }
  const msg = _replayData.messages[_replayIdx];
  const prevTs = _replayIdx > 0 ? _replayData.messages[_replayIdx - 1].timestamp : 0;
  const delay = Math.max(0, (msg.timestamp - prevTs) / _replaySpeed);
  const cappedDelay = Math.min(delay, 2000 / _replaySpeed);

  _replayTimer = setTimeout(() => {
    _processReplayMsg(msg);
    _replayIdx++;
    _updateReplayTime(msg.timestamp);
    setConn(true, '回放中 · ' + _fmtReplayTime(msg.timestamp));
    _scheduleReplayNext();
  }, cappedDelay);
}

function _processReplayMsg(msg) {
  if (msg.type === 'binary' && msg.data) {
    const binaryStr = atob(msg.data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    _processWsMsg(bytes.buffer);
  } else if (msg.type === 'text' && msg.data) {
    _processWsMsg(msg.data);
  }
}

function _seekReplay(ratio) {
  if (!_replayData || !_replayData.messages.length) return;
  const targetTs = _replayDuration * ratio;
  let idx = 0;
  for (let i = 0; i < _replayData.messages.length; i++) {
    if (_replayData.messages[i].timestamp <= targetTs) idx = i;
    else break;
  }
  for (const k in _entityJsonCache) delete _entityJsonCache[k];
  _entityCache.players = []; _entityCache.bots = []; _entityCache.items = [];
  _entityCache.containers = []; _entityCache.exits = [];
  _entityCache.boxes = []; _entityCache.doors = []; _entityCache.self = null;

  const seedStart = Math.max(0, idx - 200);
  for (let i = seedStart; i <= idx; i++) {
    _processReplayMsg(_replayData.messages[i]);
  }
  _replayIdx = idx + 1;
  _updateReplayTime(targetTs);
  if (_replayPlaying) {
    clearTimeout(_replayTimer);
    _scheduleReplayNext();
  }
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
