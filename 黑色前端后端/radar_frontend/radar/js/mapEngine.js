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
  if (info.rotate) {
    lng = bj - (info.centerY + wy) / yB;
    lat = -bj + (info.centerX - wx) / xB;
  } else {
    lng = bj - (info.centerX - wx) / xB;
    lat = -bj - (info.centerY + wy) / yB;
  }
  return L.latLng(lat, lng);
}

function buildBounds(info) {
  const sw = L.latLng(0, 0);
  const ne = L.latLng((info.boundsH - 70) * -1, info.boundsW * -1);
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

    leafletMap.on('mousemove', function (e) {
      // 坐标显示已移除
    });

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

  // 基础地图层
  tileLayer = L.tileLayer(TILE_BASE + info.layer + '/{z}_{x}_{y}.jpg', {
    minZoom: info.minZoom,
    maxZoom: 8,
    maxNativeZoom: 4,
    noWrap: false,
    bounds: bounds,
    errorTileUrl: TILE_BASE + info.layer + '/0_0_0.jpg',
    tileSize: 256,
    zoomOffset: 0,
    keepBuffer: 16,
    updateWhenZooming: true,
    updateWhenIdle: false,
  }).addTo(leafletMap);

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
function switchMap(id) {
  const info = MAPS.find(m => m.id === id);
  if (!info || info === currentMapInfo) return;

  // 清除实体图层
  clearEntityLayers();

  currentMapInfo = info;
  initLeaflet(info);
  clearEntityLayers();

  document.querySelectorAll('.map-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  document.getElementById('sbMapName').textContent = '当前地图: ' + info.name;
}
