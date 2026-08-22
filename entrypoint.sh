#!/bin/bash
set -e

# 0) 系统时区：/etc/localtime 默认指向 UTC（Debian slim），会导致 cron 调度
#    和 cron 任务里的 date 都按 UTC 跑。改为容器 TZ（默认 Asia/Shanghai）。
ln -sf /usr/share/zoneinfo/${TZ:-Asia/Shanghai} /etc/localtime

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
#    若 /workspace 还没有任何会话，自动创建一个真实引导会话（发一条最小 prompt），
#    让 /workspace 成为受信项目、按钮直接可用。会话落盘在 agent-data，仅首次创建一次。
bootstrap_workspace() {
  local i ok=1
  # 等 pi-web 就绪（最多 30s）
  for i in $(seq 1 30); do
    if node -e "fetch('http://127.0.0.1:30141/api/sessions').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      ok=0; break
    fi
    sleep 1
  done
  [ "$ok" = 1 ] && { echo "[bootstrap] pi-web 未就绪，跳过 workspace 引导"; return 0; }
  # 已有 /workspace 会话则跳过（用 API 判断，避免依赖目录编码）
  if node -e "
    fetch('http://127.0.0.1:30141/api/sessions').then(r=>r.json()).then(j=>{
      process.exit((j.sessions||[]).some(s=>s.cwd==='/workspace')?0:1)
    }).catch(()=>process.exit(1))
  " 2>/dev/null; then
    echo "[bootstrap] /workspace 已有会话，跳过"; return 0
  fi
  # 创建引导会话：type=prompt 会真实调一次模型，回复落盘后 /workspace 才被持久信任
  node -e "
    fetch('http://127.0.0.1:30141/api/agent/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/workspace', type: 'prompt', toolNames: [], message: '请只回复：就绪' }),
    }).then(r=>r.json()).then(j=>{
      if (!j.success) throw new Error(j.error || 'unknown error');
      console.log('[bootstrap] workspace 引导会话已创建:', j.sessionId);
    }).catch(e=>console.error('[bootstrap] workspace 引导失败:', e.message))
  " || true
}
bootstrap_workspace &

cleanup() {
  kill "$CRON_PID" "$PIWEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 任一进程退出则整容器退出（restart: unless-stopped 会自动拉起）
wait -n "$CRON_PID" "$PIWEB_PID"
