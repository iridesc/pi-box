---
name: cron-jobs
description: 管理容器内的周期定时任务（增删改查）：列出任务、创建或修改任务、删除任务、查看运行状态与日志。当用户要求配置定时任务、查看定时任务、修改或删除定时任务时使用本 skill。
---

# 周期任务管理（cron-jobs）

定时任务由容器内 cron 驱动，配置源是 `/workspace/.cron/jobs`（crontab 语法，唯一配置源）。

**统一任务模型**：任务 = 一条 shell 命令。所有任务本质上都是执行命令，不区分类型：
- **Agent 任务**（需要模型理解/执行）：命令用 `pi-run "自然语言描述"`（等价于非交互跑一次 pi）
- **纯脚本任务**（不需要模型）：直接用命令，如 `bash /workspace/.cron/scripts/check.sh`、`curl -s https://...`

## 实现方式选择（优先脚本，慎用 Agent）

1. **优先用脚本实现**：如果用户的意图可以固化为一个确定输出、可稳定执行的脚本（如检查服务、抓取数据、生成报告、发通知），就用脚本/命令直接实现，不经过模型——更快、更省、更可预期。脚本放 `/workspace/.cron/scripts/`。
2. **混合流程：先把能固化的环节脚本化**：如果任务需要 LLM，但流程中包含可固化的环节（采集、检查、抓取、格式化输出等），先用脚本完成这些环节并把结果落盘（如 `/workspace/.cron/data/`），再让 LLM 只处理最后需要理解/总结的部分。**不要让 LLM 从头到尾执行整个流程**。
   - 正确姿势（"每 5 分钟检查服务并汇报"）：脚本先 `curl` 检查并写入 `/workspace/.cron/data/health.txt`，然后 `pi-run "读取 /workspace/.cron/data/health.txt 并总结异常"`（仅当需要总结时）
   - 错误姿势：`pi-run "检查服务状态并汇报"`（LLM 全程跑，慢且贵）
3. **仅当确实需要 LLM 时才用 Agent**：只有需要理解、归纳、总结、撰写等模型能力时，才用 `pi-run "自然语言描述"`（例如"总结昨天的日志关键事件"）。
4. **创建任务前先判断**：能不能用一个脚本稳定产出？能就不用 Agent。拿不准时向用户确认：
   - "这个任务可以写成固定脚本直接执行，不需要模型参与，可以吗？"
   - 或 "这个任务需要模型理解/总结，将使用 Agent 执行，可以吗？"

## 常用命令

```bash
cron-job.sh list                        # 列出所有任务及运行状态（含已禁用的，状态列显示"已禁用"）
cron-job.sh log <任务ID> [n]            # 查看任务日志（默认最近 1 个）
cron-job.sh add <调度> --id <任务ID> "<命令>"
cron-job.sh disable <任务ID>            # 禁用任务（注释掉配置行，定义保留可随时恢复）
cron-job.sh enable <任务ID>             # 重新启用已禁用的任务
cron-job.sh remove <任务ID> [--purge]  # 删除任务；加 --purge 连日志/状态数据一起清理
cron-job.sh reload                      # 重新加载 crontab
```

## 示例

```bash
# Agent 任务：每天 9 点让模型总结昨天的日志
cron-job.sh add "0 9 * * *" --id daily-report 'pi-run "查看 /workspace/logs 下昨天的日志并总结关键事件"'

# 脚本任务：每 5 分钟检查服务（不经过模型）
cron-job.sh add "*/5 * * * *" --id health-check 'bash /workspace/.cron/scripts/check.sh'
```

## 命名规范（重要）

- 任务 ID 必须简短、可读、英文 kebab-case（如 `daily-report`、`health-check`）
- 添加任务前先用 `cron-job.sh list` 查看现有 ID，**不得与已有任务重复**
- 禁止使用不可读的字符串或哈希

## 操作流程

1. **添加/修改**：`cron-job.sh add <调度> --id <任务ID> "<命令>"`（脚本内部会校验 ID 重复、追加到 jobs、重载 crontab）
2. **禁用/启用**：`cron-job.sh disable <任务ID>` 暂停任务（配置行被注释，定义保留）；`cron-job.sh enable <任务ID>` 恢复。禁用后 cron 不再触发，`pi-job status` 中该任务状态显示"已禁用"
3. **删除**：`cron-job.sh remove <任务ID>`（只删配置，保留数据）；删除前**先询问用户是否一并清理该任务产生的数据文件**（日志、状态记录，以及任务生成/写入的业务报告文件），按用户选择执行：
   - 保留数据：`cron-job.sh remove <任务ID>`
   - 连同日志/状态一起清理：`cron-job.sh remove <任务ID> --purge`
   - 业务报告等自定义输出文件（如 /workspace/.cron/reports/ 下的报告），根据任务内容与用户确认后手动删除
4. **校验**：任何操作后执行 `cron-job.sh list` 确认，并回复用户结果
4. 任务日志在 `/workspace/.cron/logs/<任务ID>/`，状态记录在 `/workspace/.cron/state/<任务ID>.json`；执行时长较长的任务会在调度重叠时自动跳过（每任务独立加锁）
