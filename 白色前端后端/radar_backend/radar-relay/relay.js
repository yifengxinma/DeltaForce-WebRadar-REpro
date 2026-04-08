/**
 * WebSocket Relay Server — 实时转发 + 50ms 节流版
 * 收到 pub 数据立即转发，但每个 subscriber 50ms 内只转发一次
 * 50ms 内的后续数据直接丢弃，防止突发卡顿
 */
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');

// 剥离 IPv4-mapped IPv6 前缀 (::ffff:1.2.3.4 → 1.2.3.4)
function cleanIP(raw) {
  if (!raw) return '';
  const s = raw.replace(/^::ffff:/, '');
  return s === '::1' ? '127.0.0.1' : s;
}

const PORT = parseInt(process.env.PORT || '5000', 10);
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '1377', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const adminTokens = new Set(); // active session tokens
const MAX_SUBS = 4;
const THROTTLE_MS = 50; // 每个 sub 50ms 内只允许收一次数据

// ── 全局流量统计 ──
const gTraffic = {
  dlTotal: 0, ulTotal: 0,           // 累计下载(pub→server)/上传(server→sub)
  dlWin: 0, ulWin: 0, winStart: Date.now(),
  dlPerSec: 0, ulPerSec: 0,
};
function gTrafficTick() {
  const now = Date.now();
  if (now - gTraffic.winStart >= 1000) {
    gTraffic.dlPerSec = gTraffic.dlWin;
    gTraffic.ulPerSec = gTraffic.ulWin;
    gTraffic.dlWin = 0;
    gTraffic.ulWin = 0;
    gTraffic.winStart = now;
  }
}
setInterval(() => {
  // 2秒无数据归零
  if (Date.now() - gTraffic.winStart >= 2000) {
    gTraffic.dlPerSec = 0; gTraffic.ulPerSec = 0;
    gTraffic.dlWin = 0; gTraffic.ulWin = 0;
    gTraffic.winStart = Date.now();
  }
}, 2000);

// ══════════════════════════════════════════════════════════
// 反滥用系统：限流 + 渐进封禁
// ══════════════════════════════════════════════════════════

// IP 封禁表: Map<ip, { until: number, level: number, reason: string }>
// level 0=未封, 1=1min, 2=10min, 3=30min, 4=60min
const ipBans = new Map();
const BAN_DURATIONS = [0, 60_000, 600_000, 1_800_000, 3_600_000]; // ms

function isIPBanned(ip) {
  const ban = ipBans.get(ip);
  if (!ban) return false;
  if (Date.now() >= ban.until) { ipBans.delete(ip); _dbDeleteBan(ip, 'relay'); return false; }
  return true;
}

function banIP(ip, reason) {
  const prev = ipBans.get(ip);
  const level = prev ? Math.min(prev.level + 1, BAN_DURATIONS.length - 1) : 1;
  const duration = BAN_DURATIONS[level];
  const until = Date.now() + duration;
  ipBans.set(ip, { until, level, reason });
  _dbUpsertBan(ip, 'relay', until, level, reason);
  console.log(`[BAN] ip=${ip} level=${level} duration=${duration/1000}s reason=${reason}`);
}

// ── 认证限流: 1秒10次, 全错冷却2s, 持续滥用封IP ──
// Map<ip, { count: number, windowStart: number, failStreak: number, coolUntil: number }>
const authLimits = new Map();
const AUTH_RATE = 10;       // 每秒最多10次
const AUTH_COOLDOWN = 2000; // 全错冷却2s

function checkAuthRate(ip) {
  const now = Date.now();
  let al = authLimits.get(ip);
  if (!al) {
    al = { count: 0, windowStart: now, failStreak: 0, coolUntil: 0 };
    authLimits.set(ip, al);
  }
  // 冷却中
  if (now < al.coolUntil) return false;
  // 窗口重置
  if (now - al.windowStart >= 1000) {
    al.count = 0;
    al.windowStart = now;
  }
  al.count++;
  if (al.count > AUTH_RATE) {
    al.failStreak++;
    if (al.failStreak >= 2) {
      // 冷却后还在刷 → 封IP
      banIP(ip, 'auth_flood');
      authLimits.delete(ip);
      return false;
    }
    // 第一次超限 → 冷却2s
    al.coolUntil = now + AUTH_COOLDOWN;
    return false;
  }
  return true;
}

function onAuthFail(ip) {
  const al = authLimits.get(ip);
  if (al) al.failStreak++;
}

function onAuthSuccess(ip) {
  // 认证成功，重置失败计数
  const al = authLimits.get(ip);
  if (al) { al.failStreak = 0; al.coolUntil = 0; }
}

// ── DLL传输限流: 1秒100次, 单条500KB, 异常渐进封禁 ──
// Map<ip, { count: number, windowStart: number }>
const pubLimits = new Map();
const PUB_RATE = 100;          // 每秒最多100条
const PUB_MAX_SIZE = 500_000;  // 单条最大500KB

function checkPubRate(ip, dataSize) {
  // 单条大小检查
  if (dataSize > PUB_MAX_SIZE) {
    banIP(ip, `msg_too_large(${(dataSize/1024).toFixed(1)}KB)`);
    return false;
  }
  const now = Date.now();
  let pl = pubLimits.get(ip);
  if (!pl) {
    pl = { count: 0, windowStart: now };
    pubLimits.set(ip, pl);
  }
  if (now - pl.windowStart >= 1000) {
    pl.count = 0;
    pl.windowStart = now;
  }
  pl.count++;
  if (pl.count > PUB_RATE) {
    banIP(ip, 'pub_flood');
    pubLimits.delete(ip);
    return false;
  }
  return true;
}

// 定期清理过期记录（每60s）
setInterval(() => {
  const now = Date.now();
  for (const [ip, ban] of ipBans) { if (now >= ban.until) { ipBans.delete(ip); _dbDeleteBan(ip, 'relay'); } }
  for (const [ip, al] of authLimits) { if (now - al.windowStart > 60000) authLimits.delete(ip); }
  for (const [ip, pl] of pubLimits) { if (now - pl.windowStart > 60000) pubLimits.delete(ip); }
}, 60000);

// 有效游戏地图前缀
const MAP_PREFIXES = [
  'Dam_Iris_Level', 'OLDCITY_LEVEL', 'Forrest_Level',
  'SpaceCenter_Level', 'Brakkesh_Level', 'Tide_Level',
];
function isGameMap(name) {
  if (!name) return false;
  for (let i = 0; i < MAP_PREFIXES.length; i++) {
    if (name.startsWith(MAP_PREFIXES[i])) return true;
  }
  return false;
}

// 快速提取 type
function extractType(str) {
  const i = str.indexOf('"type":"');
  if (i === -1) return null;
  const start = i + 8;
  const end = str.indexOf('"', start);
  return end > start ? str.substring(start, end) : null;
}

// rooms: Map<key, Room>
const rooms = new Map();
function getRoom(key) {
  let r = rooms.get(key);
  if (!r) {
    r = { pub: null, subs: [], cache: new Map(), inGame: false, mapName: '',
          createdAt: Date.now(), pubConnectedAt: 0, pubIP: '', subIPs: [],
          traffic: { msgCount: 0, bytesIn: 0, rateWinStart: Date.now(), rateWinMsgs: 0, rateWinBytes: 0, msgPerSec: 0, bytesPerSec: 0 } };
    rooms.set(key, r);
  }
  return r;
}

function broadcastSubCount(room) {
  const msg = `{"type":"subCount","data":${room.subs.length}}`;
  for (let i = 0; i < room.subs.length; i++) {
    if (room.subs[i].readyState === WebSocket.OPEN) room.subs[i].send(msg);
  }
}

// 50ms 节流转发：每个 sub 50ms 窗口内最多转发 MAX_PER_WINDOW 条
const MAX_PER_WINDOW = 5;
function throttledForward(room, data, isBinary) {
  if (room.subs.length === 0) return;
  const now = Date.now();
  let deadCount = 0;
  for (let i = room.subs.length - 1; i >= 0; i--) {
    const sub = room.subs[i];
    if (sub.readyState !== WebSocket.OPEN) {
      room.subs[i] = null;
      deadCount++;
      continue;
    }
    // 窗口重置：距上次窗口起点 ≥ 50ms，重置计数器
    if (!sub._windowStart || (now - sub._windowStart) >= THROTTLE_MS) {
      sub._windowStart = now;
      sub._windowCount = 0;
    }
    // 50ms 内已达上限，丢弃
    if (sub._windowCount >= MAX_PER_WINDOW) continue;
    // 背压检查
    if (sub.bufferedAmount > 131072) continue;
    sub._windowCount++;
    const sendLen = isBinary ? data.length : Buffer.byteLength(data);
    gTraffic.ulTotal += sendLen;
    gTraffic.ulWin += sendLen;
    gTrafficTick();
    sub.send(data, { binary: isBinary });
  }
  if (deadCount > 0) {
    room.subs = room.subs.filter(s => s !== null);
    broadcastSubCount(room);
  }
}

// ── WebSocket 服务器 ──
const wss = new WebSocketServer({
  port: PORT,
  perMessageDeflate: false,
  skipUTF8Validation: true,
  maxPayload: 512 * 1024,
  backlog: 512,
  clientTracking: false,
});

wss.on('connection', (ws, req) => {
  const ip = cleanIP(req.headers['x-forwarded-for'] || req.socket.remoteAddress);

  // ── IP封禁检查 ──
  if (isIPBanned(ip)) {
    const ban = ipBans.get(ip);
    const remain = ban ? Math.ceil((ban.until - Date.now()) / 1000) : 0;
    ws.send(`{"ok":false,"error":"IP banned","remain":${remain}}`);
    ws.close(4010, 'IP banned');
    return;
  }

  let authed = false, role = null, key = null;

  const sock = ws._socket;
  if (sock) { sock.setNoDelay(true); sock.setKeepAlive(true, 30000); }

  const authTimer = setTimeout(() => { if (!authed) ws.close(4001, 'Auth timeout'); }, 5000);

  ws.on('message', (data, isBinary) => {
    // ── 认证 ──
    if (!authed) {
      clearTimeout(authTimer);
      // ── 认证限流检查 ──
      if (!checkAuthRate(ip)) {
        const ban = ipBans.get(ip);
        const remain = ban ? Math.ceil((ban.until - Date.now()) / 1000) : 2;
        ws.send(`{"ok":false,"error":"Rate limited","remain":${remain}}`);
        ws.close(4011, 'Rate limited');
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.action !== 'auth' || !msg.key || !['pub','sub','check'].includes(msg.role)) {
          onAuthFail(ip);
          ws.send('{"ok":false,"error":"Invalid auth"}');
          ws.close(4002); return;
        }
        key = msg.key; role = msg.role;

        // check 角色：仅查询房间是否有 pub，不占用 sub 名额
        if (role === 'check') {
          const room = rooms.get(key);
          const hasPub = !!(room && room.pub && room.pub.readyState === WebSocket.OPEN);
          ws.send(`{"ok":true,"role":"check","pub":${hasPub}}`);
          ws.close();
          return;
        }

        const room = getRoom(key);

        if (role === 'pub') {
          // ── 房间号白名单校验 ──
          if (allowedRoomsReady && !_allowedRoomsCache.has(key)) {
            onAuthFail(ip);
            ws.send('{"ok":false,"error":"房间号未授权"}');
            ws.close(4005, 'Key not allowed');
            return;
          }
          if (room.pub && room.pub.readyState === WebSocket.OPEN) {
            room.pub.close(4003, 'Replaced');
          }
          room.pub = ws;
          room.pubConnectedAt = Date.now();
          room.pubIP = ip;
          room.cache.clear();
        } else {
          if (room.subs.length >= MAX_SUBS) {
            ws.send(`{"ok":false,"error":"已达上限(${MAX_SUBS}人)"}`);
            ws.close(4004); return;
          }
          room.subs.push(ws);
          ws._subIP = ip;
          room.subIPs = room.subs.map(s => s._subIP || '?');
          ws._windowStart = 0; ws._windowCount = 0; // 初始化节流窗口
          // 推送持久缓存给新订阅者
          for (const [t, cached] of room.cache) {
            ws.send(cached, { binary: Buffer.isBuffer(cached) });
          }
          broadcastSubCount(room);
        }
        authed = true;
        onAuthSuccess(ip);
        const hasPub = !!(room.pub && room.pub.readyState === WebSocket.OPEN);
        ws.send(`{"ok":true,"role":"${role}","subs":${room.subs.length},"pub":${hasPub}}`);
        console.log(`[+] ${role} key="${key}" ip=${ip} subs=${room.subs.length}`);
      } catch (e) {
        onAuthFail(ip);
        ws.send('{"ok":false,"error":"Parse error"}');
        ws.close(4002);
      }
      return;
    }

    // ── pub 数据：实时转发 + 50ms 节流 ──
    if (role !== 'pub') return;

    // ── DLL传输限流检查 ──
    const dataLen = isBinary ? data.length : Buffer.byteLength(data);
    if (!checkPubRate(ip, dataLen)) {
      ws.send('{"ok":false,"error":"Pub rate exceeded"}');
      ws.close(4012, 'Pub rate exceeded');
      return;
    }

    const room = rooms.get(key);
    if (!room) return;

    // ── 全局下载统计 (pub→server) ──
    gTraffic.dlTotal += dataLen;
    gTraffic.dlWin += dataLen;
    gTrafficTick();

    // ── 房间流量统计 ──
    const t = room.traffic;
    t.msgCount++;
    t.bytesIn += dataLen;
    const tnow = Date.now();
    if (tnow - t.rateWinStart >= 1000) {
      t.msgPerSec = t.rateWinMsgs;
      t.bytesPerSec = t.rateWinBytes;
      t.rateWinMsgs = 0;
      t.rateWinBytes = 0;
      t.rateWinStart = tnow;
    }
    t.rateWinMsgs++;
    t.rateWinBytes += dataLen;

    if (!isBinary) {
      const str = data.toString();
      const type = extractType(str);
      if (type === 'mapName') {
        try {
          const parsed = JSON.parse(str);
          room.mapName = parsed.data || '';
          room.inGame = isGameMap(room.mapName);
        } catch (e) {}
        room.cache.set('mapName', str);
        // mapName 始终立即转发（不节流）
        for (let i = 0; i < room.subs.length; i++) {
          if (room.subs[i].readyState === WebSocket.OPEN) room.subs[i].send(str);
        }
      } else if (!room.inGame) {
        return;
      } else if (type) {
        room.cache.set(type, str);
        throttledForward(room, str, false);
      }
    } else {
      if (!room.inGame) return;
      throttledForward(room, data, true);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!key) return;
    const room = rooms.get(key);
    if (!room) return;
    if (role === 'pub' && room.pub === ws) {
      room.pub = null;
      room.pubConnectedAt = 0;
      room.pubIP = '';
      const msg = '{"type":"status","data":{"connected":false}}';
      for (let i = 0; i < room.subs.length; i++) {
        if (room.subs[i].readyState === WebSocket.OPEN) room.subs[i].send(msg);
      }
      console.log(`[-] pub key="${key}" subs=${room.subs.length}`);
    } else if (role === 'sub') {
      const idx = room.subs.indexOf(ws);
      if (idx !== -1) room.subs.splice(idx, 1);
      room.subIPs = room.subs.map(s => s._subIP || '?');
      broadcastSubCount(room);
      console.log(`[-] sub key="${key}" subs=${room.subs.length}`);
    }
    if (!room.pub && room.subs.length === 0) rooms.delete(key);
  });

  ws.on('error', () => {});
});

// 流量速率衰减：2秒无数据则归零
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    const t = r.traffic;
    if (now - t.rateWinStart >= 2000) {
      t.msgPerSec = 0;
      t.bytesPerSec = 0;
      t.rateWinMsgs = 0;
      t.rateWinBytes = 0;
      t.rateWinStart = now;
    }
  }
}, 2000);

// 状态打印
setInterval(() => {
  let p = 0, s = 0;
  for (const r of rooms.values()) { if (r.pub) p++; s += r.subs.length; }
  const banCount = ipBans.size;
  if (rooms.size > 0 || banCount > 0) console.log(`[Status] rooms=${rooms.size} pubs=${p} subs=${s} bans=${banCount}`);
}, 30000);

console.log(`[Relay] Throttled relay on ws://0.0.0.0:${PORT} (${THROTTLE_MS}ms throttle, pid ${process.pid})`);

// ══════════════════════════════════════════════════════════
// 管理后台 HTTP API (端口 ADMIN_PORT)
// ══════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

function fmtDuration(ms) {
  if (ms <= 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  const h = Math.floor(s / 3600);
  return h + 'h' + Math.floor((s % 3600) / 60) + 'm';
}

function getRoomList(query) {
  const now = Date.now();
  const result = [];
  for (const [key, r] of rooms) {
    if (query && !key.includes(query)) continue;
    const hasPub = !!(r.pub && r.pub.readyState === WebSocket.OPEN);
    result.push({
      key,
      subs: r.subs.length,
      hasPub,
      pubIP: r.pubIP || '-',
      subIPs: r.subIPs || [],
      mapName: r.mapName || '-',
      inGame: r.inGame,
      createdAt: r.createdAt,
      createdAgo: fmtDuration(now - r.createdAt),
      pubConnectedAt: r.pubConnectedAt,
      pubUptime: hasPub && r.pubConnectedAt ? fmtDuration(now - r.pubConnectedAt) : '-',
      msgPerSec: r.traffic.msgPerSec,
      bytesPerSec: r.traffic.bytesPerSec,
      bwStr: r.traffic.bytesPerSec < 1024 ? r.traffic.bytesPerSec + ' B/s'
        : r.traffic.bytesPerSec < 1048576 ? (r.traffic.bytesPerSec / 1024).toFixed(1) + ' KB/s'
        : (r.traffic.bytesPerSec / 1048576).toFixed(1) + ' MB/s',
      totalMsgs: r.traffic.msgCount,
      totalBytes: r.traffic.bytesIn,
      totalBytesStr: r.traffic.bytesIn < 1024 ? r.traffic.bytesIn + 'B'
        : r.traffic.bytesIn < 1048576 ? (r.traffic.bytesIn / 1024).toFixed(1) + 'KB'
        : (r.traffic.bytesIn / 1048576).toFixed(1) + 'MB',
    });
  }
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result;
}

function getBanList() {
  const now = Date.now();
  const result = [];
  for (const [ip, ban] of ipBans) {
    const remain = Math.max(0, ban.until - now);
    if (remain <= 0) { ipBans.delete(ip); _dbDeleteBan(ip, 'relay'); continue; }
    result.push({ ip, level: ban.level, reason: ban.reason || '-', remain: fmtDuration(remain), remainMs: remain });
  }
  result.sort((a, b) => b.remainMs - a.remainMs);
  return result;
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
const serverStartTime = Date.now();

function getStats() {
  let pubs = 0, subs = 0;
  for (const r of rooms.values()) { if (r.pub) pubs++; subs += r.subs.length; }
  return {
    rooms: rooms.size, pubs, subs, bans: ipBans.size,
    uptime: fmtDuration(Date.now() - serverStartTime),
    dlTotal: _savedDlTotal + (gTraffic.dlTotal - _lastSavedDl),
    ulTotal: _savedUlTotal + (gTraffic.ulTotal - _lastSavedUl),
    dlTotalStr: fmtBytes(_savedDlTotal + (gTraffic.dlTotal - _lastSavedDl)),
    ulTotalStr: fmtBytes(_savedUlTotal + (gTraffic.ulTotal - _lastSavedUl)),
    dlPerSec: gTraffic.dlPerSec, ulPerSec: gTraffic.ulPerSec,
    dlPerSecStr: fmtBytes(gTraffic.dlPerSec) + '/s', ulPerSecStr: fmtBytes(gTraffic.ulPerSec) + '/s',
  };
}

// ── 每日峰值历史系统 (SQLite) ──
const Database = require('better-sqlite3');
const DB_PATH = path.join(__dirname, 'stats.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  peak_rooms INTEGER DEFAULT 0,
  peak_pubs  INTEGER DEFAULT 0,
  peak_subs  INTEGER DEFAULT 0,
  peak_bans  INTEGER DEFAULT 0,
  peak_dl_sec INTEGER DEFAULT 0,
  peak_ul_sec INTEGER DEFAULT 0,
  dl_day INTEGER DEFAULT 0,
  ul_day INTEGER DEFAULT 0
)`);

// ── 房间号白名单表 ──
db.exec(`CREATE TABLE IF NOT EXISTS allowed_rooms (
  key TEXT PRIMARY KEY,
  updated_at INTEGER DEFAULT 0
)`);
const _stmtRoomAllowedClear  = db.prepare('DELETE FROM allowed_rooms');
const _stmtRoomAllowedInsert = db.prepare('INSERT OR REPLACE INTO allowed_rooms(key, updated_at) VALUES(?, ?)');
const _stmtRoomAllowedCheck  = db.prepare('SELECT 1 FROM allowed_rooms WHERE key=? LIMIT 1');

const ROOMS_API_URL = process.env.ROOMS_API_URL || '';
let allowedRoomsReady = false;
let _allowedRoomsCache = new Set();

// 统一更新白名单的函数（推送接口调用）
function applyAllowedRooms(keys) {
  if (keys.length === 0) { console.warn('[Rooms] Empty list, skip'); return; }
  const now = Date.now();
  const updateAll = db.transaction(ks => {
    _stmtRoomAllowedClear.run();
    for (const k of ks) _stmtRoomAllowedInsert.run(k, now);
  });
  try {
    updateAll(keys);
    _allowedRoomsCache = new Set(keys);
    if (!allowedRoomsReady) { allowedRoomsReady = true; console.log(`[Rooms] Ready, ${keys.length} keys`); }
    // 踢掉已在线但不在白名单里的 pub
    for (const [roomKey, room] of rooms) {
      if (room.pub && room.pub.readyState === WebSocket.OPEN && !_allowedRoomsCache.has(roomKey)) {
        console.log(`[Rooms] Kick unauthorized pub key="${roomKey}"`);
        room.pub.send('{"ok":false,"error":"房间号已失效"}');
        room.pub.close(4005, 'Key not allowed');
      }
    }
  } catch(e) { console.error('[Rooms] DB error:', e.message); }
}
// 启动立即拉取一次，之后每10秒刷新
const ROOMS_API_BIND = process.env.ROOMS_API_BIND || '';
function fetchAllowedRooms() {
  if (ROOMS_API_BIND) {
    // 绑定指定出口IP，使用 curl 绕过 Node.js http 路由限制
    const args = ['-4', '--interface', ROOMS_API_BIND, '-s', '--max-time', '10', ROOMS_API_URL];
    execFile('curl', args, { timeout: 12000 }, (err, stdout) => {
      if (err || !stdout) return;
      const keys = stdout.trim().split('|').map(k => k.trim()).filter(k => k.length > 0);
      applyAllowedRooms(keys);
    });
  } else {
    const parsed = new URL(ROOMS_API_URL);
    const opts = { hostname: parsed.hostname, port: parsed.port || 80, path: parsed.pathname, method: 'GET', timeout: 10000 };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        const keys = body.trim().split('|').map(k => k.trim()).filter(k => k.length > 0);
        applyAllowedRooms(keys);
      });
    });
    req.on('error', () => {});
    req.setTimeout(10000, () => { req.destroy(); });
    req.end();
  }
}
if (ROOMS_API_URL) {
  console.log(`[Rooms] Pull mode: ${ROOMS_API_URL}`);
  fetchAllowedRooms();
  setInterval(fetchAllowedRooms, 10000);
} else {
  console.log('[Rooms] Push mode: waiting for /api/set_rooms');
}

// ── 封禁持久化表 ──
db.exec(`CREATE TABLE IF NOT EXISTS active_bans (
  ip TEXT NOT NULL,
  source TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  level INTEGER DEFAULT 0,
  reason TEXT DEFAULT '',
  PRIMARY KEY(ip, source)
)`);
const _stmtBanUpsert = db.prepare(`INSERT INTO active_bans(ip,source,until_ms,level,reason) VALUES(?,?,?,?,?) ON CONFLICT(ip,source) DO UPDATE SET until_ms=excluded.until_ms, level=excluded.level, reason=excluded.reason`);
const _stmtBanDelete = db.prepare(`DELETE FROM active_bans WHERE ip=? AND source=?`);
const _stmtBanDeleteIP = db.prepare(`DELETE FROM active_bans WHERE ip=?`);
const _stmtBanLoadRelay = db.prepare(`SELECT * FROM active_bans WHERE source='relay' AND until_ms>?`);
const _stmtBanLoadAdmin = db.prepare(`SELECT * FROM active_bans WHERE source='admin' AND until_ms>?`);
const _stmtBanCleanup = db.prepare(`DELETE FROM active_bans WHERE until_ms<=?`);

function _dbUpsertBan(ip, source, untilMs, level, reason) {
  try { _stmtBanUpsert.run(ip, source, untilMs, level, reason || ''); } catch(e) { console.error('[DB] ban upsert:', e.message); }
}
function _dbDeleteBan(ip, source) {
  try { _stmtBanDelete.run(ip, source); } catch(e) {}
}
function _dbDeleteBanAll(ip) {
  try { _stmtBanDeleteIP.run(ip); } catch(e) {}
}

// 启动时恢复未过期封禁
{
  const now = Date.now();
  _stmtBanCleanup.run(now); // 先清除已过期的
  const relayRows = _stmtBanLoadRelay.all(now);
  for (const r of relayRows) ipBans.set(r.ip, { until: r.until_ms, level: r.level, reason: r.reason });
  const adminRows = _stmtBanLoadAdmin.all(now);
  for (const r of adminRows) adminIpBans.set(r.ip, { until: r.until_ms, level: r.level, reason: r.reason });
  if (relayRows.length || adminRows.length) console.log(`[DB] Restored ${relayRows.length} relay bans, ${adminRows.length} admin bans`);
}

// 从旧 JSON 迁移（一次性）
const OLD_HIST = path.join(__dirname, 'stats_history.json');
try {
  if (fs.existsSync(OLD_HIST)) {
    const old = JSON.parse(fs.readFileSync(OLD_HIST, 'utf8'));
    const ins = db.prepare(`INSERT OR IGNORE INTO daily_stats(date,peak_rooms,peak_pubs,peak_subs,peak_bans,peak_dl_sec,peak_ul_sec,dl_day,ul_day) VALUES(?,?,?,?,?,?,?,?,?)`);
    const migrate = db.transaction(rows => { for (const r of rows) ins.run(r.date, r.peakRooms||0, r.peakPubs||0, r.peakSubs||0, r.peakBans||0, r.peakDlSec||0, r.peakUlSec||0, r.dlDay||0, r.ulDay||0); });
    migrate(old.history || []);
    fs.renameSync(OLD_HIST, OLD_HIST + '.bak');
    console.log('[DB] Migrated JSON history → SQLite');
  }
} catch(e) { console.error('[DB] migrate error:', e.message); }

function todayStr() {
  // 使用北京时间 (UTC+8)
  const d = new Date(Date.now() + 8 * 3600000);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}

// 预编译 SQL
const stmtUpsert = db.prepare(`INSERT INTO daily_stats(date,peak_rooms,peak_pubs,peak_subs,peak_bans,peak_dl_sec,peak_ul_sec,dl_day,ul_day)
  VALUES(@date,@peak_rooms,@peak_pubs,@peak_subs,@peak_bans,@peak_dl_sec,@peak_ul_sec,@dl_delta,@ul_delta)
  ON CONFLICT(date) DO UPDATE SET
    peak_rooms=MAX(peak_rooms,@peak_rooms), peak_pubs=MAX(peak_pubs,@peak_pubs),
    peak_subs=MAX(peak_subs,@peak_subs), peak_bans=MAX(peak_bans,@peak_bans),
    peak_dl_sec=MAX(peak_dl_sec,@peak_dl_sec), peak_ul_sec=MAX(peak_ul_sec,@peak_ul_sec),
    dl_day=dl_day+@dl_delta, ul_day=ul_day+@ul_delta`);
const stmtSelect = db.prepare(`SELECT * FROM daily_stats ORDER BY date DESC LIMIT 90`);
const stmtGetDay = db.prepare(`SELECT dl_day, ul_day FROM daily_stats WHERE date=?`);

let _lastSavedDl = 0, _lastSavedUl = 0; // 上次写入DB时的 gTraffic 值
let _lastHistDate = todayStr();

// 启动时从 DB 读取历史累计流量（含今日已存部分）
let _savedDlTotal = 0, _savedUlTotal = 0;
try {
  const totals = db.prepare('SELECT COALESCE(SUM(dl_day),0) as dl, COALESCE(SUM(ul_day),0) as ul FROM daily_stats').get();
  _savedDlTotal = totals ? (Number(totals.dl) || 0) : 0;
  _savedUlTotal = totals ? (Number(totals.ul) || 0) : 0;
  console.log(`[Stats] 历史累计流量: DL=${fmtBytes(_savedDlTotal)} UL=${fmtBytes(_savedUlTotal)}`);
} catch(e) { console.error('[Stats] 读取历史流量失败:', e.message); }

// 每10秒更新峰值 → 写入 SQLite（用增量累加，重启不归零）
setInterval(() => {
  const s = getStats();
  const today = todayStr();

  // 跨天：重置增量基准
  if (today !== _lastHistDate) {
    _lastSavedDl = gTraffic.dlTotal;
    _lastSavedUl = gTraffic.ulTotal;
    _lastHistDate = today;
  }

  // 计算本轮增量
  const dlDelta = Math.max(0, gTraffic.dlTotal - _lastSavedDl);
  const ulDelta = Math.max(0, gTraffic.ulTotal - _lastSavedUl);
  _lastSavedDl = gTraffic.dlTotal;
  _lastSavedUl = gTraffic.ulTotal;

  try {
    stmtUpsert.run({
      date: today,
      peak_rooms: s.rooms, peak_pubs: s.pubs, peak_subs: s.subs, peak_bans: s.bans,
      peak_dl_sec: gTraffic.dlPerSec, peak_ul_sec: gTraffic.ulPerSec,
      dl_delta: dlDelta, ul_delta: ulDelta,
    });
    _savedDlTotal += dlDelta;
    _savedUlTotal += ulDelta;
  } catch(e) { console.error('[DB] upsert error:', e.message); }
}, 10000);

function getHistory() {
  try {
    const rows = stmtSelect.all();
    return rows.map(d => ({
      date: d.date,
      peakRooms: d.peak_rooms, peakPubs: d.peak_pubs, peakSubs: d.peak_subs, peakBans: d.peak_bans,
      peakDlSec: d.peak_dl_sec, peakDlSecStr: fmtBytes(d.peak_dl_sec) + '/s',
      peakUlSec: d.peak_ul_sec, peakUlSecStr: fmtBytes(d.peak_ul_sec) + '/s',
      dlDay: d.dl_day, dlDayStr: fmtBytes(d.dl_day),
      ulDay: d.ul_day, ulDayStr: fmtBytes(d.ul_day),
    }));
  } catch(e) { console.error('[DB] query error:', e.message); return []; }
}

// ── 房间每日统计 ──
db.exec(`CREATE TABLE IF NOT EXISTS room_daily_stats (
  date TEXT NOT NULL,
  room_key TEXT NOT NULL,
  peak_subs INTEGER DEFAULT 0,
  peak_msg_sec INTEGER DEFAULT 0,
  peak_bw_sec INTEGER DEFAULT 0,
  total_bytes INTEGER DEFAULT 0,
  total_msgs INTEGER DEFAULT 0,
  active_seconds INTEGER DEFAULT 0,
  map_name TEXT DEFAULT '',
  pub_ip TEXT DEFAULT '',
  PRIMARY KEY(date, room_key)
)`);
// 安全添加新列（已有表不会自动加）
try { db.exec(`ALTER TABLE room_daily_stats ADD COLUMN total_msgs INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE room_daily_stats ADD COLUMN map_name TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE room_daily_stats ADD COLUMN pub_ip TEXT DEFAULT ''`); } catch(e) {}

const stmtRoomUpsert = db.prepare(`INSERT INTO room_daily_stats(date,room_key,peak_subs,peak_msg_sec,peak_bw_sec,total_bytes,total_msgs,active_seconds,map_name,pub_ip)
  VALUES(@date,@room_key,@peak_subs,@peak_msg_sec,@peak_bw_sec,@bytes_delta,@msgs_delta,@active_seconds,@map_name,@pub_ip)
  ON CONFLICT(date,room_key) DO UPDATE SET
    peak_subs=MAX(peak_subs,@peak_subs),
    peak_msg_sec=MAX(peak_msg_sec,@peak_msg_sec),
    peak_bw_sec=MAX(peak_bw_sec,@peak_bw_sec),
    total_bytes=total_bytes+@bytes_delta,
    total_msgs=total_msgs+@msgs_delta,
    active_seconds=active_seconds+@active_seconds,
    map_name=CASE WHEN @map_name!='' THEN @map_name ELSE map_name END,
    pub_ip=CASE WHEN @pub_ip!='' THEN @pub_ip ELSE pub_ip END`);
const stmtRoomHistory = db.prepare(`SELECT * FROM room_daily_stats WHERE room_key=? ORDER BY date DESC LIMIT 90`);

// 用于计算增量
const _roomLastBytes = new Map();
const _roomLastMsgs = new Map();
const _roomLastActiveCheck = new Map();

// 每10秒更新房间统计
const _roomStatsInterval = setInterval(() => {
  const today = todayStr();
  const now = Date.now();
  const roomUpsertBatch = db.transaction(entries => { for (const e of entries) stmtRoomUpsert.run(e); });
  const batch = [];
  for (const [key, r] of rooms) {
    const hasPub = !!(r.pub && r.pub.readyState === 1);
    const lastCheck = _roomLastActiveCheck.get(key) || now;
    const activeDelta = hasPub ? Math.round((now - lastCheck) / 1000) : 0;
    _roomLastActiveCheck.set(key, now);

    // 增量计算：本轮新增字节和消息数
    const prevBytes = _roomLastBytes.get(key) || 0;
    const prevMsgs = _roomLastMsgs.get(key) || 0;
    const curBytes = r.traffic.bytesIn;
    const curMsgs = r.traffic.msgCount;
    const bytesDelta = Math.max(0, curBytes - prevBytes);
    const msgsDelta = Math.max(0, curMsgs - prevMsgs);
    _roomLastBytes.set(key, curBytes);
    _roomLastMsgs.set(key, curMsgs);

    batch.push({
      date: today, room_key: key,
      peak_subs: r.subs.length,
      peak_msg_sec: r.traffic.msgPerSec,
      peak_bw_sec: r.traffic.bytesPerSec,
      bytes_delta: bytesDelta,
      msgs_delta: msgsDelta,
      active_seconds: activeDelta > 0 ? activeDelta : 0,
      map_name: r.mapName || '',
      pub_ip: r.pubIP || '',
    });
  }
  if (batch.length > 0) {
    try { roomUpsertBatch(batch); } catch(e) { console.error('[DB] room upsert error:', e.message); }
  }
}, 10000);

function getRoomHistory(roomKey) {
  try {
    const rows = stmtRoomHistory.all(roomKey);
    return rows.map(d => ({
      date: d.date, roomKey: d.room_key,
      peakSubs: d.peak_subs,
      peakMsgSec: d.peak_msg_sec,
      peakBwSec: d.peak_bw_sec, peakBwSecStr: fmtBytes(d.peak_bw_sec) + '/s',
      totalBytes: d.total_bytes, totalBytesStr: fmtBytes(d.total_bytes),
      totalMsgs: d.total_msgs || 0,
      activeSeconds: d.active_seconds, activeStr: fmtDuration(d.active_seconds * 1000),
      mapName: d.map_name || '-',
      pubIP: d.pub_ip || '-',
    }));
  } catch(e) { console.error('[DB] room history error:', e.message); return []; }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) reject('too large'); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject('bad json'); } });
  });
}

function checkToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return adminTokens.has(token);
}

// ── 管理后台反滥用 ──────────────────────────────────────────
// adminIpBans: Map<ip, { until, level }> — 管理端独立封禁
const adminIpBans = new Map();
// adminLoginFails: Map<ip, { count, firstFailAt }> — 登录失败计数
const adminLoginFails = new Map();
// adminReqRate: Map<ip, { count, windowStart, triggerCount, triggerFirstAt }> — 请求频率
const adminReqRate = new Map();

function isAdminIPBanned(ip) {
  const b = adminIpBans.get(ip);
  if (!b) return false;
  if (Date.now() >= b.until) { adminIpBans.delete(ip); _dbDeleteBan(ip, 'admin'); return false; }
  return true;
}
function adminBanIP(ip, duration, reason) {
  const until = Date.now() + duration;
  adminIpBans.set(ip, { until, level: duration, reason });
  _dbUpsertBan(ip, 'admin', until, 0, reason);
  console.log(`[ADMIN-BAN] ip=${ip} duration=${duration/1000}s reason=${reason}`);
}
function getAdminBanRemain(ip) {
  const b = adminIpBans.get(ip);
  return b ? Math.max(0, Math.ceil((b.until - Date.now()) / 1000)) : 0;
}

// 检查管理后台请求频率: 1秒10次→封1s, 1小时内触发10次→封1小时
function checkAdminRate(ip) {
  const now = Date.now();
  let r = adminReqRate.get(ip);
  if (!r) { r = { count: 0, windowStart: now, triggerCount: 0, triggerFirstAt: now }; adminReqRate.set(ip, r); }
  // 重置1小时窗口
  if (now - r.triggerFirstAt > 3600000) { r.triggerCount = 0; r.triggerFirstAt = now; }
  // 重置1秒窗口
  if (now - r.windowStart >= 1000) { r.count = 0; r.windowStart = now; }
  r.count++;
  if (r.count > 10) {
    r.triggerCount++;
    if (r.triggerCount >= 10) {
      adminBanIP(ip, 3600000, 'admin_rate_flood_1h');
      adminReqRate.delete(ip);
    } else {
      adminBanIP(ip, 1000, 'admin_rate_burst');
    }
    return false;
  }
  return true;
}

// 检查登录失败: 5次错误→冻结1分钟
function onAdminLoginFail(ip) {
  const now = Date.now();
  let f = adminLoginFails.get(ip);
  if (!f) { f = { count: 0, firstFailAt: now }; adminLoginFails.set(ip, f); }
  // 超过2分钟重置
  if (now - f.firstFailAt > 120000) { f.count = 0; f.firstFailAt = now; }
  f.count++;
  if (f.count >= 5) {
    adminBanIP(ip, 60000, 'admin_login_fail_5x');
    adminLoginFails.delete(ip);
  }
}
function onAdminLoginSuccess(ip) { adminLoginFails.delete(ip); }

// 获取管理后台封禁列表（供前端展示）
function getAdminBanList() {
  const now = Date.now();
  const result = [];
  for (const [ip, b] of adminIpBans) {
    const remain = Math.max(0, b.until - now);
    if (remain <= 0) { adminIpBans.delete(ip); _dbDeleteBan(ip, 'admin'); continue; }
    result.push({ ip, reason: b.reason || '-', remain: fmtDuration(remain), remainMs: remain, source: 'admin' });
  }
  result.sort((a, b) => b.remainMs - a.remainMs);
  return result;
}

// 清理过期记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of adminIpBans) { if (now >= b.until) { adminIpBans.delete(ip); _dbDeleteBan(ip, 'admin'); } }
  for (const [ip, f] of adminLoginFails) { if (now - f.firstFailAt > 120000) adminLoginFails.delete(ip); }
  for (const [ip, r] of adminReqRate) { if (now - r.windowStart > 60000) adminReqRate.delete(ip); }
}, 60000);

const adminServer = http.createServer(async (req, res) => {
  const ip = cleanIP(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── 管理后台 IP 封禁检查 ──
  if (isAdminIPBanned(ip)) {
    const remain = getAdminBanRemain(ip);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(`{"ok":false,"error":"IP frozen","remain":${remain}}`);
    return;
  }

  // ── 请求频率检查 ──
  if (!checkAdminRate(ip)) {
    const remain = getAdminBanRemain(ip);
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(`{"ok":false,"error":"Too many requests","remain":${remain}}`);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ── 登录 ──
  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (body.user === ADMIN_USER && body.pass === ADMIN_PASS) {
        onAdminLoginSuccess(ip);
        const token = crypto.randomBytes(32).toString('hex');
        adminTokens.add(token);
        setTimeout(() => adminTokens.delete(token), 86400000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token }));
      } else {
        onAdminLoginFail(ip);
        const f = adminLoginFails.get(ip);
        const attemptsLeft = f ? Math.max(0, 5 - f.count) : 4;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(`{"ok":false,"error":"账号或密码错误 (剩余${attemptsLeft}次)"}`);
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"Bad request"}');
    }
    return;
  }

  // ── 以下接口需要认证 ──
  if (pathname.startsWith('/api/') && !checkToken(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"ok":false,"error":"Unauthorized"}');
    return;
  }

  if (pathname === '/api/rooms') {
    const q = url.searchParams.get('q') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: getRoomList(q), stats: getStats() }));
    return;
  }

  if (pathname === '/api/bans') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bans: getBanList(), adminBans: getAdminBanList() }));
    return;
  }

  if (pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...getStats() }));
    return;
  }

  if (pathname === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, history: getHistory() }));
    return;
  }

  if (pathname === '/api/room_history') {
    const roomKey = url.searchParams.get('key') || '';
    if (!roomKey) { res.writeHead(400); res.end('{"ok":false,"error":"missing key"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, history: getRoomHistory(roomKey) }));
    return;
  }

  if (pathname === '/api/clear_history' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      // body.mode: 'date' (清指定日期), 'all' (清全部), 'days' (清最近N天)
      if (body.mode === 'date' && body.date) {
        db.prepare('DELETE FROM daily_stats WHERE date=?').run(body.date);
        db.prepare('DELETE FROM room_daily_stats WHERE date=?').run(body.date);
      } else if (body.mode === 'all') {
        db.prepare('DELETE FROM daily_stats').run();
        db.prepare('DELETE FROM room_daily_stats').run();
      } else if (body.mode === 'days' && body.days > 0) {
        // 保留最近N天，删除更早的
        const cutoff = [];
        for (let i = 0; i < body.days; i++) {
          const d = new Date(Date.now() + 8 * 3600000 - i * 86400000);
          const pad = n => String(n).padStart(2,'0');
          cutoff.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`);
        }
        const placeholders = cutoff.map(() => '?').join(',');
        db.prepare(`DELETE FROM daily_stats WHERE date NOT IN (${placeholders})`).run(...cutoff);
        db.prepare(`DELETE FROM room_daily_stats WHERE date NOT IN (${placeholders})`).run(...cutoff);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch(e) { res.writeHead(400); res.end(`{"ok":false,"error":"${e}"}`); }
    return;
  }

  // ── 白名单状态查询（无需登录，浏览器可直接访问）──
  if (pathname === '/api/rooms_status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      ready: allowedRoomsReady,
      count: _allowedRoomsCache.size,
      keys: [..._allowedRoomsCache].slice(0, 5).join('|') + (_allowedRoomsCache.size > 5 ? '|...' : '')
    }));
    return;
  }

  // ── 白名单推送接口（无需管理员登录）──
  if (pathname === '/api/set_rooms' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (body.secret !== (process.env.ROOMS_SECRET || 'changeme')) {
        res.writeHead(403); res.end('{"ok":false,"error":"forbidden"}'); return;
      }
      const raw = typeof body.rooms === 'string' ? body.rooms : '';
      const keys = raw.split('|').map(k => k.trim()).filter(k => k.length > 0);
      applyAllowedRooms(keys);
      console.log(`[Rooms] Push received: ${keys.length} keys`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`{"ok":true,"count":${keys.length}}`);
    } catch(e) { res.writeHead(400); res.end(`{"ok":false,"error":"${e.message}"}`); }
    return;
  }

  if (pathname === '/api/kick' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const room = rooms.get(body.key);
      if (!room) { res.writeHead(404); res.end('{"ok":false}'); return; }
      if (body.target === 'pub' && room.pub) {
        room.pub.close(4100, 'Kicked by admin');
      } else if (body.target === 'all') {
        if (room.pub) room.pub.close(4100, 'Kicked by admin');
        room.subs.forEach(s => s.close(4100, 'Kicked by admin'));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch { res.writeHead(400); res.end('{"ok":false}'); }
    return;
  }

  if (pathname === '/api/ban' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (body.ip) { banIP(body.ip, 'admin_manual'); }
      if (body.unban) { ipBans.delete(body.unban); adminIpBans.delete(body.unban); _dbDeleteBanAll(body.unban); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch { res.writeHead(400); res.end('{"ok":false}'); }
    return;
  }

  // ── 静态页面 ──
  if (pathname === '/' || pathname === '/admin' || pathname === '/admin.html') {
    const htmlPath = path.join(__dirname, 'admin.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('admin.html not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

adminServer.listen(ADMIN_PORT, '0.0.0.0', () => {
  console.log(`[Admin] Dashboard on http://0.0.0.0:${ADMIN_PORT} (user: ${ADMIN_USER})`);
});
