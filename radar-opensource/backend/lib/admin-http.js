/**
 * admin-http.js — 管理后台 HTTP 服务: 鉴权 + 30+ endpoints + 静态文件
 *
 * 抽出动机:
 *   relay.js 之前 adminServer + getStats + getHistory + parseBody + 全部路由
 *   一坨 600+ 行, 改一个 endpoint 要在多个地方跳读。封装后:
 *   - createAdminHttp({ ...stores }) 接受全部依赖, 返回 { server, listen, stop }
 *   - 鉴权 cookie 双层: memory Set (热路径) + SQLite 持久化 (重启不掉线)
 *   - applySecurityHeaders + applyCors 统一进出口
 *   - 每 10s 把 traffic + rooms 状态 upsert 进 daily_stats (跨天自动重置 delta 基准)
 *
 * Endpoint 分类:
 *   无需登录: /api/healthz /api/theme(GET) /api/theme_names(GET) /api/preview_status(GET)
 *             /api/announcements/public /api/rooms_status /api/set_rooms (ROOMS_SECRET)
 *   需要登录: 其余全部
 *   静态:    / /admin /admin.html /admin.css /admin.js /admin-echarts-fallback.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { Readable } = require('stream');
const cfg = require('./config');
const { fmtBytes, fmtDuration, todayStr } = require('./util');
const { hashToken } = require('./audit');
const { timingSafeStringEqual } = require('./timing');
const log = require('./logger')('Admin');

function createAdminHttp({
  db, creds, bans, rooms, traffic, announcement, theme, preview, whitelistEnforcement, frontendAccess, privacyMode, extApi, audit, recorder,
  clientIPOf,
  version = '1.8.0',
}) {
  // audit ctx 公共字段, 每个敏感 endpoint 调用前生成一次
  function auditCtx(req, token) {
    const auth = req.headers['authorization'] || '';
    const t = token || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    return {
      actor: creds.user,
      ip: clientIPOf(req),
      ua: req.headers['user-agent'] || '-',
      tokenHash: hashToken(t),
    };
  }
  const serverStartTime = Date.now();
  // session: 双层 (内存 Set 热路径 + SQLite 持久化重启不掉线)
  const adminTokens = new Set();

  // ── 历史累计流量基准 (跨天重置 delta) ────────────────────
  let _lastSavedDl = 0, _lastSavedUl = 0;
  let _lastHistDate = todayStr();
  let _savedDlTotal = 0, _savedUlTotal = 0;
  db.stats.sumTotals().then(totals => {
    _savedDlTotal = totals ? (Number(totals.dl) || 0) : 0;
    _savedUlTotal = totals ? (Number(totals.ul) || 0) : 0;
    log.info(`stats 历史累计流量: DL=${fmtBytes(_savedDlTotal)} UL=${fmtBytes(_savedUlTotal)}`);
  }).catch(e => log.error('stats 读取历史流量失败:', e.message));

  // ── 每 10s 落盘 daily_stats ──────────────────────────────
  const statsTimer = setInterval(() => {
    const today = todayStr();
    const snap = traffic.snapshot();
    const c = rooms.countPubsSubs();
    const banSize = bans.size();

    // 跨天: 重置增量基准
    if (today !== _lastHistDate) {
      _lastSavedDl = snap.dlTotal;
      _lastSavedUl = snap.ulTotal;
      _lastHistDate = today;
    }
    const dlDelta = Math.max(0, snap.dlTotal - _lastSavedDl);
    const ulDelta = Math.max(0, snap.ulTotal - _lastSavedUl);
    _lastSavedDl = snap.dlTotal;
    _lastSavedUl = snap.ulTotal;

    db.stats.upsert({
      date: today,
      peak_rooms: c.rooms, peak_pubs: c.pubs, peak_subs: c.subs,
      peak_bans: banSize.relay + banSize.admin,
      peak_dl_sec: snap.dlPerSec, peak_ul_sec: snap.ulPerSec,
      dl_delta: dlDelta, ul_delta: ulDelta,
    }).then(() => {
      _savedDlTotal += dlDelta;
      _savedUlTotal += ulDelta;
    }).catch(e => log.error('daily_stats upsert error:', e.message));
  }, 10000);
  if (statsTimer.unref) statsTimer.unref();

  // ── session 持久化 helper ────────────────────────────────
  async function checkSessionPersisted(token) {
    try {
      const row = await db.sess.check(token, Date.now());
      return !!row;
    } catch (e) { return false; }
  }
  function saveSessionPersisted(token, durationMs) {
    db.sess.insert(token, Date.now() + durationMs).catch(e => log.error('session save failed:', e.message));
  }
  function deleteSessionPersisted(token) {
    db.sess.delete(token).catch(() => {});
  }

  db.sess.clearExpired(Date.now()).catch(() => {});
  const sessTimer = setInterval(() => {
    db.sess.clearExpired(Date.now()).catch(() => {});
  }, 3600000);
  if (sessTimer.unref) sessTimer.unref();

  // ── 鉴权 ────────────────────────────────────────────────
  async function checkToken(req) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return adminTokens.has(token) || await checkSessionPersisted(token);
  }

  function checkRoomsSecret(provided) {
    const expected = process.env.ROOMS_SECRET || '';
    if (!expected) return false;
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  // ── header helpers ──────────────────────────────────────
  function applySecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  function applyCors(req, res) {
    applySecurityHeaders(res);
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        const hostHeader = (req.headers.host || '').split(':')[0];
        const sameHost = o.hostname === hostHeader
          || (o.hostname === 'localhost' && hostHeader === '127.0.0.1')
          || (o.hostname === '127.0.0.1' && hostHeader === 'localhost');
        if (sameHost) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
      } catch (e) { /* ignore bad origin */ }
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, PUT');
  }

  function parseBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      let body = '';
      const limit = maxBytes || cfg.HTTP_BODY_LIMIT;
      req.on('data', c => { body += c; if (body.length > limit) reject('too large'); });
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject('bad json'); } });
    });
  }

  // ── 数据查询 helpers (给 endpoint 调用) ──────────────────
  function getStats() {
    const c = rooms.countPubsSubs();
    const banSize = bans.size();
    const snap = traffic.snapshot();
    const dlTotal = _savedDlTotal + (snap.dlTotal - _lastSavedDl);
    const ulTotal = _savedUlTotal + (snap.ulTotal - _lastSavedUl);
    return {
      rooms: c.rooms, pubs: c.pubs, subs: c.subs,
      bans: banSize.relay + banSize.admin,
      uptime: fmtDuration(Date.now() - serverStartTime),
      dlTotal, ulTotal,
      dlTotalStr: fmtBytes(dlTotal),
      ulTotalStr: fmtBytes(ulTotal),
      dlPerSec: snap.dlPerSec, ulPerSec: snap.ulPerSec,
      dlPerSecStr: fmtBytes(snap.dlPerSec) + '/s',
      ulPerSecStr: fmtBytes(snap.ulPerSec) + '/s',
    };
  }

  function getBanListFormatted() {
    const list = bans.relay.list();
    return list
      .sort((a, b) => b.remainMs - a.remainMs)
      .map(b => ({ ip: b.ip, level: b.level, reason: b.reason, remain: fmtDuration(b.remainMs), remainMs: b.remainMs }));
  }

  function getAdminBanListFormatted() {
    const list = bans.admin.list();
    return list
      .sort((a, b) => b.remainMs - a.remainMs)
      .map(b => ({ ip: b.ip, reason: b.reason, remain: fmtDuration(b.remainMs), remainMs: b.remainMs, source: 'admin' }));
  }

  async function getHistory() {
    try {
      const rows = await db.stats.select90();
      return rows.map(d => ({
        date: d.date,
        peakRooms: d.peak_rooms, peakPubs: d.peak_pubs, peakSubs: d.peak_subs, peakBans: d.peak_bans,
        peakDlSec: d.peak_dl_sec, peakDlSecStr: fmtBytes(d.peak_dl_sec) + '/s',
        peakUlSec: d.peak_ul_sec, peakUlSecStr: fmtBytes(d.peak_ul_sec) + '/s',
        dlDay: d.dl_day, dlDayStr: fmtBytes(d.dl_day),
        ulDay: d.ul_day, ulDayStr: fmtBytes(d.ul_day),
      }));
    } catch (e) { log.error('history query error:', e.message); return []; }
  }

  async function getRoomHistory(roomKey) {
    try {
      const rows = await db.roomStats.history(roomKey);
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
    } catch (e) { log.error('room history error:', e.message); return []; }
  }

  // ══════════════════════════════════════════════════════════
  // HTTP server: 鉴权 → 路由
  // ══════════════════════════════════════════════════════════
  const server = http.createServer(async (req, res) => {
    const ip = clientIPOf(req);
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── 管理后台 IP 封禁 ──
    if (bans.admin.isBanned(ip)) {
      const remain = bans.admin.getRemainSec(ip);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(`{"ok":false,"error":"IP frozen","remain":${remain}}`);
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ── 公开 GET / 静态资源豁免限速 (刷新后台会连打 html/css/js/assets) ──
    const isStaticAsset =
      pathname === '/' ||
      pathname === '/admin' ||
      pathname === '/admin.html' ||
      pathname === '/admin.css' ||
      pathname === '/admin.js' ||
      pathname === '/admin-events.js' ||
      pathname === '/admin-echarts-fallback.js' ||
      pathname === '/favicon.ico' ||
      pathname === '/replay.html' ||
      pathname.startsWith('/assets/');
    const isPublicGet =
      isStaticAsset ||
      (pathname === '/api/theme' && req.method === 'GET') ||
      (pathname === '/api/preview_status' && req.method === 'GET') ||
      (pathname === '/api/theme_names' && req.method === 'GET') ||
      (pathname === '/api/announcements/public' && req.method === 'GET') ||
      (pathname === '/api/privacy_mode' && req.method === 'GET') ||
      (pathname === '/api/rooms_status') ||
      (pathname === '/api/set_rooms') ||
      (pathname === '/api/healthz') ||
      (pathname.startsWith('/api/share/') && (req.method === 'GET' || req.method === 'HEAD'));

    // ── 请求频率 (仅限 /api，避免刷新静态页把 IP 冻 1 小时) ──
    if (!isPublicGet && pathname.startsWith('/api/') && !bans.admin.checkRate(ip)) {
      const remain = bans.admin.getRemainSec(ip);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(`{"ok":false,"error":"Too many requests","remain":${remain}}`);
      return;
    }

    // ══════════════════════════════════════════════════════
    // 登录 (无需 token)
    // ══════════════════════════════════════════════════════
    if (pathname === '/api/login' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        // timing-safe 用户名 + 密码比较, 防 timing-attack 推测 admin 用户名存在性
        const userOk = timingSafeStringEqual(body.user, creds.user);
        const passOk = creds.checkPassword(body.pass);
        if (userOk && passOk) {
          bans.admin.onLoginSuccess(ip);
          const token = crypto.randomBytes(32).toString('hex');
          adminTokens.add(token);
          setTimeout(() => adminTokens.delete(token), cfg.SESSION_DURATION_MS);
          saveSessionPersisted(token, cfg.SESSION_DURATION_MS);
          audit.write('login_ok', { ...auditCtx(req, token), extra: { user: creds.user } });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, token }));
        } else {
          bans.admin.onLoginFail(ip);
          const attemptsLeft = bans.admin.failsLeft(ip);
          audit.write('login_fail', {
            actor: '-', ip, ua: req.headers['user-agent'] || '-', tokenHash: '-',
            extra: { triedUser: String(body.user || '').slice(0, 32), attemptsLeft },
          });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(`{"ok":false,"error":"账号或密码错误 (剩余${attemptsLeft}次)"}`);
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"Bad request"}');
      }
      return;
    }

    // ══════════════════════════════════════════════════════
    // 鉴权门 (除豁免列表外, /api/* 必须带 token)
    // ══════════════════════════════════════════════════════
    if (pathname.startsWith('/api/')
        && pathname !== '/api/rooms_status'
        && pathname !== '/api/set_rooms'
        && pathname !== '/api/healthz'
        && !(pathname === '/api/theme' && req.method === 'GET')
        && !(pathname === '/api/preview_status' && req.method === 'GET')
        && !(pathname === '/api/theme_names' && req.method === 'GET')
        && !(pathname === '/api/announcements/public' && req.method === 'GET')
        && !(pathname === '/api/privacy_mode' && req.method === 'GET')
        && !(pathname.startsWith('/api/share/') && (req.method === 'GET' || req.method === 'HEAD'))
        && !(await checkToken(req))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"Unauthorized"}');
      return;
    }

    // ══════════════════════════════════════════════════════
    // 公告
    // ══════════════════════════════════════════════════════
    if (pathname === '/api/announcements/public' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const list = announcement.listSorted({ enabledOnly: true })
        .map(a => ({
          id: a.id, title: a.title, content: a.content,
          type: a.type, pinned: a.pinned, displayMode: a.displayMode,
          updatedAt: a.updatedAt,
        }));
      res.end(JSON.stringify({ ok: true, list }));
      return;
    }

    if (pathname === '/api/announcements' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, list: announcement.listSorted() }));
      return;
    }

    if (pathname === '/api/announcements' && req.method === 'POST') {
      try {
        const b = await parseBody(req);
        const ann = announcement.add(b);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ann }));
      } catch (e) {
        const code = String(e.message || e).includes('required') ? 400 : 400;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
      return;
    }

    if (pathname === '/api/announcements' && req.method === 'PUT') {
      try {
        const b = await parseBody(req);
        const ann = announcement.update(b.id, b);
        if (!ann) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ann }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    if (pathname === '/api/announcements' && req.method === 'DELETE') {
      try {
        const b = await parseBody(req);
        if (!announcement.remove(b.id)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    // ══════════════════════════════════════════════════════
    // 健康检查 / 主题 / 预览 / 标题图标 (大多无需登录)
    // ══════════════════════════════════════════════════════
    if (pathname === '/api/healthz' && req.method === 'GET') {
      let dbOk = true;
      try { dbOk = await db.healthCheck(); } catch (e) { dbOk = false; }
      const status = dbOk ? 200 : 503;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: dbOk,
        uptime: Math.floor((Date.now() - serverStartTime) / 1000),
        rooms: rooms.countPubsSubs().rooms,
        db: dbOk ? 'ok' : 'error',
        ver: version,
      }));
      return;
    }

    if (pathname === '/api/theme' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, theme: theme.getCurrent() }));
      return;
    }

    if (pathname === '/api/preview_status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, enabled: preview.enabled }));
      return;
    }

    if (pathname === '/api/theme_names' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        white: theme.names.white, black: theme.names.black,
        iconWhite: theme.names.iconWhite, iconBlack: theme.names.iconBlack,
        landing: theme.names.landing || {},
      }));
      return;
    }

    // ══════════════════════════════════════════════════════
    // 房间 / 封禁 / 统计 / 历史
    // ══════════════════════════════════════════════════════
    if (pathname === '/api/rooms') {
      const q = url.searchParams.get('q') || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.getRoomList(q), stats: getStats() }));
      return;
    }

    if (pathname === '/api/bans') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bans: getBanListFormatted(), adminBans: getAdminBanListFormatted() }));
      return;
    }

    if (pathname === '/api/room_events' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 10000);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const search = (url.searchParams.get('search') || '').trim();
      let rows, total;
      if (search) {
        const pattern = `%${search}%`;
        rows = await db.roomEvent.search(pattern, limit, offset);
        total = (await db.roomEvent.searchCount(pattern)).n;
      } else {
        rows = await db.roomEvent.list(limit, offset);
        total = (await db.roomEvent.count()).n;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, events: rows, total }));
      return;
    }

    if (pathname === '/api/ban_events' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 10000);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const search = (url.searchParams.get('search') || '').trim();
      let rows, total;
      if (search) {
        const pattern = `%${search}%`;
        rows = await db.banEvent.search(pattern, limit, offset);
        total = (await db.banEvent.searchCount(pattern)).n;
      } else {
        rows = await db.banEvent.list(limit, offset);
        total = (await db.banEvent.count()).n;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, events: rows, total }));
      return;
    }

    if (pathname === '/api/clear_events' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const target = body.target;
        const mode = body.mode || 'all';
        if (target !== 'room' && target !== 'ban' && target !== 'both') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"target must be room|ban|both"}');
          return;
        }
        let before = 0;
        if (mode === '7d') before = Date.now() - 7 * 86400000;
        else if (mode === '30d') before = Date.now() - 30 * 86400000;
        let deleted = { room: 0, ban: 0 };
        if (target === 'room' || target === 'both') {
          const r = mode === 'all'
            ? await db.roomEvent.cleanup(Date.now())
            : await db.roomEvent.cleanup(before);
          deleted.room = r.rowCount || 0;
        }
        if (target === 'ban' || target === 'both') {
          const r = mode === 'all'
            ? await db.banEvent.cleanup(Date.now())
            : await db.banEvent.cleanup(before);
          deleted.ban = r.rowCount || 0;
        }
        audit.write('clear_events', { ...auditCtx(req), extra: { target, mode, deleted } });
        log.info(`events cleared: target=${target} mode=${mode} room=${deleted.room} ban=${deleted.ban}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...getStats() }));
      return;
    }

    if (pathname === '/api/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, history: await getHistory() }));
      return;
    }

    if (pathname === '/api/room_history') {
      const roomKey = url.searchParams.get('key') || '';
      if (!roomKey) { res.writeHead(400); res.end('{"ok":false,"error":"missing key"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, history: await getRoomHistory(roomKey) }));
      return;
    }

    if (pathname === '/api/clear_history' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        audit.write('clear_history', { ...auditCtx(req), extra: { mode: body.mode, date: body.date, days: body.days } });
        // mode: 'date' | 'all' | 'days'
        if (body.mode === 'date' && body.date) {
          await db.stats.deleteByDate(body.date);
          await db.roomStats.deleteByDate(body.date);
        } else if (body.mode === 'all') {
          await db.stats.deleteAll();
          await db.roomStats.deleteAll();
        } else if (body.mode === 'days' && body.days > 0) {
          const cutoff = [];
          for (let i = 0; i < body.days; i++) {
            const d = new Date(Date.now() + 8 * 3600000 - i * 86400000);
            const pad = n => String(n).padStart(2, '0');
            cutoff.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
          }
          const placeholders = cutoff.map(() => '?').join(',');
          db.db.prepare(`DELETE FROM daily_stats WHERE date NOT IN (${placeholders})`).run(...cutoff);
          db.db.prepare(`DELETE FROM room_daily_stats WHERE date NOT IN (${placeholders})`).run(...cutoff);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); res.end(`{"ok":false,"error":"${e}"}`); }
      return;
    }

    // ══════════════════════════════════════════════════════
    // 房间白名单 (推/查)
    // ══════════════════════════════════════════════════════
    if (pathname === '/api/rooms_status' && req.method === 'GET') {
      const w = rooms.whitelist();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ready: w.ready,
        count: w.count,
        enforced: whitelistEnforcement.isEnabled(),
      }));
      return;
    }

    if (pathname === '/api/whitelist_status' && req.method === 'GET') {
      const w = rooms.whitelist();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        enabled: whitelistEnforcement.isEnabled(),
        ready: w.ready,
        count: w.count,
        keys: rooms.listAllowedKeys(),
        pullMode: !!cfg.ROOMS_API_URL,
        envDefault: whitelistEnforcement.envDefault,
      }));
      return;
    }

    if (pathname === '/api/whitelist' && req.method === 'GET') {
      const w = rooms.whitelist();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        enabled: whitelistEnforcement.isEnabled(),
        ready: w.ready,
        count: w.count,
        keys: rooms.listAllowedKeys(),
        pullMode: !!cfg.ROOMS_API_URL,
        envDefault: whitelistEnforcement.envDefault,
      }));
      return;
    }

    if (pathname === '/api/set_rooms' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        if (!checkRoomsSecret(body.secret)) {
          audit.write('set_rooms_forbidden', {
            actor: '-', ip, ua: req.headers['user-agent'] || '-', tokenHash: '-',
          });
          res.writeHead(403); res.end('{"ok":false,"error":"forbidden"}'); return;
        }
        const raw = typeof body.rooms === 'string' ? body.rooms : '';
        const { isValidRoomKey } = require('./util');
        const keys = raw.split('|').map(k => k.trim()).filter(k => isValidRoomKey(k));
        rooms.applyAllowed(keys);
        audit.write('set_rooms', {
          actor: 'rooms_api', ip, ua: req.headers['user-agent'] || '-', tokenHash: '-',
          extra: { count: keys.length },
        });
        log.info(`rooms push received: ${keys.length} keys`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(`{"ok":true,"count":${keys.length}}`);
      } catch (e) { res.writeHead(400); res.end(`{"ok":false,"error":"${e.message}"}`); }
      return;
    }

    // ══════════════════════════════════════════════════════
    // 踢人 / 预览 / me / logout / 改密 / 改账号 / 主题切换 / 封禁
    // ══════════════════════════════════════════════════════
    if (pathname === '/api/kick' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const room = rooms.getByKey(body.key);
        if (!room) { res.writeHead(404); res.end('{"ok":false}'); return; }
        if (body.target === 'pub' && room.pub) {
          room.pub.close(4100, 'Kicked by admin');
        } else if (body.target === 'all') {
          if (room.pub) room.pub.close(4100, 'Kicked by admin');
          room.subs.forEach(s => s.close(4100, 'Kicked by admin'));
        }
        audit.write('kick', { ...auditCtx(req), extra: { key: body.key, target: body.target } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('{"ok":false}'); }
      return;
    }

    if (pathname === '/api/preview_status' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        preview.set(!!body.enabled);
        audit.write('preview_toggle', { ...auditCtx(req), extra: { enabled: preview.enabled } });
        log.info(`preview ${preview.enabled ? 'ENABLED' : 'DISABLED'} by admin`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, enabled: preview.enabled }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/whitelist_status' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const enabled = !!body.enabled;
        whitelistEnforcement.set(enabled);
        audit.write('whitelist_toggle', {
          ...auditCtx(req),
          extra: { enabled, ready: rooms.isWhitelistReady(), count: rooms.whitelist().count },
        });
        log.info(`room whitelist enforcement ${enabled ? 'ENABLED' : 'DISABLED'} by admin`);
        const w = rooms.whitelist();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          enabled: whitelistEnforcement.isEnabled(),
          ready: w.ready,
          count: w.count,
          keys: rooms.listAllowedKeys(),
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/whitelist' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { isValidRoomKey } = require('./util');
        if (body.enabled !== undefined) {
          const enabled = !!body.enabled;
          whitelistEnforcement.set(enabled);
          audit.write('whitelist_toggle', {
            ...auditCtx(req),
            extra: { enabled, ready: rooms.isWhitelistReady(), count: rooms.whitelist().count },
          });
          log.info(`room whitelist enforcement ${enabled ? 'ENABLED' : 'DISABLED'} by admin`);
        }
        if (body.keys !== undefined) {
          if (cfg.ROOMS_API_URL) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'pull_mode_readonly' }));
            return;
          }
          const raw = typeof body.keys === 'string' ? body.keys : '';
          const keys = raw.split('|').map(k => k.trim()).filter(k => isValidRoomKey(k));
          rooms.applyAllowed(keys, { allowEmpty: true });
          audit.write('whitelist_update', {
            ...auditCtx(req),
            extra: { count: keys.length },
          });
          log.info(`whitelist updated by admin: ${keys.length} keys`);
        }
        const w = rooms.whitelist();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          enabled: whitelistEnforcement.isEnabled(),
          ready: w.ready,
          count: w.count,
          keys: rooms.listAllowedKeys(),
          pullMode: !!cfg.ROOMS_API_URL,
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/frontend_access' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        port: frontendAccess.getPort(),
        defaultPort: cfg.DEFAULT_FRONTEND_PORT,
      }));
      return;
    }

    if (pathname === '/api/frontend_access' && req.method === 'POST') {
      const oldPort = frontendAccess.getPort();
      try {
        const body = await parseBody(req);
        frontendAccess.setPort(body.port);
        let nginxResult = null;
        try {
          nginxResult = await frontendAccess.applyToNginx(oldPort);
        } catch (nginxErr) {
          // nginx 同步失败 → 回滚端口配置，让 JSON 跟 nginx 实际监听对齐
          try { frontendAccess.setPort(oldPort); } catch (_) {}
          throw new Error(`nginx_apply_failed: ${nginxErr.message}`);
        }
        audit.write('frontend_access_port', {
          ...auditCtx(req),
          extra: { port: frontendAccess.getPort(), oldPort, nginx: nginxResult },
        });
        log.info(`frontend access port set to ${frontendAccess.getPort()} (was ${oldPort}) by admin; nginx ${nginxResult && nginxResult.changed ? 'synced' : 'skip'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, port: frontendAccess.getPort(), nginx: nginxResult }));
      } catch (e) {
        const code = e.message === 'invalid_port' || e.message.startsWith('conflicts_') ? 400 : 500;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/privacy_mode' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, enabled: privacyMode.isEnabled() }));
      return;
    }

    if (pathname === '/api/privacy_mode' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        privacyMode.setEnabled(body.enabled);
        audit.write('privacy_mode', {
          ...auditCtx(req),
          extra: { enabled: privacyMode.isEnabled() },
        });
        log.info(`privacy mode ${privacyMode.isEnabled() ? 'ON' : 'OFF'} by admin`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, enabled: privacyMode.isEnabled() }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // ── 外部 API 白名单同步 ──────────────────────────────────
    if (pathname === '/api/ext_api' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...extApi.getStatus() }));
      return;
    }

    if (pathname === '/api/ext_api' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const status = extApi.configure({ url: body.url, interval: body.interval, unit: body.unit });
        audit.write('ext_api_configure', {
          ...auditCtx(req),
          extra: { url: body.url, interval: body.interval, unit: body.unit },
        });
        log.info(`ext_api configured: url=${body.url}, interval=${body.interval}${body.unit}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...status }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/ext_api/stop' && req.method === 'POST') {
      const status = extApi.stopSync();
      audit.write('ext_api_stop', { ...auditCtx(req) });
      log.info('ext_api sync stopped by admin');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...status }));
      return;
    }

    if (pathname === '/api/ext_api/test' && req.method === 'POST') {
      const body = await readBody(req);
      const url = (body.url || '').trim();
      const result = await extApi.testUrl(url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, user: creds.user }));
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const auth = req.headers['authorization'] || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token) {
        adminTokens.delete(token);
        deleteSessionPersisted(token);
      }
      audit.write('logout', auditCtx(req, token));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/api/change_password' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const oldPass = String(body.oldPass || '');
        const newPass = String(body.newPass || '');
        if (!creds.checkPassword(oldPass)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '原密码错误' }));
          return;
        }
        if (newPass.length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '新密码至少 4 位' }));
          return;
        }
        creds.setPasswordFromPlain(newPass);
        creds.save();
        adminTokens.clear();
        db.sess.deleteAll().catch(() => {});
        audit.write('change_password', auditCtx(req));
        log.info(`cred password changed by admin (memory+DB token cleared)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: '密码已修改, 请重新登录' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/change_account' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const pass = String(body.pass || '');
        const newUser = String(body.newUser || '').trim();
        if (!creds.checkPassword(pass)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '密码错误' }));
          return;
        }
        if (newUser.length < 2 || newUser.length > 32) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '账号长度 2-32 字符' }));
          return;
        }
        const oldUser = creds.user;
        creds.user = newUser;
        creds.save();
        adminTokens.clear();
        db.sess.deleteAll().catch(() => {});
        audit.write('change_account', { ...auditCtx(req), extra: { oldUser, newUser } });
        log.info('Administrator account changed; sessions invalidated');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: '账号已修改, 请重新登录' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/theme_names' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const r = theme.updateNames(body);
        if (!r.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: r.error }));
          return;
        }
        audit.write('theme_names_update', {
          ...auditCtx(req),
          extra: {
            white: theme.names.white, black: theme.names.black,
            iconWhite: theme.names.iconWhite ? 'set' : 'empty',
            iconBlack: theme.names.iconBlack ? 'set' : 'empty',
          },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          white: theme.names.white, black: theme.names.black,
          iconWhite: theme.names.iconWhite, iconBlack: theme.names.iconBlack,
          landing: theme.names.landing || {},
        }));
        log.info(`theme names updated: w="${theme.names.white}" b="${theme.names.black}" icons:${theme.names.iconWhite ? 'W' : '-'}${theme.names.iconBlack ? 'B' : '-'}`);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/theme' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const t = String(body.theme || '').toLowerCase();
        theme.setCurrent(t);
        audit.write('theme_switch', { ...auditCtx(req), extra: { theme: t } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, theme: t }));
        log.info(`theme switched to: ${t}`);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (pathname === '/api/ban' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        if (body.ip) {
          bans.relay.banIP(body.ip, 'admin_manual');
          audit.write('ban', { ...auditCtx(req), extra: { ip: body.ip } });
        }
        if (body.unban) {
          bans.admin.unbanAll(body.unban);
          audit.write('unban', { ...auditCtx(req), extra: { ip: body.unban } });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('{"ok":false}'); }
      return;
    }

    // ══════════════════════════════════════════════════════
    // 录制回放 (recording / replay / share)
    // ══════════════════════════════════════════════════════
    if (pathname === '/api/recording/start' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const roomKey = String(body.key || '');
        if (!roomKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"missing key"}'); return; }
        const room = rooms.getByKey(roomKey);
        if (!room) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"room not found"}'); return; }
        const ok = recorder.startRecording(roomKey);
        if (!ok) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"already recording"}'); return; }
        recorder.updateMetadata(roomKey, { mapName: room.mapName || '', pubIP: room.pubIP || '' });
        audit.write('recording_start', { ...auditCtx(req), extra: { key: roomKey } });
        const status = recorder.getRecordingStatus(roomKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...status }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }

    if (pathname === '/api/recording/pause' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const roomKey = String(body.key || '');
        if (!roomKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"missing key"}'); return; }
        const result = recorder.pauseRecording(roomKey);
        if (!result) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"not recording"}'); return; }
        audit.write('recording_pause', { ...auditCtx(req), extra: { key: roomKey, id: result.id } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, recording: result }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }

    if (pathname === '/api/recording/stop' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const roomKey = String(body.key || '');
        if (!roomKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"missing key"}'); return; }
        const ok = recorder.stopRecording(roomKey);
        audit.write('recording_stop', { ...auditCtx(req), extra: { key: roomKey } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }

    if (pathname === '/api/recording/status' && req.method === 'GET') {
      const roomKey = url.searchParams.get('key') || '';
      if (!roomKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"missing key"}'); return; }
      const status = recorder.getRecordingStatus(roomKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...status }));
      return;
    }

    if (pathname === '/api/recording/active' && req.method === 'GET') {
      const active = recorder.getActiveRecordings();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, active }));
      return;
    }

    if (pathname === '/api/recordings' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 50000);
      const list = await recorder.getRecordingList(limit);
      const enriched = [];
      for (const r of list) {
        const tokens = await recorder.listShareTokens(r.id);
        enriched.push({ ...r, shared: tokens && tokens.length > 0, shareToken: (tokens && tokens.length > 0) ? tokens[0].token : null, shareSlug: (tokens && tokens.length > 0) ? (tokens[0].custom_slug || '') : '' });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, recordings: enriched }));
      return;
    }

    if (pathname.startsWith('/api/recording/') && req.method === 'GET'
        && pathname !== '/api/recording/status' && pathname !== '/api/recording/active'
        && pathname !== '/api/recording/permanent'
        && !pathname.startsWith('/api/recording/download/')
        && !pathname.startsWith('/api/recording/share')) {
      const id = pathname.split('/')[3];
      if (!id) { res.writeHead(400); res.end('{"ok":false}'); return; }
      const rec = recorder.getRecording(id);
      if (!rec) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"not found"}'); return; }
      const body = JSON.stringify({ ok: true, recording: rec });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (pathname.startsWith('/api/recording/') && req.method === 'DELETE'
        && !pathname.startsWith('/api/recording/share')) {
      const id = pathname.split('/')[3];
      if (!id) { res.writeHead(400); res.end('{"ok":false}'); return; }
      const ok = await recorder.deleteRecording(id);
      if (ok) audit.write('recording_delete', { ...auditCtx(req), extra: { id } });
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
      return;
    }

    if (pathname === '/api/recording/share/status' && req.method === 'GET') {
      const qid = url.searchParams.get('id') || '';
      if (!qid) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false}'); return; }
      const tokens = await recorder.listShareTokens(qid);
      const shared = tokens && tokens.length > 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shared, token: shared ? tokens[0].token : null, slug: shared ? (tokens[0].custom_slug || '') : '' }));
      return;
    }

    if (pathname === '/api/recording/share' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const id = String(body.id || '');
        if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"missing id"}'); return; }
        const existing = await recorder.listShareTokens(id);
        if (existing && existing.length > 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, token: existing[0].token, slug: existing[0].custom_slug || '', existing: true }));
          return;
        }
        const result = await recorder.createShareToken(id, body.expiresInMs || 0);
        if (!result) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"recording not found"}'); return; }
        if (body.slug) {
          await db.share.setSlug(result.token, String(body.slug).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64));
        }
        audit.write('recording_share', { ...auditCtx(req), extra: { id, token: result.token.slice(0, 8) + '...', slug: body.slug || '' } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result, slug: body.slug || '' }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }

    if (pathname === '/api/recording/share/slug' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const token = String(body.token || '');
        const slug = String(body.slug || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
        if (!token) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"missing token"}'); return; }
        await db.share.setSlug(token, slug || null);
        audit.write('recording_share_slug', { ...auditCtx(req), extra: { token: token.slice(0, 8) + '...', slug } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slug }));
      } catch (e) {
        const isDup = String(e.message || e).includes('unique') || String(e.message || e).includes('duplicate');
        res.writeHead(isDup ? 409 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: isDup ? 'slug already in use' : e.message }));
      }
      return;
    }

    if (pathname === '/api/recording/share/revoke' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const tok = String(body.token || '');
        const rid = String(body.id || '');
        if (!tok && !rid) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"missing token or id"}'); return; }
        if (rid) {
          const tokens = await recorder.listShareTokens(rid);
          if (tokens) for (const t of tokens) await recorder.revokeShareToken(t.token);
          audit.write('recording_share_revoke', { ...auditCtx(req), extra: { id: rid, count: tokens ? tokens.length : 0 } });
        } else {
          await recorder.revokeShareToken(tok);
          audit.write('recording_share_revoke', { ...auditCtx(req), extra: { token: tok.slice(0, 8) + '...' } });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }

    if (pathname === '/api/recording/permanent' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const id = String(body.id || '');
        const permanent = !!body.permanent;
        if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"missing id"}'); return; }
        const ok = await recorder.setPermanent(id, permanent);
        if (ok) audit.write('recording_permanent', { ...auditCtx(req), extra: { id, permanent } });
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }

    // 下载录制文件
    if (pathname.startsWith('/api/recording/download/') && req.method === 'GET') {
      const id = pathname.split('/')[4];
      if (!id) { res.writeHead(400); res.end('{"ok":false}'); return; }
      const rec = recorder.getRecording(id);
      if (!rec) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"not found"}'); return; }
      const body = JSON.stringify(rec);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${id}.json"`,
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // 从 URL 导入录制
    if (pathname === '/api/recording/import' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        let importUrl = String(body.url || '').trim();
        if (!importUrl) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"missing url"}'); return; }

        // If URL is a NexusAuth lanzou redirect, resolve it first to get the actual file URL
        if (importUrl.includes('/lanzou/redirect?') || importUrl.includes('/lanzou/resolve?')) {
          try {
            const resolveUrl = importUrl.replace('/lanzou/redirect?', '/lanzou/resolve?');
            const resolveResp = await new Promise((resolve, reject) => {
              const parsed = new (require('url').URL)(resolveUrl);
              const mod = parsed.protocol === 'https:' ? require('https') : require('http');
              const r = mod.get({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, timeout: 30000, headers: { 'User-Agent': 'LD2-Relay/1.0' } }, (resp) => {
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end', () => {
                  try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                  catch (e) { reject(new Error('resolve response not JSON')); }
                });
              });
              r.on('error', reject);
            });
            if (resolveResp.ok && resolveResp.url) {
              importUrl = resolveResp.url;
            } else if (resolveResp.data && resolveResp.data.ok && resolveResp.data.url) {
              importUrl = resolveResp.data.url;
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'Lanzou resolve failed: ' + (resolveResp.msg || resolveResp.error || JSON.stringify(resolveResp)) }));
              return;
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Lanzou resolve error: ' + e.message }));
            return;
          }
        }

        const fetchData = () => new Promise((resolve, reject) => {
          let redirects = 0;
          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
          const doFetch = (u) => {
            const parsed = new (require('url').URL)(u);
            const mod = parsed.protocol === 'https:' ? require('https') : require('http');
            const opts = { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, timeout: 30000, headers: { 'User-Agent': ua } };
            const r = mod.get(opts, (resp) => {
              if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                if (++redirects > 8) { reject(new Error('too many redirects')); return; }
                resp.resume();
                let loc = resp.headers.location;
                if (loc.startsWith('/')) loc = parsed.protocol + '//' + parsed.host + loc;
                doFetch(loc);
                return;
              }
              if (resp.statusCode !== 200) { resp.resume(); reject(new Error(`HTTP ${resp.statusCode} from ${parsed.host}`)); return; }
              const chunks = [];
              resp.on('data', c => chunks.push(c));
              resp.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (text.trimStart().startsWith('<!') || text.trimStart().startsWith('<html')) {
                  reject(new Error('URL returned HTML page instead of recording data (direct link may have expired)'));
                  return;
                }
                resolve(text);
              });
              resp.on('error', reject);
            });
            r.on('error', reject);
            r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
          };
          doFetch(importUrl);
        });

        const raw = await fetchData();
        const recData = JSON.parse(raw);
        if (!recData.messages || !Array.isArray(recData.messages)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"invalid recording format: missing messages array"}');
          return;
        }

        const meta = recData.metadata || {};
        const effectiveRoomKey = meta.roomKey || recData.roomKey || body.roomKey || 'imported';
        const effectiveMapName = meta.mapName || recData.mapName || body.mapName || '';
        const effectivePubIP = meta.pubIP || recData.pubIP || '';
        const msgs = recData.messages || [];
        const lastTs = msgs.length > 0 ? (msgs[msgs.length - 1].timestamp || msgs[msgs.length - 1].dt || 0) : 0;
        const firstTs = msgs.length > 0 ? (msgs[0].timestamp || msgs[0].dt || 0) : 0;
        const effectiveDuration = meta.duration || (lastTs - firstTs) || 0;

        if (body.dryRun) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true, dryRun: true,
            roomKey: effectiveRoomKey,
            mapName: effectiveMapName,
            messages: msgs.length,
            duration: effectiveDuration,
            fileSize: Buffer.byteLength(raw),
          }));
          return;
        }

        const recId = recData.id || recData.recordingId || crypto.randomBytes(8).toString('hex');
        const roomKey = effectiveRoomKey;
        const mapName = effectiveMapName;
        const pubIP = effectivePubIP;
        const messages = msgs;
        const msgCount = messages.length;
        const duration = effectiveDuration;
        const jsonStr = JSON.stringify(recData, null, 2);
        const fileSize = Buffer.byteLength(jsonStr);
        const now = Date.now();
        const createdAt = recData.createdAt || recData.startedAt || now;
        const endedAt = recData.endedAt || now;

        const useExternal = !!body.useExternal;
        const originalUrl = String(body.url || '').trim();

        if (!useExternal) {
          const { RECORDINGS_DIR } = require('./recorder');
          const fpath = path.join(RECORDINGS_DIR, `${recId}.json`);
          fs.writeFileSync(fpath, jsonStr, 'utf8');
        }

        await db.recording.upsert({
          id: recId, room_key: roomKey, map_name: mapName, pub_ip: pubIP,
          message_count: msgCount, duration, file_size: fileSize,
          created_at: createdAt, ended_at: endedAt,
        });
        await db.recording.setPermanent(1, recId);

        if (useExternal && originalUrl) {
          await db.recording.setExternalUrl(recId, originalUrl);
        }

        audit.write('recording_import', { ...auditCtx(req), extra: { id: recId, url: importUrl.slice(0, 80), messages: msgCount } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: recId, messages: msgCount, fileSize, duration }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // 公开路由: 分享回放数据 (无需 token 认证, 支持 token 或 custom_slug)
    // 流式 gzip：不 parse/stringify 整包，避免阻塞同进程 WS 转发
    if (pathname.startsWith('/api/share/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const shareToken = pathname.split('/')[3];
      if (!shareToken) { res.writeHead(400); res.end('{"ok":false}'); return; }
      let info = await recorder.resolveShareToken(shareToken);
      if (!info) {
        const slugRow = await db.share.getBySlug(shareToken);
        if (slugRow) info = { recordingId: slugRow.recording_id };
      }
      if (!info) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"invalid or expired share link"}'); return; }

      const dbRec = await db.recording.getById(info.recordingId);
      if (dbRec && dbRec.external_url) {
        const shareBody = JSON.stringify({ ok: true, externalUrl: dbRec.external_url });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(shareBody) });
        res.end(shareBody);
        return;
      }

      const filePath = typeof recorder.getRecordingPath === 'function'
        ? recorder.getRecordingPath(info.recordingId)
        : null;
      if (!filePath) {
        const rec = recorder.getRecording(info.recordingId);
        if (!rec) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"recording not found"}'); return; }
        const shareBody = JSON.stringify({ ok: true, recording: rec });
        const accept = req.headers['accept-encoding'] || '';
        if (/\bgzip\b/i.test(accept)) {
          const gz = zlib.gzipSync(shareBody, { level: 6 });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': gz.length,
            'Cache-Control': 'public, max-age=60',
          });
          res.end(gz);
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(shareBody),
            'Cache-Control': 'public, max-age=60',
          });
          res.end(shareBody);
        }
        return;
      }

      const accept = req.headers['accept-encoding'] || '';
      const wantGzip = /\bgzip\b/i.test(accept);
      const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      };
      if (wantGzip) headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);

      const prefix = Buffer.from('{"ok":true,"recording":');
      const suffix = Buffer.from('}');
      const fileStream = fs.createReadStream(filePath);
      const body = Readable.from((async function* () {
        yield prefix;
        for await (const chunk of fileStream) yield chunk;
        yield suffix;
      })());

      if (wantGzip) {
        pipeline(body, zlib.createGzip({ level: 6 }), res, (err) => {
          if (err && !res.headersSent) {
            try { res.writeHead(500); res.end('{"ok":false}'); } catch (_) {}
          }
        });
      } else {
        pipeline(body, res, (err) => {
          if (err && !res.headersSent) {
            try { res.writeHead(500); res.end('{"ok":false}'); } catch (_) {}
          }
        });
      }
      return;
    }

    // 公开页面: 回放播放器 (无需认证)
    if (pathname === '/replay' || pathname === '/replay.html') {
      try {
        const html = fs.readFileSync(path.join(__dirname, '..', 'replay.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
      } catch (e) {
        res.writeHead(404); res.end('replay.html not found');
      }
      return;
    }

    // ══════════════════════════════════════════════════════
    // 静态文件 (admin.html 拆分后 + 配套 css/js)
    // 白名单严格匹配, 防 path traversal
    // ══════════════════════════════════════════════════════
    const STATIC_FILES = {
      '/':                            { file: 'admin.html',                 ct: 'text/html; charset=utf-8',                    maxAge: 0,     binary: false },
      '/admin':                       { file: 'admin.html',                 ct: 'text/html; charset=utf-8',                    maxAge: 0,     binary: false },
      '/admin.html':                  { file: 'admin.html',                 ct: 'text/html; charset=utf-8',                    maxAge: 0,     binary: false },
      '/admin.css':                   { file: 'admin.css',                  ct: 'text/css; charset=utf-8',                     maxAge: 300,   binary: false },
      '/admin.js':                    { file: 'admin.js',                   ct: 'application/javascript; charset=utf-8',       maxAge: 0,     binary: false },
      '/admin-events.js':             { file: 'admin-events.js',            ct: 'application/javascript; charset=utf-8',       maxAge: 0,     binary: false },
      '/admin-echarts-fallback.js':   { file: 'admin-echarts-fallback.js',  ct: 'application/javascript; charset=utf-8',       maxAge: 3600, binary: false },
      '/favicon.ico': { file: 'assets/favicon.svg', ct: 'image/svg+xml', maxAge: 86400, binary: true },
      '/assets/favicon.svg': { file: 'assets/favicon.svg', ct: 'image/svg+xml', maxAge: 86400, binary: true },
      '/assets/echarts.min.js': { file: 'assets/echarts.min.js', ct: 'application/javascript; charset=utf-8', maxAge: 86400, binary: true },
      '/assets/admin-bg-dark.webp': { file: 'assets/admin-bg-dark.webp', ct: 'image/webp', maxAge: 86400, binary: true },
      '/assets/admin-bg-light.webp': { file: 'assets/admin-bg-light.webp', ct: 'image/webp', maxAge: 86400, binary: true },
    };
    const ADMIN_CSP = "default-src 'self'; script-src 'self' ; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: https: http:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
    const sf = STATIC_FILES[pathname];
    if (sf) {
      try {
        const full = path.join(__dirname, '..', sf.file);
        const body = sf.binary ? fs.readFileSync(full) : fs.readFileSync(full, 'utf-8');
        const cache = sf.maxAge > 0
          ? `public, max-age=${sf.maxAge}, must-revalidate`
          : 'no-cache, no-store, must-revalidate';
        const headers = { 'Content-Type': sf.ct, 'Cache-Control': cache };
        if (sf.file === 'admin.html') headers['Content-Security-Policy'] = ADMIN_CSP;
        res.writeHead(200, headers);
        res.end(body);
      } catch (e) {
        res.writeHead(404);
        res.end(sf.file + ' not found');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  function stop() {
    clearInterval(statsTimer);
    clearInterval(sessTimer);
    try { server.close(); } catch (e) {}
  }

  return { server, stop };
}

module.exports = { createAdminHttp };
