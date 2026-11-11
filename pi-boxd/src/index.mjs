// pi-boxd 入口：装配 + 启动
import { createWebServer } from "pi-durable-web/src/core.mjs";
import { WORKSPACE, PROJECTS_DIR, GLOBAL_AGENTS_DIR, DATA_DIR, PORT, WEB_DIR, META_DIR, META_PROJECT } from "./paths.mjs";
import { initProvider, refreshProvider, getUseFaux, currentModel, getHasKey } from "./model.mjs";
import { boxSnapshot } from "./harness.mjs";
import { buildExtraRoutes } from "./routes.mjs";
import { join } from "node:path";
import { bootRuntime, closeScheduler, context, harness, mcpBridge, startCleanupScheduler } from "./runtime.mjs";
import { installBasicAuth } from "./auth.mjs";
import { installStaticOptimizer } from "./static.mjs";

// 初始化 model（用 config.json 或回退到 faux）
await initProvider();
await refreshProvider();

// 装配运行时（Harness + 项目会话 + 定时任务调度）。数据清理后会在同进程内重建。
await bootRuntime();

// 主动恢复上次进程遗留的 generation/tool/reporter 等持久任务。
harness.resume();

// 定时清理（日志按规则在线清；数据库每天到点且空闲时执行，会短暂中断）。
const cleanupScheduler = startCleanupScheduler();

// 启动 HTTP 服务。harness/context 是转发代理，维护重建后自动指向新实例。
const server = createWebServer({
  harness,
  context,
  getSnapshot: () => boxSnapshot(harness),
  createConversation: () =>
    harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: currentModel, cwd: PROJECTS_DIR } }, context),
  extraRoutes: buildExtraRoutes(harness, context, mcpBridge),
  webDir: WEB_DIR,
});

// 静态资源优化：gzip + ETag + 缓存头。装在认证内侧，认证仍然覆盖静态资源。
installStaticOptimizer(server, { webDir: WEB_DIR });

const auth = installBasicAuth(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pi-boxd 已启动: http://localhost:${PORT}`);
  console.log(`项目目录: ${PROJECTS_DIR}`);
  console.log(`全局 agent 库: ${GLOBAL_AGENTS_DIR}`);
  console.log(`元项目目录: ${META_DIR}（项目名: ${META_PROJECT}）`);
  console.log(`存储: ${join(DATA_DIR, "session.sqlite")}`);
  console.log(`模型: ${getUseFaux() ? "faux（离线）" : `${currentModel.provider}/${currentModel.modelId}`}`);
  console.log(`HTTP Basic Auth: ${auth.enabled ? `已启用（用户 ${auth.username}）` : "未启用"}`);
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] 收到 ${signal}：停止调度并中断运行中的任务`);
    closeScheduler();
    cleanupScheduler.close();
    // 关闭 harness 会让运行中的任务收到 abort：命令进程被终止、日志收尾、状态记为 aborted。
    await Promise.race([
      harness.close(context).catch((error) => console.error("[shutdown] 关闭失败:", error?.message ?? error)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    process.exit(0);
  });
}
