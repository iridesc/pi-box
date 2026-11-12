// 报告工具：agent 把报告写进「报告组」。
//
// 为什么是独立扩展（而不是挂到 PiBoxExtension）：
//   extension.mjs 在 spawn 子 agent 时执行 `extensions: { remove: [PiBoxExtension] }` 防递归，
//   而写报告的主力恰恰是子 agent（audit-agent 之类）。挂在那里会让它们失去报告能力。
//
// 「绑定即授权」：agent 定义里的 `reports: [slug, ...]` 是白名单。
//   没绑定时工具仍然存在（工具列表是全局的），但调用会返回明确的拒绝提示；
//   绑定后 group 可以从绑定推导，agent 不需要（也不应该）在提示词里记组名。
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { basename } from "node:path";
import { META_DIR, META_PROJECT, PROJECTS_DIR } from "./paths.mjs";
import { loadAssistant, loadEnabledAgentDef } from "./agents.mjs";
import { ConversationMeta } from "./extension.mjs";
import {
  MAX_REPORT_BYTES,
  deleteReport,
  listGroups,
  listReports,
  normalizeGroupSlug,
  publishReport,
  readReport,
} from "./reports.mjs";

/** 工具返回给模型的正文上限，避免一份大报告把上下文挤爆。 */
const READ_CLAMP = 20_000;

/** 从 cwd 反推项目名（兼容没有 ConversationMeta 的历史会话）。 */
function projectFromCwd(cwd) {
  if (!cwd) return null;
  if (cwd === META_DIR) return META_PROJECT;
  if (cwd.startsWith(PROJECTS_DIR + "/")) return basename(cwd);
  return null;
}

/** 当前会话的「项目 + 角色 + 绑定的报告组白名单」。 */
async function actorOf(api, ctx) {
  const meta = await api.snapshot(ConversationMeta, api.conversationId, ctx);
  const project = meta?.project ?? projectFromCwd(api.env?.cwd);
  if (!project) throw new Error("无法确定当前项目，报告功能不可用");
  const actorType = meta?.actorType ?? null;
  const actorName = meta?.actorName ?? null;
  if (actorType === "agent" && actorName) {
    const def = await loadEnabledAgentDef(project, actorName);
    const reports = (def?.reports ?? []).filter(Boolean);
    return { project, actor: actorName, reports };
  }
  // 助理（含 actorType 为空的历史主会话）
  const assistant = await loadAssistant(project);
  const reports = (assistant.reports ?? []).filter(Boolean);
  return { project, actor: actorName || "助理", reports };
}

/** 决定这次操作落到哪个报告组：显式传的必须在白名单内；只绑一个就自动用它。 */
function pickGroup(actor, requested) {
  const allowed = actor.reports ?? [];
  if (allowed.length === 0) {
    throw new Error(
      `当前角色「${actor.actor}」还没有绑定报告组，不能发布报告。` +
        "请让人在 pi-box 界面上给这个 agent 勾选报告组（对应 agent 文件的 reports 字段）。",
    );
  }
  const trimmed = typeof requested === "string" ? requested.trim() : "";
  if (trimmed) {
    const slug = normalizeGroupSlug(trimmed);
    if (!allowed.includes(slug)) {
      throw new Error(`报告组「${slug}」不在当前角色的白名单里。可用：${allowed.join(", ")}`);
    }
    return slug;
  }
  if (allowed.length === 1) return allowed[0];
  throw new Error(`当前角色绑定了多个报告组（${allowed.join(", ")}），调用时请用 group 参数指定`);
}

const text = (value) => ({ output: [{ type: "text", text: value }] });

/** 统一的错误出口：报告类失败以文本返回（不抛错），模型能读到原因并自我纠正。 */
function guarded(handler) {
  return async (args, api, ctx) => {
    try {
      return await handler(args, api, ctx);
    } catch (error) {
      return text(`报告操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

function formatTime(iso) {
  if (!iso) return "未知时间";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未知时间";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const ReportPublishTool = defineTool({
  name: "report_publish",
  description:
    "把一份报告发布到报告组。组内每次发布都是独立的新报告（按时间戳保存），不会覆盖历史报告。" +
    "markdown 直接写正文即可；html 必须是单文件自包含（内联 js/css/图片，禁止引用 CDN 或外链图片）。" +
    `单份上限 ${Math.round(MAX_REPORT_BYTES / 1024 / 1024)}MB。` +
    "需要当前 agent 已绑定报告组才能使用；只绑定一个组时可以省略 group 参数。",
  parameters: Type.Object({
    content: Type.String({ description: "报告正文（markdown 或完整 html）" }),
    title: Type.Optional(Type.String({ description: "报告标题，缺省用发布时间" })),
    format: Type.Optional(
      Type.Union([Type.Literal("md"), Type.Literal("html")], { description: "报告格式，默认 md" }),
    ),
    group: Type.Optional(Type.String({ description: "报告组 slug；只绑定一个组时可省略" })),
  }),
  replay: "unsafe",
  execute: guarded(async (args, api, ctx) => {
    const actor = await actorOf(api, ctx);
    const group = pickGroup(actor, args.group);
    const published = await publishReport(actor.project, group, {
      agent: actor.actor,
      title: args.title,
      format: args.format ?? "md",
      content: args.content,
    });
    const [{ group: summary, reports }, groups] = await Promise.all([
      listReports(actor.project, group),
      listGroups(actor.project),
    ]);
    const meta = groups.find((item) => item.slug === group);
    const position = reports.findIndex((item) => item.stamp === published.stamp) + 1;
    return text(
      [
        `已发布到报告组「${meta?.name ?? group}」：${published.title}`,
        `编号 ${published.stamp}（组内第 ${position}/${reports.length} 份，共 ${summary.reportCount} 份）`,
        `可见性：${published.visibility === "public" ? "公开（任何拿到链接的人都能看）" : "仅登录可见"}`,
        `查看：/reports/${actor.project}/${group}/${published.stamp}`,
      ].join("\n"),
    );
  }),
});

const ReportListTool = defineTool({
  name: "report_list",
  description:
    "列出报告组或组内的报告。不传 group 时列出当前角色绑定的所有报告组（名称、份数、最近一次时间）；" +
    "传 group 时列出该组的报告清单（编号、标题、发布者、时间）。",
  parameters: Type.Object({
    group: Type.Optional(Type.String({ description: "报告组 slug；省略则列出所有绑定的组" })),
  }),
  replay: "safe",
  execute: guarded(async (args, api, ctx) => {
    const actor = await actorOf(api, ctx);
    const allowed = actor.reports ?? [];
    if (allowed.length === 0) {
      return text(`当前角色「${actor.actor}」还没有绑定任何报告组。`);
    }
    const group = pickGroup(actor, args.group);
    if (typeof args.group !== "string" || !args.group.trim()) {
      const groups = await listGroups(actor.project);
      const mine = groups.filter((item) => allowed.includes(item.slug));
      if (mine.length === 0) return text("绑定的报告组都还不存在（可能已被删除）。");
      return text(
        mine
          .map(
            (item) =>
              `- ${item.name}（${item.slug}）：${item.reportCount} 份` +
              `${item.lastReportAt ? `，最近 ${formatTime(item.lastReportAt)}` : "，还没有报告"}` +
              `，${item.visibility === "public" ? "公开" : "私有"}`,
          )
          .join("\n"),
      );
    }
    const { group: summary, reports } = await listReports(actor.project, group);
    if (reports.length === 0) return text(`报告组「${summary.name}」还没有任何报告。`);
    return text(
      [
        `报告组「${summary.name}」（${reports.length} 份，${summary.visibility === "public" ? "公开" : "私有"}）`,
        ...reports.map(
          (item) => `- ${item.stamp}  ${item.title}  · ${item.agent || "未知"} · ${formatTime(item.createdAt)}`,
        ),
      ].join("\n"),
    );
  }),
});

const ReportReadTool = defineTool({
  name: "report_read",
  description: "读取某一份报告的正文。需要 group（除非只绑定了一个组）与报告编号 stamp。",
  parameters: Type.Object({
    stamp: Type.String({ description: "报告编号，形如 20261112-140000" }),
    group: Type.Optional(Type.String({ description: "报告组 slug；只绑定一个组时可省略" })),
  }),
  replay: "safe",
  execute: guarded(async (args, api, ctx) => {
    const actor = await actorOf(api, ctx);
    const group = pickGroup(actor, args.group);
    const detail = await readReport(actor.project, group, args.stamp);
    const content = detail.report.content;
    const clipped = content.length > READ_CLAMP ? `${content.slice(0, READ_CLAMP)}\n\n…（已截断，共 ${content.length} 字符）` : content;
    return text(
      [
        `# ${detail.report.title}`,
        `报告组：${detail.group.name} · 发布者：${detail.report.agent || "未知"} · ${formatTime(detail.report.createdAt)}`,
        `位置：第 ${detail.nav.index}/${detail.nav.total} 份`,
        "",
        clipped,
      ].join("\n"),
    );
  }),
});

const ReportDeleteTool = defineTool({
  name: "report_delete",
  description: "删除某一份报告。只能删自己发布的报告（别人发布的会拒绝）；删整个报告组只能在界面上操作。",
  parameters: Type.Object({
    stamp: Type.String({ description: "报告编号，形如 20261112-140000" }),
    group: Type.Optional(Type.String({ description: "报告组 slug；只绑定一个组时可省略" })),
  }),
  replay: "unsafe",
  execute: guarded(async (args, api, ctx) => {
    const actor = await actorOf(api, ctx);
    const group = pickGroup(actor, args.group);
    const removed = await deleteReport(actor.project, group, args.stamp, { agent: actor.actor });
    return text(`已删除报告「${removed.title}」（${removed.stamp}）。`);
  }),
});

export const ReportExtension = defineExtension({
  name: "pi-box-reports",
  tools: [ReportPublishTool, ReportListTool, ReportReadTool, ReportDeleteTool],
});

/** 工具名清单（供 configure 时按需 remove / 诊断）。 */
export const REPORT_TOOL_NAMES = ["report_publish", "report_list", "report_read", "report_delete"];