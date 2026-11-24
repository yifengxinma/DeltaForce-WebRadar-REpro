#!/usr/bin/env node
/**
 * simulate_pub.js — 本地推流模拟器（替代游戏内 DLL，用于调试前端 / 录屏 / 联调）
 *
 * 以 WS `pub` 角色连接中继，持续推送与真实 DLL 相同格式的 JSON：
 *   mapName(仅切换时) + self/players/bots(10Hz) + items/containers/exits/boxes(1.5Hz)
 *
 * 用法：
 *   node tools/simulate_pub.js                       # 默认 127.0.0.1:5000 房间 8888 地图 零号大坝
 *   node tools/simulate_pub.js --key 1234 --map cgxg # 指定房间与地图
 *   node tools/simulate_pub.js --map list            # 列出可用地图
 *   node tools/simulate_pub.js --host 1.2.3.4 --port 5000 --rate 10 --count 8
 *
 * 房间必须在后台白名单内（或关闭白名单校验）才能 pub 成功。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { WebSocket } = require(path.join(__dirname, '..', 'backend', 'node_modules', 'ws'));

// ── 参数 ────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', 5000));
const KEY = String(arg('key', '8888'));
const RATE = Math.max(1, Number(arg('rate', 10))); // 每秒发送次数
const PLAYER_COUNT = Math.max(1, Math.min(12, Number(arg('count', 6))));

// ── 读取真实地图配置，保证坐标落在图内 ────────────────────────
function loadMapConfig() {
  const file = path.join(__dirname, '..', 'frontend', 'black', 'js', 'mapConfig.js');
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = { RADAR_CONFIG: { tileBase: '' }, console: { warn() {}, log() {} } };
  const out = vm.runInNewContext(code + '\n;({ MAPS, MAP_PREFIX_TABLE });', sandbox, { timeout: 3000 });
  return out;
}
let MAPS, PREFIXES;
try {
  ({ MAPS, PREFIXES } = (() => {
    const r = loadMapConfig();
    return { MAPS: r.MAPS, PREFIXES: r.MAP_PREFIX_TABLE };
  })());
} catch (e) {
  console.error('无法读取 frontend/black/js/mapConfig.js:', e.message);
  process.exit(1);
}

if (arg('map', '') === 'list') {
  console.log('可用地图：');
  for (const m of MAPS) console.log(`  ${m.id.padEnd(8)} ${m.name}   (layer=${m.layer})`);
  process.exit(0);
}

const MAP_ID = String(arg('map', 'daba'));
const MAP = MAPS.find(m => m.id === MAP_ID) || MAPS[0];
const PREFIX = (PREFIXES.find(p => p.key === MAP.id) || { prefix: 'Dam_Iris_Level' }).prefix;
const MAP_NAME = PREFIX + '_Main';

// ── 假数据 ───────────────────────────────────────────────────
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const CX = MAP.centerX;
const CY = MAP.centerY;
const R = Math.min(MAP.width, MAP.height) * 0.32; // 活动半径，保证在可视区内

const SELF = { x: CX + rand(-R, R), y: CY + rand(-R, R), z: Math.round(rand(0, 400)), yw: rand(0, 360), tick: Math.random() * 6.28 };

const NAMES = ['老K', '阿追', '青柠', 'Breeze', '山下', 'Kestrel', '老周', 'Nova'];
const HEROES = ['1001', '1002', '2001', '2002', '3001'];
const WEAPONS = ['2002', '2003', '3001', '3002'];
const ITEM_NAMES = ['5.56x45mm 弹药', '急救包', '防弹衣', '夜视仪', '加密硬盘', '金条', '钥匙卡', '手术包', '止痛药', '燃料罐'];

const players = Array.from({ length: PLAYER_COUNT }, (_, i) => ({
  x: CX + rand(-R, R), y: CY + rand(-R, R), z: Math.round(rand(0, 400)),
  h: 100, mh: 100, hh: rand(0, 360), hm: rand(0, 360), ah: rand(0, 360), am: rand(0, 360),
  t: i % 3 + 1, ai: 0, tm: i < 2 ? 1 : 0, dn: 0,
  n: NAMES[i % NAMES.length], hr: pick(HEROES), w: pick(WEAPONS),
  hl: Math.ceil(rand(1, 4)), ar: Math.ceil(rand(1, 4)),
  vx: rand(-0.6, 0.6), vy: rand(-0.6, 0.6), yw: rand(0, 360),
}));

const bots = Array.from({ length: 4 }, () => ({
  x: CX + rand(-R, R), y: CY + rand(-R, R), z: Math.round(rand(0, 400)),
  h: Math.round(rand(20, 100)), mh: 100, ai: 1, cn: pick(['敌方AI', '巡逻人机', '精英AI']),
  vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), yw: rand(0, 360),
}));

const items = Array.from({ length: 10 }, () => ({
  x: CX + rand(-R, R), y: CY + rand(-R, R), z: Math.round(rand(0, 400)),
  n: pick(ITEM_NAMES), oid: String(Math.floor(rand(10000, 99999))),
  v: Math.floor(rand(500, 50000)), q: Math.ceil(rand(1, 5)),
}));

const containers = Array.from({ length: 3 }, () => ({
  x: CX + rand(-R, R), y: CY + rand(-R, R), z: Math.round(rand(0, 400)),
  t: Math.random() > 0.5 ? 1 : 2, o: 0,
}));

const exits = Array.from({ length: 3 }, (_, i) => ({
  x: CX + rand(-R, R), y: CY + rand(-R, R), z: Math.round(rand(0, 200)),
  s: i === 0 ? 1 : 0,
}));

const boxes = Array.from({ length: 2 }, () => ({
  x: CX + rand(-R, R), y: CY + rand(-R, R), z: Math.round(rand(0, 300)),
  n: pick(NAMES), ai: 0, bt: 1,
}));

// ── 移动 ─────────────────────────────────────────────────────
function step(e) {
  e.x += e.vx * 20;
  e.y += e.vy * 20;
  if (Math.abs(e.x - CX) > R) { e.vx *= -1; e.x = CX + Math.sign(e.x - CX) * R; }
  if (Math.abs(e.y - CY) > R) { e.vy *= -1; e.y = CY + Math.sign(e.y - CY) * R; }
  e.yw = (Math.atan2(e.vy, e.vx) * 180 / Math.PI + 360) % 360;
  return e;
}
const f1 = n => Math.round(n * 10) / 10;
const r0 = n => Math.round(n);

// ── 连接与推送 ───────────────────────────────────────────────
let ws = null;
let msgCount = 0;
let startedAt = 0;
let tickTimer = null;
let slowTimer = null;

function start() {
  ws = new WebSocket(`ws://${HOST}:${PORT}`);

  ws.on('open', () => {
    ws.send(JSON.stringify({ action: 'auth', key: KEY, role: 'pub' }));
  });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!m.ok) {
      console.error('[模拟器] 鉴权失败:', m.error || m);
      if (String(m.error || '').includes('上限')) process.exit(1);
      return;
    }
    if (!startedAt) {
      startedAt = Date.now();
      console.log(`[模拟器] 已连接 pub  host=${HOST}:${PORT}  room=${KEY}  map=${MAP.name}(${MAP_NAME})  ${RATE}Hz`);
      sendAll();
      tickTimer = setInterval(tick, Math.round(1000 / RATE));
      slowTimer = setInterval(slowTick, 1500);
      setInterval(report, 5000);
    }
  });

  ws.on('close', code => {
    clearInterval(tickTimer); clearInterval(slowTimer);
    startedAt = 0;
    console.warn(`[模拟器] 连接断开 (${code})，3 秒后重连…`);
    setTimeout(start, 3000);
  });

  ws.on('error', err => console.error('[模拟器] 连接错误:', err.message));
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
  msgCount++;
}

function sendAll() {
  send({ type: 'mapName', data: MAP_NAME });
  tick();
  slowTick();
}

function tick() {
  SELF.tick += 0.08;
  SELF.x = CX + Math.cos(SELF.tick) * R * 0.55;
  SELF.y = CY + Math.sin(SELF.tick) * R * 0.55;
  SELF.yw = (SELF.tick * 180 / Math.PI + 90) % 360;
  send({ type: 'self', data: {
    x: f1(SELF.x), y: f1(SELF.y), z: SELF.z, yw: f1(SELF.yw),
    map: MAP_NAME, n: '你自己', dead: false, h: 100, mh: 100,
  } });

  send({ type: 'players', data: players.map(p => {
    step(p);
    return {
      x: f1(p.x), y: f1(p.y), z: p.z, h: r0(p.h), mh: p.mh, t: p.t, ai: 0, tm: p.tm, dn: p.dn,
      n: p.n, hr: p.hr, w: p.w, hl: p.hl, ar: p.ar,
      hh: r0(p.hh), hm: r0(p.hm), ah: r0(p.ah), am: r0(p.am), yw: f1(p.yw),
    };
  }) });

  send({ type: 'bots', data: bots.map(b => {
    step(b);
    return { x: f1(b.x), y: f1(b.y), z: b.z, h: r0(b.h), mh: b.mh, ai: 1, cn: b.cn };
  }) });
}

function slowTick() {
  send({ type: 'items', data: items.map(i => ({
    x: f1(i.x), y: f1(i.y), z: i.z, n: i.n, oid: i.oid, v: i.v, q: i.q,
  })) });
  send({ type: 'containers', data: containers.map(c => ({ x: f1(c.x), y: f1(c.y), z: c.z, t: c.t, o: c.o })) });
  send({ type: 'exits', data: exits.map(e => ({ x: f1(e.x), y: f1(e.y), z: e.z, s: e.s })) });
  send({ type: 'boxes', data: boxes.map(b => ({ x: f1(b.x), y: f1(b.y), z: b.z, n: b.n, ai: b.ai, bt: b.bt })) });
}

let lastReport = 0;
function report() {
  const now = Date.now();
  if (!lastReport) { lastReport = now; msgCount = 0; return; } // 首次只对齐计时
  const rate = (msgCount / ((now - lastReport) / 1000)).toFixed(0);
  lastReport = now; msgCount = 0;
  const up = startedAt ? Math.round((now - startedAt) / 1000) : 0;
  console.log(`[模拟器] 运行 ${up}s · 上行 ${rate} 条/秒 · 玩家 ${PLAYER_COUNT + 1} + AI ${bots.length} · 地图 ${MAP.name}`);
}

process.on('SIGINT', () => {
  console.log('\n[模拟器] 已停止');
  try { ws && ws.close(); } catch (_) {}
  process.exit(0);
});

start();
