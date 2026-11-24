/* brand-fix.js - 0 闪烁恢复 title + favicon
 *
 * 抽出动机:
 *   原本是 HTML <head> 里的 inline <script>...</script>, CSP 强制 script-src 'unsafe-inline'
 *   现在抽成独立文件后, CSP 可以收紧 script-src 'self' (再 +'self' 同源 + 必要 CDN)
 *   inline 模式下 XSS 防御只剩输入净化一道线, 外部文件让浏览器走严格的 origin 校验
 *
 * 加载位置: <head> 顶部, defer/async 都不要, 必须同步执行
 *   (用户上次刷的 title/favicon 在 localStorage, 立刻应用避免 FOUC)
 */
(function () {
  try {
    var theme = location.pathname.indexOf('/_black/') === 0 ? 'black'
              : location.pathname.indexOf('/_white/') === 0 ? 'white'
              : (localStorage.getItem('admin_current_theme') || 'main');
    var t = localStorage.getItem('admin_brand_title_' + theme);
    var i = localStorage.getItem('admin_brand_icon_' + theme);
    if (t) document.title = t;
    if (i) {
      var L = document.createElement('link');
      L.rel = 'icon';
      if (new URL(i, location.href).origin !== location.origin) i = '../favicon.svg';
      L.href = i;
      document.head.appendChild(L);
    }
  } catch (e) {}
})();
