# 黑色主题版 — Dark Theme

暗色系 UI 风格，地图入口与地图页合并在同一个 `index.html`。

## 后端

```bash
cd radar_backend/radar-relay
cp .env.example .env   # 编辑填入你的密码
npm install
node relay.js          # 或 pm2 start ecosystem.config.js
```

**端口：**
- `5000` — WebSocket Relay（DLL 端和观战端均连此端口）
- `1377` — 管理后台（HTTP）

## 前端

纯静态文件，部署到任意 Web 服务器即可。

```bash
# Nginx 示例
server {
    listen 1010;
    root /path/to/radar_frontend/radar;
    index index.html;
}
```

**使用方式：**
- 直接访问 `http://你的域名:1010/` 输入房间号进入
- 或带参数 `http://你的域名:1010/?key=房间号` 直接进入

## 目录结构

```
radar_backend/radar-relay/
  ├── relay.js             # 主服务（WS 中继 + HTTP 管理 API）
  ├── admin.html           # 管理后台页面
  ├── ecosystem.config.js  # PM2 配置
  ├── .env.example         # 环境变量模板
  └── package.json

radar_frontend/radar/
  ├── index.html           # 入口页 + 地图页
  ├── styles.css
  ├── favicon.ico
  └── js/
      ├── mapConfig.js     # 地图坐标与游戏常量
      ├── mapEngine.js     # Leaflet 初始化与地图切换
      ├── canvasRenderer.js # Canvas 实体绘制
      ├── wsClient.js      # WebSocket 连接管理
      ├── ui.js            # 侧栏/图层/观战 UI
      └── main.js          # 启动入口
```
