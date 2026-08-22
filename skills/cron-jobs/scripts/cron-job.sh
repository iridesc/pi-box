#!/bin/bash
# cron-jobs skill 工具：周期任务增删改查（封装 pi-job + jobs 文件 + crontab 重载）
# 统一任务模型：任务 = 一条 shell 命令（Agent 任务用 pi-run "描述"，脚本任务直接用命令）
# 用法：
#   cron-job.sh list
#   cron-job.sh log <任务ID> [n]
#   cron-job.sh add <cron调度> --id <任务ID> "<命令>"
#   cron-job.sh disable <任务ID>    # 禁用（注释掉任务行，定义保留可恢复）
#   cron-job.sh enable <任务ID>     # 重新启用
#   cron-job.sh remove <任务ID> [--purge]  # 删除任务；--purge 连日志/状态数据一起清理
#   cron-job.sh reload
set -euo pipefail

JOBS=/workspace/.cron/jobs
PI_JOB=/usr/local/bin/pi-job
LOG_DIR=/workspace/.cron/logs
STATE_DIR=/workspace/.cron/state

usage() {
  sed -n '3,10p' "$0" | sed 's/^# //'
}

cmd_list() {
  "$PI_JOB" status
}

cmd_log() {
  [ $# -ge 1 ] || { echo "用法: cron-job.sh log <任务ID> [n]"; exit 1; }
  "$PI_JOB" log "$@"
}

cmd_reload() {
  crontab "$JOBS"
  echo "[cron-job] crontab 已重载"
  "$PI_JOB" status
}

# add <schedule> --id <id> "<命令>"
cmd_add() {
  [ $# -ge 2 ] || { echo "用法: cron-job.sh add <cron调度> --id <任务ID> \"<命令>\""; exit 1; }
  local schedule=$1; shift
  local id="" command=""
  local args=("$@") i=0
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      --id) id="${args[$((i+1))]:-}"; i=$((i+2)) ;;
      *) command+=" ${args[$i]}"; i=$((i+1)) ;;
    esac
  done
  command=$(echo "$command" | sed 's/^ //')

  [ -n "$id" ] || { echo "[cron-job] 错误: 缺少 --id <任务ID>"; exit 1; }
  [ -n "$command" ] || { echo "[cron-job] 错误: 缺少任务命令"; exit 1; }
  echo "$schedule" | awk '{ exit NF!=5 }' || { echo "[cron-job] 错误: 调度必须为 5 个字段（分 时 日 月 周）: $schedule"; exit 1; }

  # 校验 ID 不与已有任务重复
  if grep -q -- "--id $id" "$JOBS" 2>/dev/null; then
    echo "[cron-job] 错误: 任务 ID '$id' 已存在（修改请直接编辑 $JOBS 或先 remove）"
    exit 1
  fi

  # 命令用单引号包裹写入 crontab 行（命令内避免使用单引号）
  local line="$schedule $PI_JOB --id $id '$command'"
  { echo; echo "# $id"; echo "$line"; } >> "$JOBS"
  echo "[cron-job] 已添加任务: $id"
  cmd_reload
}

# disable <任务ID>：加 [disabled] 标记注释（禁用，定义保留）
cmd_disable() {
  [ $# -ge 1 ] || { echo "用法: cron-job.sh disable <任务ID>"; exit 1; }
  local id=$1
  if ! grep -Eq -- "--id $id" "$JOBS" 2>/dev/null; then
    echo "[cron-job] 错误: 未找到任务 ID '$id'"
    exit 1
  fi
  if grep -Eq -- "# \[disabled\] .*--id $id" "$JOBS" 2>/dev/null; then
    echo "[cron-job] 任务 $id 已是禁用状态"
    exit 0
  fi
  sed -i "/--id $id/s|^|# [disabled] |" "$JOBS"
  echo "[cron-job] 已禁用任务: $id"
  cmd_reload
}

# enable <任务ID>：去掉 [disabled] 标记（恢复启用）
cmd_enable() {
  [ $# -ge 1 ] || { echo "用法: cron-job.sh enable <任务ID>"; exit 1; }
  local id=$1
  if ! grep -Eq -- "# \[disabled\] .*--id $id" "$JOBS" 2>/dev/null; then
    echo "[cron-job] 错误: 任务 $id 未处于禁用状态"
    exit 1
  fi
  sed -i "/--id $id/s|^# \[disabled\] ||" "$JOBS"
  echo "[cron-job] 已启用任务: $id"
  cmd_reload
}

# remove <任务ID> [--purge]：--purge 同时清理日志/状态等数据文件
cmd_remove() {
  [ $# -ge 1 ] || { echo "用法: cron-job.sh remove <任务ID> [--purge]"; exit 1; }
  local id=$1 purge=0
  [ "${2:-}" = "--purge" ] && purge=1
  if ! grep -Eq -- "--id $id" "$JOBS" 2>/dev/null; then
    echo "[cron-job] 错误: 未找到任务 ID '$id'"
    exit 1
  fi
  sed -i "/--id $id/d" "$JOBS"
  echo "[cron-job] 已删除任务配置: $id"
  if [ "$purge" = 1 ]; then
    rm -rf "$LOG_DIR/$id" "$STATE_DIR/$id.json"
    echo "[cron-job] 已清理数据: logs/$id、state/$id.json"
  else
    echo "[cron-job] 数据已保留（logs/$id、state/$id.json）；如需一并清理: cron-job.sh remove $id --purge"
  fi
  cmd_reload
}

case "${1:-}" in
  list) shift; cmd_list "$@" ;;
  log) shift; cmd_log "$@" ;;
  add) shift; cmd_add "$@" ;;
  disable) shift; cmd_disable "$@" ;;
  enable) shift; cmd_enable "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  reload) shift; cmd_reload "$@" ;;
  *) usage ;;
esac
