# pi-box：持久化多 Agent 管理台

`pi-boxd` 基于 `pi-durable` 提供按项目隔离的持久会话、后台子 Agent、MCP、项目级定时任务和 Web 管理台。会话、任务、模型配置与 Agent 配置在容器重启后恢复。

## 架构

- `/workspace`：用户项目、项目 Agent、全局 Agent 与项目定时任务配置。
- `/home/agent/.pi-boxd`：Durable SQLite、模型配置和应用偏好。
- `/home/agent/.pi/agent`：MCP 配置、用户 Skills 与相关运行数据。
- 项目定时任务由 pi-boxd 内置调度器发现，并作为 Durable submission 提交给项目助理；不依赖 Linux cron 或 crontab。

```text
pi-box/
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh
├── pi-boxd/                 # Durable 守护进程、HTTP API 与 Web 管理台
├── workspace/               # 宿主机持久化项目目录
└── agent-home/              # 宿主机持久化应用 HOME
```

## 启动

```bash
cp .env.example .env
podman compose up -d --build
```

打开 <http://127.0.0.1:8790>，在系统设置中配置模型厂商、模型、API Key、MCP 与全局 Agent。

生产环境推荐只拉取已发布镜像，并删除 Compose 中的 `build: .`：

```yaml
services:
  pi:
    image: irid/pi-box:latest
    container_name: pi-box
    restart: unless-stopped
    volumes:
      - ./workspace:/workspace
      - ./agent-home:/home/agent
```

## 项目数据

`/workspace` 下每个非隐藏一级目录都是一个项目：

```text
/workspace/
├── .pi-box/
│   └── agents/                # 全局 Agent
└── <项目>/
    └── .pi/
        ├── assistant.md       # 项目助理配置
        ├── agents/*.md        # 项目 Agent
        └── schedules.json     # 项目定时任务及运行记录
```

项目助理可以通过 `subagent` 工具启动持久子会话。项目 Agent 创建后始终可用；全局 Agent 需要在项目助理配置中显式启用。

删除项目时，目录会先移动到 `/workspace/.pi-box-trash`，便于人工恢复。

## 元项目（pi-box-expert）

pi-box 启动时会在 `agent-home/.pi/agent/meta/` 下安装一个**身份特殊的内置项目**，代号 `pi-box-expert`。它不是用户创建的业务项目，而是平台级的“管理员项目”，在左侧项目列表中始终排在最前面，标记为 🔧。

### 与业务项目的区别

| 维度 | 业务项目 | 元项目 |
|---|---|---|
| 位置 | `/workspace/<name>/` | `/home/agent/.pi/agent/meta/` |
| 创建方式 | UI “+ 新建项目” | 镜像内置，首启自动安装 |
| 项目助理提示词 | 业务定位、可改 | 写死为管理员身份，UI 不可编辑 |
| 助理文件权限 | 可改 | `chmod 444`、API 拒绝改写 |
| 子 Agent | 项目级 + 全局 | 独立库 `meta/agents/*.md`，业务项目助理看不到 |
| 子 Agent 创建 | UI / API 可创建 | 宿主机直接 `write` `.md` |
| 面向客户 | 交互主题 | 平台管理 |
| `name === "meta"` | 拒绝 | 占位名 |

### 元项目能做什么

- **读**：所有业务项目的源码、`.pi/assistant.md`、`.pi/agents/*.md`、`.pi/schedules.json`、项目任意文件；业务项目助理的 Durable 会话（只读 snapshot）。
- **读写**：业务项目的助理提示词、Agent 定义、定时任务；全局 `config.json` / `prefs.json` / `mcp.json`；自己目录下的子 Agent。
- **不能做**：给业务项目助理的会话发消息 / reset / abort；调用 `/api/schedules/run` 触发业务项目的 schedule；删除自己目录下的预置 Agent。

### 怎么使用

1. 启动后在左侧项目列表最上面看到 🔧 `meta（元项目）`。
2. 点开它，与 `pi-box-expert` 助理对话；典型问题：
   - “帮我看看 /workspace 下所有项目状态怎么样”
   - “优化 `test` 项目的助理提示词”
   - “为 `travel` 加一个每天 9 点总结昨日日志的定时任务”
   - “在全局 Agent 库新建一个 `code-reviewer`”
3. 元项目助理会调 `bash` + 后端 API 读写文件与配置，操作透明可追。

### 怎么修改元项目助理提示词

只允许在宿主机手动改，首启后 file 已是只读（`chmod 444`）。需要更新时：

```bash
chmod 644 agent-home/.pi/agent/meta/assistant.md
# 编辑后
chmod 444 agent-home/.pi/agent/meta/assistant.md
```

或者重新部署 image（从 `pi-boxd/seed/meta/assistant.md` 拉取新版；仅在本地不存在时复制）：

```bash
rm agent-home/.pi/agent/meta/assistant.md
podman compose restart
```

### 元项目子 Agent 怎么加

```bash
cat > agent-home/.pi/agent/meta/agents/<name>.md <<'EOF'
---
locked: true        # 预置 agent 一般加锁，防止被误删（依然可通过 tools:[] 软停用）
---

你是 <role> ... 提示词 ...
EOF
chmod 444 agent-home/.pi/agent/meta/agents/<name>.md
podman compose restart
```

`locked: true` 只能宿主机改；被锁定的 Agent 在 UI 中显示 🔒、不能编辑、不能删除、不能通过 API 改写。“软停用”只需将其 frontmatter `tools:` 改为空数组 `[]`，助理仍然在但子 agent 不会被 spawn。

## 项目定时任务

定时任务在项目设置页面配置。支持每隔一段时间、每天、工作日、每周、每月以及指定时间仅运行一次。每项任务可以单独设置时区、启用状态和任务说明，也可以手动立即运行。

到期后，调度器向该项目的主助理提交一次 Durable 任务。助理可以调用项目中所有已启用的子 Agent。定义和最近运行记录保存在 `<项目>/.pi/schedules.json`，Durable 执行状态保存在 SQLite 中。

## 持久化与备份

生产环境只需备份：

```text
workspace/
agent-home/
```

备份 `agent-home/.pi-boxd/session.sqlite*` 时应先停止容器，确保 SQLite 主文件、WAL 和 SHM 一致。

`agent-home` 可能包含模型 API Key、MCP Token 和聊天记录，应限制宿主机访问权限，不要提交到 Git。

## 常用命令

```bash
podman compose up -d
podman compose logs -f pi
podman compose restart pi
podman compose down
```

## 环境变量

- `TZ`：容器时区，默认 `Asia/Shanghai`。
- `PI_BOXD_DATA_DIR`：Durable 数据目录；镜像默认 `/home/agent/.pi-boxd`。
- `PORT`：HTTP 监听端口；镜像默认 `8790`。
- `PI_BOX_AUTH_USERNAME` / `PI_BOX_AUTH_PASSWORD`：应用层 HTTP Basic Auth；密码为空时禁用认证。

## 安全建议

- 管理台只绑定到 `127.0.0.1`，通过 Caddy/Nginx 提供 HTTPS。
- 为 `.env`、模型配置、MCP 配置和 SQLite 数据库设置严格权限。
- 不要把 `agent-home` 或项目敏感文件提交到 Git。
- 定期检查 `.pi-box-trash` 并按恢复策略清理。
