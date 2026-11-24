/**
 * timing.js — timing-safe 字符串比较
 *
 * 抽出动机:
 *   /api/login 之前用 `body.user === creds.user` 比较用户名,
 *   字符串 === 在 v8 里走 SMI 优化, 不同 prefix 早返回, 时间可以泄露用户名前缀。
 *   攻击者反复尝试可以推测出 admin username 存在性 (timing attack)。
 *
 *   crypto.timingSafeEqual 要求等长 buffer, 直接调会因长度不同抛错也泄露长度信息。
 *   这里 padding 到 maxLen 后比较, 等长后再用 timingSafeEqual, 最后再 AND 上长度等于检查。
 *
 * 用法:
 *   timingSafeStringEqual('admin', body.user)  // true / false, 比较时间恒定 (除了长度差异)
 */
const crypto = require('crypto');

function timingSafeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a == null ? '' : a));
  const bBuf = Buffer.from(String(b == null ? '' : b));
  const maxLen = Math.max(aBuf.length, bBuf.length, 1); // 1 防止 0 长度抛错
  const aP = Buffer.alloc(maxLen);
  const bP = Buffer.alloc(maxLen);
  aBuf.copy(aP);
  bBuf.copy(bP);
  // 内容恒定时间比较 + 长度独立比较 (长度泄露无害, 因为 input 长度本身可见)
  return crypto.timingSafeEqual(aP, bP) && aBuf.length === bBuf.length;
}

module.exports = { timingSafeStringEqual };
