// ============================================================
// 地图配置（从官方地图工具 JS 解析）
// 瓦片：由 config.js 指定资源目录
// 烽火 jpg：…/img/{layer}/{z}_{x}_{y}.jpg
// 黑潮爆破 png：…/img/{layer}/{z}_{x}_{y}.png（见 tileExt）
// ============================================================
const TILE_BASE = RADAR_CONFIG.tileBase ? RADAR_CONFIG.tileBase.replace(/\/?$/, '/') : '';

const MAPS = [
  {
    id: 'daba', name: '零号大坝', layer: 'map_db',
    boundsW: -250, boundsH: 250,
    minZoom: 3, initZoom: 3, initX: -85, initY: 110,
    centerX: 358155.6875, centerY: 750191.75,
    width: 81086.304688, height: 80988.5,
    rotate: false,
    originX: 357426.3, originY: -769916.0,
  },
  {
    id: 'cgxg', name: '长弓溪谷', layer: 'map_yc',
    boundsW: -250, boundsH: 320,
    minZoom: 3, initZoom: 3, initX: -135, initY: 110,
    centerX: 330551.75, centerY: 639913.875,
    width: 112800, height: 112800,
    rotate: true,
    originX: 405944.3, originY: -654007,
  },
  {
    id: 'htjd', name: '航天基地', layer: 'map_htjd',
    boundsW: -250, boundsH: 320,
    minZoom: 3, initZoom: 3, initX: -115, initY: 110,
    centerX: 669337.0, centerY: 446449.75,
    width: 65442.871094, height: 65442.871094,
    rotate: false,
    originX: 668761, originY: -452739,
  },
  {
    id: 'bks', name: '巴克什', layer: 'map_bks2',
    boundsW: -250, boundsH: 300,
    minZoom: 3, initZoom: 3, initX: -110, initY: 110,
    centerX: 380000.0, centerY: 456000.0,
    width: 60000, height: 60000,
    rotate: false,
    originX: 378659, originY: -448791,
  },
  {
    id: 'cxjy', name: '潮汐监狱', layer: 'map_cxjy',
    boundsW: -250, boundsH: 300,
    minZoom: 2.5, initZoom: 2.5, initX: -135, initY: 150,
    centerX: 50383.464844, centerY: 51155.902344,
    width: 36596.421875, height: 36596.421875,
    rotate: false,
    originX: 53232, originY: -51924,
  },
  {
    // S10「裂变」AZ3 核电站 · 官方 map_az3.js (2026-06-26)
    // rotate=-90 → mapEngine rotate<0 分支；朝向 yawOff=0（与 +90 图互为 180° 镜像）
    // originX/Y：preview=1 校准 · MapX 合法区间约 17.5万~24.1万
    id: 'az3', name: 'AZ3核电站', layer: 'map_az3',
    boundsW: -250, boundsH: 300,
    minZoom: 2.6, initZoom: 2.6, initX: -105, initY: 110,
    centerX: 197518.906250, centerY: 204814.046875,
    width: 80999.179688, height: 80831.398438,
    rotate: -90,
    originX: 213221, originY: -199347,
  },
  // ── 黑潮爆破（BombDefusal）三图 · 瓦片 png · maxBounds 完整 256×256（boundsPad:0）──
  // 注意：航天中转站 id=htzzz，瓦片目录是 map_htzz（少一个 z）
  {
    id: 'htzzz', name: '航天中转站', layer: 'map_htzz',
    boundsW: -256, boundsH: 256, boundsPad: 0,
    minZoom: 2, initZoom: 2, initX: -125, initY: 130,
    centerX: 67177.75, centerY: 126823.210938,
    width: 8646.368164, height: 8646.368164,
    rotate: false,
    originX: 66745, originY: -126312,
    tileExt: 'png', maxNativeZoom: 3,
  },
  {
    id: 'lswdz', name: '蓝水屋电站', layer: 'map_lswdz',
    boundsW: -256, boundsH: 256, boundsPad: 0,
    minZoom: 2, initZoom: 2.2, initX: -115, initY: 130,
    centerX: 97132.992188, centerY: 53532.332031,
    width: 7565.885254, height: 7565.885254,
    rotate: false,
    originX: 98723, originY: -52396,
    tileExt: 'png', maxNativeZoom: 3,
  },
  {
    id: 'smezy', name: '萨米尔山庄', layer: 'map_smezy',
    boundsW: -256, boundsH: 256, boundsPad: 0,
    minZoom: 2, initZoom: 2.2, initX: -115, initY: 130,
    centerX: 91930.156250, centerY: 140600.812500,
    width: 8820.758789, height: 8825.270508,
    rotate: false,
    originX: 92376, originY: -140472,
    tileExt: 'png', maxNativeZoom: 3,
  },
];

// ============================================================
// 各地图区域名称数据（来自官方 selectRegion 变量）
// ============================================================
const REGIONS = {
  daba: [
    { name:'行政辖区', x:364598.8125,  y:-787795.0 },
    { name:'军营',     x:336667.7813,  y:-793117.8125 },
    { name:'水泥厂',   x:336179.1875,  y:-776354.5625 },
    { name:'主变电站', x:371413.0625,  y:-768131.25 },
    { name:'游客中心', x:392334.9063,  y:-750165.75 },
    { name:'管道区域', x:325340.7188,  y:-795599.5 },
  ],
  cgxg: [
    { name:'钻石皇后酒店', x:360745.0,    y:-630639.0 },
    { name:'储藏站',       x:298737.0313, y:-668689.4375 },
    { name:'加尔比旧址',   x:336727.0313, y:-579967.75 },
    { name:'变电站',       x:323579.6875, y:-616961.75 },
    { name:'哈夫克雷达站', x:290285.0,    y:-643214.0 },
    { name:'坠机之地',     x:356261.3438, y:-605116.9375 },
    { name:'小型庄园',     x:327072.9063, y:-591510.125 },
    { name:'小火车站',     x:335455.0,    y:-696411.8125 },
    { name:'检查站',       x:376988.7813, y:-612207.8125 },
    { name:'沙径牧场',     x:363137.7813, y:-581411.0 },
    { name:'荒废村庄',     x:350609.75,   y:-699726.1875 },
    { name:'蓝港码头',     x:376141.4063, y:-661328.625 },
    { name:'超星车站',     x:313810.3125, y:-637010.125 },
    { name:'阿米亚小镇',   x:334500.5938, y:-665446.3125 },
  ],
  htjd: [
    { name:'宿舍区',     x:645867.5625, y:-466951.3125 },
    { name:'中控区',     x:668165.3125, y:-476720.125 },
    { name:'中控桥',     x:669290.0625, y:-467892.8125 },
    { name:'工业区',     x:693125.125,  y:-465743.4063 },
    { name:'罐装区',     x:695899.0,    y:-449906.0 },
    { name:'离心机室',   x:663031.5625, y:-450335.0 },
    { name:'浮力室',     x:664288.5,    y:-456228.0 },
    { name:'蓝室',       x:675051.875,  y:-458452.1563 },
    { name:'黑室',       x:672668.4375, y:-451858.3125 },
    { name:'总裁室',     x:668804.5,    y:-451270.4375 },
    { name:'中心花园',   x:668846.0625, y:-443144.625 },
    { name:'水平试车场', x:684612.5625, y:-430689.0 },
    { name:'发射区',     x:658622.875,  y:-418851.5938 },
  ],
  bks: [
    { name:'皇家博物馆',   x:378916.1563, y:-459727.375 },
    { name:'阿萨拉营地',   x:396219.3438, y:-467645.5313 },
    { name:'樱桃小镇',     x:360747.1875, y:-479303.7813 },
    { name:'巴克什集市',   x:382193.0938, y:-471524.8125 },
    { name:'蓝调山城',     x:397693.1875, y:-481304.0 },
    { name:'巴克什大浴场', x:380123.4688, y:-480585.6875 },
    { name:'蓝汀旅馆',     x:366486.875,  y:-469968.25 },
    { name:'停车场',       x:374720.0,    y:-471518.6875 },
    { name:'阿坦亚遗址',   x:365633.0938, y:-460216.125 },
  ],
  cxjy: [
    { name:'行政区',     x:50681.2266,  y:-46910.4063 },
    { name:'卸货区',     x:39098.8828,  y:-46719.1914 },
    { name:'东侧上层入口', x:54663.7461, y:-53846.5586 },
    { name:'西侧上层入口', x:45505.5,    y:-53846.5586 },
    { name:'电梯井',     x:50694.9766,  y:-54296.4727 },
    { name:'医疗实验区', x:56148.1406,  y:-46268.1328 },
    { name:'禁闭区',     x:61580.793,   y:-49258.8359 },
    { name:'牢房',       x:59362.125,   y:-57157.1563 },
    { name:'施工区',     x:62977.3047,  y:-63904.8359 },
    { name:'潮汐控制室', x:51696.8477,  y:-65976.9219 },
    { name:'东侧小岛',   x:75549.3906,  y:-56491.5234 },
    { name:'东瞭望台区', x:65006.8086,  y:-36544.6172 },
    { name:'西瞭望台区', x:36673.5977,  y:-39682.4219 },
    { name:'蓄水区',     x:54200.1133,  y:-33264.4844 },
    { name:'囚犯活动区', x:42722.6641,  y:-60414.3438 },
    { name:'水动力渠',   x:39293.2734,  y:-60839.9453 },
  ],
  // AZ3 核电站（官方 map_az3.js selectRegion_az3，共 13 个）
  az3: [
    { name:'RBMK反应堆',  x:215006, y:-204707 },
    { name:'应急火电站',  x:219034, y:-233543 },
    { name:'应急火电站',  x:239483, y:-233543 },
    { name:'老科学院',    x:191250, y:-227472 },
    { name:'乏燃料处理厂', x:194307, y:-244886 },
    { name:'后处理厂',    x:175587, y:-240315 },
    { name:'运输仓库',    x:178761, y:-212617 },
    { name:'海水处理区',  x:205218, y:-159762 },
    { name:'海边办公楼',  x:186027, y:-158749 },
    { name:'仿星器研究所', x:212221, y:-173796 },
    { name:'压水堆',      x:227609, y:-170624 },
    { name:'废水堆放区',  x:241325, y:-170903 },
    { name:'石棺',        x:231919, y:-205798 },
  ],
};

// ============================================================
// 游戏常量表
// ============================================================
// 品级色：对齐 EspOverlay QualityColor / TLP（0灰 1白灰 2绿 3蓝 4紫 5橙 6红）
const ITEM_Q_COLORS = ['#9ca3af','#e2e8f0','#4ade80','#60a5fa','#a855f7','#f59e0b','#ff0000'];
const CTN_NAMES  = {1:'大保险箱',2:'小保险箱'};
// 干员：短号 + 8800 全 ID（EXE 发 hr=88000000051）；查不到则显示原 ID
const HERO_NAMES = {
  25:'威龙',26:'骇爪',27:'蜂医',28:'露娜',29:'牧羊人',30:'红狼',
  35:'乌鲁鲁',36:'蛊',37:'深蓝',38:'无名',39:'疾风',40:'银翼',41:'比特',
  42:'赤枭',43:'卫队副官',44:'卫队副官',45:'蝶',46:'回响',47:'液氮',
  48:'德穆兰',49:'德穆兰副官',50:'德穆兰副官',51:'旅人',
  88000000025:'威龙',88000000026:'骇爪',88000000027:'蜂医',88000000028:'露娜',
  88000000029:'牧羊人',88000000030:'红狼',88000000035:'乌鲁鲁',88000000036:'蛊',
  88000000037:'深蓝',88000000038:'无名',88000000039:'疾风',88000000040:'银翼',
  88000000041:'比特',88000000042:'赤枭',88000000043:'卫队副官',88000000044:'卫队副官',
  88000000045:'蝶',88000000046:'回响',88000000047:'液氮',88000000048:'德穆兰',
  88000000049:'德穆兰副官',88000000050:'德穆兰副官',88000000051:'旅人'
};
const WEAPON_NAMES = {
  18020000001:'MP5',18020000002:'P90',18020000003:'Vector',18020000004:'UZI',
  18020000005:'野牛',18020000006:'SMG-45',18020000008:'SR-3M',18020000009:'勇士',
  18020000010:'MP7',18020000011:'QCQ171',18020000012:'MK4',
  18070000002:'QSZ92G',18070000003:'.357左轮',18070000004:'沙漠之鹰',18070000005:'G18',
  18070000006:'93R',18070000010:'G17',18070000033:'M1911',18070000030:'激素枪',
  18010000001:'M4A1',18010000006:'AKM',18010000008:'QBZ95-1',18010000010:'AKS-74U',
  18010000012:'ASh-12',18010000013:'K416',18010000014:'M16A4',18010000015:'AUG',
  18010000016:'M7',18010000017:'SG552',18010000018:'AK-12',18010000021:'SCAR-H',
  18010000023:'G3',18010000024:'PTR-32',18010000031:'CAR-15',18010000037:'AS VAL',
  18010000038:'腾龙',18010000040:'K437',18010000042:'KC17',18010000043:'MK47',
  18010000044:'MCX',18010000045:'AR57',18010000049:'RM277突击',
  18050000002:'Mini-14',18050000003:'VSS',18050000004:'SVD',18050000005:'M14',
  18050000006:'SKS',18050000007:'SR-25',18050000008:'SR9',18050000031:'PSG-1',
  18050000032:'杠杆步枪',18050000033:'SVCH',
  18060000007:'SV-98',18060000008:'R93',18060000009:'M700',18060000011:'AWM',
  18040000001:'PKM',18040000002:'M249',18040000003:'M250',18040000004:'QJB201',
  18040000008:'机枪',
  18030000001:'M1014',18030000002:'S12K',18030000004:'M870',18030000005:'725双管',
  18030000006:'FS-12',18150000001:'复合弓',18110000000:'空手'
};

// EXE 发 8800 全 ID；优先 HERO_NAMES / 短号，再 items/heroes.json；查不到显示原 ID
function resolveHeroName(hr) {
  if (hr == null || hr === '' || hr === 0 || hr === '0') return '';
  const raw = String(hr).trim();
  if (!raw) return '';
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return raw;
  const asInt = Math.trunc(n);
  let hit = HERO_NAMES[asInt] || HERO_NAMES[String(asInt)] || HERO_NAMES[raw];
  if (hit) return hit;
  // 88000000051 → 51（不等待异步 json）
  if (asInt >= 88000000000 && asInt <= 88999999999) {
    const short = asInt - 88000000000;
    hit = HERO_NAMES[short] || HERO_NAMES[String(short)];
    if (hit) return hit;
  }
  const full = String(asInt);
  if (typeof getHeroNameById === 'function') {
    const t = getHeroNameById(full);
    if (t) return t;
  }
  if (typeof getItemNameById === 'function') {
    const t = getItemNameById(full);
    if (t) return t;
  }
  if (asInt > 0 && asInt < 1000) {
    const fullId = '88000000' + String(asInt).padStart(3, '0');
    hit = HERO_NAMES[Number(fullId)] || HERO_NAMES[fullId];
    if (hit) return hit;
    if (typeof getHeroNameById === 'function') {
      const t = getHeroNameById(fullId);
      if (t) return t;
    }
    if (typeof getItemNameById === 'function') {
      const t = getItemNameById(fullId);
      if (t) return t;
    }
  }
  return full;
}

function resolveWeaponName(w) {
  if (w == null || w === '' || w === 0 || w === '0') return '';
  const key = (typeof w === 'number' && Number.isFinite(w)) ? Math.trunc(w) : w;
  if (WEAPON_NAMES[key]) return WEAPON_NAMES[key];
  const s = String(key);
  if (WEAPON_NAMES[s]) return WEAPON_NAMES[s];
  if (typeof getItemNameById === 'function') {
    const t = getItemNameById(s);
    if (t) return t;
  }
  return s;
}
if (typeof window !== 'undefined') {
  window.resolveHeroName = resolveHeroName;
  window.resolveWeaponName = resolveWeaponName;
}
// 敌方队伍颜色（已排除与队友绿#50ff78、自身蓝#58a6ff、AI灰#8b949e 相近的颜色）
const TEAM_COLORS = [
  '#e63c3c','#ff6f00','#ffbe28','#a03ce6','#ff4081','#ff50a0','#e040fb','#ffe632',
  '#ff8c00','#d500f9','#f06292','#ff7043','#ff6e40','#ffab00','#c51162','#c6ff00',
  '#f44336','#ff5722','#ff9800','#9c27b0','#ab47bc','#e91e63','#ff1744','#cddc39',
  '#ef5350','#d81b60','#ffc107','#673ab7','#ff8a65','#ce93d8','#ff3d00','#ffeb3b'
];
const lvColor = (lv) => lv>=6?'#FF0000':lv==5?'#FFFF00':lv==4?'#9400D3':lv==3?'#00BFFF':lv==2?'#00FF00':lv==1?'#FFFFFF':'#808080';

// ── 地图名前缀匹配表（模糊匹配，兼容 Level1/Level2/Level11 等后缀）──
const MAP_PREFIX_TABLE = [
  { prefix: 'Dam_Iris_Level',    key: 'daba',    name: '零号大坝'   },
  { prefix: 'OLDCITY_LEVEL',     key: 'daba',    name: '零号大坝'   },
  // 注意：Iris_Entry 是大厅/靶场入口，不是对局图。勿映射到 daba，
  // 否则回大厅时 resolveMapKey 仍返回有效 key，残留实体不会被清空。
  { prefix: 'Forrest_Level',     key: 'cgxg',    name: '长弓溪谷'   },
  { prefix: 'SpaceCenter_Level', key: 'htjd',    name: '航天基地'   },
  { prefix: 'Brakkesh_Level',    key: 'bks',     name: '巴克什'     },
  { prefix: 'Tide_Level',        key: 'cxjy',    name: '潮汐监狱'   },
  // AZ-5 是切尔诺贝利紧急停堆按钮代号，开发内部命名致敬；PR 文案对外统一叫 AZ3
  { prefix: 'AZ-5_Level',        key: 'az3',     name: 'AZ3核电站'  },
  // 黑潮爆破：BombDefusal_Watch / _Watch_P 等均 startsWith 命中
  { prefix: 'BombDefusal_Watch',   key: 'htzzz', name: '航天中转站' },
  { prefix: 'BombDefusal_Dock',    key: 'lswdz', name: '蓝水屋电站' },
  { prefix: 'BombDefusal_Mansion', key: 'smezy', name: '萨米尔山庄' },
];

function resolveMapKey(mapName) {
  if (!mapName) return null;
  for (const { prefix, key } of MAP_PREFIX_TABLE) {
    if (mapName.startsWith(prefix)) return key;
  }
  // 未匹配时打一次日志，方便回填新图前缀；大厅 / 主菜单也会走到这（值如 "Lobby_xxx"），
  // 用 Set 去重避免刷屏。改 prefix 表后页面刷新会重新触发。
  resolveMapKey._unknownLogged = resolveMapKey._unknownLogged || new Set();
  if (!resolveMapKey._unknownLogged.has(mapName)) {
    resolveMapKey._unknownLogged.add(mapName);
    console.warn('[radar] unknown map name (未匹配任何 MAP_PREFIX_TABLE):', mapName);
  }
  return null;
}
