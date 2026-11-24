/* 前端部署配置：空地址使用当前站点，资源地址留空时不加载外部图片。 */
(function () {
  'use strict';
  const config = Object.freeze({
    apiBase: '',
    relayUrl: '',
    localUrl: '',
    tileBase: '',
    itemIconBase: '',
    markerIconBase: '',
    noCorsImageHosts: [],
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
