/**
 * logger.js — 结构化日志 (timestamp + level + scope)
 *
 * 抽出动机:
 *   之前各 lib/* 都用 `console.log('[Bans] ...')` 这种半结构化前缀,
 *   生产 PM2 日志聚合不好筛, 也没 timestamp 看不出耗时。封装后:
 *   - 统一格式: `2026-06-19T13:18:32.730Z [INFO] [Bans] message`
 *   - level: debug / info / warn / error (debug 默认关, LOG_LEVEL=debug 才开)
 *   - 子 logger: `const log = createLogger('Bans')`, message 不用再手写 [Bans] 前缀
 *   - 接 console 的 stdout/stderr 分流: info/debug 走 stdout, warn/error 走 stderr
 *
 * 不依赖任何 log 框架, 保持零依赖。如果以后要切到 pino/winston, 只改这一个文件。
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function createLogger(scope) {
  const prefix = scope ? ` [${scope}]` : '';
  return {
    debug: (...args) => {
      if (currentLevel <= LEVELS.debug) console.log(`${ts()} [DBG ]${prefix}`, ...args);
    },
    info: (...args) => {
      if (currentLevel <= LEVELS.info) console.log(`${ts()} [INFO]${prefix}`, ...args);
    },
    warn: (...args) => {
      if (currentLevel <= LEVELS.warn) console.warn(`${ts()} [WARN]${prefix}`, ...args);
    },
    error: (...args) => {
      if (currentLevel <= LEVELS.error) console.error(`${ts()} [ERR ]${prefix}`, ...args);
    },
  };
}

module.exports = createLogger;
