/**
 * credentials.js — 管理员账号 + 密码 (scrypt 哈希 + 持久化)
 *
 * 抽出动机:
 *   relay.js 之前用 4 个 module-level let 变量持久化账号密码,
 *   修改/校验函数与全局状态散落各处。封装到 class 里:
 *   - 单元测试只需 new Credentials({file: ':memory:'}) 即可
 *   - 调用方语义清晰: creds.user / creds.checkPassword(p) / creds.load()
 *   - 改密改账号统一通过 set 方法, 防止外部直接写脏 state
 */
const fs = require('fs');
const crypto = require('crypto');
const cfg = require('./config');
const log = require('./logger')('Cred');

// scrypt 参数: N=16384(2^14, 64MB 内存), r=8, p=1 — 跟 RFC 7914 推荐对标,
// 单次约 70ms (足够慢挡爆破, 不至于让登录卡顿)
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class Credentials {
  constructor({ file = cfg.CRED_FILE } = {}) {
    this.file = file;
    this.user = process.env.ADMIN_USER || '';
    this.passHash = '';
    this.passSalt = '';
  }

  hashPassword(pass) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(pass), salt, 64, SCRYPT_OPTS);
    return { salt: salt.toString('base64'), hash: hash.toString('base64') };
  }

  verifyPassword(pass, saltB64, hashB64) {
    if (!saltB64 || !hashB64) return false;
    try {
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      const actual = crypto.scryptSync(String(pass), salt, 64, SCRYPT_OPTS);
      if (actual.length !== expected.length) return false;
      // 时序攻击防御: timingSafeEqual 跟密码长度无关地恒定时间比较
      return crypto.timingSafeEqual(actual, expected);
    } catch (e) {
      return false;
    }
  }

  setPasswordFromPlain(pass) {
    const { salt, hash } = this.hashPassword(pass);
    this.passSalt = salt;
    this.passHash = hash;
  }

  checkPassword(pass) {
    return this.verifyPassword(pass, this.passSalt, this.passHash);
  }

  load() {
    try {
      const c = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (c.user) this.user = String(c.user);
      if (c.passHash && c.passSalt) {
        this.passHash = String(c.passHash);
        this.passSalt = String(c.passSalt);
      } else if (c.pass) {
        // 旧版明文迁移成 hash (一次性, 写回去后磁盘里不再有明文)
        this.setPasswordFromPlain(c.pass);
        this.save();
        log.info('Migrated plaintext password → scrypt hash');
      }
      log.info('Administrator credentials loaded');
    } catch (e) {
      const user = String(process.env.ADMIN_USER || '').trim();
      const password = process.env.ADMIN_PASS || '';
      if (!user || password.length < 12) throw new Error('Set ADMIN_USER and ADMIN_PASS (at least 12 characters) before first start');
      this.user = user;
      this.setPasswordFromPlain(password);
      this.save();
      log.info('Administrator credentials initialized from environment');
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file,
        JSON.stringify({ user: this.user, passHash: this.passHash, passSalt: this.passSalt }, null, 2));
    } catch (e) {
      log.error('Save failed:', e.message);
    }
  }
}

module.exports = { Credentials, SCRYPT_OPTS };
