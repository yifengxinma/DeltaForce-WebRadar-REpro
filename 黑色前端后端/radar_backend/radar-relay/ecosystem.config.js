module.exports = {
  "apps": [
    {
      "name": "radar-relay",
      "script": "relay.js",
      "cwd": "/opt/radar-relay",
      "node_args": "--max-old-space-size=4096",
      "env": {
        "ROOMS_API_URL": "",
        "ROOMS_API_BIND": ""
      }
    }
  ]
}