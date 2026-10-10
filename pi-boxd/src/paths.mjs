// pi-boxd 路径常量。所有路径都支持环境变量覆盖，缺省值适配容器内。
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// pi-boxd 源码位置（用于计算 web 目录默认值）
const _srcDir = dirname(fileURLToPath(import.meta.url));
const _piBoxdDir = basename(_srcDir) === "src" ? dirname(_srcDir) : _srcDir;

export const WORKSPACE = process.env.PI_BOX_WORKSPACE ?? "/workspace";
// 默认 = WORKSPACE（每个子目录 = 一个项目）；可通过 PI_BOX_PROJECTS_DIR 覆盖
export const PROJECTS_DIR = process.env.PI_BOX_PROJECTS_DIR ?? WORKSPACE;
// 全局 agent 库（所有项目共享），位于工作区的 .pi-box/agents/
export const GLOBAL_AGENTS_DIR = join(WORKSPACE, ".pi-box", "agents");
// 持久化数据目录（SQLite + config.json）
export const DATA_DIR = process.env.PI_BOXD_DATA_DIR ?? join(WORKSPACE, ".pi-boxd");
export const PORT = Number(process.env.PORT ?? 8787);
// 静态页面目录
export const WEB_DIR = process.env.PI_BOXD_WEB_DIR
  ? resolve(process.env.PI_BOXD_WEB_DIR)
  : join(_piBoxdDir, "web");
