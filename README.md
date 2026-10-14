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
