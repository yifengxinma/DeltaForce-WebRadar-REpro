/**
 * announcement.js — 公告 CRUD + 文件持久化
 *
 * 抽出动机:
 *   relay.js 之前 announcements 是 module-level 数组, load/save/sanitize/makeId
 *   散在 60+ 行里。封装后:
 *   - 调用方语义清晰: store.list({ enabled: true }) / store.add(b) / store.update(id, b) / store.remove(id)
 *   - 校验逻辑(type / displayMode / 长度截断)统一在 sanitize 一处
 *   - 测试用 new Announcements({ file: ':memory:' }) (内存模式仍然实现 read/write 接口对称)
 *
 * 字段: { id, title, content, type, enabled, pinned, displayMode, createdAt, updatedAt }
 *   type:        'info' | 'warn' | 'error' | 'success'
 *   displayMode: 'panel' | 'modal' | 'banner' | 'toast'
 */
const fs = require('fs');
const cfg = require('./config');
const { sanitizeRelayString } = require('./util');
const log = require('./logger')('Ann');

class Announcements {
  constructor({ file = cfg.ANNOUNCEMENTS_FILE } = {}) {
    this.file = file;
    this.list = []; // 按插入顺序; 查询时 sortDesc
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      const arr = Array.isArray(j) ? j : (Array.isArray(j.list) ? j.list : []);
      this.list = arr.filter(a => a && a.id).map(a => ({
        id:      String(a.id),
        title:   String(a.title || '').slice(0, cfg.ANN_TITLE_MAX),
        content: String(a.content || '').slice(0, cfg.ANN_CONTENT_MAX),
        type:    cfg.ANN_TYPES.includes(a.type) ? a.type : 'info',
        enabled: !!a.enabled,
        pinned:  !!a.pinned,
        displayMode: cfg.ANN_DISPLAY_MODES.includes(a.displayMode) ? a.displayMode : 'panel',
        createdAt: Number(a.createdAt) || Date.now(),
        updatedAt: Number(a.updatedAt) || Date.now(),
      }));
      log.info(`Loaded ${this.list.length} announcements`);
    } catch (e) {
      this.list = [];
      log.info('No file, default empty');
    }
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ list: this.list }, null, 2));
    } catch (e) {
      log.error('Save failed:', e.message);
    }
  }

  // 输入合法化: 截断 + 白名单 type / displayMode + XSS 净化 title/content
  sanitize(b) {
    return {
      title:   sanitizeRelayString(String(b.title || '').slice(0, cfg.ANN_TITLE_MAX)),
      content: sanitizeRelayString(String(b.content || '').slice(0, cfg.ANN_CONTENT_MAX)),
      type:    cfg.ANN_TYPES.includes(b.type) ? b.type : 'info',
      enabled: !!b.enabled,
      pinned:  !!b.pinned,
      displayMode: cfg.ANN_DISPLAY_MODES.includes(b.displayMode) ? b.displayMode : 'panel',
    };
  }

  // 排序: 置顶在前, 然后按 updatedAt 降序
  sortDesc(arr) {
    return [...arr].sort((a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
      b.updatedAt - a.updatedAt
    );
  }

  // 公开列表(前端用户看) / 管理列表(后台看)
  listSorted({ enabledOnly = false } = {}) {
    const arr = enabledOnly ? this.list.filter(a => a.enabled) : this.list;
    return this.sortDesc(arr);
  }

  _makeId() {
    return 'ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  add(body) {
    const fields = this.sanitize(body);
    if (!fields.title.trim() && !fields.content.trim()) {
      throw new Error('title or content required');
    }
    const now = Date.now();
    const ann = { id: this._makeId(), ...fields, createdAt: now, updatedAt: now };
    this.list.push(ann);
    this.save();
    return ann;
  }

  update(id, body) {
    const idx = this.list.findIndex(a => a.id === String(id || ''));
    if (idx < 0) return null;
    const fields = this.sanitize(body);
    this.list[idx] = { ...this.list[idx], ...fields, updatedAt: Date.now() };
    this.save();
    return this.list[idx];
  }

  remove(id) {
    const idx = this.list.findIndex(a => a.id === String(id || ''));
    if (idx < 0) return false;
    this.list.splice(idx, 1);
    this.save();
    return true;
  }
}

module.exports = { Announcements };
