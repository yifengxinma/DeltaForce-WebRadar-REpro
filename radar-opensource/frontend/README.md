# Radar 前端源码

包含白色主题 `white/`、黑色主题 `black/` 和共用脚本来源 `shared/`。
页面使用 HTML、CSS、原生 JavaScript 与随附的 Leaflet 1.7.1，无需安装依赖或编译。

## 本地查看

在仓库根目录运行 `python -m http.server`，然后通过该静态服务打开 `/white/` 或 `/black/`。
目录根必须包含 `config.js`。房间参数为 `?key=自定义房间号`。
`white/landing.html` 和 `white/map.html` 是额外入口。

## 对接服务与资源

编辑根目录 `config.js`：

- `apiBase`：HTTP API 基址，留空时使用当前站点根路径 `/api/`。
- `relayUrl`：中继 WebSocket 地址，留空时使用当前站点 `/ws`，并跟随页面自动选择 WS 或 WSS。
- `localUrl`：直连数据源的 WebSocket 地址，留空时使用中继地址。
- `tileBase`：地图瓦片根目录，目录结构为 `{layer}/{z}_{x}_{y}.jpg`，部分地图使用 `.png`。
- `itemIconBase`：物品图标根目录，文件名为 `{itemId}.png`。
- `markerIconBase`：标记图标根目录，文件名为 `bxx.png`、`xbxx.png`、`dtcld.png`、`cgcld.png`。
- `noCorsImageHosts`：需要直接使用 Image 加载的资源主机列表，默认空数组。

资源地址默认留空；未配置时显示坐标、区域和标记回退，不会请求原有图片服务。
仓库只包含前端代码和静态名称/品质字典。后端、中继服务、地图瓦片和第三方图片资源需自行提供。
同源部署可将 `/api/` 与 `/ws` 代理至自己的服务；跨源部署需配置对应 CORS。
浏览器保存的后台回放令牌只发送给同源接口。

## 目录说明

- `white/`、`black/`：可直接访问的主题，各自保留完整脚本和样式。
- `shared/`：共用脚本参考；主题中的现有差异已保留，不自动覆盖同步。
- `config.js`：不含任何实际部署地址的前端配置。
- `favicon.svg`：本地通用图标。

第三方代码说明见 `THIRD_PARTY_NOTICES.md`。
