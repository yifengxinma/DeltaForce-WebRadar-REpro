/**
 * config.js — 集中所有环境变量 + 业务常量
 *
 * 抽出动机:
 *   relay.js 之前把 PORT / 限流阈值 / 文件路径 / 节流时长 全部散落在各处,
 *   想调一个值得先 grep。集中后:
 *   - 单元测试可以 require('./lib/config') 直接看默认值, 不用启进程
 *   - 改部署时只看这一个文件, 不用怕漏改
 *   - 用 Object.freeze 防止运行时被脏代码改坏
 *
 * 【radar_lan_local】本副本默认把持久化落到 backend/data/，便于 Windows 局域网调试；
 *  可通过环境变量指定自己的持久化目录。
 */

const path = require('path');
const fs = require('fs');
const DATA_DIR = process.env.RADAR_DATA_DIR || path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

// ── 端口/反代 ────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT       || '5000', 10);
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '9090', 10);
const ADMIN_BIND = process.env.ADMIN_BIND || '127.0.0.1';
// 仅 nginx 反代后设 TRUST_PROXY=1, 否则忽略 X-Forwarded-For 防 IP 伪造
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// ── 安全开关 ──────────────────────────────────────────────────
// 默认关闭 pub 白名单校验；显式 REQUIRE_ROOM_WHITELIST=1 才开启 (ALLOW_OPEN_PUB=1 仍强制关闭)
const REQUIRE_ROOM_WHITELIST = process.env.ALLOW_OPEN_PUB !== '1'
  && process.env.REQUIRE_ROOM_WHITELIST === '1';
const DEFAULT_WHITELIST_ROOM = process.env.DEFAULT_WHITELIST_ROOM || '';

// ── 房间白名单数据源 ──────────────────────────────────────────
const ROOMS_API_URL  = process.env.ROOMS_API_URL  || '';
const ROOMS_API_BIND = process.env.ROOMS_API_BIND || '';

// ── 前端主题目录（局域网: current 为可切换入口，勿默认指 white 本体）──
const _repoRoot = path.join(__dirname, '..', '..');
const FRONTEND_WHITE  = process.env.FRONTEND_WHITE  || path.join(_repoRoot, 'frontend', 'white');
const FRONTEND_BLACK  = process.env.FRONTEND_BLACK  || path.join(_repoRoot, 'frontend', 'black');
const FRONTEND_LINK   = process.env.FRONTEND_LINK   || path.join(_repoRoot, 'frontend', 'current');

// ── 持久化文件路径 ────────────────────────────────────────────
const CRED_FILE          = process.env.CRED_FILE          || path.join(DATA_DIR, 'credentials.json');
const PREVIEW_STATE_FILE = process.env.PREVIEW_STATE_FILE || path.join(DATA_DIR, 'preview_state.json');
const PREVIEW_FLAG_FILE  = process.env.PREVIEW_FLAG_FILE  || path.join(DATA_DIR, 'preview_enabled.flag');
const WHITELIST_STATE_FILE = process.env.WHITELIST_STATE_FILE || path.join(DATA_DIR, 'whitelist_enforcement.json');
const ANNOUNCEMENTS_FILE = process.env.ANNOUNCEMENTS_FILE || path.join(DATA_DIR, 'announcements.json');
const THEME_NAMES_FILE   = process.env.THEME_NAMES_FILE   || path.join(DATA_DIR, 'theme_names.json');
const FRONTEND_ACCESS_FILE = process.env.FRONTEND_ACCESS_FILE || path.join(DATA_DIR, 'frontend_access.json');
const PRIVACY_MODE_FILE    = process.env.PRIVACY_MODE_FILE    || path.join(DATA_DIR, 'privacy_mode.json');
const EXT_API_FILE         = process.env.EXT_API_FILE         || path.join(DATA_DIR, 'ext_api.json');
const DEFAULT_FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || '8080', 10);
const AUDIT_LOG_FILE     = process.env.AUDIT_LOG_FILE || path.join(DATA_DIR, 'audit.log');

// ── WS 节流 + 房间容量 ─────────────────────────────────────────
const MAX_SUBS       = 4;
const THROTTLE_MS    = 50;  // 每个 sub 50ms 内只允许收一次数据
const MAX_PER_WINDOW = 5;   // 50ms 窗口内最多转发条数
const SUB_BACKPRESSURE = 1048576; // 1MB；慢订阅端少丢坐标

// ── 限流 + 渐进封禁 ───────────────────────────────────────────
const AUTH_RATE     = 10;    // 每秒最多认证 10 次
const AUTH_COOLDOWN = 2000;  // 全错冷却 2s
const PUB_RATE      = 300;   // 每秒最多 300 条 pub (客户端 10Hz * 多条/帧, 留足余量)
const PUB_MAX_SIZE  = 500_000; // 单条最大 500KB
const BAN_DURATIONS = [0, 60_000, 600_000, 1_800_000, 3_600_000]; // 0/1m/10m/30m/60m

// ── 管理后台节流 ──────────────────────────────────────────────
const ADMIN_RATE_PER_SEC = 60;   // 后台 stats 3s 刷新 + 多接口，10 太紧
const ADMIN_RATE_TRIGGER = 30;   // 1 小时内触发 30 次才封 1 小时
const ADMIN_LOGIN_FAIL_LIMIT = 5; // 5 次错误密码 → 冻结 1 分钟
const ADMIN_LOGIN_FAIL_WINDOW = 120000;
const SESSION_DURATION_MS = 86400000; // 24h

// ── 公告 ──────────────────────────────────────────────────────
const ANN_TYPES         = ['info', 'warn', 'error', 'success'];
const ANN_DISPLAY_MODES = ['panel', 'modal', 'banner', 'toast'];
const ANN_TITLE_MAX     = 200;
const ANN_CONTENT_MAX   = 5000;

// ── 浏览器标题 + 图标 ─────────────────────────────────────────
const ICON_MAX_BYTES = 120 * 1024; // 单图标 120KB (dataUrl ≈ 90KB 原图)

// ── HTTP body ─────────────────────────────────────────────────
const HTTP_BODY_LIMIT = 256 * 1024; // 256KB (含 icon dataUrl 余量)

module.exports = Object.freeze({
  PORT, ADMIN_PORT, ADMIN_BIND, TRUST_PROXY,
  REQUIRE_ROOM_WHITELIST, DEFAULT_WHITELIST_ROOM,
  ROOMS_API_URL, ROOMS_API_BIND,
  FRONTEND_LINK, FRONTEND_WHITE, FRONTEND_BLACK,
  CRED_FILE, PREVIEW_STATE_FILE, PREVIEW_FLAG_FILE, WHITELIST_STATE_FILE, ANNOUNCEMENTS_FILE, THEME_NAMES_FILE, FRONTEND_ACCESS_FILE, PRIVACY_MODE_FILE, EXT_API_FILE, DEFAULT_FRONTEND_PORT, AUDIT_LOG_FILE,
  MAX_SUBS, THROTTLE_MS, MAX_PER_WINDOW, SUB_BACKPRESSURE,
  AUTH_RATE, AUTH_COOLDOWN, PUB_RATE, PUB_MAX_SIZE, BAN_DURATIONS,
  ADMIN_RATE_PER_SEC, ADMIN_RATE_TRIGGER, ADMIN_LOGIN_FAIL_LIMIT, ADMIN_LOGIN_FAIL_WINDOW, SESSION_DURATION_MS,
  ANN_TYPES, ANN_DISPLAY_MODES, ANN_TITLE_MAX, ANN_CONTENT_MAX,
  ICON_MAX_BYTES,
  HTTP_BODY_LIMIT,
  DATA_DIR,
});
