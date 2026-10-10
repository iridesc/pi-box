// pi-boxd 入口：装配 + 启动
import { createWebServer } from "pi-durable-web/src/core.mjs";
import { WORKSPACE, PROJECTS_DIR, GLOBAL_AGENTS_DIR, DATA_DIR, PORT, WEB_DIR } from "./paths.mjs";
import { initProvider, refreshProvider, getUseFaux, currentModel, getHasKey } from "./model.mjs";
import { createHarness, ensureProjectConversations, boxSnapshot } from "./harness.mjs";
import { buildExtraRoutes } from "./routes.mjs";
import { join } from "node:path";

// 初始化 model（用 config.json 或回退到 faux）
await initProvider();
await refreshProvider();

// 创建 Harness + 注册 pi-box 扩展
const { harness, context } = await createHarness();

// 为每个项目建主会话
await ensureProjectConversations(harness);

// 启动 HTTP 服务
const server = createWebServer({
  harness,
  context,
  getSnapshot: () => boxSnapshot(harness),
  createConversation: () =>
    harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: currentModel, cwd: PROJECTS_DIR } }, context),
  extraRoutes: buildExtraRoutes(harness, context),
  webDir: WEB_DIR,
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pi-boxd 已启动: http://localhost:${PORT}`);
  console.log(`项目目录: ${PROJECTS_DIR}`);
  console.log(`全局 agent 库: ${GLOBAL_AGENTS_DIR}`);
  console.log(`存储: ${join(DATA_DIR, "session.sqlite")}`);
  console.log(`模型: ${getUseFaux() ? "faux（离线）" : `${currentModel.provider}/${currentModel.modelId}`}`);
});
