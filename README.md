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

## 内置消息渠道（msg-hub）

镜像内置 [msg-hub](https://github.com/iridesc/msg-hub) 的 **stdio 版**，作为 MCP server 由 pi-boxd 以子进程方式拉起，用于「把某个群加成渠道」和「往某某群发条消息」。

- **源码位置**：`/opt/msg-hub`（构建期从上游仓库拉取，**不 vendor**，见 `Dockerfile` 的 `MSG_HUB_REPO` / `MSG_HUB_REF`）
- **默认配置**：`pi-boxd/seed/mcp.json`，首启自动复制到 `~/.pi/agent/mcp.json`（已存在则**不覆盖**）
- **数据目录**：`agent-home/.pi-boxd/msg-hub/`（渠道索引 `channels.json`、凭据 `config/<id>.json` 0600、审计 `logs/*.jsonl`）
- **依赖**：零第三方依赖，只要 `python3`（镜像自带 3.11）

```json
{
  "mcpServers": {
    "msg-hub": {
      "command": "python3",
      "args": ["/opt/msg-hub/src/msg_hub/stdio.py"],
      "env": { "MSG_HUB_DATA_DIR": "/home/agent/.pi-boxd/msg-hub" },
      "exposure": "direct"
    }
  }
}
```

支持两种渠道类型：`wecom_bot`（企业微信群机器人 webhook，支持 markdown / @成员 / @所有人）与 `email`（SMTP，支持 SSL/STARTTLS/SOCKS5 代理）。要给某个助理或 Agent 用，在它的 `.md` frontmatter 里加 `mcps: [msg-hub]`。

**升级 msg-hub**：上游发布新版本后，重新构建 pi-box 镜像即可（`podman compose build && podman compose up -d`）。想钉住版本就用 `--build-arg MSG_HUB_REF=v0.2.0`。

> msg-hub 的渠道数据在 `agent-home` 里，与 Durable SQLite、mcp.json 同域备份；不要把渠道凭据放进 `workspace`。

## 模型与厂商配置

系统设置 → 模型支持同时配置多个厂商（OpenAI / DeepSeek / Anthropic / Gemini / Groq / OpenRouter / MiniMax 等），每个厂商可配置多个模型 ID、各自的 API Key 与 Base URL，全部持久化到 `agent-home/.pi-boxd/config.json`（`version: 3`，旧版单模型配置会自动迁移）。

- 每个厂商勾选「设为默认」后即成为全局默认模型；未显式指定模型的角色回退到它。
- 助理 / 子 Agent 的 frontmatter 用 `model` 字段指定模型，两种写法都支持：
  - `model: gpt-4o-mini` —— 纯 modelId，先在全局默认厂商里找，再在所有已配置厂商里唯一匹配；
  - `model: anthropic/claude-sonnet-4-5` —— `provider/modelId`，精确指定厂商与模型。
- 解析不到可用模型时回退到全局默认模型；所有厂商会同时加载，互不影响。

管理台采用四栏布局：第一栏选择项目、助理或 Agent，第二栏展示该角色的全部会话及实时状态，第三栏展示当前会话内容，第四栏只展示当前会话及其派生子会话的 Durable 任务图。运行状态属于具体会话，同一个 Agent 可以同时拥有多个会话。

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

## 品牌（标签页标题与图标）

系统设置 → 系统 → 🏷 品牌可自定义浏览器标签页的外观，全局单份（所有访客一致），页面左上角的品牌名固定为 `pi-box`：

- **页面标题**：写入 `<title>`，最长 120 字符，留空回退默认 `pi-box · 多 Agent 平台`。
- **图标**：三种模式——默认（内置 `favicon.svg`）/ Emoji（任意一个 emoji，前端内联成 SVG data URL）/ 上传图片（png、jpeg、webp、svg、ico，≤ 512KB）。

持久化与接口：

- 偏好存 `agent-home/.pi-boxd/prefs.json` 的 `appTitle` / `appIcon` 字段；上传的图标落在 `agent-home/.pi-boxd/branding/icon.<ext>`（随 `agent-home` 一起持久化）。
- `POST /api/branding/icon`（`{ dataUrl }`）上传、`DELETE /api/branding/icon` 恢复默认、`GET /api/branding/icon` 读取（未上传时回退内置 SVG）。上传的 SVG 以 `Content-Security-Policy: sandbox` + `nosniff` 提供，避免被直接打开时执行脚本。
- 标题与图标在页面启动时由 `/api/prefs` 应用，保存后立即生效，无需刷新。

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
        ├── skills/*/SKILL.md  # 项目私有 Skill（可选，同名覆盖用户/内置）
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

## Skill 管理

Skill 是「按需加载的专项说明」：系统提示词里只登记名字、描述和文件路径，模型判断任务匹配时才用 `read` 读取正文，不会一直占满上下文。

### 技能库（文件只有一份）

```text
/opt/pi-box/skills/<name>/SKILL.md          # 内置（只读，镜像自带）
/home/agent/.pi/agent/skills/<name>/SKILL.md # 用户库（界面上的「上传」落在这里）
<项目>/.pi/skills/<name>/SKILL.md           # 项目私有（同名覆盖用户/内置）
```

Skill 目录可以带 `scripts/`、`references/` 等附属文件，正文里的相对路径按 SKILL.md 所在目录解析。

### 谁在用哪些 Skill

“启用哪些 skill”是**角色级**配置，写在各自的 `.md` frontmatter 里：

```markdown
---
model: gpt-4o
tools: [read, bash]        # 启用 skill 必须保留 read
skills: [pdf-tools]        # 不写 = 不启用任何 skill
---
```

- 助理写 `.pi/assistant.md`，子 Agent 写 `.pi/agents/<name>.md`；主会话与子会话各自按自己的清单注入。
- 系统设置 → Skills 里的开关是**全局闸门**：关掉后任何角色都无法使用（用户库里写一个 `.disabled` 标记）。
- 最终生效 = 全局启用 ∧ 属于该角色的清单。上传一个 skill 不会自动对所有角色生效。
- 引用不存在的 skill 会在保存配置时被拒绝；skill 被删除后，其他角色会跳过它并记录日志。

### read 是硬依赖

Skill 正文靠 `read` 工具加载，因此配置了 skill 就必须启用 `read`：界面勾选 skill 时会自动勾上并锁定 `read`，后端保存时也会校验（`tools` 未配置时视为继承默认工具集，天然含 `read`，不报错）。

### 注入机制

Skill 由独立的 Durable 扩展 `pi-box-skills` 的 prompt section 注入，**每次请求现算**：改 frontmatter、改全局开关、重新上传，下一轮对话立即生效，不需要重启，也不需要同步已有会话（包括已 spawn 的子 Agent 和定时任务的隔离会话）。子 Agent spawn 时只移除 `pi-box` 扩展（防递归），不影响 skill 注入。

### 上传与管理

在「系统设置 → Skills」上传单个 `SKILL.md`（可附选整个目录一并上传 `scripts/`、`references/` 等文本文件）。也可以直接调 API：

```bash
curl -s -X POST http://127.0.0.1:8790/api/skills/upload \
  -H 'Content-Type: application/json' \
  -d '{"name":"pdf-tools","content":"---\nname: pdf-tools\ndescription: 从 PDF 提取文本与表格。\n---\n\n正文"}'
```

名称须符合 Agent Skills 规范（小写字母/数字/连字符，≤64 字符），`description` 必填（≤1024 字符），且 frontmatter 的 `name` 必须与目录名一致。

> ⚠️ Skill 可以指示模型执行脚本，上传等同于授予在本容器内执行的权限；请只安装可信来源。

## 项目定时任务

定时任务在项目设置页面配置。支持每隔一段时间、每天、工作日、每周、每月以及指定时间仅运行一次，也可以手动立即运行。

每个任务由两个可选阶段组成，因此分三类：

| 类型 | 配置 | 行为 |
|---|---|---|
| 纯命令 | `command` | 到点直接 `bash -c` 执行，**不创建会话、不消耗 token** |
| 纯模型 | `llm` | 把提示词交给指定角色执行，产生会话 |
| 命令 + 模型 | 两者 | 先跑命令，再把输出（`{{stdout}}` / `{{exitCode}}` / `{{logPath}}` / `{{durationMs}}`）交给模型出结论 |

- 命令段可配 `timeoutSec`（默认 900）与 `concurrency`（`skip` 重叠跳过 / `queue` 允许并行），由 `bash -c` 在项目目录执行，环境变量沿用容器全局配置。
- 模型段可配 `agent`（`assistant` 或 `agent:<项目内子 Agent>`）、`session`（`ephemeral` 每次新建 / `persistent` 沿用会话）、`onCommandFailure`（命令失败时是否继续交给模型）与 `reportTo`（`none` / `main`）。
- 每次运行都是一个 Durable 任务（`pibox.schedule.command` + 子任务 `pibox.schedule.llm`），带 `abandonOnRestart`：进程重启时中断而不重跑，避免重复执行有副作用的命令。
- 运行日志：`<项目>/.pi/schedule-logs/<任务 id>/<YYYYmmdd-HHMMSS>.log`（含命令输出与模型回答，`latest.log` 指向最近一次），单次输出上限可配（默认 20 MB）。
- 任务定义与最近运行记录保存在 `<项目>/.pi/schedules.json`，Durable 执行状态与完整会话历史保存在 SQLite 中。没有 `command` / `llm` 字段的旧任务（只有 `prompt`）继续按「纯模型」执行，以保持兼容。

## 数据清理

设置 → 🧹 数据清理，集中管理日志与数据库的保留策略（配置存在 `agent-home/.pi-boxd/cleanup.json`）。

| 项 | 默认 | 说明 |
|---|---|---|
| 日志默认保留天数 | 7 | 单个任务可用 `log.retentionDays` 覆盖；`0` = 不删除 |
| 单次输出上限 | 20 MB | 命令输出超过后截断，避免单任务擑爆磁盘 |
| 自动清理日志 | 开 | 每 6 小时检查一次，在线删文件，**不中断服务** |
| 任务/会话保留天数 | 90 | 删除早于该天数的已结束任务及其独立会话、消息、文档 |
| 清理后压缩（VACUUM） | 开 | 需要约等于库大小的临时磁盘空间；不够或失败会如实报告并跳过 |
| 自动清理数据库 | 开 | 每天到点执行，**仅在确认没有任务运行时**才动手 |
| 自动清理时间 | 03:30 | 容器时区 |
| 运行记录条数 | 300 | 每个任务在 `schedules.json` 里保留的最近运行记录数 |

两类清理的风险等级不同：

- **日志清理**是纯文件删除，运行中可以随时执行。
- **数据库清理**必须先把 Harness（及其 SQLite 连接）关掉，因为 `VACUUM` 需要独占写锁，而且 pi-durable 在内存里缓存了文档与上下文。因此点「立即清理并压缩」会走一个短维护窗口：停调度 → 中断运行中的任务 → 关 Harness → 删数据 + VACUUM → 重建 Harness（实测约 15–30 ms，有运行中任务时更长）。窗口内其它接口返回 503。

安全边界：只删「已结束且超过保留期」的任务，以及它们拥有的独立会话（项目主会话的 `owner_task_id` 为空，永远不会被选中）；`record_ids`（ID 分配表）不动。


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
- `PI_BOX_USER_SKILLS_DIR`：用户 Skill 库；默认 `~/.pi/agent/skills`。
- `PI_BOX_BUILTIN_SKILLS_DIR`：内置 Skill 库；默认 `/opt/pi-box/skills`。
- `PORT`：HTTP 监听端口；镜像默认 `8790`。
- `PI_BOX_AUTH_USERNAME` / `PI_BOX_AUTH_PASSWORD`：应用层 HTTP Basic Auth；密码为空时禁用认证。

## 安全建议

- 管理台只绑定到 `127.0.0.1`，通过 Caddy/Nginx 提供 HTTPS。
- 为 `.env`、模型配置、MCP 配置和 SQLite 数据库设置严格权限。
- 不要把 `agent-home` 或项目敏感文件提交到 Git。
- 定期检查 `.pi-box-trash` 并按恢复策略清理。
