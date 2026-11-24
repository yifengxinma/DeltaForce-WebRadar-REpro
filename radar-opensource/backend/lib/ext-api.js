/**
 * ext-api.js — 外部 API 白名单同步
 *
 * 定期从用户配置的外部 URL 拉取房间号列表（JSON 格式），
 * 支持 JSON 数组 ["1000","2000"] 或对象 { rooms: [...] } / { keys: [...] } / { data: [...] }。
 * 同步到白名单。支持秒/分/小时间隔配置，持久化到 JSON 文件。
 */
const fs   = require('fs');
const http = require('http');
const https = require('https');
const cfg  = require('./config');
const log  = require('./logger')('ExtApi');

class ExtApi {
  constructor({ rooms } = {}) {
    this.stateFile = cfg.EXT_API_FILE;
    this.rooms = rooms;
    this.url = '';
    this.interval = 10;
    this.unit = 'm';
    this.active = false;
    this.timer = null;
    this.lastFetchAt = 0;
    this.lastStatus = '';
    this.lastCount = 0;
    this.lastKeys = [];
  }

  _intervalMs() {
    const n = Math.max(1, this.interval);
    switch (this.unit) {
      case 's': return n * 1000;
      case 'h': return n * 3600000;
      default:  return n * 60000;
    }
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      this.url = j.url || '';
      this.interval = j.interval || 10;
      this.unit = j.unit || 'm';
      this.active = !!j.active;
      log.info(`external API configured: interval=${this.interval}${this.unit}, active=${this.active}`);
      if (this.active && this.url) this.start();
    } catch {
      log.info('no ext_api config, idle');
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({
        url: this.url,
        interval: this.interval,
        unit: this.unit,
        active: this.active,
      }, null, 2));
    } catch (e) {
      log.error('save failed:', e.message);
    }
  }

  configure({ url, interval, unit }) {
    this.stop();
    this.url = (url || '').trim();
    this.interval = Math.max(1, parseInt(interval) || 10);
    if (['s', 'm', 'h'].includes(unit)) this.unit = unit;
    if (this.url) {
      this.active = true;
      this.start();
    } else {
      this.active = false;
    }
    this._save();
    return this.getStatus();
  }

  stopSync() {
    this.stop();
    this.active = false;
    this._save();
    return this.getStatus();
  }

  start() {
    this.stop();
    if (!this.url) return;
    this._fetch();
    const ms = this._intervalMs();
    this.timer = setInterval(() => this._fetch(), ms);
    if (this.timer.unref) this.timer.unref();
    log.info(`started polling every ${this.interval}${this.unit} (${ms}ms)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _fetch() {
    const urlStr = this.url;
    if (!urlStr) return;
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) {
      this.lastStatus = 'error:invalid_url';
      this.lastFetchAt = Date.now();
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(urlStr, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        this.lastFetchAt = Date.now();
        if (res.statusCode !== 200) {
          this.lastStatus = `error:http_${res.statusCode}`;
          log.warn(`external API returned HTTP ${res.statusCode}`);
          return;
        }
        let keys;
        try {
          const json = JSON.parse(body);
          let arr = null;
          if (Array.isArray(json)) arr = json;
          else if (json && typeof json === 'object') {
            arr = json.rooms || json.keys || json.data || json.whitelist || json.ids || null;
          }
          if (!Array.isArray(arr)) {
            this.lastStatus = 'error:invalid_json';
            log.warn('response JSON is not an array and has no rooms/keys/data/whitelist/ids field');
            return;
          }
          keys = arr.map(k => String(k).trim()).filter(k => k.length > 0 && k.length <= 32);
        } catch {
          this.lastStatus = 'error:json_parse';
          log.warn('failed to parse response as JSON');
          return;
        }
        if (keys.length === 0) {
          this.lastStatus = 'error:empty_response';
          log.warn('fetch returned 0 valid keys');
          return;
        }
        this.lastCount = keys.length;
        this.lastKeys = keys;
        this.lastStatus = 'ok';
        if (this.rooms) {
          this.rooms.applyAllowed(keys);
          log.info(`synced ${keys.length} keys from external API`);
        }
      });
    });
    req.on('error', (e) => {
      this.lastFetchAt = Date.now();
      this.lastStatus = `error:${e.code || e.message}`;
      log.warn(`fetch error: ${e.message}`);
    });
    req.on('timeout', () => {
      req.destroy();
      this.lastFetchAt = Date.now();
      this.lastStatus = 'error:timeout';
    });
  }

  testUrl(url) {
    return new Promise((resolve) => {
      if (!url) return resolve({ ok: false, error: 'url_required' });
      let parsed;
      try { parsed = new URL(url); } catch { return resolve({ ok: false, error: 'invalid_url' }); }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(url, { timeout: 10000 }, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, error: `http_${res.statusCode}` });
          try {
            const json = JSON.parse(body);
            let arr = null;
            if (Array.isArray(json)) arr = json;
            else if (json && typeof json === 'object') {
              arr = json.rooms || json.keys || json.data || json.whitelist || json.ids || null;
            }
            if (!Array.isArray(arr)) return resolve({ ok: false, error: 'invalid_json' });
            const keys = arr.map(k => String(k).trim()).filter(k => k.length > 0 && k.length <= 32);
            resolve({ ok: true, keys, total: keys.length });
          } catch { resolve({ ok: false, error: 'json_parse' }); }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    });
  }

  getStatus() {
    return {
      url: this.url,
      interval: this.interval,
      unit: this.unit,
      active: this.active,
      running: !!this.timer,
      lastFetchAt: this.lastFetchAt,
      lastStatus: this.lastStatus,
      lastCount: this.lastCount,
      lastKeys: this.lastKeys,
    };
  }
}

module.exports = { ExtApi };
