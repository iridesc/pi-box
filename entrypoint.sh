#!/bin/bash
set -e

ln -sf "/usr/share/zoneinfo/${TZ:-Asia/Shanghai}" /etc/localtime
mkdir -p /workspace /home/agent/.pi-boxd /home/agent/.pi/agent

echo "[startup] 启动 pi-boxd..."
cd /home/pi-boxd/app
exec node src/index.mjs
