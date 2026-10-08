#!/bin/bash
set -e

# 0) 系统时区：/etc/localtime 默认指向 UTC（Debian slim），会导致 cron 调度
#    和 cron 任务里的 date 都按 UTC 跑。改为容器 TZ（默认 Asia/Shanghai）。
ln -sf /usr/share/zoneinfo/${TZ:-Asia/Shanghai} /etc/localtime

# 0.5) 容器注入的环境变量（compose 的 environment / env_file）导出为任务环境文件。
#      cron 不继承容器环境（vixie-cron 会给每个 job 重建环境，实测 job 里只剩
#      HOME/PATH/SHELL/LOGNAME/PWD），导致 .env 里加的变量在定时任务中不可见。
#      这里导出成 shell 片段，由 pi-job / pi-run 在任务启动时 source 回填，
#      使网页会话与定时任务看到同一套变量。
#      放 /run（容器可写层，不落挂载目录）；每次启动幂等重建，.env 改动需重启容器生效。
ENV_FILE=/run/pi-box/job-env.sh
mkdir -p /run/pi-box
: > "$ENV_FILE"
while IFS= read -r -d '' kv; do
  key=${kv%%=*}
  case "$key" in
    # 容器固有变量：跳过，避免覆盖 pi-job 自己设定的 HOME/PATH/TZ 等运行环境
    HOME | PATH | PWD | OLDPWD | SHLVL | _ | TERM | HOSTNAME | BASH_* | FUNCNAME | NODE_VERSION | YARN_VERSION | npm_*) continue ;;
  esac
  printf 'export %s=%q\n' "$key" "${kv#*=}" >> "$ENV_FILE"
done < <(env -0)
chmod 600 "$ENV_FILE"
echo "[bootstrap] 已导出容器环境变量到定时任务环境文件: $ENV_FILE（$(grep -c '^export ' "$ENV_FILE" || true) 个变量）"

# 1) 通用系统提示词 + cron-jobs skill：镜像内置模板，首启时安装到全局 agent 目录。
#    之后每次启动跳过（宿主机 agent-data/ 下已存在即保留用户版本）。
mkdir -p /home/agent/.pi/agent
if [ -f /opt/pi-box/SYSTEM.md ] && [ ! -f /home/agent/.pi/agent/SYSTEM.md ]; then
  cp /opt/pi-box/SYSTEM.md /home/agent/.pi/agent/SYSTEM.md
  echo "[bootstrap] 已安装通用系统提示词: /home/agent/.pi/agent/SYSTEM.md"
fi
if [ -d /opt/pi-box/skills/cron-jobs ] && [ ! -d /home/agent/.pi/agent/skills/cron-jobs ]; then
  mkdir -p /home/agent/.pi/agent/skills
  cp -r /opt/pi-box/skills/cron-jobs /home/agent/.pi/agent/skills/
  echo "[bootstrap] 已安装 cron-jobs skill"
fi
# cron-job.sh 装进 PATH（/usr/local/bin 是容器层，重建后重置，每次启动幂等创建）
ln -sf /opt/pi-box/skills/cron-jobs/scripts/cron-job.sh /usr/local/bin/cron-job.sh

# 1) 加载挂载目录中的定时任务配置（crontab 语法，放 /workspace/.cron/jobs）
#    修改后重载：docker exec pi-box crontab /workspace/.cron/jobs
mkdir -p /workspace/.cron/logs /workspace/.pi
if [ -f /workspace/.cron/jobs ]; then
  crontab /workspace/.cron/jobs
fi

# 2) 启动容器内 cron（前台模式跑在后台）
cron -f -l 8 &
CRON_PID=$!

# 3) 启动 pi-web（0.0.0.0 便于 compose 端口映射；不自动开浏览器）
pi-web --no-open --hostname 0.0.0.0 --port 30141 &
PIWEB_PID=$!

# 4) 首次启动引导：pi-web 中"新建对话"按钮依赖已选中的项目目录，
#    而项目目录只有存在落盘会话后才被信任（空会话不落盘，必须有回复）。
#    直接用 pi -p（非交互）在 /workspace 跑一次，会话落盘到默认 session 目录
#    （~/.pi/agent/sessions/--workspace--/，即 pi-web 读取的目录），
#    不经过 pi-web API，也就不受 Basic Auth / pi-web 就绪时序影响。
#    模型可能在容器启动后才配置，循环重试直到成功。
bootstrap_workspace() {
  local tries=0
  local sess_dir="$HOME/.pi/agent/sessions/--workspace--"
  mkdir -p "$HOME/.pi/agent/sessions"
  while [ $tries -lt 60 ]; do  # 最多重试 60 次（约 1 小时），避免异常死循环
    tries=$((tries+1))
    if ls "$sess_dir"/*.jsonl >/dev/null 2>&1; then
      echo "[bootstrap] /workspace 已有会话，引导完成"
      return 0
    fi
    # 直接 pi -p 跑一次（勿用 pi-run：它指定了 cron 专用 session-dir）
    if (cd /workspace && pi -p -a "请只回复：就绪" >/dev/null 2>&1) && ls "$sess_dir"/*.jsonl >/dev/null 2>&1; then
      echo "[bootstrap] workspace 引导会话已创建（$sess_dir）"
      return 0
    fi
    echo "[bootstrap] 引导未成功（模型可能未配置），60s 后重试"
    sleep 60
  done
  echo "[bootstrap] 多次重试后仍未成功，放弃（重启容器可重新触发）"
}
bootstrap_workspace &

cleanup() {
  kill "$CRON_PID" "$PIWEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 任一进程退出则整容器退出（restart: unless-stopped 会自动拉起）
wait -n "$CRON_PID" "$PIWEB_PID"
