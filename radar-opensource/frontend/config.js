/* 前端部署配置。
 * - 服务地址留空时使用当前站点同源（/api/、/ws）。
 * - 地图瓦片与图标默认指向官方公开资源，使其开箱可见；
 *   若改为自建图床，只需把下面三项替换为你的地址，或全部留空（则只显示坐标/标记回退）。
 */
(function () {
  'use strict';
  const config = Object.freeze({
    apiBase: '',
    relayUrl: '',
    localUrl: '',

    // 地图瓦片：{tileBase}{layer}/{z}_{x}_{y}.jpg（爆破图 png，见 mapConfig.js 的 tileExt）
    tileBase: 'https://game.gtimg.cn/images/dfm/cp/a20240729directory/img/',
    // 物品图标：{itemIconBase}{itemId}.png
    itemIconBase: 'https://playerhub.df.qq.com/playerhub/60004/object/',
    // 标记图标：{markerIconBase}bxx.png / xbxx.png / dtcld.png / cgcld.png
    markerIconBase: 'https://game.gtimg.cn/images/dfm/cp/a20240729directory/img/lv3/',

    // 这些主机不返回 CORS 头，跳过 fetch 直接用 Image 加载，避免控制台报错
    noCorsImageHosts: ['game.gtimg.cn', 'playerhub.df.qq.com'],
  });
  function socketUrl(value) {
    const url = new URL(value || '/ws', window.location.href);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    return url.href;
  }
  window.RADAR_CONFIG = config;
  window.RadarEndpoints = Object.freeze({
    api(path) { return config.apiBase.replace(/\/$/, '') + path; },
    relay() { return socketUrl(config.relayUrl); },
    local(host, port) {
      if (!host) return socketUrl(config.localUrl || config.relayUrl);
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return socketUrl(protocol + '//' + host + (port ? ':' + port : ''));
    },
    asset(base, file) { return base ? base.replace(/\/?$/, '/') + file : ''; },
  });
})();
