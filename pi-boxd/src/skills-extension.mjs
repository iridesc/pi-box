// pi-box 的 skill 注入扩展。
//
// 为什么必须是独立扩展（而不是塞进 pi-box 扩展）：
//   extension.mjs 在 spawn 子 agent 时执行 `extensions: { remove: [PiBoxExtension] }` 防递归，
//   若 skill section 挂在 pi-box 扩展上，子 agent 会连带失去 skill 能力。
//
// 为什么用 section（而不是把 XML 拼进 instructions）：
//   section 每次请求现算，改 skill 白名单 / 全局启停后下一轮立即生效，
//   已经 spawn 的子 agent 会话与定时任务的隔离会话都会自动跟随，无需 configure + sync。
import { defineExtension, section } from "@earendil-works/pi-durable";
import { basename } from "node:path";

import { PROJECTS_DIR, META_PROJECT, META_DIR } from "./paths.mjs";
import { loadAssistant, loadEnabledAgentDef } from "./agents.mjs";
import { resolveSkills, formatSkillsForPrompt, skillReaderOf } from "./skills.mjs";
import { ConversationMeta } from "./extension.mjs";

/** 从 cwd 反推项目名（兼容没有 ConversationMeta 的历史会话）。 */
function projectFromCwd(cwd) {
  if (!cwd) return null;
  if (cwd === META_DIR) return META_PROJECT;
  if (cwd.startsWith(PROJECTS_DIR + "/")) return basename(cwd);
  return null;
}

/** 该角色在 frontmatter 里声明的 skill 名单；未配置返回 null（= 不启用任何 skill）。 */
async function roleSkillNames(project, actorType, actorName) {
  if (actorType === "agent" && actorName) {
    // loadEnabledAgentDef 同时覆盖项目 agent、被授权的全局 agent 与元项目私有 agent。
    const def = await loadEnabledAgentDef(project, actorName);
    return def?.skills ?? null;
  }
  // 助理：含 actorType 为空的历史主会话。
  const assistant = await loadAssistant(project);
  return assistant.skills ?? null;
}

/**
 * `<skills>` 段：只放 name / description / 绝对路径，正文由模型按需读取。
 * 该角色没启用任何 skill、或没有任何读取手段时返回 undefined（不渲染、不占上下文）。
 */
export const SkillsExtension = defineExtension({
  name: "pi-box-skills",
  sections: [
    section("skills", async (input, context) => {
      const meta = await input.read.snapshot(ConversationMeta, input.conversationId, context);
      const project = meta?.project ?? projectFromCwd(input.agent.cwd);
      if (!project) return undefined;

      const names = await roleSkillNames(project, meta?.actorType ?? null, meta?.actorName ?? null);
      if (!names || names.length === 0) return undefined;

      const reader = skillReaderOf(input.agent.tools);
      if (!reader) {
        // 没有 read / bash 就没法加载正文，不要广告无法完成的操作。
        console.error(`[skills] ${project}/${meta?.actorName ?? "助理"} 启用了 skill，但没有 read/bash 工具，已跳过注入`);
        return undefined;
      }

      const { skills, missing, disabled, invalid } = await resolveSkills(names, project);
      if (missing.length > 0) {
        console.error(`[skills] ${project}/${meta?.actorName ?? "助理"} 引用了不存在的 skill：${missing.join(", ")}`);
      }
      if (invalid.length > 0) {
        console.error(`[skills] 跳过非法 skill：${invalid.map((item) => `${item.name}（${item.error}）`).join(", ")}`);
      }
      if (disabled.length > 0) {
        console.error(`[skills] 跳过被全局停用的 skill：${disabled.join(", ")}`);
      }
      const text = formatSkillsForPrompt(skills, reader).trim();
      return text === "" ? undefined : text;
    }, { tag: false }),
  ],
});

export { projectFromCwd, roleSkillNames };
