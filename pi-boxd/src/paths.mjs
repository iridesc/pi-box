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
// 元项目（pi-box-expert）：身份特殊的"管理员项目"，不存于 PROJECTS_DIR。
// 助理与子 agent 都在用户 HOME 下；与业务项目物理隔离，业务项目助理看不到这里的子 agent。
// 可用 PI_BOX_META_DIR 覆盖。
export const META_PROJECT = "meta";
export const META_DIR = process.env.PI_BOX_META_DIR
  ? resolve(process.env.PI_BOX_META_DIR)
  : join(process.env.HOME ?? "/home/agent", ".pi", "agent", "meta");
export const META_AGENTS_DIR = join(META_DIR, "agents");
// 持久化数据目录（SQLite + config.json）
export const DATA_DIR = process.env.PI_BOXD_DATA_DIR ?? join(WORKSPACE, ".pi-boxd");
export const PORT = Number(process.env.PORT ?? 8787);
// 静态页面目录
export const WEB_DIR = process.env.PI_BOXD_WEB_DIR
  ? resolve(process.env.PI_BOXD_WEB_DIR)
  : join(_piBoxdDir, "web");
