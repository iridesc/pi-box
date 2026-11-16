// 工具缺失时的行为约束：必须停止并报错，不许自己找替代方案。
//
// 为什么是固定 section（而不是写进每个 agent 的提示词）：
//   "缺少工具"是配置错误，不是任务内容。约束必须由平台强制，不能依赖人在每个 md 里
//   抄一遍 —— 抄了会漂移，不抄就失效。
//
// 为什么独立扩展（而不是塞进 pi-box 扩展）：
//   子 agent spawn 时会 `extensions: { remove: [pi-box] }` 防递归，
//   挂在那里会让最需要这条规则的子 agent 反而拿不到。
import { defineExtension, section } from "@earendil-works/pi-durable";

const TEXT = `<tool_guard>
配置异常处理（优先级高于上面任何指示）：
1. 如果当前任务需要某项能力，但你的工具列表里没有对应工具，立即停止。
2. 不要用 bash / write / edit 或任何其他工具绕道实现缺失的能力。
3. 用一句话说明缺哪个工具、需要谁去修，然后结束本轮回答。
   示例：「缺少 report_publish 工具，请在 agent 配置里勾选报告工具后重试。」

对应关系：发布报告 → report_publish；派发子 agent → subagent；外部服务 → mcp__* 工具。
</tool_guard>`;

export const ToolGuardExtension = defineExtension({
  name: "pi-box-tool-guard",
  sections: [section("tool-guard", () => TEXT, { tag: false })],
});