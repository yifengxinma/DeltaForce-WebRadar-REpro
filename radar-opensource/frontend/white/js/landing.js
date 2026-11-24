
    // 多语言字典
    const i18n = {
      en: {
        title: "Holo Tactical Radar",
        desc: "Connect to encrypted channel, sync battlefield status",
        placeholder: "Enter Room ID",
        btn: "Establish Connection",
        hint: "End-to-end encrypted communication",
        errEmpty: "Please enter a valid Room ID",
        errInvalid: "Invalid room, please let the host enter the game!",
        errTimeout: "Connection timeout, please retry",
        errNetwork: "Unable to connect to server"
      },
      zh: {
        title: "全息战术雷达",
        desc: "接入加密频道，实时同步战场态势",
        placeholder: "请输入房间号",
        btn: "建立安全连接",
        hint: "终端通信已采用端到端加密",
        errEmpty: "请输入有效房间号",
        errInvalid: "当前房间无效,请让主端进入游戏！",
        errTimeout: "连接超时，请稍后重试",
        errNetwork: "无法连接服务器"
      }
    };

    let currentLang = 'en';
    const input = document.getElementById('landingKey');
    const btn = document.getElementById('landingBtn');
    const card = document.getElementById('landingCard');
    const errorMsg = document.getElementById('errorMsg');
    const circle = document.getElementById('transitionCircle');
    const bgContainer = document.getElementById('bgContainer');
    const overlay = document.getElementById('landingOverlay');
    const langSwitch = document.getElementById('langSwitch');

    // 初始化：根据浏览器语言设置
    (function init() {
      const browserLang = navigator.language || navigator.userLanguage;
      if (browserLang.startsWith('zh')) setLang('zh');
      else setLang('en');
      
      // 自动填充上次房间号
      try {
        const saved = localStorage.getItem('lastRoomKey');
        if (saved) input.value = saved;
      } catch(e) {}
      
      setTimeout(() => input.focus(), 100);
    })();

    function setLang(lang) {
      currentLang = lang;
      document.getElementById('btnEn').classList.toggle('active', lang === 'en');
      document.getElementById('btnZh').classList.toggle('active', lang === 'zh');
      
      document.getElementById('tTitle').innerText = i18n[lang].title;
      document.getElementById('tDesc').innerText = i18n[lang].desc;
      input.placeholder = i18n[lang].placeholder;
      document.getElementById('tBtn').innerText = i18n[lang].btn;
      document.getElementById('tHint').innerText = i18n[lang].hint;
    }

    function showError(key) {
      errorMsg.innerText = i18n[currentLang][key];
      errorMsg.style.opacity = '1';
      btn.classList.remove('btn-loading');
    }

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') goRadar();
    });

    function goRadar() {
      const key = input.value.trim();
      if (!key) {
        showError('errEmpty');
        input.focus();
        return;
      }
      
      errorMsg.style.opacity = '0';
      btn.classList.add('btn-loading');

      // 连接 relay 验证房间
      const checkUrl = RadarEndpoints.relay();
      const checkWs = new WebSocket(checkUrl);
      
      const timeout = setTimeout(() => {
        checkWs.close();
        showError('errTimeout');
      }, 5000);

      checkWs.onopen = () => {
        checkWs.send(JSON.stringify({ action: 'auth', role: 'check', key: key }));
      };

      checkWs.onmessage = (e) => {
        clearTimeout(timeout);
        try {
          const msg = JSON.parse(e.data);
          checkWs.close();
          if (msg.ok && msg.pub) {
            // 验证通过，保存房间号，播放转场动画
            try { localStorage.setItem('lastRoomKey', key); } catch(e) {}
            playTransition(key);
          } else {
            showError('errInvalid');
          }
        } catch (ex) {
          showError('errInvalid');
        }
      };

      checkWs.onerror = () => {
        clearTimeout(timeout);
        showError('errNetwork');
      };
    }

    function playTransition(key) {
      // 1. 卡片消失
      card.classList.add('card-exit');
      langSwitch.style.opacity = '0';
      langSwitch.style.transition = 'opacity 0.3s';
      
      // 2. 白圈爆发
      setTimeout(() => {
        circle.classList.add('circle-expand');
        bgContainer.style.opacity = '0';
        bgContainer.style.transition = 'opacity 0.3s';
        
        // 3. 跳转到地图页
        setTimeout(() => {
          window.location.href = 'index.html?key=' + encodeURIComponent(key);
        }, 600);
      }, 400);
    }

    document.getElementById('btnEn').addEventListener('click', () => setLang('en'));
    document.getElementById('btnZh').addEventListener('click', () => setLang('zh'));
    btn.addEventListener('click', goRadar);

    (async function() {
      try {
        const r = await fetch(RadarEndpoints.api('/api/theme_names'), { mode: 'cors', cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (!d.ok || !d.landing || !d.landing.white) return;
        const lt = d.landing.white;
        if (lt.zh) { if (lt.zh.title) i18n.zh.title = lt.zh.title; if (lt.zh.desc) i18n.zh.desc = lt.zh.desc; if (lt.zh.btn) i18n.zh.btn = lt.zh.btn; if (lt.zh.hint) i18n.zh.hint = lt.zh.hint; }
        if (lt.en) { if (lt.en.title) i18n.en.title = lt.en.title; if (lt.en.desc) i18n.en.desc = lt.en.desc; if (lt.en.btn) i18n.en.btn = lt.en.btn; if (lt.en.hint) i18n.en.hint = lt.en.hint; }
        setLang(currentLang);
      } catch (e) { /* silent */ }
    })();
  