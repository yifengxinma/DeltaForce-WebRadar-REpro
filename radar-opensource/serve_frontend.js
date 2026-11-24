#!/usr/bin/env node
/**
 * 前端静态服务和同源代理。
 * 用法：node serve_frontend.js [theme|auto] [port]
 * 主题跟随管理后台，预览路径为 /_white/ 和 /_black/。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, 'backend');
const FRONTEND_ROOT = path.join(__dirname, 'frontend');
const LOOPBACK = '127.0.0.1';
const THEMES = new Set(['white', 'black']);
const SHARED_FILES = new Set(['/config.js', '/favicon.svg']);
const NETWORK_KEYS = new Set([
  'PORT', 'ADMIN_PORT', 'FRONTEND_PORT', 'FRONTEND_BIND', 'RADAR_DATA_DIR',
  'THEME_NAMES_FILE',
]);
const API_HEADERS = [
  'accept', 'accept-encoding', 'authorization', 'content-length', 'content-type',
  'origin', 'user-agent',
];
const HANDSHAKE_HEADERS = [
  'origin', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol',
  'sec-websocket-extensions',
];
const HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
];
const API_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const WEBSOCKET_IDLE_MS = 300_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.map': 'application/json',
};

function loadNetworkSettings() {
  const config = {};
  try {
    const lines = fs.readFileSync(path.join(BACKEND_ROOT, '.env'), 'utf8').split('\n');
    for (const line of lines) {
      const entry = line.trim();
      const separator = entry.indexOf('=');
      if (separator <= 0 || entry.startsWith('#')) continue;

      const key = entry.slice(0, separator).trim();
      if (NETWORK_KEYS.has(key) && config[key] === undefined) {
        config[key] = entry.slice(separator + 1).trim();
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error('无法读取后台网络配置');
  }
  for (const key of NETWORK_KEYS) {
    if (process.env[key] !== undefined) config[key] = process.env[key];
  }
  return config;
}

function parsePort(value, key) {
  const port = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(key + ' 必须是 1 到 65535 之间的整数');
  }
  return port;
}

const config = loadNetworkSettings();
const themeNamesFile = config.THEME_NAMES_FILE ||
  path.join(config.RADAR_DATA_DIR || path.join(BACKEND_ROOT, 'data'), 'theme_names.json');
const themeState = path.join(path.dirname(themeNamesFile), 'theme_current.json');
const adminPort = parsePort(config.ADMIN_PORT || 9090, 'ADMIN_PORT');
const relayPort = parsePort(config.PORT || 5000, 'PORT');
const bind = config.FRONTEND_BIND || LOOPBACK;
const [themeArg, portArg] = process.argv.slice(2);
const fallbackTheme = THEMES.has(themeArg) ? themeArg : 'white';
const listenPort = parsePort(
  /^\d+$/.test(themeArg || '') ? themeArg : portArg || config.FRONTEND_PORT || 8080,
  'FRONTEND_PORT',
);
if (listenPort === adminPort || listenPort === relayPort) {
  throw new Error('FRONTEND_PORT 不能与后台或中继端口相同');
}

function resolveActiveTheme() {
  try {
    const state = JSON.parse(fs.readFileSync(themeState, 'utf8'));
    if (state && THEMES.has(state.theme)) return state.theme;
  } catch {
    // 没有可用的主题状态时使用启动参数。
  }
  return fallbackTheme;
}

function send(res, status, body, headers) {
  res.writeHead(status, headers);
  res.end(body);
}

function routePath(reqUrl) {
  if (!reqUrl || !reqUrl.startsWith('/') || reqUrl.startsWith('//')) return null;
  try {
    const rawPath = reqUrl.split('?')[0];
    const decoded = decodeURIComponent(rawPath);
    if (/[\x00-\x1f\x7f\\]/.test(decoded)) return null;
    return new URL(reqUrl, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

function serveStatic(req, res, pathname, root) {
  const relative = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.resolve(root, '.' + relative);
  if (!file.startsWith(root + path.sep)) {
    send(res, 403, 'forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      const missing = ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(err.code);
      send(res, missing ? 404 : 500, missing ? 'not found' : 'read error');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    send(res, 200, req.method === 'HEAD' ? undefined : data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
  });
}

function proxyHeaders(req, names) {
  const headers = {};
  for (const name of names) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  if (req.socket.remoteAddress) headers['x-forwarded-for'] = req.socket.remoteAddress;

  const host = req.headers.host;
  if (host && /^[a-zA-Z0-9.\-:[\]]+$/.test(host)) {
    try {
      if (new URL('http://' + host).host) headers.host = host;
    } catch {
      // 由 Node 使用上游地址生成 Host 请求头。
    }
  }
  return headers;
}

function proxyApi(req, res) {
  const upstream = http.request({
    host: LOOPBACK,
    port: adminPort,
    method: req.method,
    path: req.url,
    headers: proxyHeaders(req, API_HEADERS),
  }, (reply) => {
    const extraHopHeaders = String(reply.headers.connection || '')
      .toLowerCase().split(',').map((name) => name.trim());
    const headers = Object.fromEntries(Object.entries(reply.headers)
      .filter(([name]) => !HOP_HEADERS.includes(name) && !extraHopHeaders.includes(name)));

    res.writeHead(reply.statusCode, headers);
    reply.on('error', () => res.destroy());
    reply.pipe(res);
  });

  upstream.setTimeout(API_TIMEOUT_MS, () => upstream.destroy());
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else send(res, 502, 'admin backend unavailable');
  });
  req.on('error', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed || !socket.writable) return;
  socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

function proxyWebSocket(req, socket, head) {
  socket.pause();
  const upstream = http.request({
    host: LOOPBACK,
    port: relayPort,
    method: 'GET',
    path: req.url,
    headers: {
      ...proxyHeaders(req, HANDSHAKE_HEADERS),
      connection: 'Upgrade',
      upgrade: 'websocket',
    },
  });

  const cancelHandshake = () => upstream.destroy();
  socket.once('close', cancelHandshake);
  socket.once('error', cancelHandshake);
  upstream.setTimeout(HANDSHAKE_TIMEOUT_MS, cancelHandshake);
  upstream.on('error', () => rejectUpgrade(socket, '502 Bad Gateway'));
  upstream.once('response', (reply) => {
    reply.destroy();
    rejectUpgrade(socket, '502 Bad Gateway');
  });
  upstream.once('upgrade', (reply, relaySocket, relayHead) => {
    socket.removeListener('close', cancelHandshake);
    socket.removeListener('error', cancelHandshake);
    if (socket.destroyed || reply.statusCode !== 101) {
      relaySocket.destroy();
      rejectUpgrade(socket, '502 Bad Gateway');
      return;
    }

    const destroyTunnel = () => {
      socket.destroy();
      relaySocket.destroy();
    };
    for (const endpoint of [socket, relaySocket]) {
      endpoint.setTimeout(WEBSOCKET_IDLE_MS, destroyTunnel);
      endpoint.once('error', destroyTunnel);
      endpoint.once('close', destroyTunnel);
    }

    const handshake = ['HTTP/1.1 101 Switching Protocols'];
    for (let i = 0; i < reply.rawHeaders.length; i += 2) {
      handshake.push(reply.rawHeaders[i] + ': ' + reply.rawHeaders[i + 1]);
    }
    socket.write(handshake.join('\r\n') + '\r\n\r\n');
    if (relayHead.length) socket.write(relayHead);
    if (head.length) relaySocket.write(head);
    relaySocket.pipe(socket);
    socket.pipe(relaySocket);
  });
  upstream.end();
}

for (const theme of THEMES) {
  if (!fs.existsSync(path.join(FRONTEND_ROOT, theme, 'index.html'))) {
    throw new Error('缺少主题入口：' + theme);
  }
}

const server = http.createServer((req, res) => {
  const pathname = routePath(req.url);
  if (!pathname) {
    send(res, 400, 'bad url');
    return;
  }
  if (pathname.startsWith('/api/')) {
    proxyApi(req, res);
    return;
  }
  if (pathname === '/ws') {
    send(res, 426, 'websocket upgrade required');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  if (SHARED_FILES.has(pathname)) {
    serveStatic(req, res, pathname, FRONTEND_ROOT);
    return;
  }

  const themePath = pathname.match(/^\/_?(white|black)(\/.*)?$/);
  if (themePath && !themePath[2]) {
    const query = req.url.slice(req.url.split('?')[0].length);
    send(res, 308, '', { Location: pathname + '/' + query });
    return;
  }
  const theme = themePath ? themePath[1] : resolveActiveTheme();
  const relative = themePath ? themePath[2] : pathname;
  serveStatic(req, res, relative, path.join(FRONTEND_ROOT, theme));
});

server.on('upgrade', (req, socket, head) => {
  const pathname = routePath(req.url);
  if (!pathname) return rejectUpgrade(socket, '400 Bad Request');
  if (pathname !== '/ws') return rejectUpgrade(socket, '404 Not Found');
  if (req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    return rejectUpgrade(socket, '400 Bad Request');
  }
  proxyWebSocket(req, socket, head);
});

server.listen(listenPort, bind, () => {
  console.log('[web] active theme=' + resolveActiveTheme() + ', port=' + listenPort);
});
