#!/bin/bash
set -e

ln -sf "/usr/share/zoneinfo/${TZ:-Asia/Shanghai}" /etc/localtime
mkdir -p /workspace /home/agent/.pi-boxd /home/agent/.pi/agent

# 首启安装元项目 seed：复制到 /home/agent/.pi/agent/meta/；已存在则跳过整体目录，
# 但允许单个 agent 文件不存在时被补齐（新增子 agent 时不破坏用户已修改内容）。
SEED_DIR="/home/pi-boxd/seed/meta"
META_DIR="/home/agent/.pi/agent/meta"
if [ -d "$SEED_DIR" ]; then
  mkdir -p "$META_DIR"
  if [ ! -f "$META_DIR/assistant.md" ]; then
    cp "$SEED_DIR/assistant.md" "$META_DIR/assistant.md"
    echo "[startup] 已安装元项目助理定义（meta/assistant.md）"
  fi
  mkdir -p "$META_DIR/agents"
  for f in "$SEED_DIR"/agents/*.md; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    if [ ! -f "$META_DIR/agents/$base" ]; then
      cp "$f" "$META_DIR/agents/$base"
      echo "[startup] 已安装元项目子 agent（meta/agents/$base）"
    fi
  done
  # 元项目助理文件只读锁定（rootless 容器下 root 即宿主用户，宿主不受影响）
  [ -f "$META_DIR/assistant.md" ] && chmod 444 "$META_DIR/assistant.md" 2>/dev/null || true
  for f in "$META_DIR"/agents/*.md; do
    [ -f "$f" ] && chmod 444 "$f" 2>/dev/null || true
  done
fi

echo "[startup] 启动 pi-boxd..."
cd /home/pi-boxd/app
exec node src/index.mjs
