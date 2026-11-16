// 图片预算：让「图片进上下文」这件事有字节上限。
//
// 为什么需要：图片以 base64 原文写进 ToolResultEntry，之后**每一轮请求都把历史里所有图片重发一遍**。
// 上游两道闸门对字节都不敏感：
//   - pi-ai 只在模型 input 不含 "image" 时把图换成占位符（纯文本模型安全，图模型照发）；
//   - 图片在 token 估算里恒为 4800 chars/张（与真实大小无关），所以 1M 上下文的图模型上，
//     压缩阈值永远不会因为图片触发，请求体能一路涨到网关的 body 上限被 413。
//
// 这里做两件事：
//   1. boundImages()：请求级裁剪。超 triggerBytes 就从**最老**的图开始换成占位文本，降到 targetBytes。
//      只影响这一次请求（不写库），且 cut 有迟滞，被替换的前缀在若干轮内保持稳定，prompt cache 不被打穿。
//   2. stripImagesFromRecords()：存储级剥离。离线（Harness 关闭时）把历史条目里的 base64 换成占位文本，
//      每个会话保留最近 keepBytes 的图片。原条目字节真的被删掉，库和备份不再虚胖。
//
// 占位文本里带上原始路径：图不在上下文里，但模型知道去哪儿重新 read（那时已是缩放后的小图）。

import { defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";

const MIB = 1024 * 1024;

export const IMAGE_BUDGET_DEFAULTS = Object.freeze({
  /** 超过它就裁（约 8MB，落在常见网关 body 上限之内）。 */
  triggerBytes: 8 * MIB,
  /** 裁到它为止。与 trigger 的差值是迟滞区间，避免每轮都改前缀。 */
  targetBytes: 5 * MIB,
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

/** 占位文本：明确告诉模型「看不到」，并给出重新读取的入口。 */
export function imagePlaceholder(path) {
  const where = path
    ? `原文件 ${path}，需要时重新 read 一次（会按模型尺寸上限缩小）`
    : "原文件路径见对应的 read 调用，需要时重新 read 一次";
  return `[图片已移除以缩小请求体，这一轮看不到它的任何像素，不要凭记忆描述其内容。${where}]`;
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
 * 请求级裁剪：历史图片字节超过 trigger 时，从最老的开始换成占位文本，直到降到 target。
 *
 * 迟滞：cut 由「按序累加、只在超 trigger 时前进」决定，所以同一份历史得到同一个 cut；
 * 新图片进来后 cut 只在越过 (trigger - target) 时前进一次，被替换的前缀长期不变。
 */
export function boundImages(messages, limits = {}) {
  const { triggerBytes, targetBytes } = resolveLimits(limits);
  if (!Array.isArray(messages) || messages.length === 0) return { messages, dropped: 0, droppedBytes: 0 };
  const sizes = [];
  mapImages(messages, (block) => {
    sizes.push(imageByteLength(block));
    return undefined;
  });
  if (sizes.length === 0) return { messages, dropped: 0, droppedBytes: 0 };

  let cut = 0;
  let kept = 0;
  for (const size of sizes) {
    kept += size;
    if (kept <= triggerBytes) continue;
    while (kept > targetBytes && cut < sizes.length) kept -= sizes[cut++];
  }
  if (cut === 0) return { messages, dropped: 0, droppedBytes: 0 };

  const paths = toolCallPaths([messages]);
  let index = 0;
  let droppedBytes = 0;
  const bounded = mapImages(messages, (block, message) => {
    if (index++ >= cut) return undefined;
    droppedBytes += imageByteLength(block);
    return { type: "text", text: imagePlaceholder(paths.get(message.toolCallId)) };
  });
  return { messages: bounded, dropped: cut, droppedBytes };
}

/**
 * 存储级剥离：`records` 是一个会话的全部条目（按 id 升序），每条 `{ id, record }`，record 里可能有
 * `model`（消息数组）与 `edits[].messages`。逆序保留最近 keepBytes 的图片，更老的换成占位文本。
 * 只有真的改了才返回新的 record 对象。
 */
export function stripImagesFromRecords(records, { keepBytes = 2 * MIB } = {}) {
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
        found.push({ message, blockIndex, bytes: imageByteLength(block) });
      });
    });
  };
  for (let index = records.length - 1; index >= 0; index--) {
    collect(records[index].record?.model);
    for (const edit of records[index].record?.edits ?? []) collect(edit?.messages);
  }
  // 2) 从最新往回保留，直到 keepBytes 用完（found 本身已按最新→最老收集）。
  const keep = new Set();
  let kept = 0;
  for (const item of found) {
    if (kept + item.bytes > keepBytes) continue;
    kept += item.bytes;
    keep.add(item);
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

/** 把 boundImages 挂进每次生成请求之前（只对这一条请求生效，不写库）。 */
export function createImageBudgetExtension(options = {}) {
  const limits = resolveLimits(options);
  return defineExtension({
    name: "image-budget",
    hooks: [
      hook(GenerationTask, {
        beforeRequest({ messages }) {
          const result = boundImages(messages, limits);
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
