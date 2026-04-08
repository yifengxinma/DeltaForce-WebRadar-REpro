// ============================================================
// UI 交互逻辑
// ============================================================

// 游戏实体图层状态
const layerState = { self:true, enemy:true, team:true, ai:false, box:true, container:true, item:true, exit:true };
// 敌方信息控制（初始化不显示名字）
const enemyInfo = { name: false, hero: true, weapon: true, helmet: true, armor: true };

// 全屏尺寸刷新
function _fsResize() {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  if (fs) {
    // 检测是否横屏（用多种方式，防止某些浏览器不支持）
    const isLand = (screen.orientation && screen.orientation.type.indexOf('landscape') >= 0)
      || (window.orientation !== undefined && Math.abs(window.orientation) === 90)
      || (window.matchMedia && window.matchMedia('(orientation: landscape)').matches);
    // screen.width/height 是屏幕物理尺寸，根据方向选择宽高
    const sw = screen.width || 0, sh = screen.height || 0;
    const w = isLand ? Math.max(sw, sh) : Math.min(sw, sh);
    const h = isLand ? Math.min(sw, sh) : Math.max(sw, sh);
    const css = 'width:'+w+'px!important;height:'+h+'px!important;overflow:hidden!important;margin:0!important;padding:0!important';
    document.documentElement.style.cssText = css;
    document.body.style.cssText = css;
    mapEl.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:'+w+'px!important;height:'+h+'px!important;z-index:0';
  } else {
    document.documentElement.style.cssText = '';
    document.body.style.cssText = '';
    mapEl.style.cssText = '';
  }
  if (typeof leafletMap !== 'undefined' && leafletMap) leafletMap.invalidateSize();
}

// 全屏切换
function toggleFullscreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
    if (req) {
      try { req.call(el); } catch(e) {}
      try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(()=>{}); } catch(e) {}
    }
  } else {
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch(e) {}
    (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || (()=>{})).call(document);
  }
}
function _onFsChange() {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const btn = document.getElementById('btnFullscreen');
  if (btn) { btn.textContent = fs ? '✕' : '⛶'; btn.classList.toggle('active', !!fs); }
  // 多次刷新，覆盖 iPad 延迟
  _fsResize();
  setTimeout(_fsResize, 100);
  setTimeout(_fsResize, 300);
  setTimeout(_fsResize, 600);
  setTimeout(_fsResize, 1200);
}
document.addEventListener('fullscreenchange', _onFsChange);
document.addEventListener('webkitfullscreenchange', _onFsChange);
// iPad 方向变化时也刷新
window.addEventListener('orientationchange', () => { setTimeout(_fsResize, 200); setTimeout(_fsResize, 600); });
window.addEventListener('resize', () => { if (document.fullscreenElement || document.webkitFullscreenElement) _fsResize(); });

// 侧边栏折叠
function toggleSidebar() {
  const sb = document.querySelector('.sidebar');
  const btn = document.getElementById('sidebarToggle');
  const collapsed = sb.classList.toggle('collapsed');
  btn.classList.toggle('collapsed', collapsed);
  btn.textContent = collapsed ? '›' : '‹';
  // 收缩时显示浮动统计面板
  const fs = document.getElementById('floatStats');
  if (fs) fs.classList.toggle('show', collapsed);
}

// 标记大小滑块
function setMarkerScale(val) {
  document.getElementById('scaleVal').textContent = parseFloat(val).toFixed(1);
  _markerScale = parseFloat(val) || 1.3;
  _scheduleCanvasRender();
}
function setItemScale(val) {
  document.getElementById('itemScaleVal').textContent = parseFloat(val).toFixed(1);
  _itemScale = parseFloat(val) || 1.0;
  _scheduleCanvasRender();
}
function setContainerScale(val) {
  document.getElementById('containerScaleVal').textContent = parseFloat(val).toFixed(1);
  _containerScale = parseFloat(val) || 1.0;
  _scheduleCanvasRender();
}

// (隐藏了UI，默认不显示名字)

// 盒子筛选 (隐藏了UI，默认只显示玩家盒子)
let _showPlayerBox = true, _showAIBox = false;

document.addEventListener('click', e => {
  // 原有的弹出逻辑删除
});

// 物品价值筛选
let _itemValueFilter = 0;
function _fmtVal(v) { return v >= 10000 ? (v/10000)+'W' : v >= 1000 ? (v/1000)+'K' : String(v); }
function setItemValueFilter(val) {
  _itemValueFilter = Math.max(0, Math.min(60000, parseInt(val) || 0));
  document.getElementById('itemValDisp').value = _fmtVal(_itemValueFilter);
  _scheduleCanvasRender();
}
function onItemValInput(raw) {
  let v = raw.trim().toUpperCase();
  if (v.endsWith('W')) v = parseFloat(v) * 10000;
  else if (v.endsWith('K')) v = parseFloat(v) * 1000;
  else v = parseInt(v) || 0;
  v = Math.max(0, Math.min(60000, Math.round(v / 1000) * 1000));
  _itemValueFilter = v;
  document.getElementById('itemValueFilter').value = v;
  document.getElementById('itemValDisp').value = _fmtVal(v);
  _scheduleCanvasRender();
}

// 图层开关
function toggleLayer(key) {
  layerState[key] = !layerState[key];
  document.getElementById('ltog-' + key).classList.toggle('on', layerState[key]);
  if (!leafletMap) return;
  _scheduleCanvasRender(); // Canvas模式：切换图层只需重绘
}

// 观战视角
let _spectateRef = { x: 0, y: 0, z: 0 };
let _spectateTarget = 'self'; // 'self' 或玩家名
let _followMode = false;
let _followPaused = false;
let _followResumeTimer = null;
function _doFollowPan() {
  if (_followMode && !_followPaused && leafletMap && currentMapInfo && !leafletMap._zooming) {
    const refPos = toMapCoord(_spectateRef.x, _spectateRef.y, currentMapInfo);
    leafletMap.panTo(refPos, { animate: false });
  }
}

function _followWheelHandler(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!leafletMap || !currentMapInfo) return;
  const delta = e.deltaY < 0 ? 0.5 : -0.5;
  const cur = leafletMap.getZoom();
  const nz = Math.max(leafletMap.getMinZoom(), Math.min(leafletMap.getMaxZoom(), cur + delta));
  if (nz === cur) return;
  const refPos = toMapCoord(_spectateRef.x, _spectateRef.y, currentMapInfo);
  leafletMap.setView(refPos, nz, { animate: true, duration: 0.15 });
}

function toggleFollow() {
  _followMode = !_followMode;
  _followPaused = false;
  clearTimeout(_followResumeTimer);
  const fb = document.getElementById('btnFollow');
  fb.textContent = '跟随: ' + (_followMode ? '开' : '关');
  fb.classList.toggle('btn-accent', _followMode);
  const mapEl = leafletMap && leafletMap.getContainer();
  if (_followMode) {
    if (leafletMap) {
      leafletMap.setMaxBounds(null);
      leafletMap.scrollWheelZoom.disable();
      mapEl.addEventListener('wheel', _followWheelHandler, { passive: false });
    }
    _doFollowPan();
  } else {
    if (leafletMap) {
      mapEl.removeEventListener('wheel', _followWheelHandler);
      leafletMap.scrollWheelZoom.enable();
      if (currentMapInfo) leafletMap.setMaxBounds(buildBounds(currentMapInfo));
    }
  }
  _updateSpectateFloat();
}

// 浮动队伍面板：跟随模式开启时在左下角显示游戏风格的队友卡片
function _updateSpectateFloat() {
  const panel = document.getElementById('spectateFloat');
  const list = document.getElementById('sfBtnList');
  if (!panel || !list) return;
  if (!_followMode) { panel.classList.remove('show'); return; }
  panel.classList.add('show');
  const data = _entityCache;
  const selfName = (data.self && data.self.n && data.self.n !== 'DefaultName') ? data.self.n : '自身';
  const teammates = (data.players||[]).filter(p => p.tm && p.n && p.n !== 'DefaultName');
  // 自身卡片
  let html = _buildTeamCard('self', selfName, 100, 100, 0, 0);
  // 队友卡片
  teammates.forEach(p => {
    html += _buildTeamCard(p.n, p.n, p.h||0, p.mh||100, p.hl||0, p.ar||0);
  });
  list.innerHTML = html;
}
// SVG内联图标（复用Canvas绘制的同款路径）
const _hlSvgPath = 'M972.59 293.94c-50.06-101.43-135.34-172.26-253.61-210.6-171.63-55.86-295.94-11.55-369.95 35.5a499.26 499.26 0 0 0-152.75 157.87c-8.42 14.56-20.08 35.27-31.06 59.5h-34.42c-58.88 0-72.7 28.33-76.12 41.07L22.09 470.24a38.8 38.8 0 0 0 3.58 33.05 35.78 35.78 0 0 0 27.65 16.84l27.19 2.67c-3.98 9.67-7.79 18.89-11.21 27.53-33.62 84.76-66.62 199.11-68.04 203.83a29.3 29.3 0 0 0 15.13 34.25 28.05 28.05 0 0 0 35.5-9.61 44.03 44.03 0 0 1 48.66-12.29 3318.67 3318.67 0 0 1 368.36 123.16 220.96 220.96 0 0 0 88.06 20.48 122.14 122.14 0 0 0 112.53-71.62c8.42-17.52 15.76-35.56 22.07-53.99a276.25 276.25 0 0 0 280.23 16.44 30.04 30.04 0 0 0 15.02-17.07c4.38-12.29 90.28-279.15-14.22-489.98zM406.66 534.13a1179.48 1179.48 0 0 0-243.43-59.96l-29.24-4.32-29.24-3.87-20.02-2.1 23.61-67.3a55.92 55.92 0 0 1 22.64-3.3h37.83c11.04 0 20.02 1.48 30.26 2.5 83.46 8.42 177.32 31.18 221.58 61.55l8.42 5.97-22.41 70.83z';
const _arSvgPath = 'M57.6 480V128c128-38.4 268.8-83.2 460.8-128 192 44.8 332.8 89.6 460.8 134.4v352c0 313.6-256 486.4-454.4 537.6C313.6 966.4 57.6 793.6 57.6 480z';
function _svgIco(path, color, sz) {
  return `<svg width="${sz}" height="${sz}" viewBox="0 0 1024 1024" style="vertical-align:middle"><path d="${path}" fill="${color}"/></svg>`;
}
function _tcLvColor(lv) { return lv>=6?'#FF0000':lv==5?'#FFFF00':lv==4?'#9400D3':lv==3?'#00BFFF':lv==2?'#00FF00':lv==1?'#FFFFFF':'#808080'; }
function _buildTeamCard(id, name, hp, maxHp, helmet, armor) {
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, (hp/maxHp)*100)) : 0;
  const barCol = pct > 60 ? '#3fb950' : pct > 25 ? '#f0883e' : '#f85149';
  const isActive = (id === 'self' && _spectateTarget === 'self') || _spectateTarget === id;
  const esc = id.replace(/'/g, "\\'");
  const hlIco = helmet > 0 ? `<span>${_svgIco(_hlSvgPath, _tcLvColor(helmet), 12)}${helmet}</span>` : '';
  const arIco = armor > 0 ? `<span>${_svgIco(_arSvgPath, _tcLvColor(armor), 12)}${armor}</span>` : '';
  return `<div class="team-card${isActive?' active':''}" onclick="_sfSelect('${esc}')">` +
    `<div class="tc-top"><span class="tc-name">${name}</span><div class="tc-gear">${hlIco}${arIco}</div></div>` +
    `<div class="tc-bar"><div class="tc-bar-fill" style="width:${pct}%;background:${barCol}"></div></div>` +
    `</div>`;
}
function _sfSelect(name) {
  document.getElementById('spectateSelect').value = name;
  _spectateTarget = name;
  _updateSpectateFloat();
  if (_followMode) _doFollowPan();
}

// Toast 提示
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// 屏幕常亮 (Wake Lock API)
let _wakeLock = null;
async function _requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _requestWakeLock();
});
_requestWakeLock();
