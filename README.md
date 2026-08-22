# pi-box：容器内常驻 Pi + pi-web + cron 周期任务

零改动 pi 与 pi-web 本体：pi-web 提供 Web 自然语言界面，容器内 cron 驱动周期任务，两者共享同一份凭据与同一份工作区规则。

## 目录结构

```
pi-box/
├── Dockerfile            # 预装 pi CLI + pi-web + cron
├── docker-compose.yml    # 挂载 workspace 与 agent-data，端口 8000
├── entrypoint.sh         # 安装系统提示词 + 启动 cron + pi-web
├── bin/pi-job            # cron 任务包装：非交互跑一次 pi，日志落盘
├── system-prompt/
│   └── SYSTEM.md         # 通用系统提示词模板（构建进镜像，首启自动安装）
├── skills/
│   └── cron-jobs/        # 定时任务管理 skill（SKILL.md + 工具 cron-job.sh）
└── workspace/            # ← 挂载目录，宿主机直接编辑
    └── .cron/
        ├── jobs          # 周期任务配置（crontab 语法，唯一配置源）
        ├── logs/<id>/    # 任务日志（每次运行一个文件 + latest.log）
        └── state/<id>.json  # 运行状态（pi-job status 查询用）
```

## 系统提示词在哪儿配置

pi-web 会话信息面板的「系统提示词」由 pi 按以下优先级组装：

| 配置 | 位置 | 作用 |
|------|------|------|
| 内置基础提示词 | pi 代码内置 | 默认提示词（编码助手定位），不可直接编辑 |
| `SYSTEM.md` | `~/.pi/agent/SYSTEM.md`（全局，本镜像内置模板自动安装）或 `.pi/SYSTEM.md`（项目） | **完全替换**内置提示词；pi-box 用它把系统改造成**通用智能助手**（非编码定位） |
| `AGENTS.md` / `CLAUDE.md` | `/workspace/AGENTS.md`（cwd 及上级）或 `~/.pi/agent/AGENTS.md`（全局） | **追加**为 `<project_context>` 段落，工作区业务约定放这里 |
| `APPEND_SYSTEM.md` | `.pi/APPEND_SYSTEM.md` 或 `~/.pi/agent/APPEND_SYSTEM.md` | **追加**到基础提示词之后 |
| CLI 参数 | `--system-prompt` / `--append-system-prompt` | 单次运行覆盖/追加 |

**通用提示词的安装机制**：镜像内预置 `system-prompt/SYSTEM.md` 模板，容器首启时由 entrypoint 自动安装到全局 `~/.pi/agent/SYSTEM.md`（全局路径对 pi-web 会话与 cron 任务同时生效）。若宿主机 `agent-data/agent/SYSTEM.md` 已存在则跳过安装——**想自定义提示词时，在宿主机放一个同名文件即可覆盖**。

**定时任务能力（cron-jobs skill）**：周期任务的增删改查不写在系统提示词里，而是做成 skill（镜像内置，首启安装到 `~/.pi/agent/skills/cron-jobs/`）。skill 采用渐进披露：系统提示词只注入一行描述，agent 在用户要求配置定时任务时才加载完整指令，并通过 `cron-job.sh` 工具操作（list/add/remove/reload，自动校验 ID 重复并重载 crontab）。

> 注意：AGENTS.md 必须放在工作目录**根**（如 `/workspace/AGENTS.md`）或上级目录，放 `.pi/` 子目录里不会被加载。修改提示词文件后**新会话**生效（已创建的会话提示词不变）。

## 使用（podman）

```bash
cd pi-box
cp .env.example .env     # 设置 PI_WEB_PASSWORD（可选）
podman compose up -d --build
```

打开 http://127.0.0.1:8000（用户名 `pi` + 密码），在 Models 面板登录模型提供商 —— 登录后 cron 任务自动复用凭据。系统默认为**通用智能助手**（非编码定位），提示词由镜像内置模板自动安装，见上文「系统提示词在哪儿配置」。

> **首次启动自动引导**：entrypoint 会在容器启动时检测 `/workspace` 是否已有会话，没有则自动创建一个引导会话（发一条最小 prompt 让模型回复后落盘）。这样 pi-web 打开后 `/workspace` 已是被信任的项目目录，侧边栏"新建对话"按钮直接可用（pi-web 的"新建对话"依赖已选中的项目目录，而目录只有在存在落盘会话后才被信任）。

### 配置周期任务（两种方式）

**统一任务模型**：任务 = 一条 shell 命令，不区分类型。

- **Agent 任务**（需要模型理解/执行）：命令用 `pi-run "自然语言描述"`（非交互跑一次 pi）
  `pi-job --id <任务ID> 'pi-run "任务描述"'`
- **纯脚本任务**（不需要模型）：直接用命令，如 `bash /workspace/.cron/scripts/check.sh`
  `pi-job --id <任务ID> 'bash /workspace/.cron/scripts/check.sh'`

**方式一：网页自然语言**。在 pi-web 里直接说：
> 每天早上 9 点总结 /workspace/logs 昨天的日志
> 把刚才那个任务改成每 30 分钟一次
> 加一个每 5 分钟执行的脚本任务，跑 /workspace/.cron/scripts/check.sh

agent 会通过 cron-jobs skill（工具 `cron-job.sh`）编辑 `/workspace/.cron/jobs` 并执行 `crontab ...` 重载。

**方式二：直接编辑文件**。宿主机改 `workspace/.cron/jobs`（crontab 语法），然后：

```bash
podman exec pi-box crontab /workspace/.cron/jobs   # 重载
podman exec pi-box crontab -l                      # 查看生效任务
```

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
podman compose logs -f pi      # 容器日志（pi-web / cron）
podman compose restart         # 重启（cron 任务自动恢复）
podman compose down            # 停止（保留数据卷目录）
```

## 注意事项

- **rootless 权限模型**：rootless podman 中容器内 root = 宿主机当前用户，所以挂载目录读写无需处理属主。rootful Docker 下则要加非 root 用户并 `chown`。
- **边界是软硬结合的**：提示词（AGENTS.md）是软约束，硬边界靠容器 + 只挂载 `/workspace` + 网络隔离实现。需要更强隔离可加 `--cap-drop=ALL` 或对 workspace 部分只读挂载。
- **凭据共享**：pi-web 与 cron 共用 `~/.pi/agent`（auth.json / settings.json），网页登录一次两处生效；cron 的 session 单独放在 `/workspace/.cron/sessions`，避免与 pi-web 的 session 锁冲突。
- **restart 策略**：rootless podman 默认不自动拉起容器（restart: unless-stopped 依赖 systemd）。长期常驻可用 `podman generate systemd --new --name pi-box` 生成 systemd unit，或 `podman-compose up -d` 后手动维护。
- **时区**：cron 按 `TZ` 环境变量执行，默认 `Asia/Shanghai`，在 `.env` 里改。
