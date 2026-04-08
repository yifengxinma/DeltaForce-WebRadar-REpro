# 白色主题版 — Light Theme

浅色毛玻璃 UI 风格，支持中/英双语切换，独立入场页面带炫酷白屏转场动画。

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

**页面说明：**
- `landing.html` — 独立入场页（毛玻璃动效 + 中英切换），验证通过后跳转到 index.html
- `index.html` — 地图主页面（也内置了入口逻辑，可直接带 `?key=房间号` 访问）
- `map.html` — 纯地图页面（无 key 时自动跳转 index.html）

## 目录结构

```
radar_backend/radar-relay/
  ├── relay.js             # 主服务（WS 中继 + HTTP 管理 API）
  ├── admin.html           # 管理后台页面
  ├── ecosystem.config.js  # PM2 配置
  ├── push_rooms.sh        # 房间白名单推送脚本
  ├── .env.example         # 环境变量模板
  └── package.json

radar_frontend/radar/
  ├── landing.html         # 独立入场页（毛玻璃 + 转场动画）
  ├── index.html           # 地图主页面
  ├── map.html             # 地图页面（需 key 参数）
  ├── styles.css
  └── js/
      ├── mapConfig.js     # 地图坐标与游戏常量
      ├── mapEngine.js     # Leaflet 初始化与地图切换
      ├── canvasRenderer.js # Canvas 实体绘制
      ├── wsClient.js      # WebSocket 连接管理
      ├── ui.js            # 侧栏/图层/观战 UI
      └── main.js          # 启动入口 + 入场动画逻辑
```
