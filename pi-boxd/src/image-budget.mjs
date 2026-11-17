// 图片预算：让「图片进上下文」这件事有字节上限。
//
// 为什么需要：图片以 base64 原文写进 ToolResultEntry，之后**每一轮请求都把历史里所有图片重发一遍**。
// 上游两道闸门对字节都不敏感：
//   - pi-ai 只在模型 input 不含 "image" 时把图换成占位符（纯文本模型安全，图模型照发）；
//   - 图片在 token 估算里恒为 4800 chars/张（与真实大小无关），所以 1M 上下文的图模型上，
//     压缩阈值永远不会因为图片触发，请求体能一路涨到网关的 body 上限被 413。
//
// 这里做三件事：
//   1. boundImages()：请求级裁剪，分两步——
//      a. 去重：**内容相同**的图只保留最新那份，旧副本换成占位（模型仍可以重读，
//         只是不会再往上下文里堆副本）。去重键是当前字节的 sha256，不是文件路径：
//         同一个文件被改过之后，旧版本和新版本是两张不同的图，都要留着让模型对比；
//         反过来，用户反复粘贴同一张图、或者把同一张图存成两个文件名，字节相同就是同一张。
//         代价用「长度预分桶」压掉：base64 长度唯一确定字节数，长度只出现一次的图不可能重复，
//         连 hash 都不用算。
//      b. 字节预算：去重后仍超 triggerBytes 时，从最老的不同文件开始换成占位，降到 targetBytes。
//         只影响这一次请求（不写库），trigger 与 target 之间的间隙就是迟滞，避免每轮都改前缀。
//   2. stripImagesFromRecords()：存储级剥离（离线）。既能按字节保留最近 keepBytes，也能只做
//      内容去重（dedupeByHash，同一套 sha256 判定），把历史里重复的 base64 副本删掉。
//   3. 一段固定的提示词（IMAGE_PROMPT_SECTION）：告诉模型图片是随工具结果附上的、别重复读。
//
// 占位文本里带上原始路径：图不在上下文里，但模型知道去哪儿重新 read（那时已是缩放后的小图）。

import { createHash } from "node:crypto";
import { SLICE_NOTICE_PREFIX } from "./image-slices.mjs";
import { defineExtension, hook, section, GenerationTask } from "@earendil-works/pi-durable";

const MIB = 1024 * 1024;

export const IMAGE_BUDGET_DEFAULTS = Object.freeze({
  /**
   * 超过它就裁。24MB 是按实测校准的：同一网关下 26.8MB 的请求体还能正常返回，
   * 48MB 才被 `payload too large` 挡掉；8MB 太保守，会让「一次要核对十几张图」的任务
   * 反复把图挤出去、再重读（实测一个会话因此读了 310 次）。
   */
  triggerBytes: 24 * MIB,
  /** 裁到它为止。与 trigger 的差值（8MB）是迟滞区间，避免每轮都改前缀。 */
  targetBytes: 16 * MIB,
});

/** 从 record/model 里的路径参数取出「这张图是哪个文件」，用于占位文本。 */
const PATH_ARG_KEYS = ["path", "filePath", "file_path", "filepath", "imagePath", "image"];

export function isImageBlock(block) {
  return Boolean(block) && typeof block === "object" && block.type === "image";
}

/** 内联图片的字节数：base64 是 ASCII，字符串长度就是它的字节数。 */
export function imageByteLength(block) {
  if (!isImageBlock(block)) return 0;
  const data = block.data ?? block.source?.data ?? "";
  return typeof data === "string" ? data.length : 0;
}

/** 被字节预算裁掉的图：明确说「这一轮看不到」，并给出重新读取的入口。 */
export function imagePlaceholder(path) {
  const where = path
    ? `原文件 ${path}，需要时重新 read 一次（会按模型尺寸上限缩小）`
    : "原文件路径见对应的 read 调用，需要时重新 read 一次";
  return `[图片已移除以缩小请求体，这一轮看不到它的任何像素，不要凭记忆描述其内容。${where}]`;
}

/** 同一张图的重复出现：旧副本省略，后面的那份还在，所以不是「看不到」。 */
export function duplicateImagePlaceholder(path) {
  const which = path ? `同一张图（${path}）` : "同一张图";
  return `[${which}的更新一份在本次上下文里（在后面），这条旧副本已省略；不要因此重复 read。]`;
}

/** 一整组长图切片被移除时，原来那段「已切成 N 片」的说明换成这句。 */
export function slicedImagesPlaceholder(original) {
  const head = String(original ?? "").split("已按原始分辨率切成")[0] ?? "";
  const size = head.startsWith(SLICE_NOTICE_PREFIX) ? head.slice(SLICE_NOTICE_PREFIX.length).replace(/[），,)\s]+$/, "") : "";
  const where = size ? `原图 ${size}，` : "";
  return `[${where}这一轮看不到它的任何像素：切出来的所有分片已整体移除以缩小请求体，不要凭记忆描述其内容。需要时重新 read 一次整图（先裁区域再读更省）]`;
}

/**
 * 一张图的身份 = 当前字节的 sha256 前 16 位。
 *
 * 为什么不复用文件路径或落盘时的文件名哈希：文件可以被原地改掉，路径不变而内容已经换了。
 * 每次组装请求都对着**实际要发出去的字节**算，才能保证「内容变了就是新图」。
 */
export function imageDigest(block) {
  const data = block?.data ?? block?.source?.data;
  if (typeof data !== "string" || data.length === 0) return undefined;
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function isMessageArray(value) {
  return Array.isArray(value) && value.every((message) => message && typeof message === "object" && "role" in message);
}

function pathArgOf(block) {
  const args = block?.arguments;
  if (!args || typeof args !== "object") return undefined;
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 工具调用 id → 该调用读的文件路径。占位文本靠它说明"重新 read 哪个文件"。
 * `lists` 是若干消息数组（请求上下文、条目的 model / edits 等），一次看全。
 */
export function toolCallPaths(lists) {
  const paths = new Map();
  for (const messages of lists) {
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        const path = pathArgOf(block);
        if (path !== undefined) paths.set(block.id, path);
      }
    }
  }
  return paths;
}

/**
 * 按发送顺序遍历所有内联图片，`visit(block, context)` 返回替换用的 block 就替换，返回 undefined 就原样保留。
 * 没有改动时返回原数组（保持引用，便于判断"要不要换掉这条消息"）。
 */
function mapImages(messages, visit) {
  let changed = false;
  const next = messages.map((message) => {
    const content = message.content;
    if (!Array.isArray(content)) return message;
    let contentChanged = false;
    const mapped = content.map((block) => {
      if (!isImageBlock(block)) return block;
      const replacement = visit(block, message);
      if (replacement === undefined) return block;
      contentChanged = true;
      return replacement;
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content: mapped };
  });
  return changed ? next : messages;
}

/** 环境变量里的预算阈值（PI_BOX_IMAGE_TRIGGER_MB / TARGET_MB），harness 与占用展示共用同一份。 */
export function imageBudgetLimits() {
  const megabytes = (name, fallback) => {
    const value = Number(process.env[name] ?? "");
    return Number.isFinite(value) && value > 0 ? Math.round(value * 1024 * 1024) : fallback;
  };
  return {
    triggerBytes: megabytes("PI_BOX_IMAGE_TRIGGER_MB", IMAGE_BUDGET_DEFAULTS.triggerBytes),
    targetBytes: megabytes("PI_BOX_IMAGE_TARGET_MB", IMAGE_BUDGET_DEFAULTS.targetBytes),
  };
}

function resolveLimits(limits = {}) {
  const triggerBytes = Number(limits.triggerBytes);
  const targetBytes = Number(limits.targetBytes);
  const trigger = Number.isFinite(triggerBytes) && triggerBytes > 0 ? triggerBytes : IMAGE_BUDGET_DEFAULTS.triggerBytes;
  const target = Number.isFinite(targetBytes) && targetBytes > 0 ? targetBytes : IMAGE_BUDGET_DEFAULTS.targetBytes;
  return { triggerBytes: trigger, targetBytes: Math.min(target, trigger) };
}

/**
 * 上下文里内联图片的总量与字节数。占用展示靠它：durable 的 token 估算把每张图恒当 4800 chars，
 * 完全看不见真实字节，而字节才是撞网关 body 上限的那个量。
 */
export function sumInlineImages(messages) {
  let count = 0;
  let bytes = 0;
  mapImages(messages, (block) => {
    count += 1;
    bytes += imageByteLength(block);
    return undefined;
  });
  return { count, bytes };
}

/**
 * 请求级裁剪：**按组**淘汰，不拆散一条消息里的多张图。
 *
 * 为什么必须按组：一张长图会被切成 N 片放在同一个 toolResult 里，末尾还跟一段
 * `这是一张长图（…）已切成 N 片…纵向范围 1..N` 的说明。如果按单个 image block 淘汰，
 * 会出现「说明说有 7 片、实际只剩 4-7 片」——比单纯少几张图更容易让模型错位。
 * 所以分组键取「同一条 message」，一次 read = 一条 message = 一组；丢就整组丢，
 * 连带把那段切片说明也换成占位。
 *
 * 保底：最新一组无论多大都保留。一组切片本身就可能十几 MB，如果按「降到 target 为止」
 * 硬丢，刚读完的长图会当场被自己裁光，等于白读。代价是请求体可能逼近网关上限，
 * 所以超限时通过 `overLimitBytes` 把这件事报出去，由调用方打日志/提示。
 *
 * 迟滞：cut 由「按组累加、只在超 trigger 时前进」决定，所以同一份历史得到同一个 cut；
 * 新图进来后 cut 只在越过 (trigger - target) 时前进一次，被替换的前缀长期不变。
 */
export function boundImages(messages, limits = {}) {
  const { triggerBytes, targetBytes } = resolveLimits(limits);
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, dropped: 0, droppedBytes: 0, deduped: 0, groups: 0, overLimitBytes: 0 };
  }

  const paths = toolCallPaths([messages]);
  const entries = []; // 按发送顺序
  messages.forEach((message) => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (!isImageBlock(block)) return;
      entries.push({ block, message, blockIndex, path: paths.get(message.toolCallId), bytes: imageByteLength(block) });
    });
  });
  if (entries.length === 0) {
    return { messages, dropped: 0, droppedBytes: 0, deduped: 0, groups: 0, overLimitBytes: 0 };
  }

  // 1) 内容去重：sha256 相同才只保留最新一份；旧副本一律省略（占位说明「更新副本在后面」）。
  //    先按 base64 长度分桶：长度唯一确定字节数，只出现一次的长度不可能有重复，省掉 hash 计算。
  const lengthCount = new Map();
  for (const entry of entries) {
    if (entry.bytes > 0) lengthCount.set(entry.bytes, (lengthCount.get(entry.bytes) ?? 0) + 1);
  }
  const byHash = new Map(); // hash -> [{ index, message }]
  entries.forEach((entry, index) => {
    if (entry.bytes <= 0) return;
    if ((lengthCount.get(entry.bytes) ?? 0) < 2) return; // 长度独一份，不可能重复
    entry.hash = imageDigest(entry.block);
    if (entry.hash === undefined) return;
    if (!byHash.has(entry.hash)) byHash.set(entry.hash, []);
    byHash.get(entry.hash).push({ index, message: entry.message });
  });
  const dropped = new Map(); // entryIndex -> "duplicate" | "budget"
  // 只在**跨组**之间去重：同一条消息里的多张图是「一次输入」，哪怕内容相同也整组留着。
  // 否则长图里连续的空白片会被合并成一片，切片说明里的「第几片」全对不上。
  for (const occurrences of byHash.values()) {
    if (occurrences.length < 2) continue;
    const newest = occurrences[occurrences.length - 1].message;
    for (const occurrence of occurrences) {
      if (occurrence.message !== newest) dropped.set(occurrence.index, "duplicate");
    }
  }

  // 2) 字节预算：按组累加（去重后仍留下的那部分），越线就从最老的**整组**淘汰到 target。
  const groupOfMessage = new Map();
  const groups = [];
  entries.forEach((entry, index) => {
    if (dropped.has(index)) return;
    let group = groupOfMessage.get(entry.message);
    if (group === undefined) {
      group = { message: entry.message, indexes: [], bytes: 0 };
      groupOfMessage.set(entry.message, group);
      groups.push(group);
    }
    group.indexes.push(index);
    group.bytes += entry.bytes;
  });

  let kept = 0;
  const order = [];
  let overLimitBytes = 0;
  for (const group of groups) {
    kept += group.bytes;
    order.push(group);
    if (kept <= triggerBytes) continue;
    // order.length > 1 → 最新一组永远留着，哪怕自己就超了 target。
    while (kept > targetBytes && order.length > 1) {
      const victim = order.shift();
      for (const index of victim.indexes) dropped.set(index, "budget");
      kept -= victim.bytes;
    }
    if (kept > targetBytes) overLimitBytes = kept;
  }

  if (dropped.size === 0 && overLimitBytes === 0) {
    return { messages, dropped: 0, droppedBytes: 0, deduped: 0, groups: groups.length, overLimitBytes: 0 };
  }

  // 3) 落成新的 messages：被丢的图换占位；某一组全丢时，它那段「已切成 N 片」的说明也换掉。
  const droppedByMessage = new Map(); // message -> Map<blockIndex, reason>
  let droppedBytes = 0;
  let deduped = 0;
  entries.forEach((entry, index) => {
    const reason = dropped.get(index);
    if (reason === undefined) return;
    droppedBytes += entry.bytes;
    if (reason === "duplicate") deduped += 1;
    if (!droppedByMessage.has(entry.message)) droppedByMessage.set(entry.message, new Map());
    droppedByMessage.get(entry.message).set(entry.blockIndex, reason);
  });

  // 这一条消息里还有没有活着的图？没有就把切片说明一起换掉，避免「说明 7 片、实际 0 片」。
  const aliveImages = new Map();
  entries.forEach((entry, index) => {
    if (dropped.has(index)) return;
    aliveImages.set(entry.message, (aliveImages.get(entry.message) ?? 0) + 1);
  });

  const bounded = messages.map((message) => {
    const byIndex = droppedByMessage.get(message);
    if (byIndex === undefined || !Array.isArray(message.content)) return message;
    const wholeGroupGone = (aliveImages.get(message) ?? 0) === 0;
    return {
      ...message,
      content: message.content.map((block, blockIndex) => {
        const reason = byIndex.get(blockIndex);
        if (reason !== undefined) {
          if (reason === "duplicate") return { type: "text", text: duplicateImagePlaceholder(paths.get(message.toolCallId)) };
          return { type: "text", text: imagePlaceholder(paths.get(message.toolCallId)) };
        }
        if (
          wholeGroupGone &&
          block?.type === "text" &&
          typeof block.text === "string" &&
          block.text.startsWith(SLICE_NOTICE_PREFIX)
        ) {
          return { type: "text", text: slicedImagesPlaceholder(block.text) };
        }
        return block;
      }),
    };
  });
  return { messages: bounded, dropped: dropped.size, droppedBytes, deduped, groups: groups.length, overLimitBytes };
}

/**
 * 存储级剥离：`records` 是一个会话的全部条目（按 id 升序），每条 `{ id, record }`，record 里可能有
 * `model`（消息数组）与 `edits[].messages`。逆序保留最近 keepBytes 的图片，更老的换成占位文本。
 * 只有真的改了才返回新的 record 对象。
 */
export function stripImagesFromRecords(records, { keepBytes = 2 * MIB, dedupeByHash = false } = {}) {
  const lists = [];
  for (const { record } of records) {
    if (Array.isArray(record?.model)) lists.push(record.model);
    for (const edit of record?.edits ?? []) if (Array.isArray(edit?.messages)) lists.push(edit.messages);
  }
  const paths = toolCallPaths(lists);

  // 1) 收集位置（按出现顺序 = 时间顺序）：条目本身的 model，以及已有 edits 里替换过的消息。
  const found = [];
  const collect = (messages) => {
    if (!Array.isArray(messages)) return;
    messages.forEach((message) => {
      if (!Array.isArray(message?.content)) return;
      message.content.forEach((block, blockIndex) => {
        if (!isImageBlock(block)) return;
        found.push({ message, blockIndex, block, bytes: imageByteLength(block), path: paths.get(message.toolCallId) });
      });
    });
  };
  for (let index = records.length - 1; index >= 0; index--) {
    collect(records[index].record?.model);
    for (const edit of records[index].record?.edits ?? []) collect(edit?.messages);
  }
  // 2) 从最新往回保留：先按内容去重（同一张图只留最新一份），再按 keepBytes 卡体积。
  //    按内容而不是按路径——文件被改过时路径不变、内容已换，旧版本必须保留。
  //    体积裁剪按**组**（同一条消息）走，理由同 boundImages：别把一张长图的切片拆散。
  const seenHashes = new Set();
  for (const item of found) {
    if (!dedupeByHash || item.bytes <= 0) continue;
    const hash = imageDigest(item.block);
    if (hash === undefined) continue;
    if (seenHashes.has(hash)) item.deduped = true; // 同内容的旧副本
    else seenHashes.add(hash);
  }

  const groupOrder = []; // 从新到旧
  const groupByMessage = new Map();
  for (const item of found) {
    if (item.deduped) continue;
    let group = groupByMessage.get(item.message);
    if (group === undefined) {
      group = { message: item.message, items: [], bytes: 0 };
      groupByMessage.set(item.message, group);
      groupOrder.push(group);
    }
    group.items.push(item);
    group.bytes += item.bytes;
  }

  const keep = new Set();
  let kept = 0;
  // 这里**不**保底最新一组：存储级是离线清理，目标是压体积，保底会让 --keep-mb 永远够不着。
  // 请求级（boundImages）才需要保底，那是为了别让刚读的图当场消失。
  for (const group of groupOrder) {
    if (kept + group.bytes > keepBytes) continue;
    for (const item of group.items) keep.add(item);
    kept += group.bytes;
  }

  // 3) 其余换占位文本。
  const dropped = found.filter((item) => !keep.has(item));
  if (dropped.length === 0) return { records, dropped: 0, droppedBytes: 0, keptBytes: kept };

  const dropByMessage = new Map();
  for (const item of dropped) {
    const key = item.message;
    if (!dropByMessage.has(key)) dropByMessage.set(key, new Set());
    dropByMessage.get(key).add(item.blockIndex);
  }

  const replaceInMessages = (messages) => {
    if (!Array.isArray(messages)) return messages;
    let changed = false;
    const next = messages.map((message) => {
      const indexes = dropByMessage.get(message);
      if (indexes === undefined || !Array.isArray(message.content)) return message;
      changed = true;
      return {
        ...message,
        content: message.content.map((block, blockIndex) =>
          indexes.has(blockIndex)
            ? { type: "text", text: imagePlaceholder(paths.get(message.toolCallId)) }
            : block,
        ),
      };
    });
    return changed ? next : messages;
  };

  const nextRecords = records.map(({ id, record }) => {
    if (!record || typeof record !== "object") return { id, record };
    const model = replaceInMessages(record.model);
    const edits = Array.isArray(record.edits)
      ? record.edits.map((edit) =>
          edit && typeof edit === "object" && Array.isArray(edit.messages)
            ? { ...edit, messages: replaceInMessages(edit.messages) }
            : edit,
        )
      : record.edits;
    if (model === record.model && edits === record.edits) return { id, record };
    return { id, record: { ...record, ...(model === record.model ? {} : { model }), ...(edits === record.edits ? {} : { edits }) } };
  });

  const droppedBytes = dropped.reduce((total, item) => total + item.bytes, 0);
  return { records: nextRecords, dropped: dropped.length, droppedBytes, keptBytes: kept };
}

/**
 * 图片相关的行为约定。写进系统提示词而不是拼在工具结果里：它适用于所有来源
 * （read / MCP 截图 / 子 agent 汇报），也适用于我们的裁剪占位。
 */
export const IMAGE_PROMPT_SECTION = [
  "图片以附件形式随工具结果返回：read 一张图时图片本身就在这条结果里，你现在就能看到它，",
  "不需要为了\"确认看清了没有\"再读一次。同一个文件不要反复 read —— 重复读不会让你看得更清楚，",
  "只会把别的图挤出上下文。",
  "",
  "历史里可能见到两种占位：",
  "- `[图片已移除以缩小请求体…]`：这张图被请求体积预算裁掉了，这一轮确实看不到，不要凭记忆描述；",
  "  需要再看就 read 一次（会按模型尺寸上限缩小）。",
  "- `[同一张图（…）的更新一份在本次上下文里，这条旧副本已省略]`：同样的像素在后面还有一份，直接用那份。",
  "  判定看的是像素内容而不是文件名：同一个文件被改过之后会出现两份不同的图，那不是重复。",
  "",
  "长图（整页截图这类又长又窄的图）会被自动切成多片返回，片间有重叠：按顺序读这些片即可，",
  "不要为了\"看全\"再去缩小整图；只需要局部细节时，用 bash 裁出区域再 read 更省。",
].join("\n");

/** 把 boundImages 挂进每次生成请求之前（只对这一条请求生效，不写库）。 */
export function createImageBudgetExtension(options = {}) {
  const limits = resolveLimits(options);
  return defineExtension({
    name: "image-budget",
    sections: [section("images", () => IMAGE_PROMPT_SECTION)],
    hooks: [
      hook(GenerationTask, {
        beforeRequest({ messages }) {
          const result = boundImages(messages, limits);
          if (result.overLimitBytes > 0) {
            // 保底留下的最新一组已经把预算撑破了：再往里塞图会撞网关的 body 上限，
            // 模型那边也会因为超长被截断。这里只报出来，不硬裁（硬裁等于刚读就白读）。
            console.error(
              `[image-budget] 保底保留的最新图片组本身就有 ${(result.overLimitBytes / MIB).toFixed(1)}MB，` +
                `已超过目标 ${Math.round(limits.targetBytes / MIB)}MB；继续读图可能触发网关体积限制，` +
                `建议先裁区域或用 bash 把长图转成文本。`,
            );
          }
          if (result.dropped === 0) return undefined;
          console.error(
            `[image-budget] 请求体超 ${Math.round(limits.triggerBytes / MIB)}MB，` +
              `已把 ${result.dropped} 张历史图片换成占位（省 ${(result.droppedBytes / MIB).toFixed(1)}MB）`,
          );
          return { messages: result.messages };
        },
      }),
    ],
  });
}
