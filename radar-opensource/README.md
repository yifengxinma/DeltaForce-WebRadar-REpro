# Radar

原生 JavaScript 的白/黑双主题雷达前端、管理后台与 WebSocket/UDP 中继。

## 目录

- `frontend/`：白色、黑色主题及共用脚本，资源与服务地址在 `frontend/config.js` 中配置。
- `backend/`：管理页面、PostgreSQL 数据层、WebSocket/UDP 中继、录制与回放。
- `serve_frontend.js`：前端静态服务、主题路由及同源 API/WebSocket 网关。
- `backend/assets/`：无损 WebP 背景、通用 SVG 图标和本地 ECharts 5.4.3。
- `third-party/`：随附第三方代码的许可证与通知。
- `tools/simulate_pub.js`：调试用推流模拟器（没有 DLL 时向房间灌假数据）。

## 启动

需要 Node.js 20 或更新版本，以及自己创建的 PostgreSQL 数据库和账号。

1. 安装已有依赖：`npm --prefix backend ci`。
2. 复制 `backend/.env.example` 为 `backend/.env`，填写下列四项。程序不提供默认账号、密码或数据库口令。
3. 启动后台：`npm --prefix backend start`。
4. 在另一个终端启动前端：`node serve_frontend.js`。

| 配置项 | 用途 |
| --- | --- |
| `ADMIN_USER` | 自定义管理员账号 |
| `ADMIN_PASS` | 首次启动的管理员密码，至少 12 个字符 |
| `ROOMS_SECRET` | 房间名单更新接口密钥，至少 32 个字符 |
| `PG_CONN` | 自己的 PostgreSQL 连接字符串 |

初次启动会创建表和本地数据目录，将管理员密码保存为带盐 scrypt 哈希。已有管理员凭据时以本地凭据文件为准，修改密码可使用后台界面。

默认前端端口 8080，后台端口 9090，中继在 TCP/WebSocket 与 UDP 共用端口 5000。网页 `/` 跟随当前主题；`/_white/`、`/_black/`、`/white/`、`/black/` 可访问指定主题。
前端 `/api/`、`/ws` 自动转发至本机后台与中继，默认不需要在前端填写服务器地址。
服务默认只在本机提供 HTTP 访问；公开部署时通过自己的反向代理访问，或配置 `FRONTEND_BIND`、`ADMIN_BIND`。代理后按自己的网络拓扑设置 `TRUST_PROXY`。

地图瓦片与物品图标的资源地址在 `frontend/config.js` 中配置：默认指向官方公开资源（开箱即有地图），也可改为自建图床目录，或全部留空退化为坐标/区域/标记渲染。资源结构与配置见 `frontend/README.md`。仓库不随包提供第三方地图图片或游戏数据源。

## 调试推流

没有游戏 DLL 时，用 `tools/simulate_pub.js` 向房间推送与真实 DLL 同格式的假数据：

```bash
node tools/simulate_pub.js --key 8888 --map daba --rate 10 --count 6
node tools/simulate_pub.js --map list
```

随后打开 `http://127.0.0.1:8080/black/?key=8888` 即可看到移动的玩家、物品与撤离点。

## 后台与状态

管理页包含总览、历史图表、主题、公告、安全、白名单、隐私、回放与账号设置。图表库从包内加载，不从第三方 CDN 加载脚本。
实际配置、登录会话、账号哈希、日志、数据库和录制文件均不属于源码发布内容，已通过 `.gitignore` 排除。
默认不自动创建示例业务房间；可在后台录入自己的房间，并按需要启用发布白名单。
修改 HTTP 监听端口后需重启相应服务。后台的 Nginx 自动端口配置只有显式设置 `NGINX_SITE_FILE` 且授予对应系统权限时才会使用，默认不写系统 Nginx 文件。

## 背景资源

深浅两张背景保留 3840 × 2160 分辨率及全部 RGBA 像素，使用无损 WebP 编码。深色约 5.74 MB，浅色约 4.50 MB；两张合计比原 PNG 减少约 54%。

第三方代码署名与许可证见 `THIRD_PARTY_NOTICES.md`。
