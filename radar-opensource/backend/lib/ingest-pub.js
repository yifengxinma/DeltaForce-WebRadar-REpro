/**
 * ingest-pub.js — pub 数据入房（WS pub / UDP pub 两套入口共用）
 *
 * 网页只收 WebSocket；数据源可以是：
 *   - 旧 EXE：WS auth role=pub 后再发 JSON
 *   - 新 DLL：UDP RadarBin → 解码 JSON
 * 转发前剥掉 key；>64B 的 JSON 一律 zlib deflate 二进制发给 viewer（前端 DecompressionStream）。
 */
const zlib = require('zlib');
const { WebSocket } = require('ws');
const cfg = require('./config');
const {
  sanitizePubPayloadEx, extractType, isGameMap,
} = require('./util');
const log = require('./logger')('Ingest');

const CACHEABLE_TYPES = new Set([
  'mapName', 'items', 'containers', 'exits', 'boxes', 'doors',
  'self', 'players', 'bots',
]);

/** UDP pub 心跳：超过此时长无包视为离线（秒） */
const UDP_PUB_TTL_MS = 8000;

function stripKeyField(str, obj) {
  if (!obj || obj.key === undefined) return str;
  const copy = { ...obj };
  delete copy.key;
  try {
    return JSON.stringify(copy);
  } catch (_) {
    return str;
  }
}

/** 对齐旧 WsRelay：大包 deflate，压不过或太小则明文（协议不变，兼容旧版 viewer/EXE） */
function wireForViewer(str) {
  if (typeof str !== 'string') {
    return { data: str, binary: Buffer.isBuffer(str) };
  }
  if (str.length <= 64) return { data: str, binary: false };
  try {
    const gz = zlib.deflateSync(Buffer.from(str, 'utf8'), { level: 6 });
    if (gz.length > 0 && gz.length < Buffer.byteLength(str)) {
      return { data: gz, binary: true };
    }
  } catch (e) {
    log.warn('deflate fail:', (e && e.message) || e);
  }
  return { data: str, binary: false };
}

function sendViewer(room, str, traffic) {
  const wire = wireForViewer(str);
  const sendLen = wire.binary ? wire.data.length : Buffer.byteLength(wire.data);
  for (let i = 0; i < room.subs.length; i++) {
    const sub = room.subs[i];
    if (sub.readyState !== WebSocket.OPEN) continue;
    if (sub.bufferedAmount > cfg.SUB_BACKPRESSURE) continue;
    traffic.addUl(sendLen);
    sub.send(wire.data, { binary: wire.binary });
  }
  return wire;
}

/**
 * @param {object} deps
 * @param {object} deps.rooms
 * @param {object} deps.traffic
 * @param {object} [deps.recorder]
 * @param {string} key room key
 * @param {string} rawUtf8 原始 JSON 文本
 * @param {{ ip?: string, via?: 'ws'|'udp', dataLen?: number }} meta
 */
function ingestPub({ rooms, traffic, recorder }, key, rawUtf8, meta = {}) {
  const room = rooms.getByKey(key);
  if (!room) return false;

  const dataLen = meta.dataLen != null ? meta.dataLen : Buffer.byteLength(rawUtf8);
  const ip = meta.ip || '';
  const via = meta.via || 'ws';

  // UDP：刷新在线戳；首次 UDP pub 通知 subs
  if (via === 'udp') {
    const wasOffline = !rooms.hasActivePub(key);
    room.pubUdpLastMs = Date.now();
    room.pubUdpIP = ip || room.pubUdpIP || '';
    if (!room.pubIP) room.pubIP = room.pubUdpIP;
    if (!room.pubConnectedAt) room.pubConnectedAt = Date.now();
    if (wasOffline) {
      const onlineMsg = '{"type":"status","data":{"connected":true}}';
      for (let i = 0; i < room.subs.length; i++) {
        if (room.subs[i].readyState === WebSocket.OPEN) {
          try { room.subs[i].send(onlineMsg); } catch (_) {}
        }
      }
      if (recorder) {
        try { recorder.updateMetadata(key, { pubIP: room.pubIP }); } catch (e) {}
      }
    }
  }

  traffic.addDl(dataLen);

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

  const { str: sanitized, obj } = sanitizePubPayloadEx(rawUtf8);
  const str = stripKeyField(sanitized, obj);
  const type = (obj && typeof obj.type === 'string') ? obj.type : extractType(str);

  if (type === 'mapName') {
    room.mapName = (obj && obj.data) || '';
    room.inGame = isGameMap(room.mapName);
    room.cache.set('mapName', str);
    sendViewer(room, str, traffic);
    if (recorder) {
      try {
        recorder.recordMessage(key, str, false);
        recorder.updateMetadata(key, { mapName: room.mapName, pubIP: room.pubIP });
      } catch (e) {}
    }
    return true;
  }

  if (type === 'info') {
    // 卡密识别包：不转发给 viewer
    return true;
  }

  if (!room.inGame) {
    return true;
  }

  if (type === 'self' || type === 'players' || type === 'bots') {
    if (CACHEABLE_TYPES.has(type)) room.cache.set(type, str);
    sendViewer(room, str, traffic);
    if (recorder) {
      try { recorder.recordMessage(key, str, false); } catch (e) {}
    }
    return true;
  }

  if (type) {
    // items / containers / exits / boxes / doors — 同样压缩
    if (CACHEABLE_TYPES.has(type)) room.cache.set(type, str);
    sendViewer(room, str, traffic);
    if (recorder) {
      try { recorder.recordMessage(key, str, false); } catch (e) {}
    }
  }
  return true;
}

function ingestPubBinary({ rooms, traffic, recorder }, key, data, meta = {}) {
  const room = rooms.getByKey(key);
  if (!room || !room.inGame) return false;
  const dataLen = data.length;
  traffic.addDl(dataLen);
  for (let i = 0; i < room.subs.length; i++) {
    const sub = room.subs[i];
    if (sub.readyState !== WebSocket.OPEN) continue;
    if (sub.bufferedAmount > cfg.SUB_BACKPRESSURE) continue;
    traffic.addUl(dataLen);
    sub.send(data, { binary: true });
  }
  if (recorder) {
    try { recorder.recordMessage(key, data, true); } catch (e) {}
  }
  return true;
}

module.exports = {
  ingestPub,
  ingestPubBinary,
  CACHEABLE_TYPES,
  UDP_PUB_TTL_MS,
  wireForViewer,
  sendViewer,
};
