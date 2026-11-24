/* ============================================================
 * announcement.js  -  前端公告 (4 种展示样式)
 *
 *   panel  -> 右下角铃铛 + 滑出面板 (默认, 所有公告统一回看入口)
 *   modal  -> 居中弹窗 (首次进入页面弹一次, 关闭后不再弹)
 *   banner -> 顶部横幅 (长期, 用户主动关闭后不再显示)
 *   toast  -> 右上角悬浮 4s 自动消失 (关闭后不再弹)
 *
 * 不管 displayMode 选哪个, 所有公告都会进 panel 供回看。
 * displayMode 只决定"有没有额外的醒目展示"。
 *
 * 数据源:    GET /api/announcements/public  (CORS)
 * 已读 ID:   localStorage 'ann_read_ids_v1'      (panel 红点用)
 * 已关 modal: localStorage 'ann_seen_modal_v1'   (modal 一次性弹窗记忆)
 * 已关 banner:localStorage 'ann_dismissed_banner_v1' (banner 用户关闭记忆)
 * 已关 toast: localStorage 'ann_shown_toast_v1'  (toast 一次性弹窗记忆)
 * 自动刷新:  5s 轮询
 * ============================================================ */
(function () {
    'use strict';

    const API_URL          = RadarEndpoints.api('/api/announcements/public');
    const STORAGE_READ_KEY     = 'ann_read_ids_v1';
    const STORAGE_MODAL_KEY    = 'ann_seen_modal_v1';
    const STORAGE_BANNER_KEY   = 'ann_dismissed_banner_v1';
    const STORAGE_TOAST_KEY    = 'ann_shown_toast_v1';
    const POLL_INTERVAL_MS = 5_000;
    const TOAST_AUTO_DISMISS_MS = 4_000;

    // ── 工具 ────────────────────────────────────────────────
    function esc(s) {
        return String(s || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function fmtTime(ts) {
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function loadSet(key) {
        try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
        catch (e) { return new Set(); }
    }
    function saveSet(key, set) {
        try { localStorage.setItem(key, JSON.stringify([...set])); }
        catch (e) { /* 静默 */ }
    }

    // ── 注入样式 ────────────────────────────────────────────
    // 直接复用页面的 CSS 变量（black/white 两个主题用同一套变量名:
    //   --bg / --panel / --border / --accent / --t1 / --t2）
    // 没 var 时 fallback 默认值, 保证脱离两主题环境也能跑。
    // 类型色 (success/warn/error/info) 写死, 全球语义一致。
    const STYLE = `
    :root {
        --ann-info:    var(--accent, #58a6ff);
        --ann-success: #3fb950;
        --ann-warn:    #d29922;
        --ann-error:   #f85149;
    }

    /* ── Fab (右下角铃铛) ── */
    .ann-fab {
        position: fixed; right: 20px; bottom: 20px;
        width: 48px; height: 48px; border-radius: 50%;
        background: var(--panel, rgba(20,20,22,0.78));
        color: var(--t1, #fff);
        border: 1px solid var(--border, rgba(255,255,255,0.18));
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; z-index: 10010;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 4px 18px rgba(0,0,0,0.18);
        transition: transform .15s cubic-bezier(0.16, 1, 0.3, 1);
        user-select: none;
    }
    .ann-fab:hover { transform: scale(1.08); }
    .ann-fab:active { transform: scale(0.96); }
    .ann-fab svg { width: 22px; height: 22px; pointer-events: none; }
    .ann-fab-badge {
        position: absolute; top: 2px; right: 2px;
        min-width: 18px; height: 18px; padding: 0 5px;
        border-radius: 9px; background: var(--ann-error); color: #fff;
        font-size: 10px; font-weight: 700; line-height: 18px;
        text-align: center; border: 2px solid var(--panel, rgba(20,20,22,0.78));
        display: none; pointer-events: none;
    }
    .ann-fab-badge.show { display: block; }

    /* ── Panel (右侧滑出) ── */
    .ann-panel {
        position: fixed; right: 0; top: 0;
        width: 360px; max-width: 92vw; height: 100vh;
        background: var(--panel, rgba(18,18,22,0.92));
        color: var(--t1, #e6e6e6);
        backdrop-filter: blur(14px) saturate(1.4);
        -webkit-backdrop-filter: blur(14px) saturate(1.4);
        border-left: 1px solid var(--border, rgba(255,255,255,0.08));
        box-shadow: -10px 0 32px rgba(0,0,0,0.18);
        transform: translateX(110%); opacity: 0;
        transition: transform .28s cubic-bezier(0.16, 1, 0.3, 1), opacity .28s;
        z-index: 10011; display: flex; flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .ann-panel.show { transform: translateX(0); opacity: 1; }
    .ann-panel-head {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
        display: flex; align-items: center; justify-content: space-between;
        flex-shrink: 0;
    }
    .ann-panel-title { font-size: 15px; font-weight: 600; color: var(--t1, #fff); letter-spacing: 0.3px; }
    .ann-panel-close {
        background: none; border: none; color: var(--t2, #888);
        font-size: 22px; cursor: pointer; padding: 0 6px;
        line-height: 1; transition: color .15s;
    }
    .ann-panel-close:hover { color: var(--t1, #fff); }
    .ann-panel-body {
        flex: 1; overflow-y: auto; padding: 12px 14px;
        scrollbar-width: thin; scrollbar-color: var(--border, rgba(255,255,255,0.18)) transparent;
    }
    .ann-panel-body::-webkit-scrollbar { width: 6px; }
    .ann-panel-body::-webkit-scrollbar-thumb { background: var(--border, rgba(255,255,255,0.18)); border-radius: 3px; }

    .ann-empty {
        text-align: center; color: var(--t2, #777);
        padding: 80px 20px; font-size: 13px; line-height: 1.6;
    }
    .ann-empty-icon {
        width: 48px; height: 48px; margin: 0 auto 14px;
        opacity: 0.5; color: var(--t2, #999);
    }
    .ann-empty-icon svg { width: 100%; height: 100%; display: block; }
    .ann-empty-icon.loading svg { animation: ann-spin 1.2s linear infinite; }
    @keyframes ann-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

    /* ── Item (panel 内的卡片) ──
       卡片背景: 用 currentColor 5% 透明叠加, 在 dark 主题上是淡白浮层,
                 在 light 主题上是淡黑浮层, 都比直接用纯色更柔和 */
    .ann-item {
        background: color-mix(in srgb, currentColor 6%, transparent);
        border-radius: 8px; padding: 12px 14px; margin-bottom: 10px;
        border-left: 3px solid var(--ann-info);
        position: relative; transition: background .15s;
        cursor: pointer;
    }
    .ann-item:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
    .ann-item:active { transform: scale(0.99); }
    .ann-item.type-success { border-left-color: var(--ann-success); }
    .ann-item.type-warn    { border-left-color: var(--ann-warn); }
    .ann-item.type-error   { border-left-color: var(--ann-error); }
    .ann-item.pinned       { background: color-mix(in srgb, var(--ann-warn) 10%, transparent); }
    .ann-item.pinned:hover { background: color-mix(in srgb, var(--ann-warn) 16%, transparent); }
    .ann-item.unread::after {
        content: ''; position: absolute; top: 14px; right: 12px;
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--ann-error); box-shadow: 0 0 6px color-mix(in srgb, var(--ann-error) 60%, transparent);
    }
    .ann-item-title {
        font-size: 13px; font-weight: 600; color: var(--t1, #fff);
        margin-bottom: 5px; padding-right: 18px;
        overflow-wrap: anywhere; line-height: 1.4;
    }
    .ann-item-content {
        font-size: 12px; color: color-mix(in srgb, var(--t1, #fff) 75%, transparent);
        line-height: 1.55; white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
    .ann-item-meta {
        font-size: 10px; color: var(--t2, #777);
        margin-top: 7px; display: flex; gap: 8px; align-items: center;
    }
    .ann-pin-badge {
        font-size: 9px; padding: 1px 6px; border-radius: 3px;
        background: color-mix(in srgb, var(--ann-warn) 22%, transparent);
        color: var(--ann-warn);
        font-weight: 600; letter-spacing: 0.4px;
    }
    .ann-panel-foot {
        padding: 12px 16px;
        border-top: 1px solid var(--border, rgba(255,255,255,0.08));
        flex-shrink: 0;
    }
    .ann-mark-all {
        width: 100%; padding: 8px;
        background: color-mix(in srgb, currentColor 6%, transparent);
        color: var(--t2, #ccc);
        border: 1px solid var(--border, rgba(255,255,255,0.12));
        border-radius: 6px; cursor: pointer;
        font-size: 12px; font-family: inherit;
        transition: all .15s;
    }
    .ann-mark-all:hover:not(:disabled) {
        background: color-mix(in srgb, currentColor 12%, transparent);
        color: var(--t1, #fff);
    }
    .ann-mark-all:disabled { opacity: 0.4; cursor: default; }

    /* ── Modal (居中弹窗) ── */
    .ann-modal-overlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.42);
        display: none; align-items: center; justify-content: center;
        z-index: 10012; backdrop-filter: blur(4px);
        opacity: 0; transition: opacity .2s;
    }
    .ann-modal-overlay.show { display: flex; opacity: 1; }
    .ann-modal {
        background: var(--bg, #1c1f26);
        color: var(--t1, #e6e6e6);
        border: 1px solid var(--border, rgba(255,255,255,0.1));
        border-radius: 12px; padding: 0;
        max-width: 480px; width: 90%;
        max-height: 80vh; overflow: hidden;
        display: flex; flex-direction: column;
        box-shadow: 0 16px 64px rgba(0,0,0,0.32);
        transform: scale(0.96); transition: transform .2s cubic-bezier(0.16, 1, 0.3, 1);
        border-top: 3px solid var(--ann-info);
    }
    .ann-modal-overlay.show .ann-modal { transform: scale(1); }
    .ann-modal.type-success { border-top-color: var(--ann-success); }
    .ann-modal.type-warn    { border-top-color: var(--ann-warn); }
    .ann-modal.type-error   { border-top-color: var(--ann-error); }
    .ann-modal-head {
        padding: 18px 24px 12px;
        display: flex; align-items: flex-start; justify-content: space-between;
        gap: 16px;
    }
    .ann-modal-title { font-size: 17px; font-weight: 600; color: var(--t1, #fff);
                       line-height: 1.4; overflow-wrap: anywhere; }
    .ann-modal-close {
        background: none; border: none; color: var(--t2, #888);
        font-size: 26px; cursor: pointer; padding: 0 4px;
        line-height: 1; flex-shrink: 0;
    }
    .ann-modal-close:hover { color: var(--t1, #fff); }
    .ann-modal-body {
        padding: 8px 24px 16px;
        font-size: 14px; color: color-mix(in srgb, var(--t1, #fff) 78%, transparent);
        line-height: 1.6;
        white-space: pre-wrap; overflow-wrap: anywhere;
        overflow-y: auto;
    }
    .ann-modal-foot {
        padding: 12px 24px 18px;
        text-align: right;
    }
    .ann-modal-btn {
        padding: 8px 22px; border-radius: 8px;
        background: var(--ann-info); color: #fff;
        border: none; cursor: pointer; font-family: inherit;
        font-size: 13px; font-weight: 600;
        transition: opacity .15s;
    }
    .ann-modal-btn:hover { opacity: 0.88; }

    /* ── Banner (顶部横幅) ── */
    .ann-banner-stack {
        position: fixed; top: 0; left: 0; right: 0;
        z-index: 10008; pointer-events: none;
    }
    .ann-banner {
        pointer-events: auto;
        background: var(--panel, rgba(28,31,38,0.96));
        color: var(--t1, #e6e6e6);
        border-bottom: 1px solid var(--border, rgba(255,255,255,0.1));
        backdrop-filter: blur(10px);
        padding: 10px 20px;
        display: flex; align-items: center; gap: 14px;
        font-size: 13px;
        border-left: 3px solid var(--ann-info);
        animation: ann-slide-down .25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .ann-banner.type-success { border-left-color: var(--ann-success); }
    .ann-banner.type-warn    { border-left-color: var(--ann-warn);
                               background: color-mix(in srgb, var(--ann-warn) 16%, var(--panel, rgba(28,31,38,0.96))); }
    .ann-banner.type-error   { border-left-color: var(--ann-error);
                               background: color-mix(in srgb, var(--ann-error) 16%, var(--panel, rgba(28,31,38,0.96))); }
    @keyframes ann-slide-down {
        from { transform: translateY(-100%); opacity: 0; }
        to   { transform: translateY(0);     opacity: 1; }
    }
    .ann-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .ann-banner-title { font-weight: 600; color: var(--t1, #fff); }
    .ann-banner-sep { opacity: 0.4; margin: 0 6px; }
    .ann-banner-close {
        background: none; border: none; color: var(--t2, #999);
        font-size: 20px; cursor: pointer; line-height: 1;
        padding: 0 6px; flex-shrink: 0;
    }
    .ann-banner-close:hover { color: var(--t1, #fff); }

    /* ── Toast (右上角浮动) ── */
    .ann-toast-stack {
        position: fixed; top: 16px; right: 16px;
        z-index: 10013; display: flex; flex-direction: column;
        gap: 10px; max-width: 340px;
    }
    .ann-toast {
        background: var(--panel, rgba(20,22,28,0.96));
        color: var(--t1, #e6e6e6);
        border: 1px solid var(--border, rgba(255,255,255,0.1));
        border-left: 3px solid var(--ann-info);
        border-radius: 8px; padding: 12px 14px;
        backdrop-filter: blur(12px);
        box-shadow: 0 8px 24px rgba(0,0,0,0.22);
        animation: ann-slide-in-right .28s cubic-bezier(0.16, 1, 0.3, 1);
        font-size: 13px; cursor: default;
        position: relative; overflow: hidden;
    }
    .ann-toast.dismiss { animation: ann-slide-out-right .25s cubic-bezier(0.65, 0, 0.35, 1) forwards; }
    .ann-toast.type-success { border-left-color: var(--ann-success); }
    .ann-toast.type-warn    { border-left-color: var(--ann-warn); }
    .ann-toast.type-error   { border-left-color: var(--ann-error); }
    @keyframes ann-slide-in-right {
        from { transform: translateX(110%); opacity: 0; }
        to   { transform: translateX(0);     opacity: 1; }
    }
    @keyframes ann-slide-out-right {
        from { transform: translateX(0);     opacity: 1; }
        to   { transform: translateX(110%); opacity: 0; }
    }
    .ann-toast-title { font-weight: 600; color: var(--t1, #fff); margin-bottom: 4px; }
    .ann-toast-content { color: color-mix(in srgb, var(--t1, #fff) 75%, transparent); line-height: 1.5; font-size: 12px; }
    .ann-toast-progress {
        position: absolute; bottom: 0; left: 0;
        height: 2px; background: color-mix(in srgb, var(--ann-info) 60%, transparent);
        animation: ann-toast-bar ${TOAST_AUTO_DISMISS_MS}ms linear forwards;
    }
    @keyframes ann-toast-bar { from { width: 100%; } to { width: 0%; } }
    `;
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-ann', '1');
    styleEl.textContent = STYLE;
    document.head.appendChild(styleEl);

    // ── 空态 SVG ────────────────────────────────────────────
    const ICON_LOADING = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
        </svg>`;
    const ICON_EMPTY = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 12h-6l-2 3h-4l-2-3H2"></path>
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
        </svg>`;

    // ── 注入 DOM ────────────────────────────────────────────
    // Fab + Panel (所有公告进面板, 始终存在)
    const fab = document.createElement('div');
    fab.className = 'ann-fab';
    fab.setAttribute('aria-label', '公告');
    fab.title = '公告';
    fab.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        <span class="ann-fab-badge"></span>
    `;
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.className = 'ann-panel';
    panel.innerHTML = `
        <div class="ann-panel-head">
            <div class="ann-panel-title">公告</div>
            <button class="ann-panel-close" aria-label="关闭">×</button>
        </div>
        <div class="ann-panel-body">
            <div class="ann-empty"><div class="ann-empty-icon loading">${ICON_LOADING}</div>加载中...</div>
        </div>
        <div class="ann-panel-foot">
            <button class="ann-mark-all" disabled>全部标记已读</button>
        </div>
    `;
    document.body.appendChild(panel);

    // Banner stack + Toast stack (按需创建)
    const bannerStack = document.createElement('div');
    bannerStack.className = 'ann-banner-stack';
    document.body.appendChild(bannerStack);

    const toastStack = document.createElement('div');
    toastStack.className = 'ann-toast-stack';
    document.body.appendChild(toastStack);

    // Modal overlay (按需 show/hide)
    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'ann-modal-overlay';
    document.body.appendChild(modalOverlay);

    const badge      = fab.querySelector('.ann-fab-badge');
    const bodyEl     = panel.querySelector('.ann-panel-body');
    const closeBtn   = panel.querySelector('.ann-panel-close');
    const markAllBtn = panel.querySelector('.ann-mark-all');

    // ── 状态 ────────────────────────────────────────────────
    let _list = [];
    let _readIds        = loadSet(STORAGE_READ_KEY);
    let _seenModalIds   = loadSet(STORAGE_MODAL_KEY);
    let _dismissedBanners = loadSet(STORAGE_BANNER_KEY);
    let _shownToastIds  = loadSet(STORAGE_TOAST_KEY);
    let _modalQueue = [];   // 待弹的 modal 列表

    // ── Panel ────────────────────────────────────────────
    function unreadCount() {
        return _list.filter(a => !_readIds.has(a.id)).length;
    }
    function updateBadge() {
        const n = unreadCount();
        if (n > 0) {
            badge.classList.add('show');
            badge.textContent = n > 99 ? '99+' : String(n);
        } else {
            badge.classList.remove('show');
            badge.textContent = '';
        }
    }
    function renderPanel() {
        if (_list.length === 0) {
            bodyEl.innerHTML = '<div class="ann-empty"><div class="ann-empty-icon">' + ICON_EMPTY + '</div>暂无公告</div>';
            markAllBtn.disabled = true;
            return;
        }
        bodyEl.innerHTML = _list.map(a => {
            const unread = !_readIds.has(a.id);
            return `
                <div class="ann-item type-${esc(a.type || 'info')} ${unread ? 'unread' : ''} ${a.pinned ? 'pinned' : ''}" data-id="${esc(a.id)}">
                    ${a.title ? '<div class="ann-item-title">' + esc(a.title) + '</div>' : ''}
                    ${a.content ? '<div class="ann-item-content">' + esc(a.content) + '</div>' : ''}
                    <div class="ann-item-meta">
                        ${a.pinned ? '<span class="ann-pin-badge">置顶</span>' : ''}
                        <span>${fmtTime(a.updatedAt)}</span>
                    </div>
                </div>
            `;
        }).join('');
        markAllBtn.disabled = unreadCount() === 0;
    }
    function markRead(id) {
        if (!_readIds.has(id)) {
            _readIds.add(id);
            saveSet(STORAGE_READ_KEY, _readIds);
            const card = bodyEl.querySelector('.ann-item[data-id="' + CSS.escape(id) + '"]');
            if (card) card.classList.remove('unread');
            markAllBtn.disabled = unreadCount() === 0;
            updateBadge();
        }
    }
    function markAllRead() {
        for (const a of _list) _readIds.add(a.id);
        saveSet(STORAGE_READ_KEY, _readIds);
        renderPanel();
        updateBadge();
    }
    function openPanel()  { panel.classList.add('show'); renderPanel(); }
    function closePanel() { panel.classList.remove('show'); }

    // ── Modal ────────────────────────────────────────────
    function showModal(a) {
        modalOverlay.innerHTML = `
            <div class="ann-modal type-${esc(a.type || 'info')}">
                <div class="ann-modal-head">
                    <div class="ann-modal-title">${esc(a.title) || '公告'}</div>
                    <button class="ann-modal-close" aria-label="关闭">×</button>
                </div>
                ${a.content ? '<div class="ann-modal-body">' + esc(a.content) + '</div>' : ''}
                <div class="ann-modal-foot">
                    <button class="ann-modal-btn">我知道了</button>
                </div>
            </div>
        `;
        modalOverlay.classList.add('show');
        const closeModal = () => {
            modalOverlay.classList.remove('show');
            _seenModalIds.add(a.id);
            saveSet(STORAGE_MODAL_KEY, _seenModalIds);
            markRead(a.id);
            setTimeout(processModalQueue, 350);  // 等动画结束再处理下一条
        };
        modalOverlay.querySelector('.ann-modal-close').onclick = closeModal;
        modalOverlay.querySelector('.ann-modal-btn').onclick = closeModal;
        modalOverlay.onclick = (e) => { if (e.target === modalOverlay) closeModal(); };
    }
    function processModalQueue() {
        if (_modalQueue.length === 0 || modalOverlay.classList.contains('show')) return;
        const next = _modalQueue.shift();
        showModal(next);
    }
    function enqueueModals() {
        for (const a of _list) {
            if (a.displayMode !== 'modal') continue;
            if (_seenModalIds.has(a.id)) continue;
            if (_modalQueue.find(x => x.id === a.id)) continue;
            _modalQueue.push(a);
        }
        processModalQueue();
    }

    // ── Banner ────────────────────────────────────────────
    function renderBanners() {
        const wanted = _list.filter(a =>
            a.displayMode === 'banner' && !_dismissedBanners.has(a.id)
        );
        // 现有 banner DOM map by id
        const existing = new Map();
        bannerStack.querySelectorAll('.ann-banner[data-id]').forEach(el =>
            existing.set(el.dataset.id, el));

        // 删除已不该显示的
        for (const [id, el] of existing) {
            if (!wanted.find(a => a.id === id)) el.remove();
        }
        // 添加新出现的
        for (const a of wanted) {
            if (existing.has(a.id)) continue;
            const div = document.createElement('div');
            div.className = 'ann-banner type-' + esc(a.type || 'info');
            div.dataset.id = a.id;
            div.innerHTML = `
                <div class="ann-banner-text">
                    ${a.title ? '<span class="ann-banner-title">' + esc(a.title) + '</span>' : ''}
                    ${a.title && a.content ? '<span class="ann-banner-sep">·</span>' : ''}
                    ${a.content ? esc(a.content) : ''}
                </div>
                <button class="ann-banner-close" aria-label="关闭">×</button>
            `;
            div.querySelector('.ann-banner-close').onclick = () => {
                _dismissedBanners.add(a.id);
                saveSet(STORAGE_BANNER_KEY, _dismissedBanners);
                markRead(a.id);
                div.remove();
            };
            bannerStack.appendChild(div);
        }
    }

    // ── Toast ────────────────────────────────────────────
    function showToast(a) {
        const div = document.createElement('div');
        div.className = 'ann-toast type-' + esc(a.type || 'info');
        div.dataset.id = a.id;
        div.innerHTML = `
            ${a.title ? '<div class="ann-toast-title">' + esc(a.title) + '</div>' : ''}
            ${a.content ? '<div class="ann-toast-content">' + esc(a.content) + '</div>' : ''}
            <div class="ann-toast-progress"></div>
        `;
        toastStack.appendChild(div);
        const dismiss = () => {
            if (div.classList.contains('dismiss')) return;
            div.classList.add('dismiss');
            setTimeout(() => div.remove(), 300);
        };
        div.onclick = dismiss;
        setTimeout(dismiss, TOAST_AUTO_DISMISS_MS);
        _shownToastIds.add(a.id);
        saveSet(STORAGE_TOAST_KEY, _shownToastIds);
        markRead(a.id);
    }
    function enqueueToasts() {
        let delay = 0;
        for (const a of _list) {
            if (a.displayMode !== 'toast') continue;
            if (_shownToastIds.has(a.id)) continue;
            setTimeout(() => showToast(a), delay);
            delay += 350;  // 错开 350ms 显示, 视觉不堆叠
        }
    }

    // ── fetch ────────────────────────────────────────────
    async function fetchList() {
        if (document.hidden) return;  // 后台标签页暂停轮询，省请求与带宽
        try {
            const res = await fetch(API_URL, { mode: 'cors', cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (!data.ok || !Array.isArray(data.list)) return;
            _list = data.list;

            // 清理 localStorage 里已被删除的公告 ID
            const valid = new Set(_list.map(a => a.id));
            [_readIds, _seenModalIds, _dismissedBanners, _shownToastIds].forEach((set, idx) => {
                const keys = [STORAGE_READ_KEY, STORAGE_MODAL_KEY, STORAGE_BANNER_KEY, STORAGE_TOAST_KEY];
                let changed = false;
                for (const id of [...set]) {
                    if (!valid.has(id)) { set.delete(id); changed = true; }
                }
                if (changed) saveSet(keys[idx], set);
            });

            // panel: 始终所有公告
            if (panel.classList.contains('show')) renderPanel();
            updateBadge();

            // banner: 持续显示直到关闭
            renderBanners();

            // modal / toast: 一次性弹窗（已弹过的不再弹）
            enqueueModals();
            enqueueToasts();
        } catch (e) { /* 静默 */ }
    }

    // ── 事件绑定 ────────────────────────────────────────────
    fab.addEventListener('click', (e) => {
        e.stopPropagation();
        if (panel.classList.contains('show')) closePanel();
        else openPanel();
    });
    closeBtn.addEventListener('click', closePanel);
    panel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
        if (panel.classList.contains('show')) closePanel();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (modalOverlay.classList.contains('show')) modalOverlay.querySelector('.ann-modal-close')?.click();
            else if (panel.classList.contains('show')) closePanel();
        }
    });
    markAllBtn.addEventListener('click', markAllRead);
    bodyEl.addEventListener('click', (e) => {
        const card = e.target.closest('.ann-item');
        if (card && card.dataset.id) markRead(card.dataset.id);
    });

    // ── 启动 ────────────────────────────────────────────────
    fetchList();
    setInterval(fetchList, POLL_INTERVAL_MS);
    // 标签页切回前台立即拉一次（补上后台期间被跳过的更新）
    document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchList(); });
})();
