/**
 * audit.js — 敏感操作审计日志 (append-only JSONL)
 *
 * 抽出动机:
 *   bans / 改密 / 改账号 / set_rooms / theme 切换 这些动作出问题时 (被攻击 / 误操作)
 *   relay.log 里只能看到无 actor 的 console.log。需要一份单独的 audit:
 *   - JSONL (每行一个 JSON), `jq` 直接处理, 不用解析半结构化文本
 *   - 字段标准化: ts / action / actor / ip / ua / tokenHash / extra
 *   - append-only 同步写 (fs.appendFileSync), 进程崩溃也不丢
 *   - 不轮转, 让 systemd logrotate 接管
 *
 * action 命名约定: 动词_对象 (login_ok / login_fail / change_password / kick / set_rooms ...)
 * tokenHash: token sha256 取前 8 位 hex, 防止 token 落审计日志被人翻
 */
const fs     = require('fs');
const crypto = require('crypto');
const cfg = require('./config');
const log    = require('./logger')('Audit');

function hashToken(token) {
  if (!token) return '-';
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
}

class AuditLog {
  constructor({ file = cfg.AUDIT_LOG_FILE } = {}) {
    this.file = file;
  }

  // ctx: { actor, ip, ua, tokenHash, extra }
  // extra 是任意 JSON, 比如 { newUser: '...', target: 'pub', count: 12 }
  write(action, ctx = {}) {
    const line = JSON.stringify({
      ts:        new Date().toISOString(),
      action:    String(action),
      actor:     ctx.actor || '-',
      ip:        ctx.ip || '-',
      ua:        (ctx.ua || '-').slice(0, 200), // UA 截断防灌坏文件
      tokenHash: ctx.tokenHash || '-',
      ...(ctx.extra || {}),
    }) + '\n';
    try {
      fs.appendFileSync(this.file, line);
    } catch (e) {
      // 审计日志写失败时不能 throw 中断业务, 但 log 一下让运维知道
      log.error(`append failed (${this.file}):`, e.message);
    }
  }
}

module.exports = { AuditLog, hashToken };
