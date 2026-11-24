// admin-events.js — CSP-safe UI bindings (no inline onclick/oninput/onchange)
(function () {
  const OVERLAY_CLOSE = {
    annModal: () => closeAnnModal(),
    changePassModal: () => closeChangePass(),
    changeAccountModal: () => closeChangeAccount(),
    historyModal: () => closeHistory(),
    roomHistModal: () => closeRoomHist(),
    shareModal: () => closeShareModal(),
    importModal: () => closeImportModal(),
  };

  const NUMERIC_ACTIONS = new Set(['clearHistKeep']);

  function callAction(name, arg, arg2) {
    const fn = window[name];
    if (typeof fn !== 'function') return;
    const args = [];
    if (arg !== undefined && arg !== '') {
      args.push(NUMERIC_ACTIONS.has(name) ? Number(arg) : arg);
    }
    if (arg2 !== undefined && arg2 !== '') args.push(arg2);
    fn(...args);
  }

  function handleClick(e) {
    const t = e.target;

    const overlay = t.closest('.modal-overlay');
    if (overlay && t === overlay && OVERLAY_CLOSE[overlay.id]) {
      OVERLAY_CLOSE[overlay.id]();
      return;
    }

    const nav = t.closest('.app-nav-item[data-view]');
    if (nav) { switchView(nav.dataset.view); return; }

    const typeOpt = t.closest('.ann-type-opt[data-type]');
    if (typeOpt) { setAnnType(typeOpt.dataset.type); return; }

    const dispOpt = t.closest('.ann-display-opt[data-display]');
    if (dispOpt) { setAnnDisplay(dispOpt.dataset.display); return; }

    const langBtn = t.closest('button[data-lang]');
    if (langBtn) { setLang(langBtn.dataset.lang); return; }

    const tab = t.closest('.tab[data-tab]');
    if (tab) { switchTab(tab.dataset.tab); return; }

    const histSeg = t.closest('.hist-seg-btn[data-value]');
    if (histSeg) {
      const group = histSeg.closest('.hist-seg');
      if (group) {
        group.querySelectorAll('.hist-seg-btn').forEach(b => b.classList.toggle('active', b === histSeg));
        const map = { metric: 'histMetric', type: 'histType', range: 'histRange' };
        const inputId = map[group.dataset.hist];
        const input = inputId ? document.getElementById(inputId) : null;
        if (input) input.value = histSeg.dataset.value;
        if (typeof renderHistChart === 'function') renderHistChart();
      }
      return;
    }

    if (t.closest('.stat-card.clickable')) { showHistory(); return; }

    const annAct = t.closest('.ann-act[data-ann-act]');
    if (annAct) {
      const id = annAct.dataset.id || '';
      if (annAct.dataset.annAct === 'toggle') toggleAnnEnabled(id);
      else if (annAct.dataset.annAct === 'edit') openAnnEdit(id);
      else if (annAct.dataset.annAct === 'delete') deleteAnn(id);
      return;
    }

    const trigger = t.closest('[data-admin-trigger]');
    if (trigger) {
      document.getElementById(trigger.dataset.adminTrigger)?.click();
      return;
    }

    const act = t.closest('[data-admin-action]');
    if (act) {
      if (act.dataset.adminPassEvent === '1') {
        toggleUserMenu(e);
        return;
      }
      if (act.dataset.adminAction === 'clearIconDirty') {
        clearIcon(act.dataset.adminArg);
        onSettingsDirty(act.dataset.adminArg);
        return;
      }
      callAction(act.dataset.adminAction, act.dataset.adminArg, act.dataset.adminArg2);
    }
  }

  function handleChange(e) {
    const id = e.target.id;
    if (id === 'histMetric' || id === 'histType' || id === 'histRange') renderHistChart();
    else if (id === 'filterDLL' || id === 'filterGame') onRoomFilter();
    else if (id === 'filterBanSrc') onBanFilter();
    else if (id === 'iconFileWhite') onIconFileSelect('white');
    else if (id === 'iconFileBlack') onIconFileSelect('black');
    else if (id === 'recDurationFilter' || id === 'recPerPage') { if (typeof _renderRecPage === 'function') { _recPage = 0; _renderRecPage(); } }
    else if (id === 'roomsPerPage') { if (typeof onRoomFilter === 'function') { roomPage = 0; onRoomFilter(); } }
    else if (id === 'bansPerPage') { if (typeof onBanFilter === 'function') { banPage = 0; onBanFilter(); } }
    else if (id === 'roomEvtPerPage') { if (typeof loadRoomEvents === 'function') { _roomEvtPage = 0; loadRoomEvents(); } }
    else if (id === 'banEvtPerPage') { if (typeof loadBanEvents === 'function') { _banEvtPage = 0; loadBanEvents(); } }
  }

  function handleInput(e) {
    const id = e.target.id;
    if (id === 'searchInput') onRoomFilter();
    else if (id === 'banSearchInput') onBanFilter();
    else if (id === 'annSearch') renderAnnList();
    else if (id === 'titleInputWhite') onSettingsDirty('white');
    else if (id === 'titleInputBlack') onSettingsDirty('black');
    else if (id === 'iconInputWhite') { onIconUrlInput('white'); onSettingsDirty('white'); }
    else if (id === 'iconInputBlack') { onIconUrlInput('black'); onSettingsDirty('black'); }
    else if (id.startsWith('landing') && id.endsWith('White')) onSettingsDirty('white');
    else if (id.startsWith('landing') && id.endsWith('Black')) onSettingsDirty('black');
    else if (id === 'frontendPortInput') updateFrontendAccessPreview();
    else if (id === 'recSearchInput') { if (typeof _renderRecPage === 'function') { _recPage = 0; _renderRecPage(); } }
    else if (id === 'roomEvtSearch') { if (typeof loadRoomEvents === 'function') { _roomEvtPage = 0; loadRoomEvents(); } }
    else if (id === 'banEvtSearch') { if (typeof loadBanEvents === 'function') { _banEvtPage = 0; loadBanEvents(); } }
  }

  document.addEventListener('click', handleClick);
  document.addEventListener('change', handleChange);
  document.addEventListener('input', handleInput);

  document.getElementById('loginForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    doLogin();
  });

  document.getElementById('whitelistAddInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addWhitelistRoom(); }
  });
})();
