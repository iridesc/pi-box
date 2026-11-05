#!/bin/bash
set -uo pipefail
REPO=/mnt/biwin/Project/pi-box/pi-boxd
E2E=/tmp/pibox-e2e-cleanup; PORT=8888
DB=$E2E/data/session.sqlite
rm -rf "$E2E"; mkdir -p "$E2E/workspace/demo/.pi" "$E2E/home" "$E2E/data" "$E2E/meta"
echo "# demo" > "$E2E/workspace/demo/.pi/assistant.md"

start() {
  cd "$REPO"
  PI_BOX_WORKSPACE="$E2E/workspace" PI_BOX_PROJECTS_DIR="$E2E/workspace" PI_BOX_META_DIR="$E2E/meta" \
  PI_BOXD_DATA_DIR="$E2E/data" HOME="$E2E/home" PORT=$PORT TZ=Asia/Shanghai node src/index.mjs >> "$E2E/log" 2>&1 &
  PID=$!
  for i in $(seq 1 60); do curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/" && return 0; sleep 0.5; done
  return 1
}
api() { curl -s -m 60 -X "$1" "http://127.0.0.1:$PORT$2" -H 'Content-Type: application/json' ${3:+-d "$3"}; }
dbq() { DB="$DB" node --input-type=commonjs -e "$1"; }

start || { echo "启动失败"; exit 1; }
echo "[1] 启动 OK"
api POST /api/cleanup/config '{"logs":{"retentionDays":7},"runs":{"maxEntries":300},"database":{"autoClean":false,"retentionDays":30}}' >/dev/null

# 命令任务 2 次
api POST /api/schedules '{"project":"demo","name":"cmd","rule":{"type":"interval","every":15,"unit":"minute"},"command":{"run":"echo tick"}}' >/dev/null
SID=$(api GET "/api/schedules?project=demo" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).schedules[0].id))')
for i in 1 2; do api POST /api/schedules/run "{\"project\":\"demo\",\"id\":\"$SID\"}" >/dev/null; sleep 0.6; done
# LLM 任务 2 次（产生 ephemeral 会话 + entries + documents）
api POST /api/schedules '{"project":"demo","name":"llm","rule":{"type":"interval","every":15,"unit":"minute"},"llm":{"prompt":"总结","agent":"assistant"}}' >/dev/null
SID2=$(api GET "/api/schedules?project=demo" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).schedules.find(s=>s.name==="llm").id))')
for i in 1 2; do api POST /api/schedules/run "{\"project\":\"demo\",\"id\":\"$SID2\"}" >/dev/null; sleep 1.5; done
sleep 4

echo "[2] 清理前"
dbq 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DB,{readOnly:true});
console.log("  " + ["tasks","conversations","entries","submissions","documents","document_revisions"].map(t=>t+"="+db.prepare("SELECT count(*) c FROM "+t).get().c).join(" "));db.close();'

echo "[3] 停服，把全部 terminal 任务标记为过期（endedAt=0）"
kill -TERM $PID 2>/dev/null; sleep 3
dbq 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DB);
const ids=db.prepare("SELECT id FROM tasks WHERE status = ?").all("terminal").map(r=>r.id);
for (const id of ids) db.prepare("UPDATE tasks SET record = json_set(record, ?, 0) WHERE id = ?").run("$.endedAt", id);
console.log("  标记过期任务数:", ids.length);db.close();'

start || { echo "重启失败"; exit 1; }
echo "[4] 重启 OK"

echo "[5] 数据库清理（保留 30 天 → 应删掉全部过期任务及其会话）"
api POST /api/cleanup/database '{"retentionDays":30,"vacuum":true}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log(JSON.stringify({ok:r.ok,durationMs:r.durationMs,result:r.result}))})'

echo "[6] 清理后"
dbq 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.DB,{readOnly:true});
console.log("  " + ["tasks","conversations","entries","submissions","documents","document_revisions"].map(t=>t+"="+db.prepare("SELECT count(*) c FROM "+t).get().c).join(" "));
console.log("  主会话仍在:", db.prepare("SELECT count(*) c FROM conversations WHERE owner_task_id IS NULL").get().c);db.close();'
echo "  库文件: $(stat -c%s $DB) bytes"
echo "  文件列表: $(ls $E2E/data | tr '\n' ' ')"

echo "[7] 服务恢复 + 继续跑任务"
curl -s -m 5 -o /dev/null -w "  /api/state: %{http_code}\n" "http://127.0.0.1:$PORT/api/state"
api POST /api/schedules/run "{\"project\":\"demo\",\"id\":\"$SID\"}" >/dev/null; sleep 3
api GET "/api/schedules?project=demo" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log("  runs:",r.runs.length,"最新:",r.runs[0]?.status,r.runs[0]?.exitCode)})'

echo "[8] 维护期 503 探测（并发请求）"
( for i in $(seq 1 40); do curl -s -m 2 -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$PORT/api/schedules?project=demo"; done ) > /tmp/probe-code.txt &
PROBE=$!
api POST /api/cleanup/database '{"retentionDays":0}' >/dev/null
wait $PROBE 2>/dev/null
echo "  状态码分布: $(sort /tmp/probe-code.txt | uniq -c | tr '\n' ' ')"
grep -iE "error|失败" "$E2E/log" | tail -3
kill -TERM $PID 2>/dev/null; sleep 2; kill -9 $PID 2>/dev/null
