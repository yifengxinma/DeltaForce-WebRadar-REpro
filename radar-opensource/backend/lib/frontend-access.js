/**
 * frontend-access.js — 管理后台「进入房间」等链接使用的前端 HTTP 端口
 *
 * 默认使用前端服务的端口，修改后的对外访问端口持久化到 JSON。
 *
 * applyToNginx(oldPort)：可选的"反向控制"——admin POST /api/frontend_access
 * 后由 admin-http.js 调用，把端口同步写到 nginx 配置 + ufw 防火墙：
 *   1. 备份 NGINX_SITE_FILE 指定的站点配置
 *   2. 写入监听对外端口并反代前端服务的站点配置
 *   3. nginx -t 验证，不通过 → 还原 .bak + 抛错
 *   4. systemctl reload nginx
 *   5. ufw allow $newPort/tcp
 *   6. ufw delete allow $oldPort/tcp（PROTECTED_PORTS 永不删）
 * 站点配置写入、校验或重载失败时尝试还原文件。
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const cfg = require('./config');
const log = require('./logger')('FrontendAccess');

const MIN_PORT = 1;
const MAX_PORT = 65535;

const NGINX_SITE_FILE = process.env.NGINX_SITE_FILE || '';
const NGINX_SITE_BAK = NGINX_SITE_FILE ? NGINX_SITE_FILE + '.bak' : '';
const CMD_TIMEOUT_MS  = 15000;

// 这些端口的防火墙规则不随对外端口改变。
function protectedPorts() {
  return new Set([22, cfg.ADMIN_PORT, cfg.PORT, cfg.DEFAULT_FRONTEND_PORT, 5432]);
}

function normalizePort(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < MIN_PORT || n > MAX_PORT) return fallback;
  return n;
}

// 站点文件包含在 nginx 的 http 块中。普通 HTTP 不携带升级头。
function buildNginxConfig(port) {
  if (port === cfg.DEFAULT_FRONTEND_PORT) throw new Error('conflicts_with_frontend_upstream_port');

  return `map $http_upgrade $radar_frontend_connection {
    default upgrade;
    '' close;
}

server {
    listen ${port};
    listen [::]:${port};
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:${cfg.DEFAULT_FRONTEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $radar_frontend_connection;
        proxy_connect_timeout 5s;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
`;
}

class FrontendAccess {
  constructor({
    stateFile = cfg.FRONTEND_ACCESS_FILE,
    envDefault = cfg.DEFAULT_FRONTEND_PORT,
  } = {}) {
    this.stateFile = stateFile;
    this.envDefault = normalizePort(envDefault, 80);
    this.port = this.envDefault;
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      if (j.port !== undefined) {
        this.port = normalizePort(j.port, this.envDefault);
        log.info(`loaded port=${this.port} from ${this.stateFile}`);
        return;
      }
    } catch (e) {
      // no state file
    }
    this.port = this.envDefault;
    log.info(`using default frontend port ${this.port}`);
  }

  getPort() {
    return this.port;
  }

  setPort(port) {
    const n = normalizePort(port, null);
    if (n === null) throw new Error('invalid_port');
    if (n === cfg.ADMIN_PORT) throw new Error('conflicts_with_admin_port');
    if (n === cfg.PORT) throw new Error('conflicts_with_ws_port');
    if (n === 22) throw new Error('conflicts_with_ssh_port');
    if (n === 5432) throw new Error('conflicts_with_pg_port');
    this.port = n;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ port: this.port }, null, 2));
    } catch (e) {
      log.error('save failed:', e.message);
      throw e;
    }
  }

  // ---- nginx + ufw 同步（由 admin-http 调用）----

  async applyToNginx(oldPort) {
    const newPort = this.port;
    if (!Number.isFinite(newPort) || newPort < 1) {
      throw new Error('apply: invalid current port');
    }
    if (oldPort === newPort) {
      log.info(`apply: port unchanged (${newPort}), nginx skip`);
      return { changed: false, port: newPort };
    }

    if (newPort === cfg.DEFAULT_FRONTEND_PORT) throw new Error('conflicts_with_frontend_upstream_port');
    if (!NGINX_SITE_FILE) throw new Error('Set NGINX_SITE_FILE to enable automatic frontend port changes');

    // 1. 备份现有 nginx 配置（如有）
    let hadBackup = false;
    try {
      if (fs.existsSync(NGINX_SITE_FILE)) {
        fs.copyFileSync(NGINX_SITE_FILE, NGINX_SITE_BAK);
        hadBackup = true;
        log.info(`apply: backup ${NGINX_SITE_FILE} -> ${NGINX_SITE_BAK}`);
      }
    } catch (e) {
      throw new Error(`backup nginx failed: ${e.message}`);
    }

    const restoreBackup = () => {
      if (!hadBackup) return;
      try { fs.copyFileSync(NGINX_SITE_BAK, NGINX_SITE_FILE); log.warn('apply: restored nginx backup'); }
      catch (e) { log.error('apply: restore backup failed:', e.message); }
    };

    // 2. 写新配置
    try {
      fs.writeFileSync(NGINX_SITE_FILE, buildNginxConfig(newPort));
      log.info(`apply: wrote nginx config (listen ${newPort})`);
    } catch (e) {
      restoreBackup();
      throw new Error(`write nginx config failed: ${e.message}`);
    }

    // 3. nginx -t 验证
    try {
      await execAsync('nginx -t', { timeout: CMD_TIMEOUT_MS });
      log.info('apply: nginx -t ok');
    } catch (e) {
      restoreBackup();
      throw new Error(`nginx -t failed: ${(e.stderr || e.message).slice(0, 200)}`);
    }

    // 4. reload nginx
    try {
      await execAsync('systemctl reload nginx', { timeout: CMD_TIMEOUT_MS });
      log.info('apply: nginx reload ok');
    } catch (e) {
      restoreBackup();
      try { await execAsync('systemctl reload nginx', { timeout: CMD_TIMEOUT_MS }); } catch (_) {}
      throw new Error(`nginx reload failed: ${(e.stderr || e.message).slice(0, 200)}`);
    }

    // 5. ufw allow 新端口（不致命，失败只 warn）
    try {
      await execAsync(`ufw allow ${newPort}/tcp`, { timeout: CMD_TIMEOUT_MS });
      log.info(`apply: ufw allow ${newPort}/tcp`);
    } catch (e) {
      log.warn(`apply: ufw allow ${newPort} failed (non-fatal):`, (e.stderr || e.message).slice(0, 200));
    }

    // 6. ufw delete 旧端口（PROTECTED_PORTS 永不删；oldPort 不是数字也跳过）
    const oldN = Number(oldPort);
    if (Number.isFinite(oldN) && oldN > 0 && !protectedPorts().has(oldN)) {
      try {
        await execAsync(`ufw delete allow ${oldN}/tcp`, { timeout: CMD_TIMEOUT_MS });
        log.info(`apply: ufw delete allow ${oldN}/tcp`);
      } catch (e) {
        log.warn(`apply: ufw delete ${oldN} failed (non-fatal):`, (e.stderr || e.message).slice(0, 200));
      }
    } else if (protectedPorts().has(oldN)) {
      log.warn(`apply: refuse to ufw delete protected port ${oldN}`);
    }

    return { changed: true, port: newPort, oldPort: oldN };
  }
}

module.exports = { FrontendAccess, normalizePort, buildNginxConfig };
