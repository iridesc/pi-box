#!/bin/bash
set -e

# 0) 系统时区
ln -sf /usr/share/zoneinfo/${TZ:-Asia/Shanghai} /etc/localtime

# 0.5) 容器环境变量导出到 /run/pi-box/job-env.sh（供 cron 任务继承）
ENV_FILE=/run/pi-box/job-env.sh
mkdir -p /run/pi-box
: > "$ENV_FILE"
while IFS= read -r -d '' kv; do
  key=${kv%%=*}
  case "$key" in
    HOME | PATH | PWD | OLDPWD | SHLVL | _ | TERM | HOSTNAME | BASH_* | FUNCNAME | NODE_VERSION | YARN_VERSION | npm_*) continue ;;
  esac
  printf 'export %s=%q\n' "$key" "${kv#*=}" >> "$ENV_FILE"
done < <(env -0)
chmod 600 "$ENV_FILE"
echo "[bootstrap] 已导出容器环境变量: $ENV_FILE（$(grep -c '^export ' "$ENV_FILE" || true) 个变量）"

# 1) 系统提示词 + cron-jobs skill：首启时安装到 /home/agent/.pi/agent
mkdir -p /home/agent/.pi/agent
if [ -f /opt/pi-box/SYSTEM.md ] && [ ! -f /home/agent/.pi/agent/SYSTEM.md ]; then
  cp /opt/pi-box/SYSTEM.md /home/agent/.pi/agent/SYSTEM.md
  echo "[bootstrap] 已安装系统提示词"
fi
if [ -d /opt/pi-box/skills/cron-jobs ] && [ ! -d /home/agent/.pi/agent/skills/cron-jobs ]; then
  mkdir -p /home/agent/.pi/agent/skills
  cp -r /opt/pi-box/skills/cron-jobs /home/agent/.pi/agent/skills/
  echo "[bootstrap] 已安装 cron-jobs skill"
fi
ln -sf /opt/pi-box/skills/cron-jobs/scripts/cron-job.sh /usr/local/bin/cron-job.sh

# 2) 加载挂载的 crontab
mkdir -p /workspace/.cron/logs /workspace/.pi
if [ -f /workspace/.cron/jobs ]; then
  crontab /workspace/.cron/jobs
fi

# 3) 启动容器内 cron（前台模式）
cron -f -l 8 &
CRON_PID=$!

# 4) 启动 pi-boxd（多 agent 管理台）
echo "[startup] 启动 pi-boxd..."
cd /home/pi-boxd/app
node src/index.mjs &
PIBOXD_PID=$!

# 5) workspace 引导：用 pi -p 跑一次（仅在没有会话时），让 pi-web（已弃）兼容层工作；
#    pi-boxd 不依赖此步骤，但保留兼容旧 pi 工具链。
bootstrap_workspace() {
  local tries=0
  local sess_dir="$HOME/.pi/agent/sessions/--workspace--"
  mkdir -p "$HOME/.pi/agent/sessions"
  while [ $tries -lt 60 ]; do
    tries=$((tries+1))
    if ls "$sess_dir"/*.jsonl >/dev/null 2>&1; then
      echo "[bootstrap] /workspace 已有会话"
      return 0
    fi
    if (cd /workspace && pi -p -a "请只回复：就绪" >/dev/null 2>&1) && ls "$sess_dir"/*.jsonl >/dev/null 2>&1; then
      echo "[bootstrap] workspace 引导会话已创建"
      return 0
    fi
    sleep 60
  done
}
bootstrap_workspace &

cleanup() {
  kill "$CRON_PID" "$PIBOXD_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait -n "$CRON_PID" "$PIBOXD_PID"
