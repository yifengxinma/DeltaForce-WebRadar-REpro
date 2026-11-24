/**
 * rooms.js — 房间 Map + 节流转发 + 白名单 + 每日统计落库
 *
 * 抽出动机:
 *   relay.js 之前 rooms Map / throttledForward / 白名单推拉双模式 / 房间每日统计
 *   散在 400+ 行。封装后:
 *   - RoomRegistry: 一处管理 Map<key, Room>; 暴露 getOrCreate / remove / values
 *   - throttledForward: 50ms 窗口 + 背压检查, 写 traffic.ul (依赖注入)
 *   - Whitelist:   推/拉双模式; 拉模式 ROOMS_API_URL 自动每 10s 刷; 推模式等 /api/set_rooms
 *   - 每 10s 统计 batch 写 room_daily_stats (动态算 bytes/msgs delta)
 *
 * Room shape (与 relay.js 旧版完全兼容):
 *   { pub, subs:[], cache:Map, inGame, mapName, createdAt, pubConnectedAt, pubIP, subIPs,
 *     traffic:{ msgCount, bytesIn, rateWinStart, rateWinMsgs, rateWinBytes, msgPerSec, bytesPerSec } }
 */
const http = require('http');
const { execFile } = require('child_process');
const { WebSocket } = require('ws');
const cfg = require('./config');
const { isValidRoomKey, fmtBytes, fmtDuration, todayStr } = require('./util');
const { UDP_PUB_TTL_MS, wireForViewer } = require('./ingest-pub');
const log = require('./logger')('Rooms');

// ── 创建一个空 Room ────────────────────────────────────────
function makeRoom() {
  return {
    pub: null,           // WS pub（兼容旧路径；DLL 现走 UDP）
    pubUdpLastMs: 0,     // UDP pub 最近收包时间
    pubUdpIP: '',
    subs: [],
    cache: new Map(),
    inGame: false,
    mapName: '',
    createdAt: Date.now(),
    pubConnectedAt: 0,
    pubIP: '',
    subIPs: [],
    traffic: {
      msgCount: 0, bytesIn: 0,
      rateWinStart: Date.now(),
      rateWinMsgs: 0, rateWinBytes: 0,
      msgPerSec: 0, bytesPerSec: 0,
    },
  };
}

function createRooms({ db, traffic }) {
  const rooms = new Map();

  // ══════════════════════════════════════════════════════════
  // Registry: 房间 Map + 节流转发
  // ══════════════════════════════════════════════════════════
  function getOrCreate(key) {
    let r = rooms.get(key);
    if (!r) { r = makeRoom(); rooms.set(key, r); }
    return r;
  }

  function broadcastSubCount(room) {
    const msg = `{"type":"subCount","data":${room.subs.length}}`;
    for (let i = 0; i < room.subs.length; i++) {
      if (room.subs[i].readyState === WebSocket.OPEN) room.subs[i].send(msg);
    }
  }

  // 50ms 节流转发: 每个 sub 窗口内最多 MAX_PER_WINDOW 条 + 背压检查
  // 死连接顺手清掉, 清完发新 subCount
  function throttledForward(room, data, isBinary) {
    if (room.subs.length === 0) return;
    const now = Date.now();
    // 字符串一律走 deflate；已是 Buffer 则原样（兼容）
    const wire = (!isBinary && typeof data === 'string')
      ? wireForViewer(data)
      : { data, binary: !!isBinary };
    let deadCount = 0;
    for (let i = room.subs.length - 1; i >= 0; i--) {
      const sub = room.subs[i];
      if (sub.readyState !== WebSocket.OPEN) {
        room.subs[i] = null;
        deadCount++;
        continue;
      }
      if (!sub._windowStart || (now - sub._windowStart) >= cfg.THROTTLE_MS) {
        sub._windowStart = now;
        sub._windowCount = 0;
      }
      if (sub._windowCount >= cfg.MAX_PER_WINDOW) continue;
      if (sub.bufferedAmount > cfg.SUB_BACKPRESSURE) continue;
      sub._windowCount++;
      const sendLen = wire.binary ? wire.data.length : Buffer.byteLength(wire.data);
      traffic.addUl(sendLen);
      sub.send(wire.data, { binary: wire.binary });
    }
    if (deadCount > 0) {
      room.subs = room.subs.filter(s => s !== null);
      broadcastSubCount(room);
    }
  }

  // 房间每日统计侧车（必须在 maybeDelete 之前声明，删房时一并清理）
  const _lastBytes = new Map();
  const _lastMsgs = new Map();
  const _lastActiveCheck = new Map();

  function hasWsPub(room) {
    return !!(room && room.pub && room.pub.readyState === WebSocket.OPEN);
  }

  function hasUdpPub(room, now = Date.now()) {
    return !!(room && room.pubUdpLastMs && (now - room.pubUdpLastMs) < UDP_PUB_TTL_MS);
  }

  function hasActivePub(keyOrRoom, now = Date.now()) {
    const room = typeof keyOrRoom === 'string' ? rooms.get(keyOrRoom) : keyOrRoom;
    return hasWsPub(room) || hasUdpPub(room, now);
  }

  // pub/sub 关闭后, 房间无人则删, 防内存泄漏（含统计侧车 Map）
  function maybeDelete(key) {
    const r = rooms.get(key);
    if (r && !hasActivePub(r) && r.subs.length === 0) {
      rooms.delete(key);
      _lastBytes.delete(key);
      _lastMsgs.delete(key);
      _lastActiveCheck.delete(key);
    }
  }

  // UDP pub 超时：清 cache + 通知 subs offline
  function sweepUdpPubs() {
    const now = Date.now();
    for (const [key, room] of rooms) {
      if (!room.pubUdpLastMs) continue;
      if (hasUdpPub(room, now)) continue;
      if (hasWsPub(room)) {
        room.pubUdpLastMs = 0;
        continue;
      }
      // UDP 过期且无 WS pub
      room.pubUdpLastMs = 0;
      room.pubUdpIP = '';
      room.pubConnectedAt = 0;
      room.pubIP = '';
      room.cache.clear();
      room.mapName = '';
      room.inGame = false;
      const msg = '{"type":"status","data":{"connected":false}}';
      for (let i = 0; i < room.subs.length; i++) {
        if (room.subs[i].readyState === WebSocket.OPEN) {
          try { room.subs[i].send(msg); } catch (_) {}
        }
      }
      log.info(`- udp pub timeout key="${key}"`);
      maybeDelete(key);
    }
  }

  // ══════════════════════════════════════════════════════════
  // 房间号白名单 (推/拉双模式)
  // ══════════════════════════════════════════════════════════
  let allowedRoomsReady = false;
  let allowedCache = new Set();

  async function loadAllowedFromDb() {
    try {
      const rows = await db.rooms.loadKeys();
      const keys = rows.map(r => r.key).filter(k => isValidRoomKey(k));
      if (keys.length > 0) {
        allowedCache = new Set(keys);
        allowedRoomsReady = true;
        log.info(`Restored ${keys.length} keys from DB`);
      }
    } catch (e) {
      log.error('DB restore error:', e.message);
    }
  }

  async function applyAllowed(keys, opts = {}) {
    if (keys.length === 0 && !opts.allowEmpty) { log.warn('empty list, skip'); return; }
    try {
      if (keys.length === 0) {
        await db.rooms.clear();
        allowedCache = new Set();
      } else {
        await db.rooms.replaceAllTx(keys, Date.now());
        allowedCache = new Set(keys);
      }
      if (!allowedRoomsReady) {
        allowedRoomsReady = true;
        log.info(`ready, ${keys.length} keys`);
      } else {
        log.info(`updated, ${keys.length} keys`);
      }
      // 踢掉已在线但不在白名单的 pub
      for (const [roomKey, room] of rooms) {
        if (room.pub && room.pub.readyState === WebSocket.OPEN && !allowedCache.has(roomKey)) {
          log.info(`kick unauthorized pub key="${roomKey}"`);
          room.pub.send('{"ok":false,"error":"房间号已失效"}');
          room.pub.close(4005, 'Key not allowed');
        }
      }
    } catch (e) { log.error('DB error:', e.message); throw e; }
  }

  function listAllowedKeys() {
    return [...allowedCache].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  function isAllowed(key) {
    return allowedCache.has(key);
  }

  // 拉模式: ROOMS_API_URL 设了就启用; ROOMS_API_BIND 用 curl 绕 Node 的 socket 绑定限制
  let fetchTimer = null;
  function fetchAllowed() {
    if (cfg.ROOMS_API_BIND) {
      const args = ['-4', '--interface', cfg.ROOMS_API_BIND, '-s', '--max-time', '10', cfg.ROOMS_API_URL];
      execFile('curl', args, { timeout: 12000 }, (err, stdout) => {
        if (err || !stdout) return;
        const keys = stdout.trim().split('|').map(k => k.trim()).filter(k => isValidRoomKey(k));
        applyAllowed(keys);
      });
    } else {
      let parsed;
      try { parsed = new URL(cfg.ROOMS_API_URL); } catch (e) { return; }
      const opts = { hostname: parsed.hostname, port: parsed.port || 80, path: parsed.pathname, method: 'GET', timeout: 10000 };
      const req = http.request(opts, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          const keys = body.trim().split('|').map(k => k.trim()).filter(k => isValidRoomKey(k));
          applyAllowed(keys);
        });
      });
      req.on('error', () => {});
      req.setTimeout(10000, () => { req.destroy(); });
      req.end();
    }
  }

  function seedDefaultWhitelistIfEmpty() {
    if (allowedRoomsReady || cfg.ROOMS_API_URL) return;
    const key = cfg.DEFAULT_WHITELIST_ROOM;
    if (!key) return;
    if (!isValidRoomKey(key)) {
      log.warn(`invalid DEFAULT_WHITELIST_ROOM: ${key}`);
      return;
    }
    applyAllowed([key]);
    log.info(`seed default whitelist: ${key}`);
  }

  function startWhitelist() {
    if (cfg.ROOMS_API_URL) {
      log.info('room whitelist pull mode enabled');
      fetchAllowed();
      fetchTimer = setInterval(fetchAllowed, 10000);
      if (fetchTimer.unref) fetchTimer.unref();
    } else {
      seedDefaultWhitelistIfEmpty();
      log.info('push mode: whitelist editable via admin or /api/set_rooms');
    }
  }

  // ══════════════════════════════════════════════════════════
  // 房间速率衰减 (2s 无数据归零) + 状态打印
  // ══════════════════════════════════════════════════════════
  const decayTimer = setInterval(() => {
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
  if (decayTimer.unref) decayTimer.unref();

  // ══════════════════════════════════════════════════════════
  // 房间每日统计落库 (每 10s 一次 batch transaction)
  // ══════════════════════════════════════════════════════════
  const statsTimer = setInterval(() => {
    const today = todayStr();
    const now = Date.now();
    const batch = [];
    for (const [key, r] of rooms) {
      const hasPub = hasActivePub(r, now);
      const lastCheck = _lastActiveCheck.get(key) || now;
      const activeDelta = hasPub ? Math.round((now - lastCheck) / 1000) : 0;
      _lastActiveCheck.set(key, now);

      const prevBytes = _lastBytes.get(key) || 0;
      const prevMsgs  = _lastMsgs.get(key) || 0;
      const curBytes  = r.traffic.bytesIn;
      const curMsgs   = r.traffic.msgCount;
      const bytesDelta = Math.max(0, curBytes - prevBytes);
      const msgsDelta  = Math.max(0, curMsgs - prevMsgs);
      _lastBytes.set(key, curBytes);
      _lastMsgs.set(key, curMsgs);

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
      db.roomStats.upsertBatchTx(batch).catch(e => log.error('room stats upsert error:', e.message));
    }
  }, 10000);
  if (statsTimer.unref) statsTimer.unref();

  const udpSweepTimer = setInterval(sweepUdpPubs, 2000);
  if (udpSweepTimer.unref) udpSweepTimer.unref();

  function stop() {
    if (fetchTimer) clearInterval(fetchTimer);
    clearInterval(decayTimer);
    clearInterval(statsTimer);
    clearInterval(udpSweepTimer);
  }

  // ══════════════════════════════════════════════════════════
  // 查询: 给 admin-http 用
  // ══════════════════════════════════════════════════════════
  function getRoomList(query) {
    const now = Date.now();
    const out = [];
    for (const [key, r] of rooms) {
      if (query && !key.includes(query)) continue;
      const hasPub = hasActivePub(r, now);
      out.push({
        key,
        subs: r.subs.length,
        hasPub,
        pubIP: r.pubIP || r.pubUdpIP || '-',
        subIPs: r.subIPs || [],
        mapName: r.mapName || '-',
        inGame: r.inGame,
        createdAt: r.createdAt,
        createdAgo: fmtDuration(now - r.createdAt),
        pubConnectedAt: r.pubConnectedAt,
        pubUptime: hasPub && r.pubConnectedAt ? fmtDuration(now - r.pubConnectedAt) : '-',
        msgPerSec: r.traffic.msgPerSec,
        bytesPerSec: r.traffic.bytesPerSec,
        bwStr: fmtBytes(r.traffic.bytesPerSec) + '/s',
        totalMsgs: r.traffic.msgCount,
        totalBytes: r.traffic.bytesIn,
        totalBytesStr: fmtBytes(r.traffic.bytesIn),
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  function countPubsSubs() {
    let pubs = 0, subs = 0;
    const now = Date.now();
    for (const r of rooms.values()) {
      if (hasActivePub(r, now)) pubs++;
      subs += r.subs.length;
    }
    return { rooms: rooms.size, pubs, subs };
  }

  function whitelist() {
    return {
      ready: allowedRoomsReady,
      count: allowedCache.size,
    };
  }

  return {
    // registry
    getOrCreate, getByKey: (k) => rooms.get(k), maybeDelete,
    rooms, // 暴露给 ws-handler 直接遍历 (close/kick 等场景)
    broadcastSubCount, throttledForward,
    hasActivePub, hasWsPub, hasUdpPub,
    // whitelist
    isAllowed, applyAllowed, startWhitelist, whitelist, listAllowedKeys, loadAllowedFromDb,
    isWhitelistReady: () => allowedRoomsReady,
    // queries
    getRoomList, countPubsSubs,
    // lifecycle
    stop,
  };
}

module.exports = { createRooms };
