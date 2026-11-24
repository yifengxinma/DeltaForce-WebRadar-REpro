/**
 * udp-server.js — DLL/Ext UDP pub 收包入房
 *
 * 链路: DLL → UDP(二进制 RadarBin 或旧 JSON) → ingestPub → WS → 网页
 * 与 ws-server 的 WS pub 并行。
 */
const dgram = require('dgram');
const { isValidRoomKey } = require('./util');
const { ingestPub } = require('./ingest-pub');
const { decodeRadarBin, isRadarBin } = require('./udp-binary');
const log = require('./logger')('UDP');

function createUdpServer({ port, bans, rooms, traffic, whitelistEnforcement, recorder }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    log.error('socket error:', (err && err.message) || err);
  });

  sock.on('message', (buf, rinfo) => {
    try {
      const ip = rinfo.address || '';
      if (bans.relay.isBanned(ip)) return;

      const dataLen = buf.length;
      if (dataLen < 2 || dataLen > 65507) return;
      if (!bans.relay.checkPubRate(ip, dataLen)) return;

      let key = '';
      let raw = '';

      if (isRadarBin(buf)) {
        const decoded = decodeRadarBin(buf);
        if (!decoded) return;
        key = decoded.key;
        raw = decoded.json;
      } else {
        // 兼容旧 JSON UDP
        let msg;
        try {
          msg = JSON.parse(buf.toString('utf8'));
        } catch (_) {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        key = typeof msg.key === 'string' ? msg.key : '';
        raw = buf.toString('utf8');
      }

      if (!isValidRoomKey(key)) return;

      if (whitelistEnforcement.isEnabled()) {
        if (!rooms.isWhitelistReady() || !rooms.isAllowed(key)) return;
      }

      rooms.getOrCreate(key);
      ingestPub({ rooms, traffic, recorder }, key, raw, {
        ip,
        via: 'udp',
        dataLen,
      });
    } catch (e) {
      log.error('msg handler:', (e && e.stack) || e);
    }
  });

  sock.bind(port, '0.0.0.0', () => {
    log.info(`udp pub listen 0.0.0.0:${port} (RadarBin + JSON)`);
  });

  function stop() {
    try { sock.close(); } catch (e) {}
  }

  return { sock, stop };
}

module.exports = { createUdpServer };
