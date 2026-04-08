#!/bin/bash
# 请设置以下环境变量:
# ROOMS_API_URL - 房间列表拉取地址
# RELAY_HOST    - relay 服务器地址 (如 127.0.0.1:1377)
# ROOMS_SECRET  - 推送接口密钥
ROOMS=$(curl -4 -s --max-time 10 "${ROOMS_API_URL}")
if [ -z "$ROOMS" ]; then exit 1; fi
curl -s -X POST "http://${RELAY_HOST}/api/set_rooms" \
  -H 'Content-Type: application/json' \
  -d "{\"secret\":\"${ROOMS_SECRET}\",\"rooms\":\"$ROOMS\"}" > /dev/null

