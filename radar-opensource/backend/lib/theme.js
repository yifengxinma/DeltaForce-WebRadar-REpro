/**
 * theme.js — 前端主题切换 + 预览模式开关 + 浏览器标题/图标
 *
 * 抽出动机:
 *   relay.js 之前散在 3 段 (themeNames / preview / setCurrentTheme), 共享一堆
 *   module-level let。封装到两个 store 后:
 *   - PreviewState: enabled flag + 标记文件同步 (nginx 看此文件决定 /_white/ /_black/ 是否 404)
 *   - ThemeStore  : 软链切换 + 浏览器标题/图标 (JSON 持久化)
 *   - 各自有 load() / save(), relay.js 启动只调一次 load
 *
 * setCurrentTheme 用 symlink, 切换瞬间生效, 无需 reload nginx
 */
const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');
const { sanitizeRelayString } = require('./util');
const log = require('./logger')('Theme');

// ── 预览模式 ────────────────────────────────────────────────
class PreviewState {
  constructor({ stateFile = cfg.PREVIEW_STATE_FILE, flagFile = cfg.PREVIEW_FLAG_FILE } = {}) {
    this.stateFile = stateFile;
    this.flagFile  = flagFile;
    this.enabled   = false;
  }

  // 写一个空文件作 nginx 检测标记: 关闭时删, 启用时建
  _syncFlag() {
    try {
      if (this.enabled) {
        fs.writeFileSync(this.flagFile, '1');
      } else if (fs.existsSync(this.flagFile)) {
        fs.unlinkSync(this.flagFile);
      }
    } catch (e) {
      log.error('preview sync flag failed:', e.message);
    }
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      this.enabled = !!j.enabled;
      log.info(`preview state loaded: ${this.enabled ? 'ENABLED' : 'DISABLED'}`);
    } catch (e) {
      log.info('preview no state file, default DISABLED');
    }
    this._syncFlag();
  }

  set(enabled) {
    this.enabled = !!enabled;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ enabled: this.enabled }));
      this._syncFlag();
    } catch (e) {
      log.error('preview save state failed:', e.message);
    }
  }
}

// ── 主题: 浏览器标题/图标 + 前端软链 ───────────────────────────
class ThemeStore {
  constructor({
    file        = cfg.THEME_NAMES_FILE,
    frontendLink = cfg.FRONTEND_LINK,
    targets      = { white: cfg.FRONTEND_WHITE, black: cfg.FRONTEND_BLACK },
  } = {}) {
    this.file = file;
    this.frontendLink = frontendLink;
    this.targets = targets;
    this.currentFile = path.join(path.dirname(file), 'theme_current.json');
    this.current = 'white';
    this.names = {
      white: 'Holo Tactical Radar',
      black: 'Divine Lock',
      iconWhite: '/favicon.ico',
      iconBlack: '/favicon.ico',
      landing: {},
    };
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (j.white) this.names.white = String(j.white);
      if (j.black) this.names.black = String(j.black);
      if (typeof j.iconWhite === 'string') this.names.iconWhite = j.iconWhite;
      if (typeof j.iconBlack === 'string') this.names.iconBlack = j.iconBlack;
      if (j.landing && typeof j.landing === 'object') this.names.landing = j.landing;
      log.info(`names loaded: w="${this.names.white}" b="${this.names.black}" icons:${this.names.iconWhite ? 'W' : '-'}${this.names.iconBlack ? 'B' : '-'} landing:${Object.keys(this.names.landing).join(',')||'-'}`);
    } catch (e) {
      log.info('names using defaults');
    }
    try {
      const cur = JSON.parse(fs.readFileSync(this.currentFile, 'utf-8'));
      if (cur && ['white', 'black'].includes(cur.theme)) this.current = cur.theme;
      else if (cur && cur.theme === 'white2') this.current = 'white'; // 深蓝版已移除
    } catch (e) { /* no state yet */ }
    // 生产: FRONTEND_LINK 是独立软链，以磁盘指向为准
    // 局域网: LINK 常直接等于 white 目录，不能覆盖状态文件（否则永远显示白色）
    const linkIsThemeDir = Object.values(this.targets).some(
      (t) => path.resolve(t) === path.resolve(this.frontendLink)
    );
    if (!linkIsThemeDir) {
      const fromLink = this._detectFromLink();
      if (fromLink !== 'unknown') this.current = fromLink;
    }
    if (this.current === 'white2') this.current = 'white';
    // 局域网: FRONTEND_LINK=frontend/current，启动时确保 junction 指向当前主题
    try { this._ensureLink(this.current); } catch (e) {
      log.error('ensure theme link failed:', e.message);
    }
    log.info(`current theme: ${this.current}`);
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.names, null, 2));
    } catch (e) {
      log.error('names save failed:', e.message);
    }
  }

  // 部分更新: 只覆盖 body 里出现的字段; icon 字段做协议白名单校验
  // 返回 { ok: true } 或 { ok: false, error: '...' }; 调用方拿到错误自行返 4xx
  updateNames(body) {
    let changed = false;
    if (typeof body.white === 'string') {
      const n = sanitizeRelayString(body.white.trim()).slice(0, 64);
      if (n) { this.names.white = n; changed = true; }
    }
    if (typeof body.black === 'string') {
      const n = sanitizeRelayString(body.black.trim()).slice(0, 64);
      if (n) { this.names.black = n; changed = true; }
    }
    for (const key of ['iconWhite', 'iconBlack']) {
      if (typeof body[key] === 'string') {
        const v = body[key];
        if (v.length > cfg.ICON_MAX_BYTES) {
          return { ok: false, error: `${key} too large (max ${cfg.ICON_MAX_BYTES / 1024}KB)` };
        }
        // SVG 禁: 内嵌 <script onload=...> 可绕 CSP
        if (v && v.startsWith('data:image/svg')) {
          return { ok: false, error: `${key} SVG icons are not allowed` };
        }
        if (v && !v.startsWith('http://') && !v.startsWith('https://') && !v.startsWith('data:image/')) {
          return { ok: false, error: `${key} must be http(s) URL or data:image/...` };
        }
        this.names[key] = v;
        changed = true;
      }
    }
    if (body.landing && typeof body.landing === 'object') {
      const LANDING_FIELDS = ['title', 'desc', 'btn', 'hint'];
      const LANGS = ['zh', 'en'];
      for (const theme of ['white', 'black']) {
        if (!body.landing[theme]) continue;
        if (!this.names.landing[theme]) this.names.landing[theme] = {};
        for (const lang of LANGS) {
          if (!body.landing[theme][lang]) continue;
          if (!this.names.landing[theme][lang]) this.names.landing[theme][lang] = {};
          for (const field of LANDING_FIELDS) {
            if (typeof body.landing[theme][lang][field] === 'string') {
              this.names.landing[theme][lang][field] = sanitizeRelayString(body.landing[theme][lang][field]).slice(0, 200);
              changed = true;
            }
          }
        }
      }
    }
    if (changed) this.save();
    return { ok: true, changed };
  }

  // 通过 realpath / basename 看软链指向；Windows 路径用 \ 也能识别
  _detectFromLink() {
    try {
      const real = path.resolve(fs.realpathSync(this.frontendLink));
      for (const [name, target] of Object.entries(this.targets)) {
        if (path.resolve(target) === real) return name;
      }
      const base = path.basename(real).toLowerCase();
      if (base === 'white2' || base.includes('white2')) return 'white'; // 深蓝版已移除 → 白色
      if (base === 'white' || base.includes('white')) return 'white';
      if (base === 'black' || base.includes('black')) return 'black';
      // 旧 Linux 部署目录名
      if (real.includes('白色前端后端v2') || real.includes('-white2')) return 'white';
      if (real.includes('白色') || real.includes('-white')) return 'white';
      if (real.includes('黑色') || real.includes('-black')) return 'black';
      return 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }

  getCurrent() {
    if (this.current === 'white2') this.current = 'white';
    if (this.current && ['white', 'black'].includes(this.current)) return this.current;
    const detected = this._detectFromLink();
    return detected === 'unknown' ? 'white' : detected;
  }

  _saveCurrent(theme) {
    this.current = theme;
    try {
      fs.writeFileSync(this.currentFile, JSON.stringify({ theme }, null, 2));
    } catch (e) {
      log.error('save current theme failed:', e.message);
    }
  }

  setCurrent(theme) {
    if (theme === 'white2') throw new Error('Theme white2 (深蓝版) has been removed');
    const target = this.targets[theme];
    if (!target) throw new Error('Invalid theme: ' + theme);
    if (!fs.existsSync(target)) throw new Error('Target not exists: ' + target);

    this._saveCurrent(theme);
    this._ensureLink(theme);
  }

  // 更新 FRONTEND_LINK 软链/junction；禁止在 white/black 本体上 unlink
  _ensureLink(theme) {
    const target = this.targets[theme];
    if (!target || !fs.existsSync(target)) throw new Error('Target not exists: ' + theme);

    const linkResolved = path.resolve(this.frontendLink);
    const linkIsThemeDir = Object.values(this.targets).some((t) => path.resolve(t) === linkResolved);
    if (linkIsThemeDir) {
      log.info(`theme set to ${theme} (state file only; FRONTEND_LINK is a theme dir, skip symlink)`);
      return;
    }

    try {
      const real = path.resolve(fs.realpathSync(this.frontendLink));
      if (real === path.resolve(target)) {
        log.info(`theme link already -> ${theme}`);
        return;
      }
    } catch (e) { /* link missing */ }

    // 仅删除软链/junction；若误配成真实目录则拒绝，避免删掉主题
    try {
      const st = fs.lstatSync(this.frontendLink);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        // Windows junction: lstat 常报 isDirectory=true 且 isSymbolicLink=false
        // 用 readlink 判断是否为重解析点
        let isReparse = false;
        try { fs.readlinkSync(this.frontendLink); isReparse = true; } catch (e2) { isReparse = false; }
        if (!isReparse) {
          throw new Error('FRONTEND_LINK is a real directory, refuse to replace: ' + this.frontendLink);
        }
      }
      fs.unlinkSync(this.frontendLink);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        if (String(e.message || '').includes('refuse to replace')) throw e;
        // unlink 失败再试一次 readlink 路径
        try { fs.unlinkSync(this.frontendLink); } catch (e3) {
          if (e3.code !== 'ENOENT') log.error('unlink FRONTEND_LINK:', e3.message);
        }
      }
    }

    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(path.resolve(target), this.frontendLink, type);
    log.info(`theme symlink -> ${theme}`);
  }
}

module.exports = { PreviewState, ThemeStore };
