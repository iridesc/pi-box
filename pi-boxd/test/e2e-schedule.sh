#!/bin/bash
# 端到端验证：临时 pi-boxd 实例（端口 8899，独立 workspace/home），不触碰本机 8790 实例
set -uo pipefail
REPO=/mnt/biwin/Project/pi-box/pi-boxd
E2E=/tmp/pibox-e2e
PORT=8899

rm -rf "$E2E"
mkdir -p "$E2E/workspace/demo/.pi" "$E2E/home" "$E2E/data" "$E2E/meta"
echo "# demo 助理" > "$E2E/workspace/demo/.pi/assistant.md"

cd "$REPO"
PI_BOX_WORKSPACE="$E2E/workspace" \
PI_BOX_PROJECTS_DIR="$E2E/workspace" \
PI_BOX_META_DIR="$E2E/meta" \
PI_BOXD_DATA_DIR="$E2E/data" \
HOME="$E2E/home" \
PORT=$PORT \
TZ=Asia/Shanghai \
node src/index.mjs > "$E2E/pi-boxd.log" 2>&1 &
PID=$!
echo "pi-boxd pid=$PID"

for i in $(seq 1 40); do
  if curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then break; fi
  sleep 0.5
done
curl -s -m 3 -o /dev/null -w "boot: HTTP %{http_code}\n" "http://127.0.0.1:$PORT/"

api() { curl -s -m 30 -X "$1" "http://127.0.0.1:$PORT$2" -H 'Content-Type: application/json' ${3:+-d "$3"}; }

echo "--- 1) 创建纯命令任务 ---"
CREATE=$(api POST /api/schedules '{"project":"demo","name":"cmd-ok","command":{"run":"echo hello-from-schedule; echo to-stderr 1>&2; exit 0","timeoutSec":60},"rule":{"type":"interval","every":5,"unit":"minute"}}')
echo "$CREATE" | head -c 400; echo
SID=$(echo "$CREATE" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).schedule.id)}catch{console.log("")}})')
echo "scheduleId=$SID"

echo "--- 2) 手动触发（纯命令） ---"
api POST /api/schedules/run "{\"project\":\"demo\",\"id\":\"$SID\"}" | head -c 400; echo
sleep 4

echo "--- 3) 运行记录 ---"
api GET "/api/schedules?project=demo" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const r=JSON.parse(d);
  console.log("schedules:", r.schedules.map(s=>({name:s.name,kind:s.kind,desc:s.description})));
  console.log("runs:", r.runs.map(x=>({status:x.status,kind:x.kind,exitCode:x.exitCode,durationMs:x.durationMs,llmStatus:x.llmStatus,logPath:x.logPath?"yes":null})));
})'

echo "--- 4) 日志内容 ---"
find "$E2E/workspace/demo/.pi/schedule-logs" -name '*.log' | head -5
LOG=$(find "$E2E/workspace/demo/.pi/schedule-logs" -name '2*.log' | sort | tail -1)
echo "== $LOG"; cat "$LOG"

echo "--- 5) 失败命令 + LLM 段（faux 模型） ---"
CREATE2=$(api POST /api/schedules '{"project":"demo","name":"cmd-llm-fail","command":{"run":"echo data-line; echo boom 1>&2; exit 7","timeoutSec":60},"llm":{"prompt":"命令输出如下：\n{{stdout}}\n退出码 {{exitCode}}","agent":"assistant","session":"ephemeral","reportTo":"none","onCommandFailure":"run"},"rule":{"type":"interval","every":5,"unit":"minute"}}')
SID2=$(echo "$CREATE2" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).schedule.id)}catch{console.log("")}})')
echo "scheduleId2=$SID2"
api POST /api/schedules/run "{\"project\":\"demo\",\"id\":\"$SID2\"}" | head -c 300; echo
sleep 8
api GET "/api/schedules?project=demo" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const r=JSON.parse(d);
  console.log("runs:", JSON.stringify(r.runs.map(x=>({name:x.scheduleName,status:x.status,exitCode:x.exitCode,llmStatus:x.llmStatus})),null,1));
})'
LOG2=$(find "$E2E/workspace/demo/.pi/schedule-logs" -name '2*.log' -newer "$LOG" | sort | tail -1)
echo "== 混合任务日志: $LOG2"; cat "$LOG2" 2>/dev/null | head -40

echo "--- 6) 幂等（同 occurrence 再触发） ---"
api POST /api/schedules/run "{\"project\":\"demo\",\"id\":\"$SID\"}" >/dev/null
sleep 3
echo "任务节点（任务图）："
api GET "/api/system" | head -c 300; echo


echo "--- 8) 纯 LLM 任务（无命令段） ---"
CREATE3=$(api POST /api/schedules '{"project":"demo","name":"llm-only","llm":{"prompt":"说一句话","agent":"assistant","session":"ephemeral","reportTo":"none"},"rule":{"type":"daily","time":"16:00"}}')
SID3=$(echo "$CREATE3" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).schedule.id)}catch{console.log("")}})')
echo "scheduleId3=$SID3 kind=$(echo "$CREATE3" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).schedule.kind)}catch{console.log("")}})')"
api POST /api/schedules/run "{\"project\":\"demo\",\"id\":\"$SID3\"}" >/dev/null
sleep 6
api GET "/api/schedules?project=demo" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const r=JSON.parse(d);
  const x=r.runs.find(v=>v.scheduleName==="llm-only");
  console.log("llm-only run:", JSON.stringify(x&&{status:x.status,llmStatus:x.llmStatus,logPath:!!x.logPath}));
})'
L3=$(find "$E2E/workspace/demo/.pi/schedule-logs/$SID3" -name '2*.log' 2>/dev/null | sort | tail -1)
echo "== 纯 LLM 日志: $L3"; cat "$L3" 2>/dev/null | head -20

echo "--- 7) 容器日志尾部 ---"
tail -20 "$E2E/pi-boxd.log"

kill $PID 2>/dev/null; sleep 1; kill -9 $PID 2>/dev/null
wait $PID 2>/dev/null
echo "done"
