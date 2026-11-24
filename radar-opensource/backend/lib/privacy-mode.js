/**
 * privacy-mode.js — 隐私模式开关
 *
 * 开启后前端玩家名字只显示首尾字符（你是45我 → 你***我），避免泄露真实 ID。
 * 持久化到 JSON 文件，前端通过公开 API 轮询状态。
 */
const fs = require('fs');
const cfg = require('./config');
const log = require('./logger')('PrivacyMode');

class PrivacyMode {
  constructor({ stateFile = cfg.PRIVACY_MODE_FILE } = {}) {
    this.stateFile = stateFile;
    this.enabled = false;
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      this.enabled = !!j.enabled;
      log.info(`loaded privacy_mode=${this.enabled}`);
    } catch {
      this.enabled = false;
      log.info('privacy mode off (no state file)');
    }
  }

  isEnabled() {
    return this.enabled;
  }

  setEnabled(val) {
    this.enabled = !!val;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ enabled: this.enabled }, null, 2));
    } catch (e) {
      log.error('save failed:', e.message);
      throw e;
    }
  }
}

module.exports = { PrivacyMode };
