/**
 * udp-binary.js — 解码 DLL RadarBin UDP 包 → 现有 JSON（给 ingestPub / 网页）
 *
 * Hdr(44): magic u32 LE 'RDAR'=0x52414452, ver u16, type u8, flags u8, key[32], payloadBytes u32
 */
const MAGIC = 0x52414452;
const VERSION = 1;
const HDR = 44;

const T = {
  Info: 1, MapName: 2, Self: 3, Players: 4, Bots: 5,
  Items: 6, Containers: 7, Exits: 8, Boxes: 9, Doors: 10,
};

function readCString(buf, off, max) {
  const end = Math.min(off + max, buf.length);
  let i = off;
  while (i < end && buf[i] !== 0) i++;
  return buf.toString('utf8', off, i);
}

function escJson(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function f1(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.0';
  return (Math.round(n * 10) / 10).toFixed(1);
}

function f0(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toString();
}

/**
 * @param {Buffer} buf
 * @returns {{ key: string, json: string } | null}
 */
function decodeRadarBin(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HDR) return null;
  if (buf.readUInt32LE(0) !== MAGIC) return null;
  const ver = buf.readUInt16LE(4);
  if (ver !== VERSION) return null;
  const type = buf[6];
  const key = readCString(buf, 8, 32);
  const payloadBytes = buf.readUInt32LE(40);
  if (payloadBytes > 60000 || buf.length < HDR + payloadBytes) return null;
  const p = buf.subarray(HDR, HDR + payloadBytes);

  let json = null;
  switch (type) {
    case T.Info: {
      const card = readCString(p, 0, 8);
      json = `{"type":"info","card":"${escJson(card)}"}`;
      break;
    }
    case T.MapName: {
      const map = readCString(p, 0, 64);
      json = `{"type":"mapName","data":"${escJson(map)}"}`;
      break;
    }
    case T.Self: {
      if (p.length < 6 * 4 + 4 + 64 + 64) return null;
      const x = p.readFloatLE(0), y = p.readFloatLE(4), z = p.readFloatLE(8);
      const yw = p.readFloatLE(12), h = p.readFloatLE(16), mh = p.readFloatLE(20);
      const dead = p[24] !== 0;
      const map = readCString(p, 28, 64);
      const name = readCString(p, 92, 64);
      json = `{"type":"self","data":{"x":${f1(x)},"y":${f1(y)},"z":${f1(z)},"yw":${f1(yw)},"map":"${escJson(map)}","n":"${escJson(name)}","dead":${dead},"h":${f0(h)},"mh":${f0(mh)}}}`;
      break;
    }
    case T.Players: {
      if (p.length < 2) return null;
      const n = p.readUInt16LE(0);
      const stride = 132;
      if (p.length < 2 + n * stride) return null;
      const parts = [];
      for (let i = 0; i < n; i++) {
        const o = 2 + i * stride;
        const x = p.readFloatLE(o), y = p.readFloatLE(o + 4), z = p.readFloatLE(o + 8);
        const h = p.readFloatLE(o + 12), mh = p.readFloatLE(o + 16);
        const hh = p.readFloatLE(o + 20), hm = p.readFloatLE(o + 24);
        const ah = p.readFloatLE(o + 28), am = p.readFloatLE(o + 32), yw = p.readFloatLE(o + 36);
        const teamId = p.readUInt32LE(o + 40);
        const tm = p[o + 45], dn = p[o + 46];
        const heroId = p.readBigUInt64LE(o + 48);
        const weaponId = p.readBigUInt64LE(o + 56);
        const hl = p.readInt8(o + 64), ar = p.readInt8(o + 65);
        const name = readCString(p, o + 68, 64);
        parts.push(
          `{"x":${f1(x)},"y":${f1(y)},"z":${f1(z)},"h":${f0(h)},"mh":${f0(mh)},` +
          `"t":${teamId},"ai":0,"tm":${tm},"dn":${dn},"n":"${escJson(name)}",` +
          `"hr":${heroId.toString()},"w":${weaponId.toString()},"hl":${hl},"ar":${ar},` +
          `"hh":${f0(hh)},"hm":${f0(hm)},"ah":${f0(ah)},"am":${f0(am)},"yw":${f1(yw)}}`
        );
      }
      json = `{"type":"players","data":[${parts.join(',')}]}`;
      break;
    }
    case T.Bots: {
      if (p.length < 2) return null;
      const n = p.readUInt16LE(0);
      const stride = 84;
      if (p.length < 2 + n * stride) return null;
      const parts = [];
      for (let i = 0; i < n; i++) {
        const o = 2 + i * stride;
        const x = p.readFloatLE(o), y = p.readFloatLE(o + 4), z = p.readFloatLE(o + 8);
        const h = p.readFloatLE(o + 12), mh = p.readFloatLE(o + 16);
        const cn = readCString(p, o + 20, 64);
        parts.push(
          `{"x":${f1(x)},"y":${f1(y)},"z":${f1(z)},"h":${f0(h)},"mh":${f0(mh)},"ai":1,"cn":"${escJson(cn)}"}`
        );
      }
      json = `{"type":"bots","data":[${parts.join(',')}]}`;
      break;
    }
    case T.Items: {
      if (p.length < 2) return null;
      const n = p.readUInt16LE(0);
      const stride = 92;
      if (p.length < 2 + n * stride) return null;
      const parts = [];
      for (let i = 0; i < n; i++) {
        const o = 2 + i * stride;
        const x = p.readFloatLE(o), y = p.readFloatLE(o + 4), z = p.readFloatLE(o + 8);
        const v = p.readInt32LE(o + 12), q = p.readInt32LE(o + 16);
        const sku = p.readBigUInt64LE(o + 20);
        const name = readCString(p, o + 28, 64);
        const oid = sku.toString();
        parts.push(
          `{"x":${f1(x)},"y":${f1(y)},"z":${f1(z)},"n":"${escJson(name)}","oid":"${escJson(oid)}","v":${v},"q":${q}}`
        );
      }
      json = `{"type":"items","data":[${parts.join(',')}]}`;
      break;
    }
    case T.Containers: {
      if (p.length < 2) return null;
      const n = p.readUInt16LE(0);
      const stride = 20;
      if (p.length < 2 + n * stride) return null;
      const parts = [];
      for (let i = 0; i < n; i++) {
        const o = 2 + i * stride;
        const x = p.readFloatLE(o), y = p.readFloatLE(o + 4), z = p.readFloatLE(o + 8);
        const t = p.readInt32LE(o + 12), op = p[o + 16];
        parts.push(`{"x":${f1(x)},"y":${f1(y)},"z":${f1(z)},"t":${t},"o":${op}}`);
      }
      json = `{"type":"containers","data":[${parts.join(',')}]}`;
      break;
    }
    case T.Exits: {
      if (p.length < 2) return null;
      const n = p.readUInt16LE(0);
      const stride = 16;
      if (p.length < 2 + n * stride) return null;
      const parts = [];
      for (let i = 0; i < n; i++) {
        const o = 2 + i * stride;
        const x = p.readFloatLE(o), y = p.readFloatLE(o + 4), z = p.readFloatLE(o + 8);
        const s = p[o + 12];
        parts.push(`{"x":${f1(x)},"y":${f1(y)},"z":${f1(z)},"s":${s}}`);
      }
      json = `{"type":"exits","data":[${parts.join(',')}]}`;
      break;
    }
    case T.Boxes: {
      if (p.length < 2) return null;
      const n = p.readUInt16LE(0);
      const stride = 84;
      if (p.length < 2 + n * stride) return null;
      const parts = [];
      for (let i = 0; i < n; i++) {
        const o = 2 + i * stride;
        const x = p.readFloatLE(o), y = p.readFloatLE(o + 4), z = p.readFloatLE(o + 8);
        const pl = p[o + 12], ai = p[o + 13];
        const bt = p.readInt32LE(o + 16);
        const name = readCString(p, o + 20, 64);
        parts.push(
          `{"x":${f1(x)},"y":${f1(y)},"z":${f1(z)},"p":${pl},"ai":${ai},"bt":${bt},"n":"${escJson(name)}"}`
        );
      }
      json = `{"type":"boxes","data":[${parts.join(',')}]}`;
      break;
    }
    case T.Doors: {
      if (p.length < 2) return null;
      const n = p.readUInt16LE(0);
      const stride = 16;
      if (p.length < 2 + n * stride) return null;
      const parts = [];
      for (let i = 0; i < n; i++) {
        const o = 2 + i * stride;
        const x = p.readFloatLE(o), y = p.readFloatLE(o + 4), z = p.readFloatLE(o + 8);
        const sum = p.readInt32LE(o + 12);
        parts.push(`{"x":${f1(x)},"y":${f1(y)},"z":${f1(z)},"sum":${sum},"opened":false}`);
      }
      json = `{"type":"doors","data":[${parts.join(',')}]}`;
      break;
    }
    default:
      return null;
  }

  if (!json || !key) return null;
  // 注入 key 供 ingest 识别房间（与旧 WithKey 一致）
  const withKey = `{"key":"${escJson(key)}",${json.slice(1)}`;
  return { key, json: withKey };
}

function isRadarBin(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === MAGIC;
}

module.exports = { decodeRadarBin, isRadarBin, MAGIC, VERSION };
