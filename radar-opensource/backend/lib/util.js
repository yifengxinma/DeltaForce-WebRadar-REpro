/**
 * util.js — relay 通用工具函数 (零状态依赖，可独立测试)
 *
 * 拆出动机:
 *   relay.js 1800 行 god file 里把 IP 解析、字符串净化、字节格式化、时间格式化等
 *   纯函数全部混在一起。这一层抽出后, relay.js 主文件减 ~150 行,
 *   且这些函数可以独立写单测 (require('./lib/util') 即可)。
 */

// ── IP 处理 ─────────────────────────────────────────
// 剥离 IPv4-mapped IPv6 前缀 (::ffff:1.2.3.4 → 1.2.3.4)
function cleanIP(raw) {
  if (!raw) return '';
  const s = raw.replace(/^::ffff:/, '');
  return s === '::1' ? '127.0.0.1' : s;
}

// 取真实客户端 IP; 仅 nginx 反代后 trustProxy=true 才信任 X-Forwarded-For, 否则防伪造
function clientIP(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return cleanIP(String(xff).split(',')[0].trim());
  }
  return cleanIP(req.socket && req.socket.remoteAddress);
}

// ── 字符串净化 (防经 WS 注入到前端 innerHTML 的 XSS) ─
function sanitizeRelayString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/[<>`\u0000-\u001f]/g, (c) => (c === '`' ? "'" : ''));
}

function sanitizeRelayValue(v) {
  if (typeof v === 'string') return sanitizeRelayString(v);
  if (Array.isArray(v)) return v.map(sanitizeRelayValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = sanitizeRelayValue(v[k]);
    return out;
  }
  return v;
}

// 净化 pub 文本载荷, 复用解析后的对象避免下游重复 JSON.parse (热路径优化)
function sanitizePubPayloadEx(raw) {
  try {
    const clean = sanitizeRelayValue(JSON.parse(raw));
    return { str: JSON.stringify(clean), obj: clean };
  } catch (e) {
    return { str: sanitizeRelayString(raw), obj: null };
  }
}

// 快速从已知含 "type":"X" 的 JSON 字符串里提取 type, 避免全量 parse
function extractType(str) {
  const i = str.indexOf('"type":"');
  if (i === -1) return null;
  const start = i + 8;
  const end = str.indexOf('"', start);
  return end > start ? str.substring(start, end) : null;
}

// ── 房间 key 校验 + 游戏地图前缀匹配 ─────────────────
const MAP_PREFIXES = [
  'Dam_Iris_Level', 'OLDCITY_LEVEL', 'Forrest_Level',
  'SpaceCenter_Level', 'Brakkesh_Level', 'Tide_Level',
  'AZ-5_Level',   // AZ3 核电站 (AZ-5_Level1/2/3)
  'BombDefusal_Watch',   // 航天中转站
  'BombDefusal_Dock',    // 蓝水屋电站
  'BombDefusal_Mansion', // 萨米尔山庄
];

function isGameMap(name) {
  if (!name) return false;
  for (let i = 0; i < MAP_PREFIXES.length; i++) {
    if (name.startsWith(MAP_PREFIXES[i])) return true;
  }
  return false;
}

// 房间号格式: 1-64 字符, 仅 [字母数字 _ . - |]
function isValidRoomKey(key) {
  return typeof key === 'string' && key.length >= 1 && key.length <= 64
    && /^[\w.\-|]+$/.test(key);
}

// ── 时长/字节格式化 ─────────────────────────────────
function fmtDuration(ms) {
  if (ms <= 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  const h = Math.floor(s / 3600);
  return h + 'h' + Math.floor((s % 3600) / 60) + 'm';
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

// 当前北京时间日期串 YYYY-MM-DD (UTC+8)
function todayStr() {
  const d = new Date(Date.now() + 8 * 3600000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

module.exports = {
  cleanIP, clientIP,
  sanitizeRelayString, sanitizeRelayValue, sanitizePubPayloadEx,
  extractType,
  MAP_PREFIXES, isGameMap, isValidRoomKey,
  fmtDuration, fmtBytes, todayStr,
};
