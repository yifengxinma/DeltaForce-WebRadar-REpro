/**
 * whitelist-enforcement.js — 房间白名单 enforcement 运行时开关
 *
 * 与 rooms.js 里的名单数据分离:
 *   - rooms.js 维护 allowed 集合 (推/拉)
 *   - 本模块决定 pub 鉴权是否校验该集合
 *
 * 默认关闭 enforcement；env REQUIRE_ROOM_WHITELIST=1 才默认开启。管理员可在后台切换并持久化。
 */
const fs = require('fs');
const cfg = require('./config');
const log = require('./logger')('Whitelist');

class WhitelistEnforcement {
  constructor({ stateFile = cfg.WHITELIST_STATE_FILE, envDefault = cfg.REQUIRE_ROOM_WHITELIST } = {}) {
    this.stateFile = stateFile;
    this.envDefault = !!envDefault;
    this.enabled = this.envDefault;
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      if (typeof j.enabled === 'boolean') {
        this.enabled = j.enabled;
        log.info(`whitelist enforcement loaded: ${this.enabled ? 'ON' : 'OFF'}`);
        return;
      }
    } catch (e) {
      // no state file
    }
    log.info(`whitelist enforcement default: ${this.enabled ? 'ON' : 'OFF'} (env)`);
  }

  set(enabled) {
    this.enabled = !!enabled;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ enabled: this.enabled }));
    } catch (e) {
      log.error('whitelist enforcement save failed:', e.message);
      throw e;
    }
  }

  isEnabled() {
    return this.enabled;
  }
}

module.exports = { WhitelistEnforcement };
