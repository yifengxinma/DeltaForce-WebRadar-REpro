// ============================================================
// Leaflet 地图引擎 + 坐标转换 + 区域标签
// ============================================================
let leafletMap = null;
let tileLayer = null;
let currentMapInfo = null;
let regionLayer = null;
let showRegions = true;

// 游戏世界坐标 → Leaflet CRS.Simple 坐标
// 输入为原始 UE 坐标（DLL 直接传输，不再 /100）
function toMapCoord(worldX, worldY, info) {
  let wx = worldX, wy = worldY;
  if (info.originX !== undefined) {
    wx = worldX + info.originX;
    wy = worldY + info.originY;
  }
  const bj = 128;
  const xB = info.width / bj;
  const yB = info.height / bj;
  let lat, lng;
  // rotate 取值约定：truthy 走旋转 90°（cgxg）；数值 < 0 走逆时针 90°（az3 等）；
  // 0/false/undefined 不旋转（daba/htjd/bks/cxjy）。+90 与 -90 互为 180° 镜像。
  if (typeof info.rotate === 'number' && info.rotate < 0) {
    lng = bj + (info.centerY + wy) / yB;
    lat = -bj - (info.centerX - wx) / xB;
  } else if (info.rotate) {
    lng = bj - (info.centerY + wy) / yB;
    lat = -bj + (info.centerX - wx) / xB;
  } else {
    lng = bj - (info.centerX - wx) / xB;
    lat = -bj - (info.centerY + wy) / yB;
  }
  return L.latLng(lat, lng);
}

// toMapCoord 的反函数：Leaflet 坐标 → 游戏世界坐标
// 用于鼠标悬停校准（preview=1 时启用）：浏览器显示的坐标系跟游戏 DLL 推上来的一致，
// 用户在游戏里站到某点 + 浏览器鼠标移到同点，差值就是 originX/originY 校准量。
function fromMapCoord(latLng, info) {
  const bj = 128;
  const xB = info.width / bj;
  const yB = info.height / bj;
  const lng = latLng.lng, lat = latLng.lat;
  let wx, wy;
  if (typeof info.rotate === 'number' && info.rotate < 0) {
    wy = (lng - bj) * yB - info.centerY;
    wx = info.centerX + (lat + bj) * xB;
  } else if (info.rotate) {
    wy = -((bj - lng) * yB) - info.centerY;
    wx = info.centerX - (lat + bj) * xB;
  } else {
    wx = info.centerX - (bj - lng) * xB;
    wy = -((lat + bj) * yB) - info.centerY;
  }
  // 反向 origin 偏移（origin 是 DLL→瓦片的平移；反向就 DLL=瓦片-origin）
  if (info.originX !== undefined) {
    wx -= info.originX;
    wy -= info.originY;
  }
  return { x: wx, y: wy };
}

function buildBounds(info) {
  // 烽火图默认裁掉上方约 70 单位空白；黑潮爆破图 boundsPad:0 用完整 256×256
  const pad = (info.boundsPad !== undefined) ? info.boundsPad : 70;
  const sw = L.latLng(0, 0);
  const ne = L.latLng((info.boundsH - pad) * -1, info.boundsW * -1);
  return L.latLngBounds(sw, ne);
}

function initLeaflet(info) {
  const bounds = buildBounds(info);

  if (!leafletMap) {
    leafletMap = L.map('map', {
      crs: L.CRS.Simple,
      attributionControl: false,
      zoomControl: true,
      maxBoundsViscosity: 0.9,
      minZoom: 1,
      maxZoom: 8,
      zoomSnap: 0.25,
      zoomDelta: 0.25,
      wheelDebounceTime: 10,
      zoomAnimation: true,
      fadeAnimation: true,
    });

    // ── 鼠标悬停显示游戏世界坐标 (仅 URL 含 preview=1 启用，用于 origin 校准) ──
    // 浮窗跟随鼠标移动，避免被公告 fab/进度条/铃铛等任何固定 UI 遮挡。
    if (/[?&]preview=1\b/.test(window.location.search)) {
      let coordEl = document.getElementById('mouseCoord');
      if (!coordEl) {
        coordEl = document.createElement('div');
        coordEl.id = 'mouseCoord';
        coordEl.style.cssText = 'position:fixed;left:0;top:0;background:rgba(0,0,0,0.78);color:#fff;padding:4px 8px;font:11px/1.4 Menlo,Consolas,monospace;border-radius:3px;z-index:9999;pointer-events:none;white-space:nowrap;letter-spacing:0.5px;display:none';
        coordEl.textContent = 'X: -, Y: -';
        document.body.appendChild(coordEl);
      }
      leafletMap.on('mousemove', function (e) {
        if (!currentMapInfo) return;
        const w = fromMapCoord(e.latlng, currentMapInfo);
        // 显示官方地图坐标（与 REGIONS/瓦片同系），便于和本人 DLL 原始值配对算 origin
        const ox = currentMapInfo.originX || 0;
        const oy = currentMapInfo.originY || 0;
        const mapX = Math.round(w.x + ox);
        const mapY = Math.round(w.y + oy);
        coordEl.textContent = 'Map: ' + mapX.toLocaleString() + '   Y: ' + mapY.toLocaleString();
        coordEl.style.display = 'block';
        const ev = e.originalEvent;
        if (!ev) return;
        const margin = 14;
        const rect = coordEl.getBoundingClientRect();
        let x = ev.clientX + margin, y = ev.clientY + margin;
        if (x + rect.width  > window.innerWidth  - 4) x = ev.clientX - rect.width  - margin;
        if (y + rect.height > window.innerHeight - 4) y = ev.clientY - rect.height - margin;
        if (x < 4) x = 4;
        if (y < 4) y = 4;
        coordEl.style.left = x + 'px';
        coordEl.style.top  = y + 'px';
      });
      leafletMap.on('mouseout', function () {
        coordEl.style.display = 'none';
      });
    } else {
      leafletMap.on('mousemove', function (e) {});
    }

    function _pauseFollow() {
      if (_followMode) { _followPaused = true; clearTimeout(_followResumeTimer); }
    }
    function _resumeFollow() {
      if (_followMode && _followPaused) {
        clearTimeout(_followResumeTimer);
        _followResumeTimer = setTimeout(function () { _followPaused = false; }, 1500);
      }
    }
    leafletMap.on('dragstart', _pauseFollow);
    leafletMap.on('dragend', _resumeFollow);

    if (!_cvs) _initCanvas();
  }

  // 替换瓦片层
  if (tileLayer) leafletMap.removeLayer(tileLayer);

  // 基础地图层（烽火默认 jpg / maxNativeZoom:4；爆破图见 mapConfig tileExt / maxNativeZoom）
  const tileExt = info.tileExt || 'jpg';
  const maxNativeZoom = (info.maxNativeZoom !== undefined) ? info.maxNativeZoom : 4;
  tileLayer = TILE_BASE ? L.tileLayer(TILE_BASE + info.layer + '/{z}_{x}_{y}.' + tileExt, {
    minZoom: info.minZoom,
    maxZoom: 8,
    maxNativeZoom: maxNativeZoom,
    noWrap: false,
    bounds: bounds,
    errorTileUrl: TILE_BASE + info.layer + '/0_0_0.' + tileExt,
    tileSize: 256,
    zoomOffset: 0,
    keepBuffer: 16,
    updateWhenZooming: true,
    updateWhenIdle: false,
  }).addTo(leafletMap) : null;

  leafletMap.setMaxBounds(bounds);
  leafletMap.setMinZoom(info.minZoom);
  leafletMap.setView([info.initX, info.initY], info.initZoom, {animate:false});

  renderRegions(info);
}

// ============================================================
// 区域名称标签
// ============================================================
function renderRegions(info) {
  if (regionLayer) {
    leafletMap.removeLayer(regionLayer);
    regionLayer = null;
  }
  if (!showRegions) return;
  const data = REGIONS[info.id];
  if (!data || !data.length) return;

  regionLayer = L.layerGroup();
  // REGIONS 坐标来自官方地图工具，不需要 originX/Y 偏移
  const infoNoOrigin = Object.assign({}, info, {originX: undefined, originY: undefined});
  data.forEach(function(r) {
    const pos = toMapCoord(r.x, r.y, infoNoOrigin);
    const icon = L.divIcon({
      className: 'map-region-name',
      html: '<span style="display:inline-block;transform:translate(-50%,-50%);white-space:nowrap;font-size:11px;font-weight:600;color:rgba(255,255,255,0.88);text-shadow:0 0 3px #000,0 0 3px #000,1px 1px 4px #000;pointer-events:none;letter-spacing:0.3px">' + r.name + '</span>',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    L.marker(pos, { icon: icon, interactive: false, keyboard: false }).addTo(regionLayer);
  });
  regionLayer.addTo(leafletMap);
}

function toggleRegions() {
  showRegions = !showRegions;
  const btn = document.getElementById('btnRegion');
  btn.classList.toggle('active', showRegions);
  if (showRegions) {
    renderRegions(currentMapInfo);
  } else if (regionLayer) {
    leafletMap.removeLayer(regionLayer);
    regionLayer = null;
  }
}

// ============================================================
// 地图切换
// ============================================================
function tryAutoSwitchMap(mapName) {
  if (!mapName) return false;
  const mapKey = resolveMapKey(mapName);
  if (!mapKey) return false;
  if (!currentMapInfo || currentMapInfo.id !== mapKey) {
    const info = MAP_PREFIX_TABLE.find(m => m.key === mapKey);
    switchMap(mapKey);
    if (typeof showToast === 'function') showToast('自动切换: ' + (info ? info.name : mapKey));
  }
  return true;
}

function switchMap(id) {
  const info = MAPS.find(m => m.id === id);
  if (!info || info === currentMapInfo) return;

  // 清除实体图层
  clearEntityLayers();

  currentMapInfo = info;
  initLeaflet(info);
  clearEntityLayers();

  document.querySelectorAll('.map-tab').forEach(t => t.classList.remove('active'));
  const tabEl = document.getElementById('tab-' + id);
  if (tabEl) tabEl.classList.add('active');
  const sb = document.getElementById('sbMapName');
  if (sb) sb.textContent = '当前地图: ' + info.name;
}
