/**
 * bans.js — 双套封禁系统 (relay + admin) + 渐进限流
 *
 * 内存 Map 是主数据源 (isBanned/banIP 全部同步), DB 只做持久化 (fire-and-forget)
 */
const cfg = require('./config');
const log = require('./logger')('Bans');

function createBans({ db }) {
  const ipBans     = new Map();
  const authLimits = new Map();
  const pubLimits  = new Map();

  const relay = {
    isBanned(ip) {
      const b = ipBans.get(ip);
      if (!b) return false;
      if (Date.now() >= b.until) {
        ipBans.delete(ip);
        db.bans.delete(ip, 'relay').catch(() => {});
        return false;
      }
      return true;
    },

    banIP(ip, reason) {
      const prev = ipBans.get(ip);
      const level = prev ? Math.min(prev.level + 1, cfg.BAN_DURATIONS.length - 1) : 1;
      const duration = cfg.BAN_DURATIONS[level];
      const until = Date.now() + duration;
      ipBans.set(ip, { until, level, reason });
      db.bans.upsert(ip, 'relay', until, level, reason || '').catch(e => log.error('relay ban upsert:', e.message));
      db.banEvent.insert(ip, 'ban', 'relay', reason || '', duration, '', Date.now()).catch(() => {});
      log.info(`BAN ip=${ip} level=${level} duration=${duration / 1000}s reason=${reason}`);
    },

    getRemainMs(ip) {
      const b = ipBans.get(ip);
      return b ? Math.max(0, b.until - Date.now()) : 0;
    },

    list() {
      const out = [];
      const now = Date.now();
      for (const [ip, b] of ipBans) {
        const remainMs = Math.max(0, b.until - now);
        if (remainMs <= 0) {
          ipBans.delete(ip);
          db.bans.delete(ip, 'relay').catch(() => {});
          continue;
        }
        out.push({ ip, level: b.level, reason: b.reason || '-', remainMs });
      }
      return out;
    },

    checkAuthRate(ip) {
      const now = Date.now();
      let al = authLimits.get(ip);
      if (!al) { al = { count: 0, windowStart: now, failStreak: 0, coolUntil: 0 }; authLimits.set(ip, al); }
      if (now < al.coolUntil) return false;
      if (now - al.windowStart >= 1000) { al.count = 0; al.windowStart = now; }
      al.count++;
      if (al.count > cfg.AUTH_RATE) {
        al.failStreak++;
        if (al.failStreak >= 2) {
          relay.banIP(ip, 'auth_flood');
          authLimits.delete(ip);
          return false;
        }
        al.coolUntil = now + cfg.AUTH_COOLDOWN;
        return false;
      }
      return true;
    },

    onAuthFail(ip) {
      const al = authLimits.get(ip);
      if (al) al.failStreak++;
    },

    onAuthSuccess(ip) {
      const al = authLimits.get(ip);
      if (al) { al.failStreak = 0; al.coolUntil = 0; }
    },

    checkPubRate(ip, dataSize) {
      // 只保留单条大小限制, 关闭 pub_flood 频率 ban (合法客户端游戏激烈时会短时超限, 不应被 ban)
      if (dataSize > cfg.PUB_MAX_SIZE) {
        relay.banIP(ip, `msg_too_large(${(dataSize / 1024).toFixed(1)}KB)`);
        return false;
      }
      return true;
    },
  };

  const adminIpBans     = new Map();
  const adminLoginFails = new Map();
  const adminReqRate    = new Map();

  const admin = {
    isBanned(ip) {
      const b = adminIpBans.get(ip);
      if (!b) return false;
      if (Date.now() >= b.until) {
        adminIpBans.delete(ip);
        db.bans.delete(ip, 'admin').catch(() => {});
        return false;
      }
      return true;
    },

    banIP(ip, duration, reason) {
      const until = Date.now() + duration;
      adminIpBans.set(ip, { until, level: duration, reason });
      db.bans.upsert(ip, 'admin', until, 0, reason || '').catch(e => log.error('admin ban upsert:', e.message));
      db.banEvent.insert(ip, 'ban', 'admin', reason || '', duration, '', Date.now()).catch(() => {});
      log.info(`ADMIN-BAN ip=${ip} duration=${duration / 1000}s reason=${reason}`);
    },

    getRemainSec(ip) {
      const b = adminIpBans.get(ip);
      return b ? Math.max(0, Math.ceil((b.until - Date.now()) / 1000)) : 0;
    },

    checkRate(ip) {
      const now = Date.now();
      let r = adminReqRate.get(ip);
      if (!r) { r = { count: 0, windowStart: now, triggerCount: 0, triggerFirstAt: now }; adminReqRate.set(ip, r); }
      if (now - r.triggerFirstAt > 3600000) { r.triggerCount = 0; r.triggerFirstAt = now; }
      if (now - r.windowStart >= 1000) { r.count = 0; r.windowStart = now; }
      r.count++;
      if (r.count > cfg.ADMIN_RATE_PER_SEC) {
        r.triggerCount++;
        if (r.triggerCount >= cfg.ADMIN_RATE_TRIGGER) {
          admin.banIP(ip, 3600000, 'admin_rate_flood_1h');
          adminReqRate.delete(ip);
        } else {
          admin.banIP(ip, 1000, 'admin_rate_burst');
        }
        return false;
      }
      return true;
    },

    onLoginFail(ip) {
      const now = Date.now();
      let f = adminLoginFails.get(ip);
      if (!f) { f = { count: 0, firstFailAt: now }; adminLoginFails.set(ip, f); }
      if (now - f.firstFailAt > cfg.ADMIN_LOGIN_FAIL_WINDOW) { f.count = 0; f.firstFailAt = now; }
      f.count++;
      if (f.count >= cfg.ADMIN_LOGIN_FAIL_LIMIT) {
        admin.banIP(ip, 60000, 'admin_login_fail_5x');
        adminLoginFails.delete(ip);
      }
    },

    onLoginSuccess(ip) { adminLoginFails.delete(ip); },

    failsLeft(ip) {
      const f = adminLoginFails.get(ip);
      return f ? Math.max(0, cfg.ADMIN_LOGIN_FAIL_LIMIT - f.count) : (cfg.ADMIN_LOGIN_FAIL_LIMIT - 1);
    },

    list() {
      const out = [];
      const now = Date.now();
      for (const [ip, b] of adminIpBans) {
        const remainMs = Math.max(0, b.until - now);
        if (remainMs <= 0) {
          adminIpBans.delete(ip);
          db.bans.delete(ip, 'admin').catch(() => {});
          continue;
        }
        out.push({ ip, reason: b.reason || '-', remainMs, source: 'admin' });
      }
      return out;
    },

    unbanAll(ip) {
      ipBans.delete(ip);
      adminIpBans.delete(ip);
      db.bans.deleteIp(ip).catch(() => {});
      db.banEvent.insert(ip, 'unban', 'admin', 'manual', 0, '', Date.now()).catch(() => {});
    },
  };

  async function restore() {
    const now = Date.now();
    await db.bans.cleanup(now).catch(() => {});
    let relayCount = 0, adminCount = 0;
    try {
      const relayBans = await db.bans.loadBySource('relay', now);
      for (const r of relayBans) {
        ipBans.set(r.ip, { until: r.until_ms, level: r.level, reason: r.reason });
        relayCount++;
      }
      const adminBansRows = await db.bans.loadBySource('admin', now);
      for (const r of adminBansRows) {
        adminIpBans.set(r.ip, { until: r.until_ms, level: r.level, reason: r.reason });
        adminCount++;
      }
    } catch (e) { log.error('ban restore:', e.message); }
    if (relayCount || adminCount) {
      log.info(`Restored ${relayCount} relay bans, ${adminCount} admin bans`);
    }
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of ipBans)      { if (now >= b.until) { ipBans.delete(ip); db.bans.delete(ip, 'relay').catch(() => {}); } }
    for (const [ip, b] of adminIpBans) { if (now >= b.until) { adminIpBans.delete(ip); db.bans.delete(ip, 'admin').catch(() => {}); } }
    for (const [ip, al] of authLimits) { if (now - al.windowStart > 60000) authLimits.delete(ip); }
    for (const [ip, pl] of pubLimits)  { if (now - pl.windowStart > 60000) pubLimits.delete(ip); }
    for (const [ip, f] of adminLoginFails) { if (now - f.firstFailAt > cfg.ADMIN_LOGIN_FAIL_WINDOW) adminLoginFails.delete(ip); }
    for (const [ip, r] of adminReqRate)    { if (now - r.windowStart > 60000) adminReqRate.delete(ip); }
  }, 60000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  function stop() { if (cleanupTimer) clearInterval(cleanupTimer); }
  function size() { return { relay: ipBans.size, admin: adminIpBans.size }; }

  return { relay, admin, restore, stop, size };
}

module.exports = { createBans };
