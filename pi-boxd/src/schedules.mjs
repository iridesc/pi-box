import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Cron } from "croner";
import { configure } from "@earendil-works/pi-durable";

import { assistantInstructions, listAgents, loadAssistant, resolveAgentModel, resolveAssistantTools } from "./agents.mjs";
import { AnchorTask, setConversationMeta } from "./extension.mjs";
import { META_DIR, META_PROJECT, PROJECTS_DIR } from "./paths.mjs";

const MAX_RUNS = 100;
const DEFAULT_TIMEZONE = process.env.TZ || "Asia/Shanghai";
const RULE_TYPES = new Set(["interval", "daily", "weekdays", "weekly", "monthly", "once"]);
const SESSION_MODES = new Set(["assistant", "isolated"]);

function projectCwd(project) {
  return project === META_PROJECT ? META_DIR : join(PROJECTS_DIR, project);
}

function schedulePath(project) {
  return join(PROJECTS_DIR, project, ".pi", "schedules.json");
}

function normalizeStore(raw) {
  return {
    version: 1,
    schedules: Array.isArray(raw?.schedules) ? raw.schedules : [],
    runs: Array.isArray(raw?.runs) ? raw.runs.slice(0, MAX_RUNS) : [],
  };
}

export async function loadScheduleStore(project) {
  try {
    return normalizeStore(JSON.parse(await readFile(schedulePath(project), "utf-8")));
  } catch {
    return normalizeStore();
  }
}

async function saveScheduleStore(project, store) {
  const file = schedulePath(project);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, "utf-8");
  await rename(temporary, file);
}

export function nextScheduleRun(schedule, after = new Date()) {
  if (!schedule.enabled) return null;
  if (schedule.rule?.type === "once") {
    const runAt = new Date(schedule.rule.runAt);
    return Number.isNaN(runAt.getTime()) || runAt <= after ? null : runAt.toISOString();
  }
  if (schedule.rule?.type === "interval") {
    const milliseconds = schedule.rule.every * (schedule.rule.unit === "minute" ? 60_000 : schedule.rule.unit === "hour" ? 3_600_000 : 86_400_000);
    const anchor = new Date(schedule.createdAt ?? schedule.updatedAt);
    if (!milliseconds || Number.isNaN(anchor.getTime())) return null;
    const steps = Math.max(1, Math.floor((after.getTime() - anchor.getTime()) / milliseconds) + 1);
    return new Date(anchor.getTime() + steps * milliseconds).toISOString();
  }
  const cron = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
  return cron.nextRun(after)?.toISOString() ?? null;
}

function latestDueRun(schedule, cursor, now) {
  if (schedule.rule?.type === "once") {
    const runAt = new Date(schedule.rule.runAt);
    return !Number.isNaN(runAt.getTime()) && runAt > cursor && runAt <= now ? runAt.toISOString() : null;
  }
  if (schedule.rule?.type === "interval") {
    const milliseconds = schedule.rule.every * (schedule.rule.unit === "minute" ? 60_000 : schedule.rule.unit === "hour" ? 3_600_000 : 86_400_000);
    const anchor = new Date(schedule.createdAt ?? schedule.updatedAt);
    if (!milliseconds || Number.isNaN(anchor.getTime()) || now < anchor) return null;
    const steps = Math.floor((now.getTime() - anchor.getTime()) / milliseconds);
    const latest = new Date(anchor.getTime() + steps * milliseconds);
    return latest > cursor && latest <= now ? latest.toISOString() : null;
  }
  const cron = new Cron(schedule.cron, { timezone: schedule.timezone, paused: true });
  const latest = cron.previousRun(new Date(now.getTime() + 1000));
  return latest && latest > cursor && latest <= now ? latest.toISOString() : null;
}

function integer(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return number;
}

function timeParts(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) throw new Error("执行时间格式无效");
  return { hour: integer(match[1], 0, 23, "小时"), minute: integer(match[2], 0, 59, "分钟") };
}

function zonedLocalDate(localDateTime, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(localDateTime ?? ""));
  if (!match) throw new Error("单次执行时间格式无效");
  const desired = Date.UTC(...match.slice(1).map(Number).map((value, index) => index === 1 ? value - 1 : value));
  let instant = desired;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    instant += desired - represented;
  }
  return new Date(instant);
}

export function compileScheduleRule(input, timezone = DEFAULT_TIMEZONE) {
  const rule = input && typeof input === "object" ? input : {};
  if (!RULE_TYPES.has(rule.type)) throw new Error("请选择执行频率");
  if (rule.type === "once") {
    const runAt = rule.localDateTime ? zonedLocalDate(rule.localDateTime, timezone) : new Date(rule.runAt);
    if (Number.isNaN(runAt.getTime())) throw new Error("单次执行时间无效");
    if (runAt <= new Date()) throw new Error("单次执行时间必须晚于当前时间");
    return { rule: { type: "once", runAt: runAt.toISOString() }, cron: null };
  }
  if (rule.type === "interval") {
    const unit = ["minute", "hour", "day"].includes(rule.unit) ? rule.unit : null;
    if (!unit) throw new Error("请选择间隔单位");
    const limits = unit === "minute" ? [5, 59] : unit === "hour" ? [1, 23] : [1, 28];
    const every = integer(rule.every, limits[0], limits[1], "执行间隔");
    return { rule: { type: "interval", every, unit }, cron: null };
  }
  const { hour, minute } = timeParts(rule.time);
  if (rule.type === "daily") return { rule: { type: "daily", time: rule.time }, cron: `${minute} ${hour} * * *` };
  if (rule.type === "weekdays") return { rule: { type: "weekdays", time: rule.time }, cron: `${minute} ${hour} * * 1-5` };
  if (rule.type === "weekly") {
    const weekdays = [...new Set((Array.isArray(rule.weekdays) ? rule.weekdays : []).map(Number))]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
    if (weekdays.length === 0) throw new Error("每周任务至少选择一天");
    return { rule: { type: "weekly", weekdays, time: rule.time }, cron: `${minute} ${hour} * * ${weekdays.join(",")}` };
  }
  const day = integer(rule.day, 1, 28, "每月日期");
  return { rule: { type: "monthly", day, time: rule.time }, cron: `${minute} ${hour} ${day} * *` };
}

function inferLegacyRule(cron) {
  const parts = String(cron ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, day, month, weekday] = parts;
  if (month !== "*") return null;
  const time = /^\d+$/.test(hour) && /^\d+$/.test(minute)
    ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : null;
  if (time && day === "*" && weekday === "*") return { type: "daily", time };
  if (time && day === "*" && weekday === "1-5") return { type: "weekdays", time };
  if (time && day === "*" && /^(?:[0-6],?)+$/.test(weekday)) return { type: "weekly", weekdays: weekday.split(",").map(Number), time };
  if (time && /^\d+$/.test(day) && weekday === "*") return { type: "monthly", day: Number(day), time };
  const minuteInterval = /^\*\/(\d+)$/.exec(minute);
  if (minuteInterval && hour === "*" && day === "*" && weekday === "*") return { type: "interval", every: Number(minuteInterval[1]), unit: "minute" };
  const hourInterval = /^\*\/(\d+)$/.exec(hour);
  if (minute === "0" && hourInterval && day === "*" && weekday === "*") return { type: "interval", every: Number(hourInterval[1]), unit: "hour" };
  return null;
}

export function scheduleDescription(schedule) {
  const rule = schedule.rule ?? inferLegacyRule(schedule.cron);
  if (!rule) return "自定义时间规则";
  if (rule.type === "once") return `${new Date(rule.runAt).toLocaleString("zh-CN", { hour12: false })}，仅执行一次`;
  if (rule.type === "interval") return `每隔 ${rule.every} ${rule.unit === "minute" ? "分钟" : rule.unit === "hour" ? "小时" : "天"}`;
  if (rule.type === "daily") return `每天 ${rule.time}`;
  if (rule.type === "weekdays") return `工作日 ${rule.time}`;
  if (rule.type === "monthly") return `每月 ${rule.day} 日 ${rule.time}`;
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `每${rule.weekdays.map((day) => names[day]).join("、")} ${rule.time}`;
}

export function validateScheduleInput(input) {
  const name = String(input.name ?? "").trim();
  const prompt = String(input.prompt ?? "").trim();
  const timezone = String(input.timezone ?? DEFAULT_TIMEZONE).trim();
  if (!name) throw new Error("定时任务名称不能为空");
  if (!prompt) throw new Error("给助理的任务说明不能为空");
  const compiled = input.rule ? compileScheduleRule(input.rule, timezone) : { rule: inferLegacyRule(input.cron), cron: String(input.cron ?? "").trim() };
  if (!compiled.cron && !["once", "interval"].includes(compiled.rule?.type)) throw new Error("执行规则不能为空");
  try {
    if (compiled.cron) new Cron(compiled.cron, { timezone, paused: true }).nextRun();
    else new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(new Date());
  } catch (error) {
    throw new Error(`执行规则或时区无效：${error.message}`);
  }
  const sessionMode = String(input.sessionMode ?? "isolated");
  if (!SESSION_MODES.has(sessionMode)) throw new Error("请选择有效的会话方式");
  return { name, prompt, ...compiled, timezone, enabled: input.enabled !== false, sessionMode };
}

export async function listSchedules(project) {
  const store = await loadScheduleStore(project);
  return {
    schedules: store.schedules.map((schedule) => ({
      ...schedule,
      // 旧任务没有该字段；保持上线前的主会话行为。
      sessionMode: schedule.sessionMode ?? "assistant",
      rule: schedule.rule ?? inferLegacyRule(schedule.cron),
      description: scheduleDescription(schedule),
      nextRunAt: nextScheduleRun(schedule),
    })),
    runs: store.runs,
  };
}

export async function upsertSchedule(project, input) {
  const clean = validateScheduleInput(input);
  const store = await loadScheduleStore(project);
  const index = input.id ? store.schedules.findIndex((item) => item.id === input.id) : -1;
  const now = new Date().toISOString();
  const schedule = index >= 0
    ? { ...store.schedules[index], ...clean, updatedAt: now, cursorAt: now }
    : { id: randomUUID(), ...clean, createdAt: now, updatedAt: now, cursorAt: now };
  if (index >= 0) store.schedules[index] = schedule;
  else store.schedules.push(schedule);
  await saveScheduleStore(project, store);
  return { ...schedule, nextRunAt: nextScheduleRun(schedule) };
}

export async function deleteSchedule(project, id) {
  const store = await loadScheduleStore(project);
  const length = store.schedules.length;
  store.schedules = store.schedules.filter((item) => item.id !== id);
  if (store.schedules.length === length) throw new Error("定时任务不存在");
  await saveScheduleStore(project, store);
}

async function appendRun(project, run, updateSchedule) {
  const store = await loadScheduleStore(project);
  const schedule = store.schedules.find((item) => item.id === run.scheduleId);
  if (schedule && updateSchedule) Object.assign(schedule, updateSchedule);
  store.runs.unshift(run);
  store.runs = store.runs.slice(0, MAX_RUNS);
  await saveScheduleStore(project, store);
}

async function projectConversation(harness, project, context) {
  const cwd = projectCwd(project);
  const { AgentDoc } = await import("@earendil-works/pi-durable");
  const { items } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
  for (const record of items) {
    if (record.owner != null) continue;
    const agent = await harness.snapshot(AgentDoc, record.id, context);
    if (agent?.cwd === cwd) return harness.conversation(record.id, context);
  }
  return undefined;
}

async function isolatedScheduleConversation(harness, project, schedule, run, context) {
  const main = await projectConversation(harness, project, context);
  if (!main) throw new Error(`找不到项目“${project}”的助理会话`);
  const assistant = await loadAssistant(project);
  const agents = await listAgents(project);
  // Anchor 会立即 terminal，因此必须和 owned conversation 在同一个 transaction 内原子创建。
  const conversationId = await harness.commit(async (tx) => {
    const anchor = await tx.createTask(AnchorTask, null, {
      ownership: { kind: "conversation" },
      conversationId: main.id,
      background: true,
    });
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
    await configure(tx, child.id, {
      model: resolveAgentModel(assistant.model),
      instructions: assistantInstructions(project, assistant, agents),
      tools: resolveAssistantTools(assistant.tools, assistant.mcps),
      cwd: projectCwd(project),
    });
    await setConversationMeta(tx, child.id, {
      project,
      actorType: "assistant",
      actorName: "助理",
      source: "schedule",
      title: schedule.name,
      parentConversationId: String(main.id),
      scheduleId: schedule.id,
      scheduleRunId: run.id,
      createdAt: run.triggeredAt,
    });
    return child.id;
  }, context);
  const conversation = await harness.conversation(conversationId, context);
  if (!conversation) throw new Error(`未能创建项目“${project}”的独立定时任务会话`);
  return conversation;
}

export async function triggerSchedule(harness, context, project, schedule, options = {}) {
  const scheduledAt = options.scheduledAt ?? new Date().toISOString();
  const occurrenceId = options.occurrenceId ?? `${schedule.id}:${scheduledAt}`;
  const requestId = `pibox-schedule:${project}:${occurrenceId}`;
  const run = {
    id: randomUUID(), scheduleId: schedule.id, scheduleName: schedule.name,
    scheduledAt, triggeredAt: new Date().toISOString(), status: "submitted", requestId,
    manual: options.manual === true,
    sessionMode: schedule.sessionMode ?? "assistant",
  };
  try {
    const conversation = run.sessionMode === "isolated"
      ? await isolatedScheduleConversation(harness, project, schedule, run, context)
      : await projectConversation(harness, project, context);
    if (!conversation) throw new Error(`找不到项目“${project}”的助理会话`);
    run.conversationId = String(conversation.id);
    const submission = await conversation.submit({
      type: "input",
      content: schedule.prompt,
      requestId,
      whenBusy: "followUp",
      entry: {
        kind: "pibox.schedule",
        data: { scheduleId: schedule.id, scheduleName: schedule.name, scheduledAt, occurrenceId, sessionMode: run.sessionMode },
      },
    }, context);
    run.submissionId = String(submission.id);
    submission.wait(context).catch((error) => console.error(`[schedule] ${project}/${schedule.name}:`, error.message));
    const update = options.advanceCursor ? { cursorAt: options.advanceCursor, lastRunAt: run.triggeredAt } : { lastRunAt: run.triggeredAt };
    if (schedule.rule?.type === "once") update.enabled = false;
    await appendRun(project, run, update);
    return run;
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    await appendRun(project, run, options.advanceCursor ? { cursorAt: options.advanceCursor } : undefined);
    throw error;
  }
}

export function startProjectScheduler({ harness, context, listProjects, intervalMs = 15_000 }) {
  let running = false;
  let closed = false;
  const tick = async () => {
    if (running || closed) return;
    running = true;
    try {
      const now = new Date();
      for (const project of await listProjects()) {
        const store = await loadScheduleStore(project);
        for (const schedule of store.schedules) {
          if (!schedule.enabled) continue;
          const cursor = new Date(schedule.cursorAt || schedule.createdAt || now);
          const due = latestDueRun(schedule, cursor, now);
          if (!due) continue;
          // 默认漏跑策略为 latest：停机期间只补最近需要处理的一次，然后推进游标。
          await triggerSchedule(harness, context, project, schedule, {
            scheduledAt: due,
            occurrenceId: `${schedule.id}:${due}`,
            advanceCursor: now.toISOString(),
          }).catch((error) => console.error(`[schedule] 触发失败 ${project}/${schedule.name}: ${error.message}`));
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => tick().catch(console.error), intervalMs);
  timer.unref?.();
  tick().catch(console.error);
  return { close: () => { closed = true; clearInterval(timer); }, tick };
}
