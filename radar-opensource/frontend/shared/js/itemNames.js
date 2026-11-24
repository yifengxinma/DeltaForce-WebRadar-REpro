// 物品 ID→名称 / 品质表：异步加载，不阻塞绘制
// 对齐 hookcall：items.json 优先，heroes.json 补全干员 8800… 名
const itemIdToName = Object.create(null);
const itemIdToQuality = Object.create(null);
const heroIdToName = Object.create(null);
let _itemNamesReady = false;
let _itemNameCount = 0;
let _itemQualityCount = 0;
let _heroNameCount = 0;

function _yieldToRenderer() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 80 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function _fetchJsonIdle(url) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'default' });
  if (!r.ok) throw new Error(url + ' ' + r.status);
  const text = await r.text();
  await _yieldToRenderer();
  const data = JSON.parse(text);
  await _yieldToRenderer();
  return data;
}

function _mergeDict(target, src) {
  if (!src || typeof src !== 'object') return 0;
  let n = 0;
  for (const k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      target[k] = src[k];
      n++;
    }
  }
  return n;
}

function _notifyItemNamesReady() {
  _itemNamesReady = true;
  try {
    if (typeof _scheduleCanvasRender === 'function') _scheduleCanvasRender();
  } catch (e) { /* canvas 未就绪 */ }
  try { window.dispatchEvent(new Event('itemNamesReady')); } catch (e) {}
}

(async () => {
  try {
    const [names, quality, heroes] = await Promise.all([
      _fetchJsonIdle('items.json').catch(e => { console.warn('[itemNames] items.json', e); return null; }),
      _fetchJsonIdle('items_quality.json').catch(e => { console.warn('[itemNames] items_quality.json', e); return null; }),
      _fetchJsonIdle('heroes.json').catch(e => { console.warn('[itemNames] heroes.json', e); return null; }),
    ]);
    await _yieldToRenderer();
    _itemNameCount = _mergeDict(itemIdToName, names);
    await _yieldToRenderer();
    _itemQualityCount = _mergeDict(itemIdToQuality, quality);
    await _yieldToRenderer();
    _heroNameCount = _mergeDict(heroIdToName, heroes);
    // heroes 补洞，不覆盖 items 里已有展示名（如 威龙）
    for (const k in heroIdToName) {
      if (!itemIdToName[k]) itemIdToName[k] = heroIdToName[k];
    }
    console.log('[itemNames] names=', _itemNameCount, 'quality=', _itemQualityCount, 'heroes=', _heroNameCount);
    _notifyItemNamesReady();
  } catch (e) {
    console.warn('[itemNames] load failed', e);
  }
})();

function getItemIconUrl(itemId) {
  if (!itemId) return null;
  return RadarEndpoints.asset(RADAR_CONFIG.itemIconBase, String(itemId) + '.png');
}

function getItemNameById(itemId) {
  if (!itemId) return null;
  return itemIdToName[String(itemId)] || null;
}

function getHeroNameById(itemId) {
  if (!itemId) return null;
  const k = String(itemId);
  return heroIdToName[k] || itemIdToName[k] || null;
}

function getItemQualityById(itemId) {
  if (!itemId) return 0;
  const q = itemIdToQuality[String(itemId)];
  const n = Number(q);
  return (n >= 1 && n <= 6) ? n : 0;
}

function isWeaponItemId(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n < 10000000) return false;
  const cat = Math.floor(n / 10000000);
  return cat >= 1800 && cat < 1900;
}

function resolveItemQuality(item) {
  if (!item) return 0;
  const id = item.oid || item.n || item.id;
  if (isWeaponItemId(id)) return 1;
  const wq = Number(item.q) || 0;
  if (wq >= 1 && wq <= 6) return wq;
  const tq = getItemQualityById(id);
  if (tq >= 1 && tq <= 6) return tq;
  return 0;
}

// 有效过滤价值：真实 v>1 优先；否则用品质估；未知返回 0（不过滤）
function resolveItemFilterValue(item) {
  if (!item) return 0;
  const v = Number(item.v) || 0;
  if (v > 1) return v;
  const q = resolveItemQuality(item);
  const kQVal = [0, 500, 2000, 8000, 20000, 45000, 80000];
  if (q >= 1 && q <= 6) return kQVal[q];
  return 0;
}

function itemPassesValueFilter(item, minV) {
  const min = Number(minV) || 0;
  if (min <= 0) return true;
  const v = resolveItemFilterValue(item);
  // 未知价值：不按价值筛掉（查不到名/价时仍显示 ID）
  if (v <= 0) return true;
  return v >= min;
}

function getItemDisplayName(nameOrId) {
  if (!nameOrId) return '';
  const s = String(nameOrId);
  if (/^\d{8,}$/.test(s)) {
    // 表内有名才返回中文；未命中返回空，让调用方决定是否回退成 ID
    return itemIdToName[s] || heroIdToName[s] || '';
  }
  return s;
}

window.itemIdToName = itemIdToName;
window.itemIdToQuality = itemIdToQuality;
window.heroIdToName = heroIdToName;
window.getItemIconUrl = getItemIconUrl;
window.getItemNameById = getItemNameById;
window.getHeroNameById = getHeroNameById;
window.getItemQualityById = getItemQualityById;
window.isWeaponItemId = isWeaponItemId;
window.resolveItemQuality = resolveItemQuality;
window.resolveItemFilterValue = resolveItemFilterValue;
window.itemPassesValueFilter = itemPassesValueFilter;
window.getItemDisplayName = getItemDisplayName;
window.itemNamesReady = () => _itemNamesReady;
