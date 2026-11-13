# pi-box 架构索引

这份文档给 agent 读，不给人读。目的只有一个：**回答「pi-box 怎么实现 X / 为什么这样设计」时，知道去哪找，以及别凭印象编。**

规则：

1. 涉及实现细节，先去源码里确认。本文只给地图，不给答案。
2. 本文与源码冲突时，以源码为准，并指出本文过期的地方。
3. 不要在第 1 层（本文）找到答案后就停止。本文第 8 节列了「常见问题的入口文件」，去读那里的注释——大部分模块头部有 `// 设计要点` 段落，写的是理由。

---

## 1. 这是什么

单进程 Node 服务（包名 pi-boxd）。它把 `pi-durable-web` 的持久化会话能力，包装成一个多 Agent 管理台：项目管理、助理、子 Agent、定时任务、报告、文件浏览。

同一个进程里跑着五样东西：

| 东西 | 说明 |
|---|---|
| HTTP 服务 | `pi-durable-web/src/core.mjs` 的 `createWebServer` |
| Harness | 每个会话一个，持久的（存在 SQLite），不是每请求新建 |
| 定时任务调度器 | 进程内 cron 循环，到点 spawn |
| MCP 桥 | 把 MCP server 的工具注入 agent |
| 清理调度器 | 日志在线清；数据库清理会短暂中断服务 |

技术约束（改动前必须知道）：

- 前端**无框架、无构建**。`web/app.js` + `web/style.css` 直接进镜像，浏览器原样加载。没有 webpack/vite/tsc。
- 后端**不用 ORM**。配置一律 JSON / Markdown 落盘；只有会话数据进 SQLite。
- 一切路径都用绝对路径常量，集中在 `src/paths.mjs`，全部支持环境变量覆盖。

## 2. 启动顺序

`src/index.mjs` 是唯一入口，顺序不可随意调换：

```
initProvider()        读 config.json，没有 key 就退到 faux（离线假模型）
refreshProvider()     把已配置厂商的模型全部加载进 pi-ai 的 Models 集合
bootRuntime()         装配 Harness / Context / MCP 桥 / 调度器
harness.resume()      恢复上次进程遗留的 generation / tool / reporter 持久任务
startCleanupScheduler()
createWebServer({harness, context, getSnapshot, createConversation, extraRoutes, webDir})
installStaticOptimizer(server)    gzip + ETag + 缓存头
installReportPages(server)        /reports 与公开报告 /r/*
installBasicAuth(server, {exempt: isPublicReportRequest})
server.listen(PORT)
```

两条关键事实：

- **中间件顺序有意义。** 静态优化装在认证内侧（认证仍覆盖静态资源）。报告页必须装在 basicAuth **之前**，否则豁免后的请求还要再穿一层。
- **`harness` / `context` 是转发代理（Proxy）。** 数据清理会在同一进程内重建 Harness，代理自动指向新实例。任何模块都不要长期持有 `harness` 的原始引用，只持有代理。

## 3. 目录布局（容器内）

| 路径 | 内容 | 可写 |
|---|---|---|
| `/home/pi-boxd/app/` | 程序本体：`src/`、`web/`、`README.md`、`docs/` | 否（镜像内） |
| `/home/pi-boxd/seed/` | 首次启动的模板：`SYSTEM.md`、`meta/assistant.md`、`mcp.json` | 否 |
| `/workspace/` | 所有业务项目的根，`/workspace/<项目名>/` | 是 |
| `/workspace/.pi-box/agents/` | 全局 Agent 库 | 是 |
| `/home/agent/.pi/agent/` | 系统级配置：`SYSTEM.md`、`skills/`、`mcp.json` | 是 |
| `/home/agent/.pi/agent/meta/` | 元项目：`assistant.md`、`agents/` | 部分（`assistant.md` 是 444） |
| `/home/agent/.pi-boxd/` | 运行时数据：`config.json`、`prefs.json`、`session.sqlite` | 是 |

程序本体是只读的。**任何改造都要走「改源码 → 重新构建镜像」的路径，不能在容器里就地改。**

## 4. 后端模块表

`src/` 下 23 个模块。一句话职责，细节读文件头注释。

| 模块 | 职责 |
|---|---|
| `index.mjs` | 入口：装配 + 启动 + 优雅退出 |
| `paths.mjs` | 全部路径常量，支持环境变量覆盖。**要加新目录先改这里** |
| `routes.mjs` | HTTP 路由（`extraRoutes`）。**加 API 就改这里** |
| `auth.mjs` | HTTP Basic Auth，支持 `exempt` 豁免回调 |
| `static.mjs` | 静态资源：gzip + ETag + 缓存头 |
| `harness.mjs` | Harness 创建、项目主会话管理、配置同步、`boxSnapshot`（前端首屏快照） |
| `runtime.mjs` | 运行时装配与**同进程重建**：Harness / Context / MCP 桥 / 调度器 |
| `model.mjs` | 全局模型状态，多厂商加载，无 key 退 faux |
| `providers.mjs` | 支持的 LLM 厂商列表与默认值 |
| `agents.mjs` | Agent 定义 / 助理 / 项目扫描。文件即真相 |
| `skills.mjs` | Skill 库：扫描 / 解析 / 校验 / prompt 渲染 / 上传 |
| `skills-extension.mjs` | Skill 注入扩展（必须是独立扩展，见第 7 节） |
| `extension.mjs` | 主扩展：`subagent` 工具 + Anchor + Reporter |
| `report-tools.mjs` | 报告工具扩展：`report_publish/list/read/delete` |
| `reports.mjs` | 报告组存储层：CRUD、publish、敏感扫描、保留期清理 |
| `report-pages.mjs` | 报告阅读页 `/reports` 与公开访问 `/r/*`，含 CSP |
| `schedules.mjs` | 定时任务定义：规则类型、会话模式、增删改 |
| `schedule-log.mjs` | 定时任务运行日志：落盘、保留清理、并发锁、幂等标记 |
| `exec.mjs` | 命令执行：spawn + 流式输出 + 超时杀整个进程组 |
| `files.mjs` | 项目文件浏览：列目录、文本预览、原文件流（Range）、上传 |
| `cleanup.mjs` | 数据清理：日志（在线安全）与数据库（需短暂中断） |
| `io.mjs` | 配置读写 + HTTP body 工具 |
| `mcp-bridge.mjs` | MCP server 连接与工具注入 |

## 5. 前端结构

单文件，约 5000 行。没有模块系统，靠函数名组织。

| 位置 | 内容 |
|---|---|
| `web/app.js` | 全部逻辑：状态、渲染、事件、路由 |
| `web/style.css` | 全部样式。深色主题，CSS 变量在顶部 |
| `web/index.html` | 极简骨架，只有挂载点 |

`app.js` 的组织方式：

- `el(tag, props, children)` —— 唯一的 DOM 构造辅助函数，全局可用。
- `state` —— 全局快照对象，由 `refresh()` 从 `/api/state` 拉取后整体替换。
- 渲染函数命名 `renderXxx()`，几乎都是「清空容器 → 重新 append」。
- 弹窗统一 `.drawer-submodal-backdrop` + `.drawer-submodal`，变体类单独设宽度（基类 `max-width` 会截断，变体必须自己声明 `max-width`）。
- 文件末尾有启动分支，会按 URL 决定走主界面还是独立阅读页（`REPORT_ROUTE`）。**改动时注意不要把启动入口重复执行。**

前端有三条硬规矩：

1. 不引入构建工具。写的代码必须浏览器直接能跑（原生 ES module 或普通 script）。
2. 不引入框架。用 `el()` 手写。
3. CSS 用现有变量，不要硬编码颜色。

## 6. 数据落盘

| 数据 | 位置 | 形态 |
|---|---|---|
| 会话（消息、锚点、任务图） | `DATA_DIR/session.sqlite` | SQLite |
| 全局配置（厂商、模型、key） | `DATA_DIR/config.json` | JSON |
| UI 偏好 | `DATA_DIR/prefs.json` | JSON |
| 项目 | `PROJECTS_DIR/<name>/` | 目录 |
| 项目助理 | `<项目>/.pi/assistant.md` | Markdown + frontmatter |
| 项目子 Agent | `<项目>/.pi/agents/<name>.md` | Markdown + frontmatter |
| 全局 Agent | `GLOBAL_AGENTS_DIR/<name>.md` | 同上 |
| 定时任务 | `<项目>/.pi/schedules.json` | JSON |
| 定时任务日志 | `<项目>/.pi/schedule-logs/<id>/` | 文本 |
| 报告组 | `<项目>/.pi/reports/<组名>/` | JSON meta + md/html |
| 公开报告索引 | `DATA_DIR/reports-public.json` | JSON |

核心原则：**文件即真相。** 没有注册表，没有缓存一致性层。目录里有什么就是什么，读盘即读状态。加数据前先想清楚「能不能不建表」。

## 7. 关键设计决策

这些决策的理由**在源码里读不出来**（代码只写怎么做），下面是要点，细节看对应文件头。

### 为什么扩展要拆成三个

`extension.mjs` / `report-tools.mjs` / `skills-extension.mjs` 必须各自独立。

原因：spawn 子 agent 时会执行 `extensions.remove(PiBoxExtension)`，把主扩展拿掉。如果报告工具或 skill 注入塞在同一个扩展里，子 agent 就丢工具、丢 skill。

**推论**：任何「子 agent 也要用」的能力，都不能挂在 `extension.mjs` 里。

### 为什么报告组是「容器」不是「版本」

组内每次发布都是独立完整的文档，用时间戳命名。没有「第 N 版」，`latest` 就是列表第一项。

理由：拼版本链就要维护 parent 指针，还要处理分叉与回滚。审计报告天然是一次性快照，不需要版本血缘。

### 为什么报告只允许单文件自包含

写入时扫描 `script/link/img/iframe/video/audio/source/object/embed/use` 标签、`url()`、`@import`，外链一律拒绝。

理由：CDN 上的 JS 等于同源 RCE；外链图片会泄漏访客 IP 和 Referer。

### 为什么用 CSP 而不是子域隔离

报告内容的 CSP 是 `sandbox allow-scripts` + `connect-src 'none'`。

- `allow-scripts` 让报告能跑图表脚本。
- **绝不能加 `allow-same-origin`**，否则沙箱形同虚设。
- `connect-src 'none'` 关死一切外发请求。

子域隔离需要额外域名和证书，CSP 不需要。已实测：报告内 `fetch('/api/state')` 被拒，`document.cookie` 抛 SecurityError，iframe origin 是 `null`。

### 为什么报告可见性只能人操作

agent 没有设置可见性的工具，只能在组内发布。

理由：公开 = 数据出网。让 agent 决定数据出网，等于把「误发」变成一个默认可能。

### 为什么绑定即授权

Agent 的 frontmatter 写 `reports: [组名]` 才能发布到该组。没绑定就调用会被拒，并提示怎么绑。

推论：

- 组名从绑定推导，**不要写进提示词**。提示词里记路由信息必然过期。
- 发布到不存在的组**报错，不自动建组**。自动建组会让 agent 随手造出垃圾组。

### 为什么定时任务支持「命令 + LLM」组合

纯命令任务跑完没法写报告（没有 LLM）。正确做法是：命令把结构化结果写文件，LLM 段用 `read` 读文件再总结。

注意 `exec.mjs` 的命令 stdout 只保留尾部 16000 字符，提示词模板只用其中 4000（`PROMPT_SOURCE_CHARS`）。数据量大就走文件，不要指望 stdout。

### 为什么元项目助理的提示词文件是 444

`meta/assistant.md` 只允许首启写入，之后 API 改写会被拒。

理由：这是平台管理员自己的身份定义，被 agent 改掉等于自我提权。

修改方式只有两种：改 seed 后走系统设置的「覆盖」流程，或在宿主机上直接改文件（需先 `chmod`）。

## 8. 改动索引

| 想做的事 | 动哪些文件 |
|---|---|
| 加一个 HTTP API | `routes.mjs`（+ 业务模块） |
| 加一个目录 / 改路径 | `paths.mjs` |
| 给 agent 加工具 | 新扩展文件，然后在 `runtime.mjs` 注册 |
| 改首屏快照 | `harness.mjs` 的 `boxSnapshot`，同步改前端 `refresh()` |
| 改前端某个界面 | `web/app.js` 里 grep 对应 `renderXxx`，样式在 `style.css` |
| 改某个弹窗尺寸 | `style.css` 里的变体类，**必须同时写 `max-width`** |
| 加定时任务规则 | `schedules.mjs` 的 `RULE_TYPES` + 前端对应表单 |
| 改清理策略 | `cleanup.mjs` |
| 改报告机制 | `reports.mjs`（存储）+ `report-tools.mjs`（工具）+ `report-pages.mjs`（阅读页） |
| 改 Skill 注入 | `skills.mjs`（库）+ `skills-extension.mjs`（注入） |

## 9. 已知陷阱

这些都是踩过的，改之前先看一眼。

1. **`pkill -f "PORT=89xx"` 会自杀。** 执行它的 shell 命令行里就含这个串。改用 `lsof -ti:PORT | xargs -r kill -9`。
2. **`app.js` 末尾的启动入口不能被执行两次。** 文件中部有旧的 `initPrefs(); refresh();`，末尾有路由分支。重复执行会导致 `renderStatus` 读 null。
3. **报告模式下必须重置 `#view` 的 `className`。** 残留 `view-empty` 会继承 `letter-spacing: 8px`，排版全乱。
4. **`isPublicReportRequest` 不能写成 `startsWith("/r")`。** 会把 `/reports` 一起豁免掉，内侧页面直接裸奔。只认 `/r` 和 `/r/`。
5. **静态优化的中间件顺序固定。** 装在 basicAuth 内侧；报告页装在 basicAuth 外侧。
6. **SSE 每帧重绘会冲掉滚动位置和展开状态。** 有状态的列表要加 dirty 标记，别每帧重建。
7. **元项目 `assistant.md` 是 444。** 直接 `write` 会失败，先想清楚走哪条流程。

## 10. 自检方法

改完不确定对不对，按这个顺序验：

```bash
# 1. 语法
node --check web/app.js
for f in src/*.mjs; do node --check "$f"; done

# 2. 单元测试
node --test test/*.test.mjs

# 3. 起一个临时实例（换个端口和数据目录，绝不碰现有实例）
PORT=89xx PI_BOXD_DATA_DIR=/tmp/<临时目录> node src/index.mjs

# 4. 浏览器验证（前端改动必做）
#    看错误日志 + 截图，不要只看接口返回 200

# 5. 看容器日志
docker logs --since 5m <容器名>
```

`test/durable.test.mjs` 依赖网络（MCP 连接），离线环境会超时，这不算失败。