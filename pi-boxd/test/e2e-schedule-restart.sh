#!/bin/bash
# 验证 abandonOnRestart：pi-boxd 重启时，正在跑的命令任务应被中断（aborted）而不是重跑。
set -uo pipefail
REPO=/mnt/biwin/Project/pi-box/pi-boxd
E2E=/tmp/pibox-restart
PORT=8898
COUNTER=$E2E/counter.txt

rm -rf "$E2E"
mkdir -p "$E2E/workspace/demo/.pi" "$E2E/home" "$E2E/data" "$E2E/meta"
echo "# demo" > "$E2E/workspace/demo/.pi/assistant.md"

start() {
  cd "$REPO"
  PI_BOX_WORKSPACE="$E2E/workspace" \
  PI_BOX_PROJECTS_DIR="$E2E/workspace" \
  PI_BOX_META_DIR="$E2E/meta" \
  PI_BOXD_DATA_DIR="$E2E/data" \
  HOME="$E2E/home" PORT=$PORT TZ=Asia/Shanghai \
  node src/index.mjs >> "$E2E/pi-boxd.log" 2>&1 &
  PID=$!
  for i in $(seq 1 40); do
    curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

api() { curl -s -m 30 -X "$1" "http://127.0.0.1:$PORT$2" -H 'Content-Type: application/json' ${3:+-d "$3"}; }

start || { echo "启动失败"; exit 1; }
echo "第一次启动 pid=$PID"

SID=$(api POST /api/schedules "{\"project\":\"demo\",\"name\":\"long-cmd\",\"command\":{\"run\":\"echo started >> $COUNTER; sleep 60\",\"timeoutSec\":120},\"rule\":{\"type\":\"interval\",\"every\":5,\"unit\":\"minute\"}}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).schedule.id)}catch{console.log("")}})')
echo "scheduleId=$SID"
api POST /api/schedules/run "{\"project\":\"demo\",\"id\":\"$SID\"}" >/dev/null
sleep 3

echo "命令是否已启动: $(wc -l < "$COUNTER" 2>/dev/null || echo 0) 次"
echo "--- 杀掉 pi-boxd（SIGTERM） ---"
kill $PID 2>/dev/null
sleep 2
kill -9 $PID 2>/dev/null
wait $PID 2>/dev/null || true
echo "pi-boxd 已停止；残留 sleep 进程: $(pgrep -f 'sleep 60' | wc -l)"

echo "--- 重新启动（同一份 data，触发 harness.resume） ---"
start || { echo "重启失败"; exit 1; }
echo "第二次启动 pid=$PID"
sleep 12

echo "--- 结果 ---"
echo "命令执行次数（应为 1，不重跑）: $(wc -l < "$COUNTER" 2>/dev/null || echo 0)"
api GET "/api/schedules?project=demo" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const r=JSON.parse(d);
  console.log("runs:", JSON.stringify(r.runs.map(x=>({name:x.scheduleName,status:x.status,exitCode:x.exitCode})),null,1));
})'
echo "--- 重启后的 pi-boxd 日志（尾部） ---"
tail -12 "$E2E/pi-boxd.log"

kill $PID 2>/dev/null; sleep 1; kill -9 $PID 2>/dev/null
echo done
