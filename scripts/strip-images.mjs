#!/usr/bin/env node
// 把会话历史里的图片 base64 从数据库里剥离掉（换成一个说明性占位文本）。
//
// 背景：图片以 base64 写进 entries.record 的 model 消息里，之后每一轮请求都会重发一遍。
// 会话跑久了，一条会话能堆到几十 MB，网关直接 413、会话卡死。请求级裁剪（image-budget 扩展）
// 已经能兜住新会话，但已经堆起来的字节还得从库里清掉，否则库、WAL、备份一起虚胖。
//
// 用法（**必须先停掉 pi-boxd**，否则它内存里的上下文视图和库会脱钩）：
//   node scripts/strip-images.mjs --db /home/agent/.pi-boxd/session.sqlite --dedupe         # 只删重复副本（预演）
//   node scripts/strip-images.mjs --db ... --dedupe --apply                                 # 真删重复副本 + VACUUM
//   node scripts/strip-images.mjs --db ... --keep-mb 2                                      # 按体积裁（预演）
//   node scripts/strip-images.mjs --db ... --keep-mb 2 --apply                              # 按体积裁 + VACUUM
//   node scripts/strip-images.mjs --db ... --dedupe --keep-mb 16 --apply                    # 两者一起
//   node scripts/strip-images.mjs --db ... --dedupe --apply --conversation 70833            # 只处理一个会话
//
// 两种策略可以单用也可以合并：
//   --dedupe     内容相同的图只留最新那份，旧副本换成占位（按 sha256 判定，与文件名/路径无关）。
//   --keep-mb N  每个会话只保留最近 N MB 的图片（默认 2），更老的换占位。
// 占位文本里带原文件路径，模型需要时重新 read。
// 改之前自动备份 session.sqlite（含 -wal / -shm 一起拷），改不回来可以整库还原。

import { copyFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIB = 1024 * 1024;

/** 脚本随镜像发布（/home/pi-boxd/app/scripts），也能在仓库里直接跑；两处都要能找到实现。 */
async function loadModule() {
  const candidates = [
    // 镜像里：/home/pi-boxd/app/{scripts,src}
    join(HERE, "..", "src", "image-budget.mjs"),
    // 仓库里：scripts/ 与 pi-boxd/src/ 平级
    join(HERE, "..", "pi-boxd", "src", "image-budget.mjs"),
    "/home/pi-boxd/app/src/image-budget.mjs",
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return await import(candidate);
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error(`找不到 image-budget.mjs（试过 ${candidates.join(", ")}）`);
}

function parseArgs(argv) {
  const options = { db: undefined, keepMb: undefined, dedupe: false, apply: false, conversation: undefined, vacuum: true };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    if (arg === "--db") options.db = next();
    else if (arg === "--keep-mb") options.keepMb = Number(next());
    else if (arg === "--dedupe") options.dedupe = true;
    else if (arg === "--conversation") options.conversation = Number(next());
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--no-vacuum") options.vacuum = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function usage() {
  return [
    "用法：node scripts/strip-images.mjs --db <session.sqlite> [选项]",
    "",
    "  --dedupe           内容相同的图只留最新那份（按 sha256 判定；文件改过就算不同）",
    "  --keep-mb N        每个会话保留最近 N MB 的图片（默认 2；与 --dedupe 同用时按去重后再裁）",
    "  --conversation ID  只处理这一个会话",
    "  --apply            真的写库（默认只预演、只统计）",
    "  --no-vacuum        写完不 VACUUM",
  ].join("\n");
}

function tableExists(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** 库里的 entries 行 → 每个会话一组（按 id 升序），record 已解析。 */
function loadConversations(db, onlyConversation) {
  const filter = Number.isFinite(onlyConversation) ? " WHERE conversation_id = ?" : "";
  const rows = db
    .prepare(`SELECT id, conversation_id, record FROM entries${filter} ORDER BY conversation_id, id`)
    .all(...(Number.isFinite(onlyConversation) ? [onlyConversation] : []));
  const byConversation = new Map();
  for (const row of rows) {
    let record;
    try {
      record = JSON.parse(row.record);
    } catch {
      continue;
    }
    if (!byConversation.has(row.conversation_id)) byConversation.set(row.conversation_id, []);
    byConversation.get(row.conversation_id).push({ id: row.id, record });
  }
  return byConversation;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function backupDatabase(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${dbPath}.bak-${stamp}`;
  // WAL 里可能还有没 checkpoint 的页，三个文件一起拷贝才是一致快照。
  await copyFile(dbPath, target);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    try {
      await copyFile(source, `${target}${suffix}`);
    } catch {
      /* 没有就算了 */
    }
  }
  return target;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.db) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const dbPath = resolve(options.db);
  // 只做去重时不动体积预算（keepBytes = Infinity），避免顺手把不同文件也裁掉。
  const keepMb = options.keepMb === undefined ? (options.dedupe ? Number.POSITIVE_INFINITY : 2) : options.keepMb;
  if (!(keepMb >= 0)) throw new Error("--keep-mb 必须是非负数");

  const { stripImagesFromRecords } = await loadModule();
  const sizeBefore = await fileSize(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 8000");
  if (!tableExists(db, "entries")) throw new Error(`${dbPath} 不是 durable 会话库（没有 entries 表）`);

  const conversations = loadConversations(db, options.conversation);
  const updates = [];
  let totalDropped = 0;
  let totalBytes = 0;
  const perConversation = [];

  for (const [conversationId, records] of conversations) {
    const result = stripImagesFromRecords(records, {
      keepBytes: keepMb === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.round(keepMb * MIB),
      dedupeByHash: options.dedupe,
    });
    if (result.dropped === 0) continue;
    totalDropped += result.dropped;
    totalBytes += result.droppedBytes;
    for (const record of result.records) {
      const before = records.find((item) => item.id === record.id);
      if (before !== undefined && before.record !== record.record) updates.push(record);
    }
    perConversation.push({ conversationId, dropped: result.dropped, bytes: result.droppedBytes });
  }

  console.log(`库：${dbPath}（${(sizeBefore / MIB).toFixed(1)} MB）`);
  console.log(
    `会话：${conversations.size} 个，待剥离图片 ${totalDropped} 张，共 ${(totalBytes / MIB).toFixed(1)} MB` +
      `（策略：${options.dedupe ? "同内容去重" : ""}${options.dedupe && keepMb !== Number.POSITIVE_INFINITY ? " + " : ""}${keepMb === Number.POSITIVE_INFINITY ? "" : `保留最近 ${keepMb}MB`}）`,
  );
  for (const item of perConversation.sort((a, b) => b.bytes - a.bytes).slice(0, 15)) {
    console.log(`  #${item.conversationId}: ${item.dropped} 张，${(item.bytes / MIB).toFixed(1)} MB`);
  }

  if (totalDropped === 0) {
    db.close();
    console.log("没有需要剥离的图片。");
    return;
  }
  if (!options.apply) {
    db.close();
    console.log("（预演，未写库。加 --apply 才会真的清掉）");
    return;
  }

  const backup = await backupDatabase(dbPath);
  console.log(`已备份：${backup}`);

  db.exec("BEGIN");
  try {
    const statement = db.prepare("UPDATE entries SET record = ? WHERE id = ?");
    for (const record of updates) statement.run(JSON.stringify(record.record), record.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  // VACUUM 需要独占，必须在关连接前没有其它会话；这里只有我们自己。
  if (options.vacuum) {
    try {
      db.exec("VACUUM");
      console.log("已 VACUUM。");
    } catch (error) {
      console.log(`VACUUM 失败（不影响剥离结果）：${error.message}`);
    }
  }
  db.close();

  const sizeAfter = await fileSize(dbPath);
  console.log(
    `完成：${updates.length} 条条目已改写，剥离 ${totalDropped} 张图片（${(totalBytes / MIB).toFixed(1)} MB），` +
      `库 ${(sizeBefore / MIB).toFixed(1)} MB → ${(sizeAfter / MIB).toFixed(1)} MB`,
  );
}

main().catch((error) => {
  console.error(`失败：${error?.message ?? error}`);
  process.exitCode = 1;
});
