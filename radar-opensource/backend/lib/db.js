/**
 * db.js — PostgreSQL 持久化层
 *
 * 表: room_events, ban_events, daily_stats, admin_sessions, allowed_rooms,
 *     active_bans, room_daily_stats, recordings, recording_share_tokens
 *
 * API 设计:
 *   - 写操作返回 Promise (热路径里可 fire-and-forget, catch 错误即可)
 *   - 读操作返回 Promise (API handler 里 await)
 *   - pool 自动管理连接, 无需手动 acquire/release
 */
const { Pool } = require('pg');
const fs = require('fs');
const log = require('./logger')('DB');

function open(connStr) {
  if (!connStr) throw new Error('PG_CONN must be configured');
  const pool = new Pool({
    connectionString: connStr,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    log.error('Unexpected pool error:', err.message);
  });

  async function initTables() {
    const client = await pool.connect();
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        peak_rooms INTEGER DEFAULT 0,
        peak_pubs  INTEGER DEFAULT 0,
        peak_subs  INTEGER DEFAULT 0,
        peak_bans  INTEGER DEFAULT 0,
        peak_dl_sec INTEGER DEFAULT 0,
        peak_ul_sec INTEGER DEFAULT 0,
        dl_day BIGINT DEFAULT 0,
        ul_day BIGINT DEFAULT 0
      )`);

      await client.query(`CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        expires_at BIGINT NOT NULL
      )`);

      await client.query(`CREATE TABLE IF NOT EXISTS allowed_rooms (
        key TEXT PRIMARY KEY,
        updated_at BIGINT DEFAULT 0
      )`);

      await client.query(`CREATE TABLE IF NOT EXISTS active_bans (
        ip TEXT NOT NULL,
        source TEXT NOT NULL,
        until_ms BIGINT NOT NULL,
        level INTEGER DEFAULT 0,
        reason TEXT DEFAULT '',
        PRIMARY KEY(ip, source)
      )`);

      await client.query(`CREATE TABLE IF NOT EXISTS room_daily_stats (
        date TEXT NOT NULL,
        room_key TEXT NOT NULL,
        peak_subs INTEGER DEFAULT 0,
        peak_msg_sec INTEGER DEFAULT 0,
        peak_bw_sec INTEGER DEFAULT 0,
        total_bytes BIGINT DEFAULT 0,
        total_msgs BIGINT DEFAULT 0,
        active_seconds INTEGER DEFAULT 0,
        map_name TEXT DEFAULT '',
        pub_ip TEXT DEFAULT '',
        PRIMARY KEY(date, room_key)
      )`);

      await client.query(`CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        room_key TEXT NOT NULL,
        map_name TEXT DEFAULT '',
        pub_ip TEXT DEFAULT '',
        message_count INTEGER DEFAULT 0,
        duration INTEGER DEFAULT 0,
        file_size INTEGER DEFAULT 0,
        created_at BIGINT NOT NULL,
        ended_at BIGINT NOT NULL,
        permanent INTEGER DEFAULT 0,
        external_url TEXT DEFAULT ''
      )`);
      await client.query(`ALTER TABLE recordings ADD COLUMN IF NOT EXISTS external_url TEXT DEFAULT ''`).catch(() => {});
      await client.query(`CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_recordings_room_key ON recordings(room_key)`);

      await client.query(`CREATE TABLE IF NOT EXISTS recording_share_tokens (
        token TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL,
        expires_at BIGINT DEFAULT 0,
        custom_slug TEXT UNIQUE
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_share_tokens_recording_id ON recording_share_tokens(recording_id)`);
      await client.query(`ALTER TABLE recording_share_tokens ADD COLUMN IF NOT EXISTS custom_slug TEXT UNIQUE`).catch(() => {});

      await client.query(`CREATE TABLE IF NOT EXISTS room_events (
        id SERIAL PRIMARY KEY,
        room_key TEXT NOT NULL,
        role TEXT NOT NULL,
        event TEXT NOT NULL,
        ip TEXT DEFAULT '',
        ts BIGINT NOT NULL
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_room_events_ts ON room_events(ts)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_room_events_key ON room_events(room_key)`);

      await client.query(`CREATE TABLE IF NOT EXISTS ban_events (
        id SERIAL PRIMARY KEY,
        ip TEXT NOT NULL,
        event TEXT NOT NULL,
        source TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        duration_ms BIGINT DEFAULT 0,
        actor TEXT DEFAULT '',
        ts BIGINT NOT NULL
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ban_events_ts ON ban_events(ts)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ban_events_ip ON ban_events(ip)`);

      log.info('PostgreSQL tables initialized');
    } finally {
      client.release();
    }
  }

  // ── session operations ──
  const sess = {
    insert(token, expiresAt) {
      return pool.query(
        `INSERT INTO admin_sessions(token, expires_at) VALUES($1, $2)
         ON CONFLICT(token) DO UPDATE SET expires_at=$2`, [token, expiresAt]);
    },
    check(token, now) {
      return pool.query(
        `SELECT 1 FROM admin_sessions WHERE token=$1 AND expires_at>$2 LIMIT 1`,
        [token, now]).then(r => r.rows[0] || null);
    },
    delete(token) {
      return pool.query(`DELETE FROM admin_sessions WHERE token=$1`, [token]);
    },
    deleteAll() {
      return pool.query(`DELETE FROM admin_sessions`);
    },
    clearExpired(now) {
      return pool.query(`DELETE FROM admin_sessions WHERE expires_at<=$1`, [now]);
    },
  };

  // ── ban operations ──
  const bans = {
    upsert(ip, source, untilMs, level, reason) {
      return pool.query(
        `INSERT INTO active_bans(ip,source,until_ms,level,reason) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(ip,source) DO UPDATE SET until_ms=$3, level=$4, reason=$5`,
        [ip, source, untilMs, level, reason]);
    },
    delete(ip, source) {
      return pool.query(`DELETE FROM active_bans WHERE ip=$1 AND source=$2`, [ip, source]);
    },
    deleteIp(ip) {
      return pool.query(`DELETE FROM active_bans WHERE ip=$1`, [ip]);
    },
    loadBySource(source, now) {
      return pool.query(
        `SELECT * FROM active_bans WHERE source=$1 AND until_ms>$2`,
        [source, now]).then(r => r.rows);
    },
    cleanup(now) {
      return pool.query(`DELETE FROM active_bans WHERE until_ms<=$1`, [now]);
    },
  };

  // ── room whitelist ──
  const rooms = {
    clear() { return pool.query(`DELETE FROM allowed_rooms`); },
    upsert(key, updatedAt) {
      return pool.query(
        `INSERT INTO allowed_rooms(key, updated_at) VALUES($1, $2)
         ON CONFLICT(key) DO UPDATE SET updated_at=$2`, [key, updatedAt]);
    },
    check(key) {
      return pool.query(`SELECT 1 FROM allowed_rooms WHERE key=$1 LIMIT 1`, [key])
        .then(r => r.rows[0] || null);
    },
    loadKeys() {
      return pool.query(`SELECT key FROM allowed_rooms ORDER BY updated_at DESC`)
        .then(r => r.rows);
    },
    async replaceAllTx(keys, now) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM allowed_rooms');
        for (const k of keys) {
          await client.query(
            `INSERT INTO allowed_rooms(key, updated_at) VALUES($1, $2)
             ON CONFLICT(key) DO UPDATE SET updated_at=$2`, [k, now]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };

  // ── daily stats ──
  const stats = {
    upsert(p) {
      return pool.query(
        `INSERT INTO daily_stats(date,peak_rooms,peak_pubs,peak_subs,peak_bans,peak_dl_sec,peak_ul_sec,dl_day,ul_day)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(date) DO UPDATE SET
           peak_rooms=GREATEST(daily_stats.peak_rooms,$2), peak_pubs=GREATEST(daily_stats.peak_pubs,$3),
           peak_subs=GREATEST(daily_stats.peak_subs,$4), peak_bans=GREATEST(daily_stats.peak_bans,$5),
           peak_dl_sec=GREATEST(daily_stats.peak_dl_sec,$6), peak_ul_sec=GREATEST(daily_stats.peak_ul_sec,$7),
           dl_day=daily_stats.dl_day+$8, ul_day=daily_stats.ul_day+$9`,
        [p.date, p.peak_rooms, p.peak_pubs, p.peak_subs, p.peak_bans, p.peak_dl_sec, p.peak_ul_sec, p.dl_delta, p.ul_delta]);
    },
    select90() {
      return pool.query(`SELECT * FROM daily_stats ORDER BY date DESC LIMIT 90`).then(r => r.rows);
    },
    getDay(date) {
      return pool.query(`SELECT dl_day, ul_day FROM daily_stats WHERE date=$1`, [date]).then(r => r.rows[0] || null);
    },
    sumTotals() {
      return pool.query(`SELECT COALESCE(SUM(dl_day),0) as dl, COALESCE(SUM(ul_day),0) as ul FROM daily_stats`)
        .then(r => r.rows[0]);
    },
    deleteByDate(date) {
      return pool.query(`DELETE FROM daily_stats WHERE date=$1`, [date]);
    },
    deleteAll() {
      return pool.query(`DELETE FROM daily_stats`);
    },
  };

  // ── room daily stats ──
  const roomStats = {
    upsert(p) {
      return pool.query(
        `INSERT INTO room_daily_stats(date,room_key,peak_subs,peak_msg_sec,peak_bw_sec,total_bytes,total_msgs,active_seconds,map_name,pub_ip)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(date,room_key) DO UPDATE SET
           peak_subs=GREATEST(room_daily_stats.peak_subs,$3),
           peak_msg_sec=GREATEST(room_daily_stats.peak_msg_sec,$4),
           peak_bw_sec=GREATEST(room_daily_stats.peak_bw_sec,$5),
           total_bytes=room_daily_stats.total_bytes+$6,
           total_msgs=room_daily_stats.total_msgs+$7,
           active_seconds=room_daily_stats.active_seconds+$8,
           map_name=CASE WHEN $9!='' THEN $9 ELSE room_daily_stats.map_name END,
           pub_ip=CASE WHEN $10!='' THEN $10 ELSE room_daily_stats.pub_ip END`,
        [p.date, p.room_key, p.peak_subs, p.peak_msg_sec, p.peak_bw_sec, p.bytes_delta, p.msgs_delta, p.active_seconds, p.map_name, p.pub_ip]);
    },
    history(roomKey) {
      return pool.query(`SELECT * FROM room_daily_stats WHERE room_key=$1 ORDER BY date DESC LIMIT 90`, [roomKey])
        .then(r => r.rows);
    },
    deleteByDate(date) {
      return pool.query(`DELETE FROM room_daily_stats WHERE date=$1`, [date]);
    },
    deleteAll() {
      return pool.query(`DELETE FROM room_daily_stats`);
    },
    async upsertBatchTx(entries) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const p of entries) {
          await client.query(
            `INSERT INTO room_daily_stats(date,room_key,peak_subs,peak_msg_sec,peak_bw_sec,total_bytes,total_msgs,active_seconds,map_name,pub_ip)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT(date,room_key) DO UPDATE SET
               peak_subs=GREATEST(room_daily_stats.peak_subs,$3),
               peak_msg_sec=GREATEST(room_daily_stats.peak_msg_sec,$4),
               peak_bw_sec=GREATEST(room_daily_stats.peak_bw_sec,$5),
               total_bytes=room_daily_stats.total_bytes+$6,
               total_msgs=room_daily_stats.total_msgs+$7,
               active_seconds=room_daily_stats.active_seconds+$8,
               map_name=CASE WHEN $9!='' THEN $9 ELSE room_daily_stats.map_name END,
               pub_ip=CASE WHEN $10!='' THEN $10 ELSE room_daily_stats.pub_ip END`,
            [p.date, p.room_key, p.peak_subs, p.peak_msg_sec, p.peak_bw_sec, p.bytes_delta, p.msgs_delta, p.active_seconds, p.map_name, p.pub_ip]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };

  // ── recordings ──
  const recording = {
    upsert(p) {
      return pool.query(
        `INSERT INTO recordings(id,room_key,map_name,pub_ip,message_count,duration,file_size,created_at,ended_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(id) DO UPDATE SET room_key=$2,map_name=$3,pub_ip=$4,message_count=$5,duration=$6,file_size=$7,created_at=$8,ended_at=$9`,
        [p.id, p.room_key, p.map_name, p.pub_ip, p.message_count, p.duration, p.file_size, p.created_at, p.ended_at]);
    },
    list(limit) {
      return pool.query(`SELECT * FROM recordings ORDER BY created_at DESC LIMIT $1`, [limit]).then(r => r.rows);
    },
    listByRoom(roomKey, limit) {
      return pool.query(`SELECT * FROM recordings WHERE room_key=$1 ORDER BY created_at DESC LIMIT $2`, [roomKey, limit]).then(r => r.rows);
    },
    getById(id) {
      return pool.query(`SELECT * FROM recordings WHERE id=$1`, [id]).then(r => r.rows[0] || null);
    },
    delete(id) {
      return pool.query(`DELETE FROM recordings WHERE id=$1`, [id]);
    },
    deleteByRoom(roomKey) {
      return pool.query(`DELETE FROM recordings WHERE room_key=$1`, [roomKey]);
    },
    cleanup(before) {
      return pool.query(`DELETE FROM recordings WHERE ended_at<$1 AND permanent=0`, [before]);
    },
    count() {
      return pool.query(`SELECT COUNT(*) AS n FROM recordings`).then(r => r.rows[0]);
    },
    setPermanent(permanent, id) {
      return pool.query(`UPDATE recordings SET permanent=$1 WHERE id=$2`, [permanent, id]);
    },
    setExternalUrl(id, externalUrl) {
      return pool.query(`UPDATE recordings SET external_url=$1 WHERE id=$2`, [externalUrl, id]);
    },
  };

  // ── share tokens ──
  const share = {
    insert(token, recordingId, createdAt, expiresAt) {
      return pool.query(
        `INSERT INTO recording_share_tokens(token,recording_id,created_at,expires_at) VALUES($1,$2,$3,$4)
         ON CONFLICT(token) DO UPDATE SET recording_id=$2,created_at=$3,expires_at=$4`,
        [token, recordingId, createdAt, expiresAt]);
    },
    getByToken(token) {
      return pool.query(`SELECT * FROM recording_share_tokens WHERE token=$1`, [token]).then(r => r.rows[0] || null);
    },
    listByRecording(recordingId) {
      return pool.query(`SELECT * FROM recording_share_tokens WHERE recording_id=$1 ORDER BY created_at DESC`, [recordingId]).then(r => r.rows);
    },
    delete(token) {
      return pool.query(`DELETE FROM recording_share_tokens WHERE token=$1`, [token]);
    },
    deleteByRecording(recordingId) {
      return pool.query(`DELETE FROM recording_share_tokens WHERE recording_id=$1`, [recordingId]);
    },
    cleanupExpired(now) {
      return pool.query(`DELETE FROM recording_share_tokens WHERE expires_at>0 AND expires_at<$1`, [now]);
    },
    getBySlug(slug) {
      return pool.query(`SELECT * FROM recording_share_tokens WHERE custom_slug=$1`, [slug]).then(r => r.rows[0] || null);
    },
    setSlug(token, slug) {
      return pool.query(`UPDATE recording_share_tokens SET custom_slug=$1 WHERE token=$2`, [slug || null, token]);
    },
  };

  // ── room events ──
  const roomEvent = {
    insert(roomKey, role, event, ip, ts) {
      return pool.query(
        `INSERT INTO room_events(room_key,role,event,ip,ts) VALUES($1,$2,$3,$4,$5)`,
        [roomKey, role, event, ip, ts]);
    },
    list(limit, offset) {
      return pool.query(`SELECT * FROM room_events ORDER BY ts DESC LIMIT $1 OFFSET $2`, [limit, offset]).then(r => r.rows);
    },
    count() {
      return pool.query(`SELECT COUNT(*) AS n FROM room_events`).then(r => r.rows[0]);
    },
    search(pattern, limit, offset) {
      return pool.query(`SELECT * FROM room_events WHERE room_key LIKE $1 ORDER BY ts DESC LIMIT $2 OFFSET $3`, [pattern, limit, offset]).then(r => r.rows);
    },
    searchCount(pattern) {
      return pool.query(`SELECT COUNT(*) AS n FROM room_events WHERE room_key LIKE $1`, [pattern]).then(r => r.rows[0]);
    },
    cleanup(before) {
      return pool.query(`DELETE FROM room_events WHERE ts < $1`, [before]);
    },
  };

  // ── ban events ──
  const banEvent = {
    insert(ip, event, source, reason, durationMs, actor, ts) {
      return pool.query(
        `INSERT INTO ban_events(ip,event,source,reason,duration_ms,actor,ts) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [ip, event, source, reason, durationMs, actor, ts]);
    },
    list(limit, offset) {
      return pool.query(`SELECT * FROM ban_events ORDER BY ts DESC LIMIT $1 OFFSET $2`, [limit, offset]).then(r => r.rows);
    },
    count() {
      return pool.query(`SELECT COUNT(*) AS n FROM ban_events`).then(r => r.rows[0]);
    },
    search(pattern, limit, offset) {
      return pool.query(`SELECT * FROM ban_events WHERE ip LIKE $1 ORDER BY ts DESC LIMIT $2 OFFSET $3`, [pattern, limit, offset]).then(r => r.rows);
    },
    searchCount(pattern) {
      return pool.query(`SELECT COUNT(*) AS n FROM ban_events WHERE ip LIKE $1`, [pattern]).then(r => r.rows[0]);
    },
    cleanup(before) {
      return pool.query(`DELETE FROM ban_events WHERE ts < $1`, [before]);
    },
  };

  // ── health check ──
  async function healthCheck() {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── migration helper: import old JSON history ──
  async function migrateOldJsonHistory(jsonPath) {
    try {
      if (!fs.existsSync(jsonPath)) return;
      const old = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const r of (old.history || [])) {
          await client.query(
            `INSERT INTO daily_stats(date,peak_rooms,peak_pubs,peak_subs,peak_bans,peak_dl_sec,peak_ul_sec,dl_day,ul_day)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT(date) DO NOTHING`,
            [r.date, r.peakRooms||0, r.peakPubs||0, r.peakSubs||0, r.peakBans||0,
             r.peakDlSec||0, r.peakUlSec||0, r.dlDay||0, r.ulDay||0]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      fs.renameSync(jsonPath, jsonPath + '.bak');
      log.info('Migrated JSON history → PostgreSQL');
    } catch (e) {
      log.error('migrate error:', e.message);
    }
  }

  return {
    pool, sess, bans, rooms, stats, roomStats, recording, share, roomEvent, banEvent,
    initTables, healthCheck, migrateOldJsonHistory,
    close: () => pool.end(),
  };
}

module.exports = { open };
