// ============================================================
// Canvas 2D 渲染引擎（替代 DOM Markers，零 DOM 开销）
// ============================================================
let _cvs, _cx;       // canvas + context
let _tipEl;           // 悬浮提示 DOM（唯一DOM，复用）
const _hitTargets = []; // 命中检测列表 [{x,y,r,tip}]
const _DPR = window.devicePixelRatio || 1;

// 精确 cubic-bezier(0, 0, 0.25, 1) 求解器（匹配 Leaflet CSS 动画曲线）
// P0=(0,0) P1=(0,0) P2=(0.25,1) P3=(1,1)
// x(t) = 0.75*t² + 0.25*t³,  y(t) = 3*t² - 2*t³
function _cbX(t) { return t * t * (0.75 + 0.25 * t); }
function _cbY(t) { return t * t * (3 - 2 * t); }
function _cbXDeriv(t) { return t * (1.5 + 0.75 * t); }
// 给定 x ∈ [0,1]，用 Newton 法求 t，然后返回 y(t)
function _easeCubicBezier(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x; // 初始估计
  for (let i = 0; i < 6; i++) {
    const dx = _cbX(t) - x;
    const d = _cbXDeriv(t);
    if (Math.abs(d) < 1e-10) break;
    t -= dx / d;
    t = Math.max(0, Math.min(1, t));
  }
  return _cbY(t);
}

// 缩放动画插值（纯 JS 数学，零 DOM 访问）
let _zoomAnim = null;  // 动画参数对象
let _stableZoom = 0;   // 上次稳定状态的 zoom
let _stableCenter = null; // 上次稳定状态的 center

function _initCanvas() {
  _cvs = document.createElement('canvas');
  // 固定在 map 容器上，纯 JS 插值实现缩放跟随（不读 DOM/CSS）
  _cvs.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:450';
  leafletMap.getContainer().appendChild(_cvs);
  _cx = _cvs.getContext('2d');
  // Tooltip
  _tipEl = document.createElement('div');
  _tipEl.style.cssText = 'position:absolute;display:none;z-index:600;pointer-events:none;max-width:220px;padding:6px 10px;background:rgba(20,20,30,0.92);color:#fff;font-size:12px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);box-shadow:0 2px 8px rgba(0,0,0,0.5);line-height:1.5';
  leafletMap.getContainer().appendChild(_tipEl);
  // 鼠标命中检测
  leafletMap.getContainer().addEventListener('mousemove', _onHover);
  leafletMap.getContainer().addEventListener('mouseleave', () => { _tipEl.style.display='none'; });

  // 记录稳定状态（首次在 viewreset 后初始化，之后每次缩放/拖动结束更新）
  function _updateStable() {
    _stableZoom = leafletMap.getZoom();
    _stableCenter = leafletMap.getCenter();
  }
  leafletMap.on('zoomend moveend load viewreset', _updateStable);

  // 缩放动画开始：捕获动画参数（纯数学，不读 DOM）
  leafletMap.on('zoomanim', _onZoomAnim);
  leafletMap.on('zoomend', () => { _zoomAnim = null; _zoomEndTime = performance.now(); _scheduleCanvasRender(); });
  // 拖动/大小变化
  leafletMap.on('move moveend resize', _scheduleCanvasRender);
  _startRenderLoop();
}

// 捕获缩放动画参数（从稳定状态到目标状态的过渡）
function _onZoomAnim(e) {
  if (!_stableCenter) return;
  const z0 = _stableZoom;
  const c0 = _stableCenter;
  const z1 = e.zoom;
  const c1 = e.center;
  const s = Math.pow(2, z1 - z0);
  // 旧/新中心在 z0 像素空间的坐标
  const pc0 = leafletMap.project(c0, z0);
  const pc1 = leafletMap.project(c1, z0);
  // d = 缩放中心偏移（保证鼠标点在屏幕上不动）
  const denom = s - 1;
  const dx = Math.abs(denom) > 1e-6 ? s * (pc1.x - pc0.x) / denom : 0;
  const dy = Math.abs(denom) > 1e-6 ? s * (pc1.y - pc0.y) / denom : 0;
  const size = leafletMap.getSize();
  _zoomAnim = {
    t0: performance.now(),
    z0, z1, s,
    pc0x: pc0.x, pc0y: pc0.y,
    dx, dy,
    halfW: size.x / 2, halfH: size.y / 2,
    // 每帧更新的值
    currentZoom: z0,
    vcX: pc0.x, vcY: pc0.y, // 视觉中心在 currentZoom 像素空间
    st: 1
  };
}

let _lastCW = 0, _lastCH = 0;
function _sizeCanvas() {
  const s = leafletMap.getSize();
  const w = s.x * _DPR, h = s.y * _DPR;
  if (_lastCW !== w || _lastCH !== h) {
    _cvs.width = w; _cvs.height = h;
    _cvs.style.width = s.x + 'px';
    _cvs.style.height = s.y + 'px';
    _lastCW = w; _lastCH = h;
  }
  _cx.setTransform(_DPR, 0, 0, _DPR, 0, 0);
}

// 脏标记：只在数据或视图变化时才重绘
let _renderDirty = true;
function _markDirty() { _renderDirty = true; }

// 渲染循环：缩放动画期间每帧重绘（纯数学），其他时刻按脏标记重绘
let _renderLoopRunning = false;
function _startRenderLoop() {
  if (_renderLoopRunning) return;
  _renderLoopRunning = true;
  function _loop() {
    const leafletAnim = !!(leafletMap && leafletMap._animatingZoom);
    // 兜底：zoomanim 未触发但 Leaflet 在动画，尝试构建动画参数
    if (leafletAnim && !_zoomAnim) {
      const z1 = leafletMap._animateToZoom != null ? leafletMap._animateToZoom : leafletMap.getZoom();
      const c1 = leafletMap._animateToCenter || leafletMap.getCenter();
      if (z1 !== _stableZoom) {
        _onZoomAnim({zoom: z1, center: c1});
      }
    }
    // 插值补帧：原始帧率×3，上限60fps，节流插值渲染
    const _lerpActive = _lerpCache.size > 0 || _lerpSelfCache;
    let _doLerpRender = false;
    if (_lerpActive) {
      const _now = performance.now();
      if (_now - _lastLerpRenderTime >= _lerpFrameInterval) {
        _lastLerpRenderTime = _now;
        _doLerpRender = true;
      }
    }
    if (_zoomAnim || _renderDirty || _doLerpRender) {
      _renderDirty = false;
      // 更新动画插值（纯数学，零 DOM 读取）
      if (_zoomAnim) {
        const a = _zoomAnim;
        const elapsed = performance.now() - a.t0;
        const t = Math.min(1, elapsed / 250);
        const eased = _easeCubicBezier(t);
        a.currentZoom = a.z0 + (a.z1 - a.z0) * eased;
        a.st = Math.pow(2, a.currentZoom - a.z0);
        // 视觉中心在 currentZoom 像素空间的坐标
        a.vcX = a.pc0x * a.st + a.dx * (a.st - 1);
        a.vcY = a.pc0y * a.st + a.dy * (a.st - 1);
      }
      _renderAll();
    }
    requestAnimationFrame(_loop);
  }
  requestAnimationFrame(_loop);
}
let _isFollowPanning = false; // 阻断跟随平移的反馈环路
let _zoomEndTime = 0;          // 缩放结束时间戳（冷却用）
let _lastFollowPanTime = 0;    // 上次跟随平移时间戳（节流用）
function _scheduleCanvasRender() {
  if (_isFollowPanning) return; // 跟随 setView 触发的 move 事件不标记脏
  _renderDirty = true;
}

// 游戏坐标 → canvas绘制坐标（动画期间用 project(ll, currentZoom) 插值）
function _toScreen(gx, gy) {
  const ll = toMapCoord(gx, gy, currentMapInfo);
  if (_zoomAnim) {
    const a = _zoomAnim;
    // 在当前视觉 zoom 下投影，减去视觉中心像素坐标，加屏幕中心偏移
    const pp = leafletMap.project(ll, a.currentZoom);
    return {
      x: pp.x - a.vcX + a.halfW,
      y: pp.y - a.vcY + a.halfH
    };
  }
  const cp = leafletMap.latLngToContainerPoint(ll);
  return {x: cp.x, y: cp.y};
}

// 鼠标悬浮命中检测（容器坐标直接匹配）
let _curTipHtml = ''; // 当前tooltip内容，避免重复设置innerHTML
function _onHover(e) {
  const rect = leafletMap.getContainer().getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  let best = null, bestD = 20;
  for (const t of _hitTargets) {
    const d = Math.hypot(t.x - mx, t.y - my);
    if (d < bestD && d < t.r + 8) { bestD = d; best = t; }
  }
  if (best) {
    // 仅在目标变化时更新innerHTML（避免重复创建<img>触发请求）
    if (_curTipHtml !== best.tip) {
      _curTipHtml = best.tip;
      _tipEl.innerHTML = best.tip;
      // 将缓存的Image克隆注入占位符，避免新网络请求
      _tipEl.querySelectorAll('.tip-ico').forEach(el => {
        const cached = _imgCache[el.dataset.src];
        if (cached && cached._loaded && !cached._failed && cached._el) {
          const clone = cached._el.cloneNode(false);
          clone.style.cssText = 'width:48px;height:48px;object-fit:contain';
          el.appendChild(clone);
        }
      });
    }
    _tipEl.style.display = 'block';
    _tipEl.style.left = (mx + 12) + 'px';
    _tipEl.style.top = (my - 20) + 'px';
  } else {
    _curTipHtml = '';
    _tipEl.style.display = 'none';
  }
}

// 全局缩放因子（与旧版 --ms CSS变量对应）
let _markerScale = 1.3;
let _itemScale = 1.0;       // 物品独立缩放
let _containerScale = 1.0;  // 容器独立缩放

// CDN图片预加载缓存
// 策略: fetch→blob→objectURL（本地源，零跨域跟踪警告）; 失败则回退Image
const _imgCache = {};
// 不支持CORS的域名列表（跳过fetch直接用Image，避免CORS报错）
const _noCorsForFetch = ['playerhub.df.qq.com'];
function _loadImg(url) {
  if (_imgCache[url]) return _imgCache[url];
  const entry = { _loaded: false, _failed: false, _el: null };
  _imgCache[url] = entry;
  // 已知不支持CORS的域名→跳过fetch，直接用Image加载（避免CORS报错）
  if (_noCorsForFetch.some(d => url.includes(d))) {
    const img = new Image();
    img.onload = () => { entry._loaded = true; entry._el = img; _scheduleCanvasRender(); };
    img.onerror = () => { entry._failed = true; };
    img.src = url;
    return entry;
  }
  // 其他域名: fetch→blob→objectURL（本地源，零警告）; 失败回退Image
  fetch(url, { mode: 'cors', credentials: 'omit' })
    .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
    .then(blob => _loadFromBlob(entry, blob))
    .catch(() => {
      const img = new Image();
      img.onload = () => { entry._loaded = true; entry._el = img; _scheduleCanvasRender(); };
      img.onerror = () => { entry._failed = true; };
      img.src = url;
    });
  return entry;
}
function _loadFromBlob(entry, blob) {
  const objUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => { entry._loaded = true; entry._el = img; _scheduleCanvasRender(); };
  img.onerror = () => { entry._failed = true; };
  img.src = objUrl;
}
// 预加载常用图片
const _IMG_CTN_BIG  = 'https://game.gtimg.cn/images/dfm/cp/a20240729directory/img/lv3/bxx.png';
const _IMG_CTN_SM   = 'https://game.gtimg.cn/images/dfm/cp/a20240729directory/img/lv3/xbxx.png';
const _IMG_EXIT     = 'https://game.gtimg.cn/images/dfm/cp/a20240729directory/img/lv3/dtcld.png';
const _IMG_SAFE_EXIT = 'https://game.gtimg.cn/images/dfm/cp/a20240729directory/img/lv3/cgcld.png';
const _ICON_CDN     = 'https://playerhub.df.qq.com/playerhub/60004/object/';
// 立即预加载常用图片
_loadImg(_IMG_CTN_BIG); _loadImg(_IMG_CTN_SM); _loadImg(_IMG_EXIT); _loadImg(_IMG_SAFE_EXIT);
// 子弹图标路径解析
const _ammoMetric = [
  ['12.7x55mm','12.7x55mm'],['7.62x54R','7.62x54mm'],['7.62x51mm','7.62x51mm'],
  ['7.62x39mm','7.62x39mm'],['6.8x51mm','6.8x51mm'],['5.56x45mm','5.56x45mm'],
  ['5.45x39mm','5.45x39mm'],['5.8x42mm','5.8x42mm'],['5.7x28mm','5.7x28mm'],
  ['4.6x30mm','4.6x30mm'],['9x39mm','9x39mm'],['9x19mm','9x19mm']
];
const _ammoSpecial = [
  ['.357 Magnum','357-Magnum'],['.300BLK','300BLK'],['.300 BLK','300BLK'],
  ['.45 ACP','45-ACP'],['.50 AE','50-AE'],['12 Gauge','12-Gauge']
];
function _resolveIconKey(name, objectId) {
  if (!name) return objectId || '';
  for (const [p, cdn] of _ammoMetric) if (name.startsWith(p)) return 'gun/ammo/' + cdn;
  for (const [p, cdn] of _ammoSpecial) if (name.startsWith(p)) return 'gun/ammo/' + cdn;
  return objectId || '';
}

// Canvas 绘制辅助
function _drawCircle(x, y, r, fill, stroke, glow) {
  if (glow) { _cx.shadowColor = fill + '88'; _cx.shadowBlur = glow; }
  _cx.beginPath(); _cx.arc(x, y, r, 0, Math.PI*2);
  _cx.fillStyle = fill; _cx.fill();
  if (stroke) { _cx.strokeStyle = stroke; _cx.lineWidth = 2; _cx.stroke(); }
  _cx.shadowBlur = 0;
}

// 方向箭头——完全还原旧版SVG polygon几何
// 旧版: aw=diameter*0.5, ah=diameter*0.55, 箭头从圆边缘开始向外延伸
// screenYawDeg = p.yw + yawOffset (CSS旋转角度: 0°=上, 顺时针)
function _drawArrow(cx, cy, radius, screenYawDeg, fill, strokeCol) {
  const ah = radius * 1.1;     // diameter * 0.55
  const halfW = radius * 0.5;  // diameter * 0.25
  const tipDist = radius + ah;
  // CSS rotation → Canvas angle (CSS 0°=上 → Canvas -90°)
  const a = (screenYawDeg - 90) * Math.PI / 180;
  const perp = a + Math.PI / 2;
  // 箭头尖端（圆边缘 + ah）
  const tx = cx + Math.cos(a) * tipDist;
  const ty = cy + Math.sin(a) * tipDist;
  // 箭头底边中点（圆边缘）
  const bx = cx + Math.cos(a) * radius;
  const by = cy + Math.sin(a) * radius;
  // 底边两角
  const lx = bx + Math.cos(perp) * halfW;
  const ly = by + Math.sin(perp) * halfW;
  const rx = bx - Math.cos(perp) * halfW;
  const ry = by - Math.sin(perp) * halfW;
  _cx.beginPath(); _cx.moveTo(tx, ty); _cx.lineTo(lx, ly); _cx.lineTo(rx, ry); _cx.closePath();
  _cx.fillStyle = fill; _cx.fill();
  _cx.strokeStyle = strokeCol || 'rgba(0,0,0,0.6)'; _cx.lineWidth = 1.5; _cx.stroke();
}

// 描边文字（strokeText 替代4次 fillText，减少 draw calls：5→2）
function _drawText(text, x, y, font, color, align, baseline) {
  _cx.font = font || 'bold 10px sans-serif';
  _cx.textAlign = align || 'center';
  _cx.textBaseline = baseline || 'middle';
  _cx.shadowBlur = 0;
  // 黑色描边（单次 strokeText 替代4方向偏移）
  _cx.strokeStyle = '#000';
  _cx.lineWidth = 3;
  _cx.lineJoin = 'round';
  _cx.strokeText(text, x, y);
  // 正文
  _cx.fillStyle = color || '#fff';
  _cx.fillText(text, x, y);
}

// HP条
function _drawHpBar(x, y, w, hp, maxHp, color) {
  if (!maxHp || maxHp <= 0) return;
  const h = 3, pct = Math.max(0, Math.min(1, hp/maxHp));
  _cx.fillStyle = 'rgba(0,0,0,0.5)';
  _cx.fillRect(x - w/2, y, w, h);
  _cx.fillStyle = pct > 0.5 ? color : (pct > 0.25 ? '#ffa500' : '#ff3333');
  _cx.fillRect(x - w/2, y, w * pct, h);
}

// 绘制图片（居中，带回退）
function _drawImg(entry, x, y, sz) {
  if (entry && entry._loaded && !entry._failed && entry._el) {
    _cx.drawImage(entry._el, x - sz/2, y - sz/2, sz, sz);
    return true;
  }
  return false;
}

// 头盔/护甲 SVG 图标（用 Path2D 完全还原旧版 SVG 路径）
const _helmetPath = new Path2D('M972.59 293.94c-50.06-101.43-135.34-172.26-253.61-210.6-171.63-55.86-295.94-11.55-369.95 35.5a499.26 499.26 0 0 0-152.75 157.87c-8.42 14.56-20.08 35.27-31.06 59.5h-34.42c-58.88 0-72.7 28.33-76.12 41.07L22.09 470.24a38.8 38.8 0 0 0 3.58 33.05 35.78 35.78 0 0 0 27.65 16.84l27.19 2.67c-3.98 9.67-7.79 18.89-11.21 27.53-33.62 84.76-66.62 199.11-68.04 203.83a29.3 29.3 0 0 0 15.13 34.25 28.05 28.05 0 0 0 35.5-9.61 44.03 44.03 0 0 1 48.66-12.29 3318.67 3318.67 0 0 1 368.36 123.16 220.96 220.96 0 0 0 88.06 20.48 122.14 122.14 0 0 0 112.53-71.62c8.42-17.52 15.76-35.56 22.07-53.99a276.25 276.25 0 0 0 280.23 16.44 30.04 30.04 0 0 0 15.02-17.07c4.38-12.29 90.28-279.15-14.22-489.98zM406.66 534.13a1179.48 1179.48 0 0 0-243.43-59.96l-29.24-4.32-29.24-3.87-20.02-2.1 23.61-67.3a55.92 55.92 0 0 1 22.64-3.3h37.83c11.04 0 20.02 1.48 30.26 2.5 83.46 8.42 177.32 31.18 221.58 61.55l8.42 5.97-22.41 70.83z');
const _armorPath = new Path2D('M57.6 480V128c128-38.4 268.8-83.2 460.8-128 192 44.8 332.8 89.6 460.8 134.4v352c0 313.6-256 486.4-454.4 537.6C313.6 966.4 57.6 793.6 57.6 480z');

function _drawHelmetIcon(x, y, lv) {
  const c = lvColor(lv), sz = 12 * _markerScale;
  _cx.save();
  _cx.translate(x - sz/2, y - sz/2);
  _cx.scale(sz/1024, sz/1024);
  _cx.fillStyle = c;
  _cx.fill(_helmetPath);
  _cx.restore();
}
function _drawArmorIcon(x, y, lv) {
  const c = lvColor(lv), sz = 12 * _markerScale;
  _cx.save();
  _cx.translate(x - sz/2, y - sz/2);
  _cx.scale(sz/1024, sz/1024);
  _cx.fillStyle = c;
  _cx.fill(_armorPath);
  _cx.restore();
}

// 独立消息模式: 缓存每种实体数据，按type单独更新图层
const _entityCache = { self:null, players:[], items:[], containers:[], exits:[], boxes:[] };

// ── 位置插值补帧（只给活着的非AI玩家 + 自身）──
let _wsInterval = 100;          // WS 推送间隔(ms)，动态测量
let _wsLastTime = 0;            // 上次 WS 数据时间戳
let _lerpMultiplier = 3;        // 补帧倍率（用户可调 2-10）
let _lerpFrameInterval = 33.3;  // 插值帧间隔(ms) = wsInterval/multiplier，上限60fps⇒16.67ms
let _lastLerpRenderTime = 0;    // 上次插值渲染时间戳
function setLerpMultiplier(v) {
  _lerpMultiplier = Math.max(2, Math.min(10, parseInt(v) || 3));
  _lerpFrameInterval = Math.max(16.67, _wsInterval / _lerpMultiplier);
  document.getElementById('lerpVal').textContent = '×' + _lerpMultiplier;
}
const _lerpCache = new Map();   // key → {px,py,pz,pyw, cx,cy,cz,cyw, t0}
let _lerpSelfCache = null;      // 自身插值缓存

function _lerpKey(p) { return p.n || ('_' + p.x + '_' + p.y); }

let _followNeedsUpdate = false;

// 当新数据到达时，更新插值缓存（current→prev，new→current）
function _updateLerpData() {
  _followNeedsUpdate = true;
  const now = performance.now();
  // 测量 WS 推送间隔，平滑更新
  if (_wsLastTime > 0) {
    const dt = now - _wsLastTime;
    if (dt > 10 && dt < 2000) { // 合理范围
      _wsInterval = _wsInterval * 0.7 + dt * 0.3; // 平滑
      _lerpFrameInterval = Math.max(16.67, _wsInterval / _lerpMultiplier); // ×N，上限60fps
    }
  }
  _wsLastTime = now;
  const data = _entityCache;
  // 只给活着的非AI玩家补帧
  const seen = new Set();
  (data.players || []).forEach(p => {
    if (p.ai || p.dn) return; // 跳过AI和倒地玩家
    const k = _lerpKey(p);
    seen.add(k);
    const c = _lerpCache.get(k);
    if (c) {
      if (c.cx !== p.x || c.cy !== p.y || c.cz !== p.z) {
        c.px = c.cx; c.py = c.cy; c.pz = c.cz;
        c.cx = p.x;  c.cy = p.y;  c.cz = p.z;
        c.t0 = now;
      }
    } else {
      _lerpCache.set(k, {px:p.x, py:p.y, pz:p.z, cx:p.x, cy:p.y, cz:p.z, t0:now});
    }
  });
  for (const k of _lerpCache.keys()) { if (!seen.has(k)) _lerpCache.delete(k); }
  // 自身位置插值（朝向不插值，避免箭头闪烁）
  if (data.self && data.self.x != null) {
    const s = data.self;
    if (_lerpSelfCache) {
      if (_lerpSelfCache.cx !== s.x || _lerpSelfCache.cy !== s.y || _lerpSelfCache.cz !== s.z) {
        _lerpSelfCache.px = _lerpSelfCache.cx; _lerpSelfCache.py = _lerpSelfCache.cy;
        _lerpSelfCache.pz = _lerpSelfCache.cz;
        _lerpSelfCache.cx = s.x; _lerpSelfCache.cy = s.y; _lerpSelfCache.cz = s.z;
        _lerpSelfCache.t0 = now;
      }
    } else {
      _lerpSelfCache = {px:s.x, py:s.y, pz:s.z, cx:s.x, cy:s.y, cz:s.z, t0:now};
    }
  } else {
    _lerpSelfCache = null;
  }
}

// 获取插值后的坐标（只对活着的非AI玩家有效）
function _getLerped(p) {
  if (p.ai || p.dn) return {x:p.x, y:p.y, z:p.z, yw:p.yw}; // AI/倒地不补帧
  const k = _lerpKey(p);
  const c = _lerpCache.get(k);
  if (!c) return {x:p.x, y:p.y, z:p.z, yw:p.yw};
  const t = Math.min(1, (performance.now() - c.t0) / _wsInterval);
  return {
    x: c.px + (c.cx - c.px) * t,
    y: c.py + (c.cy - c.py) * t,
    z: c.pz + (c.cz - c.pz) * t,
    yw: p.yw  // 朝向不插值，用原始值
  };
}
function _getLerpedSelf() {
  const s = _entityCache.self;
  if (!s || !_lerpSelfCache) return s;
  const c = _lerpSelfCache;
  const t = Math.min(1, (performance.now() - c.t0) / _wsInterval);
  return Object.assign({}, s, {
    x: c.px + (c.cx - c.px) * t,
    y: c.py + (c.cy - c.py) * t,
    z: c.pz + (c.cz - c.pz) * t,
    // yw 不插值，保留原始朝向
  });
}

let _lastTeamNames = '';

// 距离+高度差标签
function distLabel(x, y, z) {
  const dx = x - _spectateRef.x, dy = y - _spectateRef.y, dz = z - _spectateRef.z;
  // 坐标为原始 UE 单位(cm)，除以100得到米
  const dist = Math.sqrt(dx*dx + dy*dy) / 100;
  const hDiff = Math.round(dz / 100);
  const arrow = hDiff > 0 ? '↑' : hDiff < 0 ? '↓' : '';
  const hStr = hDiff !== 0 ? `${arrow}${Math.abs(hDiff)}` : '';
  return `${Math.round(dist)}m ${hStr}`;
}

function clearEntityLayers() {
  // Canvas模式：清空缓存即可，下帧自动重绘
  if (_cvs) { const s = leafletMap.getSize(); _cx.clearRect(0,0,s.x,s.y); }
}

// ============================================================
// Canvas 统一渲染（替代 renderDynamicLayers + renderStaticLayers）
// ============================================================
// 屏幕边界检查（跳过屏幕外实体，节省绘制开销）
let _vpW = 0, _vpH = 0, _vpMargin = 100; // 视口宽高 + 边距
function _inView(x, y) {
  return x > -_vpMargin && x < _vpW + _vpMargin && y > -_vpMargin && y < _vpH + _vpMargin;
}

function _renderAll() {
  if (!leafletMap || !currentMapInfo || !_cx) return;
  _sizeCanvas();
  const s = leafletMap.getSize();
  _vpW = s.x; _vpH = s.y;
  _cx.clearRect(0, 0, s.x, s.y);
  _hitTargets.length = 0;

  const data = _entityCache;
  const info = currentMapInfo;
  const S = _markerScale; // 全局缩放因子

  // 更新浮动视角面板（跟随模式时，每秒最多更新1次）
  if (_followMode && (!window._lastSfUpdate || Date.now() - window._lastSfUpdate > 1000)) {
    window._lastSfUpdate = Date.now();
    _updateSpectateFloat();
  }

  // 更新观战视角参考点（每帧用插值坐标，距离标签平滑）
  _spectateTarget = document.getElementById('spectateSelect').value;
  if (_spectateTarget === 'self' && data.self) {
    const _ls = _getLerpedSelf() || data.self;
    _spectateRef = { x: _ls.x||0, y: _ls.y||0, z: _ls.z||0 };
  } else if (_spectateTarget !== 'self') {
    const tp = (data.players||[]).find(p => p.n === _spectateTarget);
    if (tp) { const _lt = _getLerped(tp); _spectateRef = { x: _lt.x, y: _lt.y, z: _lt.z }; }
  }
  // 跟随平移：节流100ms + 缩放后300ms冷却，防止瓦片闪烁
  if (_followMode && !_followPaused && !_zoomAnim && !leafletMap._animatingZoom) {
    const _now = performance.now();
    if ((_now - _zoomEndTime) > 300 && (_now - _lastFollowPanTime) >= 100) {
      _lastFollowPanTime = _now;
      const refPos = toMapCoord(_spectateRef.x, _spectateRef.y, info);
      _isFollowPanning = true;
      leafletMap.setView(refPos, leafletMap.getZoom(), { animate: false });
      _isFollowPanning = false;
    }
  }

  // 更新观战下拉列表
  const _selfDispName = (data.self && data.self.n && data.self.n !== 'DefaultName') ? data.self.n : '自身';
  const teamNames = (data.players||[]).filter(p => p.tm && p.n && p.n !== 'DefaultName').map(p => p.n).join(',');
  const _selectHash = _selfDispName + '|' + teamNames;
  if (_selectHash !== _lastTeamNames) {
    _lastTeamNames = _selectHash;
    const sel = document.getElementById('spectateSelect');
    const curVal = sel.value;
    const opts = [`<option value="self">${_selfDispName}</option>`];
    teamNames.split(',').filter(Boolean).forEach(n => opts.push(`<option value="${n}">${n}</option>`));
    sel.innerHTML = opts.join('');
    sel.value = curVal;
    if (!sel.value) sel.value = 'self';
  }

  // yaw → 屏幕角度
  const yawOff = info.rotate ? 180 : 90;

  // ── 按旧版z-index顺序绘制（后画=在上面）──
  // z=100: AI玩家 → z=200: 撤离 → z=300: 容器 → z=350-450: 箱子
  // → z=500+: 物品 → z=700: 队友 → z=750: 倒地 → z=800: 敌方 → z=1000: 自身

  // ── 准备玩家分类（需要提前统计+分类，按z-index分层绘制）──
  const _isSpectTeam = _spectateTarget !== 'self';
  const _spectTeammate = _isSpectTeam ? (data.players||[]).find(p => p.n === _spectateTarget && p.tm) : null;
  let cntP=0, cntA=0, cntD=0;
  const _pAI = [], _pTeam = [], _pDowned = [], _pEnemy = [];
  (data.players || []).forEach(p => {
    const isAI=!!p.ai, isDowned=!!p.dn;
    if (isAI) cntA++; else { if (isDowned) cntD++; else cntP++; }
    if (_isSpectTeam && _spectTeammate && p.n === _spectateTarget && p.tm) return;
    if (isAI) _pAI.push(p);
    else if (p.tm) _pTeam.push(p);
    else if (isDowned) _pDowned.push(p);
    else _pEnemy.push(p);
  });

  // z=100: AI玩家（最底层）
  _pAI.forEach(p => _drawPlayer(p));

  // z=200: 撤离闸
  if (layerState.exit) (data.exits || []).forEach(ex => {
    const pt = _toScreen(ex.x, ex.y);
    if (!_inView(pt.x, pt.y)) return;
    const sz = 20 * S;
    const exImg = _loadImg(ex.s ? _IMG_SAFE_EXIT : _IMG_EXIT);
    const col = '#30D158';
    const bord = ex.s ? '#30D158' : '#f85149';
    if (_drawImg(exImg, pt.x, pt.y, sz)) {
      // 绘制边框
      _cx.strokeStyle = bord; _cx.lineWidth = 2;
      _cx.strokeRect(pt.x - sz/2, pt.y - sz/2, sz, sz);
    } else {
      // 回退：彩色方块
      const R = 6 * S;
      _cx.fillStyle = ex.s ? '#3fb950' : '#f85149';
      _cx.fillRect(pt.x - R, pt.y - R, R*2, R*2);
      _cx.strokeStyle = '#fff'; _cx.lineWidth = 2;
      _cx.strokeRect(pt.x - R, pt.y - R, R*2, R*2);
    }
    _drawText(distLabel(ex.x, ex.y, ex.z||0), pt.x, pt.y + sz/2 + 8*S, `600 ${Math.round(8*S)}px sans-serif`, col);
    _hitTargets.push({x:pt.x, y:pt.y, r:sz/2, tip: ex.s ? '安全撤离闸' : '撤离闸'});
  });

  // z=300: 容器（已开启的在DLL端过滤）
  if (layerState.container) (data.containers || []).forEach(c => {
    const pt = _toScreen(c.x, c.y);
    if (!_inView(pt.x, pt.y)) return;
    const col = '#ffd700';
    const CS = S * _containerScale;
    const sz = 20 * CS;
    const label = CTN_NAMES[c.t||1] || '保险箱';
    const imgUrl = c.t === 2 ? _IMG_CTN_SM : _IMG_CTN_BIG;
    const ctnImg = _loadImg(imgUrl);
    if (!_drawImg(ctnImg, pt.x, pt.y, sz)) {
      // 回退：金色方块
      const R = 7 * CS;
      _cx.fillStyle = col; _cx.shadowColor = col; _cx.shadowBlur = 4;
      _cx.fillRect(pt.x - R, pt.y - R, R*2, R*2);
      _cx.shadowBlur = 0;
      _cx.strokeStyle = 'rgba(0,0,0,0.5)'; _cx.lineWidth = 1;
      _cx.strokeRect(pt.x - R, pt.y - R, R*2, R*2);
    }
    _drawText(distLabel(c.x, c.y, c.z||0), pt.x, pt.y + sz/2 + 8*CS, `600 ${Math.round(8*CS)}px sans-serif`, col);
    _hitTargets.push({x:pt.x, y:pt.y, r:sz/2, tip: `<b>${label}</b>`});
  });

  // z=350-450: 箱子（旧版: 12px圆 + 1.5px白边半透明 + box-shadow + 名字+距离底部）
  if (layerState.box) (data.boxes || []).filter(b => {
    const ai = !!b.ai;
    return ai ? _showAIBox : _showPlayerBox;
  }).forEach(b => {
    const pt = _toScreen(b.x, b.y);
    if (!_inView(pt.x, pt.y)) return;
    const isAI = !!b.ai;
    const col = isAI ? '#808080' : '#C8A060';
    const R = 6 * S;
    _drawCircle(pt.x, pt.y, R, col, 'rgba(255,255,255,0.5)', R * 0.5);
    const nameStr = b.n || (isAI ? '人机盒' : '玩家盒');
    _drawText(nameStr, pt.x, pt.y + R + 6*S, `600 ${Math.round(8*S)}px sans-serif`, col);
    _drawText(distLabel(b.x, b.y, b.z||0), pt.x, pt.y + R + 16*S, `600 ${Math.round(8*S)}px sans-serif`, col);
    _hitTargets.push({x:pt.x, y:pt.y, r:R, tip: `<b style="color:${col}">${isAI?'人机':'玩家'}盒子</b>${b.n?'<br>'+b.n:''}${b.bt?'<br>BoxType: '+b.bt:''}`});
  });

  // z=500+: 物品（堆叠聚类：屏幕距离<20px的物品归为一组，按价值排序）
  if (layerState.item) {
    const _filteredItems = (data.items || []).filter(it => (it.v||0) >= _itemValueFilter);
    // 计算屏幕坐标并聚类
    const _itemPts = _filteredItems.map(it => ({it, pt: _toScreen(it.x, it.y)}));
    const _clusters = [], _used = new Set();
    const CLUSTER_R = 20 * S; // 聚类半径（屏幕像素）
    for (let i = 0; i < _itemPts.length; i++) {
      if (_used.has(i)) continue;
      const cluster = [_itemPts[i]];
      _used.add(i);
      for (let j = i + 1; j < _itemPts.length; j++) {
        if (_used.has(j)) continue;
        const dx = _itemPts[i].pt.x - _itemPts[j].pt.x;
        const dy = _itemPts[i].pt.y - _itemPts[j].pt.y;
        if (dx*dx + dy*dy < CLUSTER_R * CLUSTER_R) {
          cluster.push(_itemPts[j]);
          _used.add(j);
        }
      }
      // 按价值降序排列
      cluster.sort((a, b) => (b.it.v||0) - (a.it.v||0));
      _clusters.push(cluster);
    }
    // 绘制每个聚类（跳过屏幕外）
    _clusters.forEach(cluster => {
      const top = cluster[0]; // 最高价值物品
      const {it, pt} = top;
      if (!_inView(pt.x, pt.y)) return;
      const IS = S * _itemScale;
      const q = Math.min(it.q||0, 6), col = ITEM_Q_COLORS[q];
      const sz = 20 * IS;
      const rawOid = it.oid||'';
      const iconKey = _resolveIconKey(it.n, rawOid);
      const hasIco = iconKey && iconKey.length > 3;
      let drawn = false;
      if (hasIco) {
        const itemImg = _loadImg(_ICON_CDN + iconKey + '.png');
        if (itemImg._loaded && !itemImg._failed && itemImg._el) {
          _cx.shadowColor = col; _cx.shadowBlur = 3;
          _cx.drawImage(itemImg._el, pt.x - sz/2, pt.y - sz/2, sz, sz);
          _cx.shadowBlur = 0;
          drawn = true;
        }
      }
      if (!drawn) {
        const R = (sz - 6) / 2;
        _drawCircle(pt.x, pt.y, R, col, 'rgba(0,0,0,0.5)', 3);
      }
      // 物品标签：背景条（价值/名字）上方，距离+Z下方
      const fSize = Math.round(9 * IS);
      const MAX_SHOW = 3;
      const shown = cluster.slice(0, MAX_SHOW);
      let labelTop = pt.y - sz/2 - 4*IS;

      // 从下往上叠加（最高价值在最靠近圆圈处）
      for (let ci_i = shown.length - 1; ci_i >= 0; ci_i--) {
        const ci = shown[ci_i].it;
        const cq = Math.min(ci.q||0, 6), cc = ITEM_Q_COLORS[cq];
        const cv = ci.v||0;
        const cvStr = cv>=10000?Math.round(cv/10000)+'W':cv>=1000?Math.round(cv/1000)+'K':cv>0?String(cv):'';
        const label = (cvStr ? cvStr+'/' : '') + (ci.n||'物品');
        _cx.font = `600 ${fSize}px 'Plus Jakarta Sans',sans-serif`;
        const tw = _cx.measureText(label).width;
        const ph = 5*IS, pv = 3*IS;
        const bw = tw + ph*2, bh = fSize + pv*2;
        const bx = pt.x - bw/2, by = labelTop - bh;
        // 背景圆角条，用物品品质色
        const br = 4*IS;
        _cx.save();
        _cx.beginPath();
        _cx.moveTo(bx+br,by); _cx.lineTo(bx+bw-br,by);
        _cx.quadraticCurveTo(bx+bw,by,bx+bw,by+br);
        _cx.lineTo(bx+bw,by+bh-br); _cx.quadraticCurveTo(bx+bw,by+bh,bx+bw-br,by+bh);
        _cx.lineTo(bx+br,by+bh); _cx.quadraticCurveTo(bx,by+bh,bx,by+bh-br);
        _cx.lineTo(bx,by+br); _cx.quadraticCurveTo(bx,by,bx+br,by);
        _cx.closePath();
        _cx.fillStyle = cc; _cx.globalAlpha = 0.75; _cx.fill();
        _cx.restore();
        // 文字
        _cx.save();
        _cx.font = `600 ${fSize}px 'Plus Jakarta Sans',sans-serif`;
        _cx.fillStyle = '#fff'; _cx.textAlign = 'center'; _cx.textBaseline = 'middle';
        _cx.fillText(label, pt.x, by + bh/2);
        _cx.restore();
        labelTop = by - 2*IS;
      }

      // 距离+Z（圆圈下方）
      _drawText(distLabel(it.x, it.y, it.z||0), pt.x, pt.y + sz/2 + 8*IS, `600 ${Math.round(8*IS)}px 'Plus Jakarta Sans',sans-serif`, col);
      // tooltip：列出所有物品详情（鼠标悬停时显示）
      let tipHtml = '';
      cluster.forEach(({it: ci}) => {
        const cq = Math.min(ci.q||0, 6), cc = ITEM_Q_COLORS[cq];
        const cv = ci.v||0;
        const cvStr = cv>=10000?Math.round(cv/10000)+'W':cv>=1000?Math.round(cv/1000)+'K':cv>0?String(cv):'';
        const cDist = distLabel(ci.x, ci.y, ci.z||0);
        tipHtml += `<div style="margin:2px 0;border-left:3px solid ${cc};padding-left:5px">`;
        tipHtml += `<b style="color:${cc}">${ci.n||'物品'}</b>`;
        if (cvStr) tipHtml += ` <span style="color:#ffd700">${cvStr}</span>`;
        tipHtml += `<br><span style="color:#888;font-size:11px">${cDist}</span>`;
        tipHtml += `</div>`;
      });
      _hitTargets.push({x:pt.x, y:pt.y, r: Math.max(sz/2, 12*S), tip: tipHtml});
    });
  }

  // ── 动态实体（玩家/自身）──
  function _drawPlayer(p) {
    const isAI=!!p.ai, isTeam=!!p.tm, isDowned=!!p.dn;
    const tid = p.t||0;
    const fill = isAI ? '#8b949e' : (isTeam ? '#50ff78' : (isDowned ? '#a0a0a0' : TEAM_COLORS[tid % 32]));
    const layerKey = isAI ? 'ai' : (isTeam ? 'team' : 'enemy');
    if (!layerState[layerKey]) return;

    // 插值补帧：在 WS 数据间平滑移动
    const lp = _getLerped(p);
    const pt = _toScreen(lp.x, lp.y);
    if (!_inView(pt.x, pt.y)) return;
    // 旧版: R=10(人,即20px直径) / R=8(AI,即16px直径)
    const R = (isAI ? 8 : 10) * S;

    // 方向箭头（非AI，旧版SVG polygon附在圆外）
    let _arrowUpExt = 0, _arrowDnExt = 0; // 箭头向上/向下超出圆的距离
    if (!isAI) {
      const yawDeg = (lp.yw || 0) + yawOff;
      _drawArrow(pt.x, pt.y, R, yawDeg, fill);
      // 计算箭头尖端的垂直偏移，用于避让文字标签
      const _aRad = (yawDeg - 90) * Math.PI / 180;
      const _tipY = Math.sin(_aRad) * (R + R * 1.1); // 箭头尖端相对圆心的Y偏移
      if (_tipY < -R) _arrowUpExt = -_tipY - R;  // 向上超出圆顶的距离
      if (_tipY > R) _arrowDnExt = _tipY - R;    // 向下超出圆底的距离
    }

    // 主圆（旧版: 2px solid rgba(0,0,0,.6) + box-shadow glow）
    _drawCircle(pt.x, pt.y, R, fill, 'rgba(0,0,0,0.6)', R * 0.6);

    // 圆心文字（旧版: AI=9px / 队伍ID=10px）
    if (isAI) {
      _drawText('AI', pt.x, pt.y, `bold ${Math.round(9*S)}px sans-serif`, '#fff');
    } else if (!isTeam && !isDowned) {
      _drawText(String(tid), pt.x, pt.y, `bold ${Math.round(10*S)}px sans-serif`, '#fff');
    }

    // 名字牌（上方，旧版排列：护甲行→名字行）——根据箭头方向自动避让
    let above = pt.y - R - _arrowUpExt - 3*S;
    const _isEnemy = !isAI && !isTeam;
    const _ei = enemyInfo; // 敌方信息开关
    if (_isEnemy) {
      const hero = (_ei.hero ? HERO_NAMES[p.hr] : '') || '';
      const weapon = (_ei.weapon ? WEAPON_NAMES[p.w] : '') || '';
      const helmetLv = _ei.helmet ? (p.hl||0) : 0;
      const armorLv = _ei.armor ? (p.ar||0) : 0;

      // 构建一行简洁信息：(干员)手持/头盔N/护甲N
      let infoStr = '';
      if (hero) infoStr += '(' + hero + ')';
      if (weapon) infoStr += weapon;
      if (helmetLv) infoStr += (infoStr ? '/' : '') + '头盔' + helmetLv;
      if (armorLv) infoStr += (infoStr ? '/' : '') + '护甲' + armorLv;

      if (infoStr) {
        const fz = Math.round(9 * S);
        _cx.font = `600 ${fz}px 'Plus Jakarta Sans',sans-serif`;
        const tw = _cx.measureText(infoStr).width;
        const ph = 4 * S, pv = 3 * S;
        const bw = tw + ph * 2, bh = fz + pv * 2;
        const bx = pt.x - bw / 2, by = above - bh;
        // 半透明深色背景圆角条
        const br = 4 * S;
        _cx.save();
        _cx.beginPath();
        _cx.moveTo(bx + br, by);
        _cx.lineTo(bx + bw - br, by);
        _cx.quadraticCurveTo(bx + bw, by, bx + bw, by + br);
        _cx.lineTo(bx + bw, by + bh - br);
        _cx.quadraticCurveTo(bx + bw, by + bh, bx + bw - br, by + bh);
        _cx.lineTo(bx + br, by + bh);
        _cx.quadraticCurveTo(bx, by + bh, bx, by + bh - br);
        _cx.lineTo(bx, by + br);
        _cx.quadraticCurveTo(bx, by, bx + br, by);
        _cx.closePath();
        _cx.fillStyle = fill;
        _cx.globalAlpha = 0.75;
        _cx.fill();
        _cx.restore();
        // 文字
        _cx.save();
        _cx.font = `600 ${fz}px 'Plus Jakarta Sans',sans-serif`;
        _cx.fillStyle = '#ffffff';
        _cx.textAlign = 'center';
        _cx.textBaseline = 'middle';
        _cx.fillText(infoStr, pt.x, by + bh / 2);
        _cx.restore();
        above = by - 2 * S;
      }

      // 名字行
      if (_ei.name && p.n && p.n !== 'DefaultName') {
        _drawText(p.n, pt.x, above, `bold ${Math.round(10*S)}px 'Plus Jakarta Sans',sans-serif`, fill);
      }
    } else if ((isAI || isTeam) && p.n && p.n !== 'DefaultName') {
      const fz = isAI ? 9 : 10;
      _drawText(p.n, pt.x, above, `${isAI?'600':'bold'} ${Math.round(fz*S)}px sans-serif`, isAI ? '#8b949e' : fill);
    }

    // 距离（下方，旧版: 8px 600weight）——根据箭头方向自动避让
    {
      const dY = pt.y + R + _arrowDnExt + 6*S;
      _drawText(distLabel(lp.x, lp.y, lp.z||0), pt.x, dY, `600 ${Math.round(8*S)}px sans-serif`, fill);
    }

    // tooltip
    const hp = (p.mh > 0) ? `HP: ${Math.round(p.h||0)}/${Math.round(p.mh)}<br>` : '';
    _hitTargets.push({x:pt.x, y:pt.y, r:R, tip: `<b style="color:${fill}">${p.n||(isAI?'人机':'玩家')}</b><br>队伍: ${tid}<br>${hp}${isDowned?'<span style="color:#a0a0a0">倒地</span>':''}`});
  }

  // z=700: 队友
  _pTeam.forEach(p => _drawPlayer(p));
  // 观战：真自己作为队友（使用插值坐标）
  if (_isSpectTeam && _spectTeammate && data.self && data.self.x != null) {
    const _ls = _getLerpedSelf() || data.self;
    _drawPlayer({
      x: _ls.x, y: _ls.y, z: _ls.z,
      yw: _ls.yw, n: _ls.n || '自身',
      tm: 1, ai: 0, dn: 0, t: 0,
      h: null, mh: null, hr: 0, w: 0,
      hl: 0, ar: 0, hh: 0, hm: 0, ah: 0, am: 0
    });
  }
  // z=750: 倒地
  _pDowned.forEach(p => _drawPlayer(p));
  // z=800: 敌方（存活）
  _pEnemy.forEach(p => _drawPlayer(p));

  // z=1000: 自身标记（最上层，使用插值坐标）
  if (layerState.self && data.self && data.self.x != null) {
    let sx, sy, syw, sn;
    if (_isSpectTeam && _spectTeammate) {
      const _lt = _getLerped(_spectTeammate);
      sx = _lt.x; sy = _lt.y;
      syw = _lt.yw; sn = _spectTeammate.n;
    } else {
      const _ls = _getLerpedSelf() || data.self;
      sx = _ls.x; sy = _ls.y;
      syw = _ls.yw; sn = _ls.n;
    }
    const pt = _toScreen(sx, sy);
    if (_inView(pt.x, pt.y)) {
      const R = 8 * S, sFill = '#58a6ff';
      const _sYawDeg = (syw||0) + yawOff;
      _drawArrow(pt.x, pt.y, R, _sYawDeg, sFill, 'rgba(255,255,255,0.6)');
      _drawCircle(pt.x, pt.y, R, sFill, 'rgba(255,255,255,0.6)', 8);
      const realName = (sn && sn !== 'DefaultName') ? sn : '';
      if (realName) {
        const _sRad = (_sYawDeg - 90) * Math.PI / 180;
        const _sTipY = Math.sin(_sRad) * (R + R * 1.1);
        const _sUpExt = _sTipY < -R ? -_sTipY - R : 0;
        _drawText(realName, pt.x, pt.y - R - _sUpExt - 5*S, `bold ${Math.round(10*S)}px sans-serif`, sFill);
      }
      _hitTargets.push({x:pt.x, y:pt.y, r:R, tip: `<b style="color:#58a6ff">${realName||'自身'}</b>`});
    }
  }

  // 更新统计（侧边栏 + 浮动面板）
  const _cntI = (data.items||[]).length, _cntC = (data.containers||[]).length, _cntE = (data.exits||[]).length;
  document.getElementById('stP').textContent = cntP;
  document.getElementById('stA').textContent = cntA;
  document.getElementById('stD').textContent = cntD;
  // 顶部计数条
  const _pcP = document.getElementById('pcP'); if (_pcP) _pcP.textContent = cntP;
  const _pcA = document.getElementById('pcA'); if (_pcA) _pcA.textContent = cntA;
  const _pcD = document.getElementById('pcD'); if (_pcD) _pcD.textContent = cntD;
  document.getElementById('stI').textContent = _cntI;
  document.getElementById('stC').textContent = _cntC;
  document.getElementById('stE').textContent = _cntE;
  // 浮动统计面板（收缩侧边栏时）
  const _fs = document.getElementById('floatStats');
  if (_fs && _fs.classList.contains('show')) {
    document.getElementById('fsP').textContent = cntP;
    document.getElementById('fsA').textContent = cntA;
    document.getElementById('fsD').textContent = cntD;
    document.getElementById('fsI').textContent = _cntI;
    document.getElementById('fsC').textContent = _cntC;
    document.getElementById('fsE').textContent = _cntE;
  }
}
