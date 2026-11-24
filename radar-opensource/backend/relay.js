/**
 * relay.js — WebSocket 中继 + 管理后台 (薄入口)
 *
 * 业务全部抽到 lib/* (单文件单职责), 这里只做 wire:
 *   1. process 异常兜底
 *   2. 装载 config / 凭据 / 弱口令检查
 *   3. 实例化各 store: db / traffic / bans / rooms / announcement / theme / preview
 *   4. 启动 ws-server (依赖 bans + rooms + traffic)
 *   5. 启动 admin-http (依赖几乎所有 store)
 *   6. 启动白名单拉取 + 打印启动信息
 */
const fs = require('fs');
const path = require('path');

(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

const cfg = require('./lib/config');
const util = require('./lib/util');
const createLogger = require('./lib/logger');
const { Credentials } = require('./lib/credentials');
const { Traffic } = require('./lib/traffic');
const { Announcements } = require('./lib/announcement');
const { PreviewState, ThemeStore } = require('./lib/theme');
const { AuditLog } = require('./lib/audit');
const dbLib = require('./lib/db');
const { createBans } = require('./lib/bans');
const { createRooms } = require('./lib/rooms');
const { createWsServer } = require('./lib/ws-server');
const { createUdpServer } = require('./lib/udp-server');
const { createAdminHttp } = require('./lib/admin-http');
const { WhitelistEnforcement } = require('./lib/whitelist-enforcement');
const { FrontendAccess } = require('./lib/frontend-access');
const { PrivacyMode } = require('./lib/privacy-mode');
const { ExtApi } = require('./lib/ext-api');
const { createRecorderManager } = require('./lib/recorder');

const log    = createLogger('Main');
const logSec = createLogger('Security');

process.on('uncaughtException', (err) => {
  log.error('FATAL uncaughtException:', (err && err.stack) || err);
  setTimeout(() => process.exit(1), 200);
});
process.on('unhandledRejection', (reason) => {
  log.warn('unhandledRejection:', (reason && reason.stack) || reason);
});

const creds = new Credentials({ file: cfg.CRED_FILE });
creds.load();

(function validateConfiguration() {
  if (!creds.user || !creds.passHash || !creds.passSalt) throw new Error('Administrator credentials are required');
  if (String(process.env.ROOMS_SECRET || '').length < 32) throw new Error('ROOMS_SECRET must contain at least 32 characters');
  if (!String(process.env.PG_CONN || '').trim()) throw new Error('PG_CONN must be configured');
})();

// ── PostgreSQL + 业务 store ──────────────────────────────────
const PG_CONN = process.env.PG_CONN;
const db = dbLib.open(PG_CONN);

const traffic     = new Traffic();
const bans        = createBans({ db });
const announcement = new Announcements();
announcement.load();
const theme       = new ThemeStore();
theme.load();
const preview     = new PreviewState();
preview.load();
const whitelistEnforcement = new WhitelistEnforcement();
whitelistEnforcement.load();
const frontendAccess = new FrontendAccess();
frontendAccess.load();
const privacyMode = new PrivacyMode();
privacyMode.load();
const audit       = new AuditLog({ file: cfg.AUDIT_LOG_FILE });

const clientIPOf = (req) => util.clientIP(req, cfg.TRUST_PROXY);

// ── 异步启动 ─────────────────────────────────────────────────
(async function boot() {
  try {
    await db.initTables();
    log.info('PostgreSQL tables ready');

    const rooms = createRooms({ db, traffic });
    await rooms.loadAllowedFromDb();
    await bans.restore();

    const recorder = await createRecorderManager(db);

    const logRelay = createLogger('Relay');
    const ws = createWsServer({ port: cfg.PORT, bans, rooms, traffic, clientIPOf, whitelistEnforcement, recorder, db });
    const udp = createUdpServer({ port: cfg.PORT, bans, rooms, traffic, whitelistEnforcement, recorder });
    logRelay.info(`relay ws+udp on 0.0.0.0:${cfg.PORT} (${cfg.THROTTLE_MS}ms throttle, pid ${process.pid})`);

    const extApi = new ExtApi({ rooms });
    extApi.load();

    const logAdmin = createLogger('Admin');
    const admin = createAdminHttp({
      db, creds, bans, rooms, traffic, announcement, theme, preview, whitelistEnforcement, frontendAccess, privacyMode, extApi, audit, recorder,
      clientIPOf,
    });

    admin.server.listen(cfg.ADMIN_PORT, cfg.ADMIN_BIND, () => {
      logAdmin.info(`dashboard on http://${cfg.ADMIN_BIND}:${cfg.ADMIN_PORT}`);
      if (cfg.ADMIN_BIND === '0.0.0.0') {
        logSec.warn('管理后台已绑定 0.0.0.0 (公网可达)。生产环境强烈建议改用 ADMIN_BIND=127.0.0.1 + nginx TLS 反代。');
      } else if (cfg.ADMIN_BIND === '127.0.0.1' || cfg.ADMIN_BIND === 'localhost') {
        logAdmin.info(`当前仅 loopback 可达, 公网访问需 nginx 反代到 ${cfg.ADMIN_PORT}`);
      }
    });

    rooms.startWhitelist();

    // 清理 30 天以上的房间/封禁事件记录
    const cutoff = Date.now() - 30 * 86400000;
    db.roomEvent.cleanup(cutoff).catch(() => {});
    db.banEvent.cleanup(cutoff).catch(() => {});

    // ── 优雅停机 ──
    const { WebSocket } = require('ws');
    let _shuttingDown = false;
    function shutdown(signal) {
      if (_shuttingDown) return;
      _shuttingDown = true;
      log.info(`got ${signal}, graceful shutdown...`);
      const offlineMsg = '{"type":"status","data":{"connected":false,"reason":"server_restart"}}';
      let kicked = 0;
      for (const room of rooms.rooms.values()) {
        for (const sub of room.subs) {
          if (sub.readyState === WebSocket.OPEN) {
            try { sub.send(offlineMsg); kicked++; } catch (e) {}
          }
        }
      }
      log.info(`broadcast offline to ${kicked} subscribers`);
      try { ws.stop(); } catch (e) {}
      try { udp.stop(); } catch (e) {}
      try { admin.stop(); } catch (e) {}
      try { recorder.flushAll(); } catch (e) {}
      try { rooms.stop(); } catch (e) {}
      try { bans.stop(); } catch (e) {}
      try { traffic.stop(); } catch (e) {}
      db.close();
      const exitTimer = setTimeout(() => { log.warn('shutdown timeout, force exit'); process.exit(0); }, 1500);
      exitTimer.unref();
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

  } catch (e) {
    log.error('Boot failed:', e.stack || e.message);
    process.exit(1);
  }
})();
