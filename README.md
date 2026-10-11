# pi-box：持久化多 Agent 管理台 + cron 周期任务

`pi-boxd` 基于 `pi-durable` 提供按项目隔离的持久会话、后台子 Agent 和 Web 管理台；容器内 cron 继续驱动周期任务。会话、任务和模型配置在容器重启后恢复。

## 目录结构

```
pi-box/
├── Dockerfile            # 预装 pi CLI + pi-boxd + cron
├── docker-compose.yml    # 挂载 workspace 与 agent-data，端口 8790
├── entrypoint.sh         # 导出环境变量 + 安装系统提示词 + 启动 cron + pi-boxd
├── pi-boxd/              # durable 守护进程、HTTP API 与 Web 管理台
├── bin/pi-job            # cron 任务包装：非交互跑一次 pi，日志落盘
├── system-prompt/
│   └── SYSTEM.md         # 通用系统提示词模板（构建进镜像，首启自动安装）
├── skills/
│   └── cron-jobs/        # 定时任务管理 skill（SKILL.md + 工具 cron-job.sh）
└── workspace/            # ← 挂载目录，宿主机直接编辑
    └── .cron/
        ├── jobs          # 周期任务配置（crontab 语法，唯一配置源）
        ├── env           # 可选：任务专用环境变量（sh 语法，pi-job/pi-run 启动时加载）
        ├── logs/<id>/    # 任务日志（每次运行一个文件 + latest.log）
        └── state/<id>.json  # 运行状态（pi-job status 查询用）
```

## 系统提示词在哪儿配置

cron 中的 pi CLI 按以下优先级组装系统提示词；pi-boxd 项目助理和 Agent 则分别使用项目配置文件：

| 配置 | 位置 | 作用 |
|------|------|------|
| 内置基础提示词 | pi 代码内置 | 默认提示词（编码助手定位），不可直接编辑 |
| `SYSTEM.md` | `~/.pi/agent/SYSTEM.md`（全局，本镜像内置模板自动安装）或 `.pi/SYSTEM.md`（项目） | **完全替换**内置提示词；pi-box 用它把系统改造成**通用智能助手**（非编码定位） |
| `AGENTS.md` / `CLAUDE.md` | `/workspace/AGENTS.md`（cwd 及上级）或 `~/.pi/agent/AGENTS.md`（全局） | **追加**为 `<project_context>` 段落，工作区业务约定放这里 |
| `APPEND_SYSTEM.md` | `.pi/APPEND_SYSTEM.md` 或 `~/.pi/agent/APPEND_SYSTEM.md` | **追加**到基础提示词之后 |
| CLI 参数 | `--system-prompt` / `--append-system-prompt` | 单次运行覆盖/追加 |

**通用提示词的安装机制**：镜像内预置 `system-prompt/SYSTEM.md` 模板，容器首启时由 entrypoint 自动安装到全局 `~/.pi/agent/SYSTEM.md`，供 cron 中的 pi CLI 使用。若对应文件已存在则跳过安装。

**定时任务能力（cron-jobs skill）**：周期任务的增删改查不写在系统提示词里，而是做成 skill（镜像内置，首启安装到 `~/.pi/agent/skills/cron-jobs/`）。skill 采用渐进披露：系统提示词只注入一行描述，agent 在用户要求配置定时任务时才加载完整指令，并通过 `cron-job.sh` 工具操作（list/add/remove/reload，自动校验 ID 重复并重载 crontab）。

> 注意：AGENTS.md 必须放在工作目录**根**（如 `/workspace/AGENTS.md`）或上级目录，放 `.pi/` 子目录里不会被加载。修改提示词文件后**新会话**生效（已创建的会话提示词不变）。

## 使用（podman）

```bash
cd pi-box
cp .env.example .env     # 可选：设置时区及任务环境变量
podman compose up -d --build
```

打开 http://127.0.0.1:8790，在设置中选择模型提供商、模型并填写 API Key。没有 Key 时服务以 faux 离线模型启动，只允许查看和配置，不执行真实模型请求。

`/workspace` 下每个非隐藏一级目录都是一个项目。项目助理配置保存在 `<项目>/.pi/assistant.md`；项目 Agent 保存在 `<项目>/.pi/agents/*.md`；全局共享 Agent 保存在 `/workspace/.pi-box/agents/*.md`。项目助理可通过 `subagent` 工具启动持久后台子会话，子 Agent 的回复会自动回流主会话。

> entrypoint 仍会创建一个旧 pi CLI 引导会话，仅用于兼容已有工具链；pi-boxd 的项目发现和 Durable 会话不依赖它。

> 当前 compose 只把管理台绑定到 `127.0.0.1`。若通过反向代理对外开放，请在代理层配置 HTTPS 和身份认证。

### 配置周期任务（两种方式）

**统一任务模型**：任务 = 一条 shell 命令，不区分类型。

- **Agent 任务**（需要模型理解/执行）：命令用 `pi-run "自然语言描述"`（非交互跑一次 pi）
  `pi-job --id <任务ID> 'pi-run "任务描述"'`
- **纯脚本任务**（不需要模型）：直接用命令，如 `bash /workspace/.cron/scripts/check.sh`
  `pi-job --id <任务ID> 'bash /workspace/.cron/scripts/check.sh'`

**方式一：网页自然语言**。在 pi-boxd 项目对话中直接说：
> 每天早上 9 点总结 /workspace/logs 昨天的日志
> 把刚才那个任务改成每 30 分钟一次
> 加一个每 5 分钟执行的脚本任务，跑 /workspace/.cron/scripts/check.sh

agent 会通过 cron-jobs skill（工具 `cron-job.sh`）编辑 `/workspace/.cron/jobs` 并执行 `crontab ...` 重载。

**方式二：直接编辑文件**。宿主机改 `workspace/.cron/jobs`（crontab 语法），然后：

```bash
podman exec pi-box crontab /workspace/.cron/jobs   # 重载
podman exec pi-box crontab -l                      # 查看生效任务
```

### 环境变量如何传给定时任务

**cron 不继承容器环境**：vixie-cron 会给每个 job 重建环境（只有 `HOME`/`PATH`/`SHELL`/`LOGNAME`/`PWD`），因此 compose 的 `environment:` 与 `env_file: .env` 注入的变量在定时任务里默认**不可见**——表现为「网页会话里能用，定时任务里读不到」。

pi-box 的处理：entrypoint 启动时把容器注入的环境变量导出到 `/run/pi-box/job-env.sh`，`pi-job` / `pi-run` 在任务启动时 source 回填。所以 `.env` 里加变量后**重启容器**，网页会话与定时任务看到同一套变量：

```bash
# .env
MY_TOKEN=your-token-here

podman compose up -d
podman exec pi-box pi-job --id env-test 'echo "TOKEN=$MY_TOKEN"'   # → TOKEN=your-token-here
```

- **过滤规则**：容器固有变量（`HOME`/`PATH`/`PWD`/`SHLVL`/`TERM`/`HOSTNAME`/`BASH_*`/`NODE_VERSION` 等）跳过，避免覆盖任务运行环境；其余全部导出，值经 `printf %q` 安全转义（含空格、引号的密钥可用）。
- **落盘位置**：`/run/pi-box/job-env.sh`（容器可写层，权限 600，每次启动幂等重建，不落挂载目录）。需要更强隔离时可在 compose 给该目录挂 tmpfs：`tmpfs: [/run/pi-box]`。
- **只给任务用的变量**（不进 `.env`、改完不必重启容器）：编辑 `/workspace/.cron/env`（sh 语法，如 `export API_KEY=xxx`），`pi-job`/`pi-run` 每次运行都会加载，优先级高于自动导出。
- **注意**：cron 行中的变量由 cron 自身解析，只有经由 `pi-job` 包装的命令（本项目的规范写法）才会拿到上述变量。

### 任务状态与日志

```bash
podman exec pi-box pi-job status           # 所有任务：是否在跑、上次结果、时长
podman exec pi-box pi-job log <任务ID>     # 查看某任务最近日志（默认 1 个，可传 n）
```

- 日志：`workspace/.cron/logs/<任务ID>/`（每次运行一个文件，`latest.log` 软链最近一次，每任务最多保留 50 个）。
- 状态：`workspace/.cron/state/<任务ID>.json`（last_start / last_exit / last_duration / running / pid）。
- **加锁**：每任务独立 flock，同一任务重叠执行时自动跳过本次（如 5 分钟调度、实际跑 10 分钟，第二次自动跳过），不同任务互不阻塞。锁在容器 `/tmp/pi-job-locks/`，重启自动清空。

### 常用命令

```bash
podman compose logs -f pi      # 容器日志（pi-boxd / cron）
podman compose restart         # 重启（cron 任务自动恢复）
podman compose down            # 停止（保留数据卷目录）
```

## 注意事项

- **rootless 权限模型**：rootless podman 中容器内 root = 宿主机当前用户，所以挂载目录读写无需处理属主。rootful Docker 下则要加非 root 用户并 `chown`。
- **边界是软硬结合的**：提示词（AGENTS.md）是软约束，硬边界靠容器 + 只挂载 `/workspace` + 网络隔离实现。需要更强隔离可加 `--cap-drop=ALL` 或对 workspace 部分只读挂载。
- **凭据隔离**：pi-boxd 模型配置保存在 `/home/agent/.pi-boxd/config.json`；cron 中的 pi CLI 使用 `~/.pi/agent`。cron 的 session 单独放在 `/workspace/.cron/sessions`。
- **restart 策略**：rootless podman 默认不自动拉起容器（restart: unless-stopped 依赖 systemd）。长期常驻可用 `podman generate systemd --new --name pi-box` 生成 systemd unit，或 `podman-compose up -d` 后手动维护。
- **时区**：cron 按 `TZ` 环境变量执行，默认 `Asia/Shanghai`，在 `.env` 里改。
