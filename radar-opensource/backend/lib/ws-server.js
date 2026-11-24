/**
 * ws-server.js — WebSocket 服务: 鉴权 + pub/sub/check 三角色 + 节流转发
 *
 * 抽出动机:
 *   relay.js 之前 wss 设置 + connection handler 一坨 230 行, 顶层 try/catch
 *   包裹整个 message handler。封装后:
 *   - 注入 bans / rooms / traffic 三个 store, 不再依赖 module-level state
 *   - clientIPOf(req) 由调用方提供 (TRUST_PROXY 决定是否信任 XFF, 由 relay.js 主入口闭包)
 *   - createWsServer().stop() 关 wss + 30s 状态打印 timer
 *
 * 协议 (与旧版完全一致, 不改动 wire format):
 *   client → server: { action: "auth", key, role }   role: "pub" | "sub" | "check"
 *   server → client: { ok: true, role, subs, pub }   或 { ok: false, error, ... }
 *
 * 角色:
 *   pub   — 推送数据源 (DLL 注入); 同房间唯一, 后到者替换前者
 *   sub   — 订阅者 (浏览器); 每房间最多 MAX_SUBS 个
 *   check — 仅查询房间是否有 pub, 不占名额, 用完即关
 */
const { WebSocketServer, WebSocket } = require('ws');
const cfg = require('./config');
const { isValidRoomKey } = require('./util');
const { ingestPub, ingestPubBinary, wireForViewer } = require('./ingest-pub');
const log = require('./logger')('WS');

function createWsServer({ port, bans, rooms, traffic, clientIPOf, whitelistEnforcement, recorder, db }) {
  const wss = new WebSocketServer({
    port,
    perMessageDeflate: false,
    skipUTF8Validation: true,
    maxPayload: 512 * 1024,
    backlog: 512,
    clientTracking: false,
  });

  wss.on('connection', (ws, req) => {
    const ip = clientIPOf(req);

    // ── IP 封禁检查 ──
    if (bans.relay.isBanned(ip)) {
      const remain = Math.ceil(bans.relay.getRemainMs(ip) / 1000);
      ws.send(`{"ok":false,"error":"IP banned","remain":${remain}}`);
      ws.close(4010, 'IP banned');
      return;
    }

    let authed = false, role = null, key = null;

    const sock = ws._socket;
    if (sock) { sock.setNoDelay(true); sock.setKeepAlive(true, 30000); }

    const authTimer = setTimeout(() => { if (!authed) ws.close(4001, 'Auth timeout'); }, 5000);

    ws.on('message', (data, isBinary) => {
     try {
      // ══════════════════════════════════════════════════════
      // 认证阶段
      // ══════════════════════════════════════════════════════
      if (!authed) {
        clearTimeout(authTimer);
        if (!bans.relay.checkAuthRate(ip)) {
          const remain = Math.ceil(bans.relay.getRemainMs(ip) / 1000) || 2;
          ws.send(`{"ok":false,"error":"Rate limited","remain":${remain}}`);
          ws.close(4011, 'Rate limited');
          return;
        }
        try {
          const msg = JSON.parse(data.toString());
          if (msg.action !== 'auth' || !msg.key || !['pub', 'sub', 'check'].includes(msg.role)) {
            bans.relay.onAuthFail(ip);
            ws.send('{"ok":false,"error":"Invalid auth"}');
            ws.close(4002); return;
          }
          if (!isValidRoomKey(msg.key)) {
            bans.relay.onAuthFail(ip);
            ws.send('{"ok":false,"error":"Invalid room key"}');
            ws.close(4002); return;
          }
          key = msg.key; role = msg.role;

          // check 角色: 仅查询房间是否有 pub, 不占用 sub 名额
          if (role === 'check') {
            const hasPub = rooms.hasActivePub(key);
            ws.send(`{"ok":true,"role":"check","pub":${hasPub}}`);
            ws.close();
            return;
          }

          const room = rooms.getOrCreate(key);

          if (role === 'pub') {
            // 房间号白名单 (白名单未就绪也拒绝, 防空窗注入)
            if (whitelistEnforcement.isEnabled()) {
              if (!rooms.isWhitelistReady()) {
                bans.relay.onAuthFail(ip);
                ws.send('{"ok":false,"error":"房间白名单未就绪"}');
                ws.close(4005, 'Whitelist not ready');
                return;
              }
              if (!rooms.isAllowed(key)) {
                bans.relay.onAuthFail(ip);
                ws.send('{"ok":false,"error":"房间号未授权"}');
                ws.close(4005, 'Key not allowed');
                return;
              }
            }
            // 同房间 WS pub 唯一: 后到者顶替前者（不影响并行的 UDP pub）
            if (room.pub && room.pub.readyState === WebSocket.OPEN) {
              room.pub.close(4003, 'Replaced');
            }
            const hadAnyPub = rooms.hasActivePub(room);
            room.pub = ws;
            room.pubConnectedAt = Date.now();
            room.pubIP = ip;
            // 仅在没有 UDP 在线时清 cache，避免冲掉 UDP 源正在喂的帧
            if (!rooms.hasUdpPub(room)) {
              room.cache.clear();
            }
            if (recorder) {
              try { recorder.updateMetadata(key, { pubIP: ip }); } catch (e) {}
            }
            if (!hadAnyPub) {
              const onlineMsg = '{"type":"status","data":{"connected":true}}';
              for (let i = 0; i < room.subs.length; i++) {
                if (room.subs[i].readyState === WebSocket.OPEN) {
                  try { room.subs[i].send(onlineMsg); } catch (_) {}
                }
              }
            }
            // db.roomEvent.insert(key, 'pub', 'connect', ip, Date.now()).catch(() => {});
          } else {
            if (room.subs.length >= cfg.MAX_SUBS) {
              ws.send(`{"ok":false,"error":"已达上限(${cfg.MAX_SUBS}人)"}`);
              ws.close(4004); return;
            }
            room.subs.push(ws);
            ws._subIP = ip;
            room.subIPs = room.subs.map(s => s._subIP || '?');
            ws._windowStart = 0; ws._windowCount = 0;
            // db.roomEvent.insert(key, 'sub', 'connect', ip, Date.now()).catch(() => {});
            // 新订阅者立即吃一遍 cache（大包 deflate，与实时转发一致）
            for (const [, cached] of room.cache) {
              const wire = typeof cached === 'string'
                ? wireForViewer(cached)
                : { data: cached, binary: Buffer.isBuffer(cached) };
              ws.send(wire.data, { binary: wire.binary });
            }
            rooms.broadcastSubCount(room);
          }
          authed = true;
          bans.relay.onAuthSuccess(ip);
          const hasPub = rooms.hasActivePub(key);
          ws.send(`{"ok":true,"role":"${role}","subs":${room.subs.length},"pub":${hasPub}}`);
          log.info(`+ ${role} key="${key}" ip=${ip} subs=${room.subs.length}`);
        } catch (e) {
          bans.relay.onAuthFail(ip);
          ws.send('{"ok":false,"error":"Parse error"}');
          ws.close(4002);
        }
        return;
      }

      // ══════════════════════════════════════════════════════
      // pub 数据 → ingestPub（与 UDP 共用）
      // ══════════════════════════════════════════════════════
      if (role !== 'pub') return;

      const dataLen = isBinary ? data.length : Buffer.byteLength(data);
      if (!bans.relay.checkPubRate(ip, dataLen)) {
        ws.send('{"ok":false,"error":"Pub rate exceeded"}');
        ws.close(4012, 'Pub rate exceeded');
        return;
      }

      if (!rooms.getByKey(key)) return;

      if (!isBinary) {
        ingestPub({ rooms, traffic, recorder }, key, data.toString(), {
          ip, via: 'ws', dataLen,
        });
      } else {
        ingestPubBinary({ rooms, traffic, recorder }, key, data, { ip, via: 'ws' });
      }
     } catch (e) {
      // 业务异常顶层兜底, 防止单条坏消息打挂整个 process
      log.error('msg handler:', (e && e.stack) || e);
      try { ws.close(1011, 'Internal error'); } catch (_) {}
     }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!key) return;
      const room = rooms.getByKey(key);
      if (!room) return;
      if (role === 'pub' && room.pub === ws) {
        room.pub = null;
        // UDP 仍在发：只摘 WS 句柄，房间保持在线
        if (rooms.hasUdpPub(room)) {
          if (room.pubUdpIP) room.pubIP = room.pubUdpIP;
          log.info(`- ws pub key="${key}" (udp still live) subs=${room.subs.length}`);
        } else {
          room.pubConnectedAt = 0;
          room.pubIP = '';
          room.cache.clear();
          room.mapName = '';
          room.inGame = false;
          const msg = '{"type":"status","data":{"connected":false}}';
          for (let i = 0; i < room.subs.length; i++) {
            if (room.subs[i].readyState === WebSocket.OPEN) room.subs[i].send(msg);
          }
          log.info(`- ws pub key="${key}" subs=${room.subs.length}`);
        }
      } else if (role === 'sub') {
        const idx = room.subs.indexOf(ws);
        if (idx !== -1) room.subs.splice(idx, 1);
        room.subIPs = room.subs.map(s => s._subIP || '?');
        rooms.broadcastSubCount(room);
        // db.roomEvent.insert(key, 'sub', 'disconnect', ip, Date.now()).catch(() => {});
        log.info(`- sub key="${key}" subs=${room.subs.length}`);
      }
      rooms.maybeDelete(key);
    });

    ws.on('error', () => { /* 客户端中断不打日志, 让 close handler 收尾 */ });
  });

  // 30s 周期状态摘要 (空闲时静默, 有房间或封禁时打一行)
  const statusTimer = setInterval(() => {
    const { rooms: nRooms, pubs, subs } = rooms.countPubsSubs();
    const banCount = bans.size().relay;
    if (nRooms > 0 || banCount > 0) {
      log.info(`status rooms=${nRooms} pubs=${pubs} subs=${subs} bans=${banCount}`);
    }
  }, 30000);
  if (statusTimer.unref) statusTimer.unref();

  function stop() {
    clearInterval(statusTimer);
    try { wss.close(); } catch (e) {}
  }

  return { wss, stop };
}

module.exports = { createWsServer };
