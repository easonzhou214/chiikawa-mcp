#!/usr/bin/env node
"use strict";

/*
 * 吉伊卡哇资料库 · 数据服务（stdio 形态）
 *
 * 无端口、无监听、无依赖。宿主按需拉起本进程，通过标准输入输出收发 JSON-RPC。
 * 契约见 ../README.md，实现说明见 ./implementation-notes.md。
 * 数据目录默认取工程根的 js/，可用环境变量 CHIIKAWA_DATA_DIR 覆盖。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "chiikawa-archive";
const SERVER_VERSION = "0.5.0";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// 检索的默认页比列表小：一次命中的往往是「概览级」结果，
// 给太多对调用方没增益，只是把上下文撑大。
const SEARCH_LIMIT = 40;

/* ------------------------------------------------------------------ 握手说明 */

// 这段话在 initialize 时交给宿主，是「怎么用这个库」的唯一来源。
// 人格那层只负责认人 + 口吻 + 转交 + 保底，不复述这里的规则 —— 改规则只改这一处。
//
// 有一类东西不能写进来：**角色专属的内容**（口癖、自称、说话长短）。
// 服务是用户级登记的，一台机器一份说明；而人格是每个项目各注入一份，
// 同一个服务要同时伺候「这个项目是乌萨奇、那个项目是小八」。所以口吻留在人格里。
//
// 写的时候有两条约束：
//   1. 全是行为约束，不写实现细节。「它的返回里有 fields / known_gaps」这种
//      对模型的行为没有影响，只占上下文，删掉。
//   2. 别和人格重复。人格里已经有的（用户交办的实际任务照常办），这里不写 ——
//      重复的代价不只是字数，还有两处会各自漂移。
//
// 正文放在同目录的 instructions.txt，不写在这里。原来它是一串拼接的字符串字面量，
// 而 agent.html 要把这段原文抄给读者看 —— 页面侧的核对只能用正则去啃 JS 源码，
// 排版一动就静默判「无法核对」，甚至反过来报「一致」。抽成纯文本之后，
// 服务和页面读的是同一个文件，逐字比对即可。
const INSTRUCTIONS = (() => {
  const file = path.join(__dirname, "instructions.txt");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    // 读不到就别演：人格锚那边写着「拿不到说明就别扮角色」，
    // 这里返回空串正好触发那条保底；工具本身照常可用。
    process.stderr.write(
      "[chiikawa] 读不到 " + file + "，本次握手不带行为说明。\n" +
      "           整个项目要完整复制，不能只拷贝 mcp/server.js。\n"
    );
    return "";
  }
})();

/* ------------------------------------------------------------------ 世界词表 */

// 这个世界的「有什么」——地点、营生、吃食、活动、规矩。
// 人格层不写这份清单（写了就是常驻成本 + 两处维护），但没有它就没法即兴：
// 不知道这世界里存在布丁和铠甲先生，编出来的东西会离题。
//
// 所以它放在按需层：只有真去查库的那几轮才带出来。
// 词条不是文案，是**索引** —— 每个词下面压着库里的篇章与条目，来处写清楚，
// 顺着它就能往下查。加一个新地点：改这里一处，不用碰人格、不用重装。
const WORLD = {
  note:
    "《吉伊卡哇》世界的词汇索引。人格层不重复这份清单——即兴时按这里挑词，" +
    "需要细节再按 kind + id 去查对应词条。列在这里的每一项在库中都有据可查；" +
    "没列的东西不等于不存在，但先查再讲。",
  places: [
    { cn: "拉面店「郎」", id: "rou", kind: "arc", hint: "规矩硬到要练点单" },
    { cn: "ラーメン「山」", id: "ramen-yama", kind: "arc", hint: "开在山顶，值得专门跑一趟" },
    { cn: "涌出口", id: "waki", kind: "arc", hint: "食物与生活的来源之一，涸过一次" },
    { cn: "洞穴", id: "hole", kind: "arc" },
    { cn: "山", id: "yamanba", kind: "arc", hint: "山佬篇那片山" },
    { cn: "二手书店", id: "furuhonya", kind: "character" },
    { cn: "乌萨奇的家", id: "usagi-house", kind: "arc", hint: "它住哪一直没人知道" },
  ],
  food: [
    { cn: "布丁", hint: "超级可口布丁、焦糖布丁，要攒钱买" },
    { cn: "热松饼" },
    { cn: "咖喱", id: "oni-curry", kind: "arc", hint: "魔鬼咖喱，辣到超出常识" },
    { cn: "小猪杯面" },
    { cn: "蛋包饭" },
    { cn: "寿司" },
    { cn: "幸运翻车鱼", id: "manbou", kind: "character", hint: "遇到它算今天运气不错" },
  ],
  work: [
    { cn: "除草", hint: "最常见的营生" },
    { cn: "讨伐", id: "tobatsu-anoko", kind: "arc", hint: "接任务打怪物，换报酬" },
    { cn: "打工", hint: "餐厅、书店这类地方接活" },
    { cn: "报酬", hint: "干活换来的钱，攒着买东西" },
    { cn: "检定", id: "kusamushiri", kind: "arc", hint: "除草检定，考不过就得重来" },
    { cn: "资格考试", id: "shisa-qual", kind: "arc" },
    { cn: "排行榜", hint: "讨伐成绩会挂上去" },
  ],
  life: [
    { cn: "铠甲先生", hint: "穿铠甲的从业者：手工、劳动、拉面、除草，还有老板" },
    { cn: "睡衣派对仔", id: "pajama", kind: "arc", hint: "土豆祭上被抓走同伴的那个团" },
    { cn: "三星餐厅", id: "three-star", kind: "arc" },
    { cn: "照相机", id: "camera", kind: "arc" },
    { cn: "开关", id: "switch", kind: "arc", hint: "捡回来的东西，越养越说不清是什么" },
    { cn: "流星", id: "black-meteor", kind: "arc", hint: "墙上那些小星星，后期黑幕" },
    { cn: "猜拳", hint: "常拿来决定事情" },
  ],
  people: [
    { cn: "老师", hint: "下克上那条线：只看结果，努力是前提不是理由" },
    { cn: "山佬", id: "yamanba", kind: "arc", hint: "认得他们，最后自己走回山里" },
    { cn: "那孩子", id: "anoko", kind: "character" },
    { cn: "大强", id: "dekatsuyo", kind: "character", hint: "名字叫又大又强，其实胆小善良" },
    { cn: "奇美拉", id: "chimera", kind: "character" },
    { cn: "魔女", id: "majo", kind: "character" },
    { cn: "古本屋", id: "furuhonya", kind: "character" },
  ],
};

// 词表是手写的索引，数据是会变的 —— 两者一旦脱节，模型就会照着不存在的设定编。
// 所以每次装载都拿真实数据核一遍：cn 必须在库文里出现过，id 必须真能查到。
// 只报不改，只报「有据可查」这一项；hint 是概述，不参与校验。
function auditWorld(idx, archive) {
  const arcs = new Set(archive.arcs.map((x) => x.id));
  const chars = new Set(archive.characters.map((c) => c.id));
  const hay = [
    ...archive.arcs.map((x) => (x.cn || "") + (x.jp || "") + (x.summary || "")),
    ...archive.characters.map((c) =>
      (c.cn || "") + (c.jp || "") + (c.intro || "") + (c.line || "") +
      (c.tags || []).join("") + (c.alias || []).join("")),
    ...archive.episodes.flatMap((e) => [
      e.cn || "", e.jp || "",
      ...(e.sh || []).map((s) => (s.t || "") + (s.s || "") + (s.l || []).map((l) => l.x || "").join("")),
    ]),
  ].join(" ");

  const problems = [];
  for (const [cat, items] of Object.entries(WORLD)) {
    if (cat === "note") continue;
    for (const it of items) {
      if (hay.indexOf(it.cn) < 0) {
        problems.push("world." + cat + "「" + it.cn + "」在库文中 0 次，无法核实");
      }
      if (it.id) {
        const pool = it.kind === "arc" ? arcs : chars;
        if (!pool.has(it.id)) {
          problems.push("world." + cat + "「" + it.cn + "」指向的 " + it.kind + " id「" + it.id + "」在库里不存在");
        }
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ 装载 */

function resolveDataDir() {
  if (process.env.CHIIKAWA_DATA_DIR) return path.resolve(process.env.CHIIKAWA_DATA_DIR);
  return path.resolve(__dirname, "..", "..", "js");
}

function loadArchive() {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) {
    throw new Error("找不到数据目录 " + dir + "（可用环境变量 CHIIKAWA_DATA_DIR 指定）");
  }
  const files = fs.readdirSync(dir)
    .filter((f) => /^(episodes-|data-).*\.js$/.test(f))
    .sort();
  if (!files.length) throw new Error("数据目录里没有数据文件 " + dir);

  const sandbox = { window: {} };
  const ctx = vm.createContext(sandbox);
  const hash = crypto.createHash("sha256");
  let bytes = 0;

  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    bytes += Buffer.byteLength(src);
    hash.update(f).update("\0").update(src).update("\0");
    vm.runInContext(src, ctx, { filename: f });
  }

  const CK = sandbox.window.CK;
  if (!CK) throw new Error("数据文件读到了，但没有产出 window.CK");

  return {
    dir,
    files,
    bytes,
    version: hash.digest("hex").slice(0, 12),
    // 红线：磁盘读取顺序不是集号顺序，必须显式排序
    episodes: (CK.episodes || []).slice().sort((a, b) => a.id - b.id),
    characters: CK.characters || [],
    arcs: CK.arcs || [],
  };
}

/* ------------------------------------------------------------------ 索引 */

// 说话人字段里会出现合并写法（如「哈奇喵与吉伊」），它指的不是一个实体。
// 按连接词拆开逐个解析，整串解析不出来时才拆；拆了也不认得的部分算未登记。
const SPEAKER_SPLIT = /[与和、·]|\s*\/\s*/;

function resolveSpeaker(name, charIdByName) {
  if (!name) return [];
  const whole = charIdByName.get(name);
  if (whole) return [whole];
  const parts = String(name).split(SPEAKER_SPLIT).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const ids = [];
  for (const p of parts) {
    const id = charIdByName.get(p);
    if (id) { if (ids.indexOf(id) < 0) ids.push(id); } else { return []; }
  }
  return ids;
}

function buildIndex(a) {
  const byEpisode = new Map();
  const byCharacter = new Map();
  const byArc = new Map();
  for (const e of a.episodes) byEpisode.set(e.id, e);
  for (const c of a.characters) byCharacter.set(c.id, c);
  for (const x of a.arcs) byArc.set(x.id, x);

  const charIdByName = new Map();
  for (const c of a.characters) {
    for (const n of [c.cn, c.jp].concat(c.alias || [])) {
      if (n && !charIdByName.has(n)) charIdByName.set(n, c.id);
    }
  }

  const epToChars = new Map();
  const charToEps = new Map();
  const charToSpokenEps = new Map();
  const charToActedEps = new Map();
  const unmatched = new Map();
  const unmatchedEps = new Map();

  const mark = (map, cid, epid) => {
    if (!map.has(cid)) map.set(cid, new Set());
    map.get(cid).add(epid);
  };

  for (const e of a.episodes) {
    const set = new Set();
    for (const sh of e.sh || []) {
      for (const l of sh.l || []) {
        const ids = resolveSpeaker(l.w, charIdByName);
        if (!ids.length) {
          if (l.w) {
            unmatched.set(l.w, (unmatched.get(l.w) || 0) + 1);
            if (!unmatchedEps.has(l.w)) unmatchedEps.set(l.w, new Set());
            unmatchedEps.get(l.w).add(e.id);
          }
          continue;
        }
        // 动作行（k="a"）与台词行（k="t"）分开记：两者都算「该集有它」，
        // 但只有台词能证明它当场说过话，倒推的口径必须能拆开看。
        const byKind = l.k === "a" ? charToActedEps : charToSpokenEps;
        for (const cid of ids) {
          set.add(cid);
          mark(charToEps, cid, e.id);
          mark(byKind, cid, e.id);
        }
      }
    }
    epToChars.set(e.id, set);
  }

  // 篇章 → 集，两条来源分别记，供对账
  const arcRange = new Map();
  for (const x of a.arcs) {
    const set = new Set();
    const from = Number.isFinite(x.start) ? x.start : 1;
    const to = Number.isFinite(x.end) ? x.end : from;
    for (let id = from; id <= to; id++) if (byEpisode.has(id)) set.add(id);
    arcRange.set(x.id, set);
  }
  const arcLink = new Map();
  for (const e of a.episodes) {
    for (const aid of e.a || []) {
      if (!arcLink.has(aid)) arcLink.set(aid, new Set());
      arcLink.get(aid).add(e.id);
    }
  }

  // 预计算「集 → 篇章」，避免每次调用都对全部篇章做一遍区间扫描
  const epToArcs = new Map();
  for (const e of a.episodes) epToArcs.set(e.id, new Set(e.a || []));
  arcRange.forEach((eps, aid) => {
    eps.forEach((id) => {
      if (!epToArcs.has(id)) epToArcs.set(id, new Set());
      epToArcs.get(id).add(aid);
    });
  });

  const shorts = [];
  const shortByRef = new Map();
  const searchable = [];
  let lineCount = 0;

  // 排序权重：集 > 短篇 > 角色/篇章。同一层级内按集号先后。
  const ORDER_EPISODE = (id) => id;
  const ORDER_SHORT = (id, index) => 100000 + id * 100 + index;

  for (const e of a.episodes) {
    const shText = (e.sh || []).map((sh) => sh.s || "").join(" ");
    searchable.push({
      kind: "episode",
      ref: String(e.id),
      title: [e.cn || "", e.jp || ""].join(" ").trim(),
      body: [e.cn || "", e.jp || "", shText].join(" "),
      lines: [],
      order: ORDER_EPISODE(e.id),
    });
  }

  for (const e of a.episodes) {
    (e.sh || []).forEach((sh, i) => {
      const index = i + 1;
      const ref = e.id + ":" + index;
      const rec = {
        ref,
        episode_id: e.id,
        index,
        title: sh.t || "",
        confidence: sh.c || "",
        summary: sh.s || "",
        lines: (sh.l || []).map((l) => ({ who: l.w || "", kind: l.k || "", text: l.x || "" })),
      };
      lineCount += rec.lines.length;
      shorts.push(rec);
      shortByRef.set(ref, rec);
      searchable.push({
        kind: "short",
        ref,
        title: rec.title,
        body: rec.summary,
        lines: rec.lines,
        order: ORDER_SHORT(e.id, index),
      });
    });
  }

  for (const c of a.characters) {
    searchable.push({
      kind: "character",
      ref: c.id,
      title: c.cn || c.id,
      body: [c.intro || "", c.jp || "", (c.tags || []).join(" "), (c.alias || []).join(" ")].join(" "),
      lines: [],
      order: 0,
    });
  }

  for (const x of a.arcs) {
    searchable.push({
      kind: "arc",
      ref: x.id,
      title: x.cn || x.id,
      body: [x.summary || "", x.jp || "", x.tag || ""].join(" "),
      lines: [],
      order: 0,
    });
  }

  return {
    byEpisode, byCharacter, byArc, charIdByName, epToChars, charToEps,
    charToSpokenEps, charToActedEps, epToArcs,
    arcRange, arcLink, shorts, shortByRef, searchable, lineCount, unmatched, unmatchedEps,
  };
}

/* ------------------------------------------------------------------ 检索 */

function runSearch(idx, query, kind, offset, limit) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { total: 0, offset, returned: 0, has_more: false, hits: [] };

  const hits = [];
  for (const rec of idx.searchable) {
    if (kind && rec.kind !== kind) continue;

    const title = String(rec.title).toLowerCase();
    const body = String(rec.body).toLowerCase();
    let score = 0;
    let all = true;
    // 片段只放在本地变量里 —— 早先写在 rec 上再 delete，多个调用方共享同一份记录时会互相串。
    let snips = [];

    for (const t of terms) {
      let hit = 0;
      if (title.indexOf(t) >= 0) hit += 6;
      if (body.indexOf(t) >= 0) hit += 2;
      for (const l of rec.lines) {
        const text = String(l.text);
        if (text.toLowerCase().indexOf(t) >= 0) {
          hit += 2;
          if (snips.length < 3) snips.push(l.who + "：" + text);
        }
      }
      if (hit === 0) { all = false; break; }
      score += hit;
    }
    if (!all) continue;

    hits.push({
      kind: rec.kind,
      ref: rec.ref,
      title: rec.title,
      snippet: snips.length ? snips.slice(0, 3) : [String(rec.body).slice(0, 80)],
      score,
      order: rec.order,
    });
  }

  hits.sort((x, y) => y.score - x.score || x.order - y.order);
  const page = Number.isFinite(limit) ? hits.slice(offset, offset + limit) : hits.slice(offset);
  return {
    total: hits.length,
    offset,
    returned: page.length,
    has_more: offset + page.length < hits.length,
    hits: page,
  };
}

/* ------------------------------------------------------------------ 工具 */

const KIND_ENUM = ["episode", "short", "character", "arc"];

const TOOLS = [
  {
    name: "list_entries",
    description:
      "分页浏览词条概要；需要完整目录时按 has_more 和 offset 翻页。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KIND_ENUM, description: "词条类型" },
        filter: {
          type: "object",
          description: "按类型生效的过滤条件，多余字段会被忽略",
          properties: {
            season: { type: "integer", enum: [1, 2, 3], description: "仅 episode：第几季" },
            arc_id: { type: "string", description: "仅 episode：属于该篇章" },
            has_arc: { type: "boolean", description: "仅 episode：是否已关联篇章" },
            episode_id: { type: "integer", description: "仅 short：属于该集" },
            confidence: { type: "string", enum: ["A", "B"], description: "仅 short：可信度等级" },
            tag: { type: "string", description: "仅 arc：篇章标签" },
            role: { type: "string", description: "仅 character：角色定位" },
            q: { type: "string", description: "标题包含该字符串" },
          },
        },
        offset: { type: "integer", minimum: 0, description: "从第几条开始，默认 0" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "本页条数，默认 50，上限 200" },
      },
      required: ["kind"],
    },
  },
  {
    name: "get_entry",
    description:
      "取单个词条。id：episode 用集号；short 用集号:序号（从 1 开始）；character/arc 用其 id。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KIND_ENUM },
        id: { type: ["string", "integer"], description: "词条 id，形式见工具说明" },
        compact: { type: "boolean", description: "精简台词明细，默认 false" },
      },
      required: ["kind", "id"],
    },
  },
  {
    name: "search_entries",
    description:
      "检索集、短篇、角色与篇章，返回定位及最多 3 条片段，不返全文。按 total / has_more / offset 翻页。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词，空格分隔表示全部命中" },
        kind: { type: "string", enum: KIND_ENUM, description: "限定类型，省略则全部" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "本页条数，默认 40，上限 200" },
        offset: { type: "integer", minimum: 0, description: "从第几条开始，默认 0" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_related",
    description:
      "查集、角色、篇章的关联。episode_ids 包含库内全部关联集号；覆盖来源见 coverage。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["episode", "character", "arc"] },
        id: { type: ["string", "integer"] },
        limit: {
          type: "integer", minimum: 1, maximum: MAX_LIMIT,
          description: "可读集列表的条数上限，默认 60；episode_ids 始终完整",
        },
      },
      required: ["kind", "id"],
    },
  },
  {
    name: "describe_schema",
    description:
      "返回字段语义、规模、版本与已知缺口；本会话首次使用时调用。",
    inputSchema: { type: "object", properties: {} },
  },
];

for (const tool of TOOLS) {
  tool.annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/* ------------------------------------------------------------------ 实现 */

function seasonOf(id) {
  return id <= 120 ? 1 : id <= 240 ? 2 : 3;
}

function epBrief(idx, id) {
  const e = idx.byEpisode.get(id);
  if (!e) return null;
  return { id: e.id, cn: e.cn || "", jp: e.jp || "", date: e.d || "" };
}

function arcIdsForEpisode(idx, e) {
  // 区间 ∪ 反查，装载时已预计算（见 buildIndex 的 epToArcs）
  return Array.from(idx.epToArcs.get(e.id) || []);
}

function tList(idx, kind, filter, offset, limit) {
  const f = filter || {};
  let rows = [];
  let mapped;

  if (kind === "episode") {
    rows = Array.from(idx.byEpisode.values());
    if (f.season) rows = rows.filter((e) => seasonOf(e.id) === f.season);
    // 按篇章过滤一律取「区间 ∪ 反查」，与 get_related / get_entry 同口径。
    // 早先只看 episodes[].a，会把区间内漏回填的集（如第 214 集）静默漏掉。
    if (f.arc_id) rows = rows.filter((e) => (idx.epToArcs.get(e.id) || new Set()).has(f.arc_id));
    if (typeof f.has_arc === "boolean") {
      rows = rows.filter((e) => ((idx.epToArcs.get(e.id) || new Set()).size > 0) === f.has_arc);
    }
    if (f.q) {
      const q = String(f.q).toLowerCase();
      rows = rows.filter((e) =>
        (e.cn || "").toLowerCase().indexOf(q) >= 0 || (e.jp || "").toLowerCase().indexOf(q) >= 0);
    }
    rows.sort((x, y) => x.id - y.id);
    mapped = rows.map((e) => ({
      id: e.id, cn: e.cn || "", jp: e.jp || "", date: e.d || "",
      shorts: (e.sh || []).length, arcs: arcIdsForEpisode(idx, e),
    }));
  } else if (kind === "short") {
    rows = idx.shorts.slice();
    if (f.episode_id) rows = rows.filter((s) => s.episode_id === f.episode_id);
    if (f.confidence) rows = rows.filter((s) => s.confidence === f.confidence);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      rows = rows.filter((s) => s.title.toLowerCase().indexOf(q) >= 0);
    }
    rows.sort((x, y) => x.episode_id - y.episode_id || x.index - y.index);
    mapped = rows.map((s) => ({
      ref: s.ref, episode_id: s.episode_id, index: s.index,
      title: s.title, confidence: s.confidence,
      summary: s.summary.slice(0, 60),
    }));
  } else if (kind === "arc") {
    rows = Array.from(idx.byArc.values());
    if (f.tag) rows = rows.filter((x) => x.tag === f.tag);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      rows = rows.filter((x) =>
        (x.cn || "").toLowerCase().indexOf(q) >= 0 || (x.jp || "").toLowerCase().indexOf(q) >= 0);
    }
    rows.sort((x, y) => (x.start || 0) - (y.start || 0));
    mapped = rows.map((x) => ({
      id: x.id, cn: x.cn || "", jp: x.jp || "",
      range: [x.start, x.end], tag: x.tag || "", status: x.status || "",
    }));
  } else if (kind === "character") {
    rows = Array.from(idx.byCharacter.values());
    if (f.role) rows = rows.filter((c) => c.role === f.role);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      rows = rows.filter((c) =>
        (c.cn || "").toLowerCase().indexOf(q) >= 0 || (c.jp || "").toLowerCase().indexOf(q) >= 0);
    }
    rows.sort((x, y) => String(x.id).localeCompare(String(y.id)));
    mapped = rows.map((c) => ({
      id: c.id, cn: c.cn || "", jp: c.jp || "", role: c.role || "", tags: c.tags || [],
    }));
  } else {
    throw new Error("未知的 kind：" + kind);
  }

  const total = mapped.length;
  const page = mapped.slice(offset, offset + limit);
  return {
    kind, total, offset, limit,
    returned: page.length,
    has_more: offset + page.length < total,
    items: page,
  };
}

function characterEpisodes(idx, c) {
  const declared = (c.eps || []).filter((n) => idx.byEpisode.has(n)).sort((x, y) => x - y);
  const spoken = Array.from(idx.charToSpokenEps.get(c.id) || []).sort((x, y) => x - y);
  const acted = Array.from(idx.charToActedEps.get(c.id) || []).sort((x, y) => x - y);
  const inferred = Array.from(new Set(spoken.concat(acted))).sort((x, y) => x - y);
  const union = Array.from(new Set(declared.concat(inferred))).sort((x, y) => x - y);
  // 互斥拆分：只说没做 / 只做没说 / 又说又做。相加才是 inferred，避免读者把两个数当不相交。
  const spokenSet = new Set(spoken);
  const actedSet = new Set(acted);
  const spokenOnly = spoken.filter((n) => !actedSet.has(n));
  const actedOnly = acted.filter((n) => !spokenSet.has(n));
  const both = spoken.filter((n) => actedSet.has(n));
  return { declared, spoken, acted, spokenOnly, actedOnly, both, inferred, union };
}

function tGet(idx, archive, kind, id, compact) {
  if (kind === "episode") {
    const e = idx.byEpisode.get(Number(id));
    if (!e) return { found: false, error: "没有第 " + id + " 集" };
    const out = {
      found: true, kind: "episode", id: e.id, cn: e.cn || "", jp: e.jp || "",
      date: e.d || "", season: seasonOf(e.id), arcs: arcIdsForEpisode(idx, e),
      characters: Array.from(idx.epToChars.get(e.id) || []),
      shorts: (e.sh || []).map((sh, i) => {
        const base = {
          ref: e.id + ":" + (i + 1), index: i + 1,
          title: sh.t || "", confidence: sh.c || "", summary: sh.s || "",
        };
        if (!compact) {
          base.lines = (sh.l || []).map((l) => ({ who: l.w || "", kind: l.k || "", text: l.x || "" }));
        } else {
          base.line_count = (sh.l || []).length;
        }
        return base;
      }),
    };
    return out;
  }

  if (kind === "short") {
    // 短篇的 id 是「集号:序号」字符串，两种入参形态都先转成字符串再查
    const ref = String(id);
    const rec = idx.shortByRef.get(ref);
    if (!rec) return { found: false, error: "没有短篇 " + ref + "（形式应为 集号:序号）" };
    return {
      found: true, kind: "short", ref: rec.ref,
      episode: epBrief(idx, rec.episode_id),
      index: rec.index, title: rec.title, confidence: rec.confidence,
      summary: rec.summary,
      lines: rec.lines.map((l) =>
        compact ? { who: l.who, kind: l.kind } : { who: l.who, kind: l.kind, text: l.text }),
    };
  }

  if (kind === "character") {
    const c = idx.byCharacter.get(String(id));
    if (!c) return { found: false, error: "没有角色 " + id };
    const ep = characterEpisodes(idx, c);
    const out = {
      found: true, kind: "character", id: c.id, cn: c.cn || "", jp: c.jp || "",
      romaji: c.romaji || "", role: c.role || "", tags: c.tags || [], alias: c.alias || [],
      cvJp: c.cvJp || "", cvCn: c.cvCn || "",
      intro: c.intro || "", sample_line: c.line || "",
      episodes: ep.union,
      episode_coverage: {
        declared: ep.declared.length,
        from_speaking: ep.spoken.length,
        from_actions: ep.acted.length,
        union: ep.union.length,
        breakdown: {
          declared_only: ep.declared.filter((n) => ep.union.indexOf(n) >= 0 && ep.inferred.indexOf(n) < 0).length,
          spoken_only: ep.spokenOnly.length,
          acted_only: ep.actedOnly.length,
          both: ep.both.length,
          note: "inferred = spoken_only + acted_only + both；declared 与 inferred 之间可能重叠。",
        },
        note:
          "characters[].eps 是代表性出场，不是全集。union = 声明 ∪ 台词可证 ∪ 动作可证。" +
          "from_speaking 是它确实在这些集里说过话的集数；from_actions 只由动作行（k=\"a\"）推出，" +
          "证明的是「该集有它」，不等于它开口了——不说话的集也能这样推出来，所以 from_actions 通常远大于 from_speaking。" +
          "没有台词也没有动作的出场推不出来，union 仍是下界。",
      },
    };
    if (!compact) {
      out.declared_episodes = ep.declared;
      out.spoken_episodes = ep.spoken;
      out.action_episodes = ep.acted;
      out.inferred_episodes = ep.inferred;
    }
    return out;
  }

  if (kind === "arc") {
    const x = idx.byArc.get(String(id));
    if (!x) return { found: false, error: "没有篇章 " + id };
    const linked = idx.arcLink.get(x.id) || new Set();
    const ranged = idx.arcRange.get(x.id) || new Set();
    const union = new Set([...linked, ...ranged]);
    return {
      found: true, kind: "arc", id: x.id, cn: x.cn || "", jp: x.jp || "",
      range: [x.start, x.end], tag: x.tag || "", status: x.status || "",
      summary: x.summary || "",
      episode_count: union.size,
      episodes: Array.from(union).sort((p, q) => p - q),
      coverage: {
        from_episode_links: linked.size,
        from_arc_range: ranged.size,
        note:
          "两来源语义不同：arcs[].start/end 是主体连续区间，episodes[].a 还含呼应/回访集，" +
          "二者不构成倒排关系，episode_count 取并集。差异是设计如此，不是数据错误。",
      },
    };
  }

  throw new Error("未知的 kind：" + kind);
}

function tRelated(idx, kind, id, limit) {
  const packEpisodes = (ids) => {
    const sorted = Array.from(new Set(ids)).filter((n) => idx.byEpisode.has(n)).sort((a, b) => a - b);
    const page = sorted.slice(0, limit);
    return {
      episodes: page.map((n) => epBrief(idx, n)),
      episode_ids: sorted,
      episode_total: sorted.length,
      has_more: sorted.length > page.length,
    };
  };

  const packArcs = (ids) =>
    Array.from(new Set(ids)).map((aid) => {
      const x = idx.byArc.get(aid);
      return { id: aid, cn: x ? x.cn : aid, range: x ? [x.start, x.end] : null };
    });

  const packChars = (ids) =>
    Array.from(new Set(ids)).map((cid) => {
      const c = idx.byCharacter.get(cid);
      return { id: cid, cn: c ? c.cn : cid };
    });

  if (kind === "episode") {
    const e = idx.byEpisode.get(Number(id));
    if (!e) return { found: false, error: "没有第 " + id + " 集" };
    return Object.assign(
      { found: true, kind: "episode", id: e.id, cn: e.cn || "", jp: e.jp || "" },
      { characters: packChars(idx.epToChars.get(e.id) || []), arcs: packArcs(arcIdsForEpisode(idx, e)) }
    );
  }

  if (kind === "character") {
    const c = idx.byCharacter.get(String(id));
    if (!c) return { found: false, error: "没有角色 " + id };
    const ep = characterEpisodes(idx, c);
    const arcs = new Set();
    for (const n of ep.union) (idx.epToArcs.get(n) || new Set()).forEach((aid) => arcs.add(aid));
    return Object.assign(
      {
        found: true, kind: "character", id: c.id, cn: c.cn || "", jp: c.jp || "",
        coverage: {
          declared: ep.declared.length,
          from_speaking: ep.spoken.length,
          from_actions: ep.acted.length,
          union: ep.union.length,
          breakdown: {
            spoken_only: ep.spokenOnly.length,
            acted_only: ep.actedOnly.length,
            both: ep.both.length,
          },
        },
      },
      packEpisodes(ep.union),
      { arcs: packArcs(arcs) }
    );
  }

  if (kind === "arc") {
    const x = idx.byArc.get(String(id));
    if (!x) return { found: false, error: "没有篇章 " + id };
    const linked = idx.arcLink.get(x.id) || new Set();
    const ranged = idx.arcRange.get(x.id) || new Set();
    const union = new Set([...linked, ...ranged]);
    const chars = new Set();
    for (const n of union) (idx.epToChars.get(n) || new Set()).forEach((cid) => chars.add(cid));
    return Object.assign(
      {
        found: true, kind: "arc", id: x.id, cn: x.cn || "", jp: x.jp || "",
        coverage: { from_episode_links: linked.size, from_arc_range: ranged.size },
      },
      packEpisodes(union),
      { characters: packChars(chars) }
    );
  }

  throw new Error("get_related 的 kind 只支持 episode / character / arc");
}

function arcMissingLinks(idx, archive) {
  const out = [];
  for (const x of archive.arcs) {
    for (let i = x.start; i <= x.end; i++) {
      const e = idx.byEpisode.get(i);
      if (e && (e.a || []).indexOf(x.id) < 0) {
        out.push({ arc_id: x.id, arc_cn: x.cn || x.id, episode_id: i, episode_cn: e.cn || "" });
      }
    }
  }
  return out;
}

function tDescribe(idx, archive) {
  const missing = arcMissingLinks(idx, archive);
  const insideRange = new Set();
  for (const x of archive.arcs) {
    for (let i = x.start; i <= x.end; i++) if (idx.byEpisode.has(i)) insideRange.add(i);
  }
  const outsideRange = archive.episodes.length - insideRange.size;
  const shortSummaries = idx.shorts.map((s) => s.summary.length).sort((x, y) => x - y);
  const median = shortSummaries.length ? shortSummaries[Math.floor(shortSummaries.length / 2)] : 0;
  const truncated = idx.shorts.filter((s) => s.summary.length < 80).length;

  const seen = new Map();
  for (const e of archive.episodes) {
    for (const sh of e.sh || []) {
      for (const l of sh.l || []) {
        const k = e.id + "|" + sh.t + "|" + l.w + "|" + l.x;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
    }
  }
  let dupLines = 0;
  seen.forEach((v) => { if (v > 1) dupLines += 1; });

  // 角色出场的两处口径都按真实数据现算，不写死示例数字 —— 写死的说明会随数据漂移。
  const affected = [];
  for (const c of archive.characters) {
    const declared = (c.eps || []).filter((n) => idx.byEpisode.has(n)).length;
    const union = characterEpisodes(idx, c).union.length;
    if (union > declared) affected.push({ c, declared, union });
  }
  affected.sort((a, b) => (b.union - b.declared) - (a.union - a.declared));
  const affectedSample = affected.slice(0, 3)
    .map((x) => x.c.cn + " 声明 " + x.declared + " / 并集 " + x.union)
    .join("；");

  const spokenName = (n) => (idx.charToSpokenEps.get(n) || new Set()).size;
  const chiikawaChar = idx.byCharacter.get("chiikawa");
  const chiikawaSplit = chiikawaChar
    ? characterEpisodes(idx, chiikawaChar)
    : { actedOnly: [], inferred: [] };
  const worldProblems = auditWorld(idx, archive);

  return {
    server: SERVER_NAME,
    server_version: SERVER_VERSION,
    data_version: archive.version,
    source_dir: archive.dir,
    source_files: archive.files.length,
    source_bytes: archive.bytes,
    counts: {
      episode: archive.episodes.length,
      short: idx.shorts.length,
      character: archive.characters.length,
      arc: archive.arcs.length,
      line: idx.lineCount,
    },
    // 人格层不写世界清单（常驻成本 + 两处维护），但即兴需要它 —— 放在这里按需带出。
    // 它是索引不是文案：每个词都指向库里的条目，顺着能往下查。
    world: WORLD,
    world_check: worldProblems.length
      ? { ok: false, problems: worldProblems }
      : { ok: true, note: "世界词表的每一项都在库中有据可查" },
    fields: {
      "episodes[].id": "集号，1-345，连续无缺",
      "episodes[].jp / .cn": "日文原名 / 中文标题",
      "episodes[].d": "首播日期",
      "episodes[].a": "该集涉及的篇章 id 数组，含呼应/回访集，因此不限于「所属区间」；空数组多数表示该集本就不属于任何篇章",
      "episodes[].sh[]": "一集内的短篇，通常 2 个；不是「集」，别叫错",
      "sh[].t": "短篇标题",
      "sh[].c": "可信度等级 A/B（A=有资料支撑），不是分类",
      "sh[].s": "短篇概要",
      "sh[].l[]": "台词与动作行",
      "l[].w": "说话人/动作主体。可能写成合并形式（如「哈奇喵与吉伊」），本服务会拆开解析",
      "l[].k": "a=动作，t=台词。两者都能证明「该集有它」，只有 t 能证明它说过话",
      "l[].x": "文本",
      "characters[].eps": "代表性出场集号，不是全集（见 known_gaps: character-eps-is-subset）",
      "arcs[].start / .end": "篇章的主体连续区间。与 episodes[].a 语义不同，二者不构成倒排关系，取并集才是完整覆盖",
    },
    known_gaps: [
      {
        id: "load-order-trap",
        detail: "数据文件的读取顺序不是集号顺序，靠文件名排序会把靠后的区间排到前面。",
        workaround: "任何消费者都必须显式按 id 排序，而且不会报错，只会安静地返回错结果。本服务已在装载层处理。",
      },
      {
        id: "arc-fk-missing",
        detail:
          "篇章区间内有 " + missing.length + " 集没有回填 episodes[].a" +
          (missing.length
            ? "：" + missing.map((m) => "第 " + m.episode_id + " 集「" + m.episode_cn + "」（" + m.arc_cn + "）").join("、")
            : "") +
          "。另有 " + outsideRange + " 集本就不属于任何篇章，其 a[] 为空是正常的，不是缺陷。",
        workaround: "对 arc 取「区间 ∪ 反查」而非单看 a[]，本服务已这么做并返回 coverage。",
      },
      {
        id: "arc-link-not-inverse",
        detail:
          "episodes[].a 与 arcs[].start/.end 语义不同：前者含呼应/回访集（如第 125 集指向 41-43 的郎拉面篇），" +
          "后者是主体连续区间。二者本就不该互为倒排，差异不是缺陷。",
        workaround: "需要完整覆盖时取并集，不要拿任一单边当真值。",
      },
      {
        id: "character-eps-is-subset",
        detail:
          "characters[].eps 是代表性出场，不是全集——" + archive.characters.length + " 个角色里 " +
          affected.length + " 个的并集大于声明（按差额排前几：" + (affectedSample || "无") + "）。" +
          "并集由三种证据合成：声明、台词可证、动作可证；其中只有台词能说明它在该集开口了。" +
          "以吉伊卡哇为例：台词可证 " + spokenName("chiikawa") + " 集，纯动作可证 " +
          chiikawaSplit.actedOnly.length + " 集，两者相加才等于并集 " + chiikawaSplit.inferred.length + " 集。" +
          "不要拿声明数回答该角色出现在哪些集。",
        workaround: "get_related(character) 与 get_entry(character) 返回 episodes 并集，并在 coverage 里拆开 declared / from_speaking / from_actions。",
      },
      {
        id: "duplicate-lines",
        detail: "有 " + dupLines + " 条完全重复的台词/动作行（同集、同短篇、同说话人、同文本）。",
        workaround: "检索结果可能重复出现，按 ref + 序号去重。",
      },
      {
        id: "short-summaries",
        detail: "短篇概要中位数 " + median + " 字，其中 " + truncated + " 条不足 80 字。",
        workaround: "概念性检索优先用 title 与 lines，别只靠概要。",
      },
      {
        id: "unmatched-speakers",
        detail:
          "有说话人未登记为角色（共 " + idx.unmatched.size + " 个名字 / " +
          Array.from(idx.unmatched.values()).reduce((s, n) => s + n, 0) + " 行）：" +
          (Array.from(idx.unmatched.entries()).map(([n, x]) => n + "×" + x).join("、") || "无") + "。",
        workaround: "这几处出场推不出角色，关系图有洞；完整清单与各自所在集见本响应的 unmatched_speakers。",
      },
    ],
    unmatched_speakers: Array.from(idx.unmatched.entries())
      .map(([name, count]) => ({
        name,
        count,
        episode_ids: Array.from(idx.unmatchedEps.get(name) || []).sort((a, b) => a - b),
      }))
      .sort((x, y) => y.count - x.count),
  };
}

/* ------------------------------------------------------------------ 分发 */

function callTool(idx, archive, name, args) {
  const a = args || {};
  const fallback = name === "get_related" ? 60
    : (name === "search_entries" ? SEARCH_LIMIT : DEFAULT_LIMIT);
  const rawLimit = Number(a.limit);
  const limit = Math.min(Math.max(1, rawLimit || fallback), MAX_LIMIT);
  const offset = Math.max(0, Number(a.offset) || 0);

  switch (name) {
    case "list_entries":
      return tList(idx, a.kind, a.filter, offset, limit);
    case "get_entry":
      return tGet(idx, archive, a.kind, a.id, Boolean(a.compact));
    case "search_entries": {
      /* 不传 limit 时按 SEARCH_LIMIT 分页，不再「一次把命中的全塞回去」。
         原来这里是 Infinity：搜「吉伊」实测命中 226 条、响应体 64KB —— 一次
         工具调用烧掉六万多字节上下文，而 schema 上写着「默认 20」。
         分页元信息由 runSearch 按实际 limit 算，has_more / next_offset 都是真的，
         不需要靠「全给」来避免谎报。 */
      const out = runSearch(idx, a.query, a.kind, offset, limit);
      return {
        query: a.query,
        kind: a.kind || null,
        total: out.total,
        offset: out.offset,
        returned: out.returned,
        has_more: out.has_more,
        hits: out.hits,
      };
    }
    case "get_related":
      return tRelated(idx, a.kind, a.id, limit);
    case "describe_schema":
      return tDescribe(idx, archive);
    default:
      throw new Error("没有这个工具：" + name);
  }
}

/* ------------------------------------------------------------------ 协议 */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

let archive = null;
let index = null;

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    replyError(null, -32700, "请求不是合法 JSON");
    return;
  }

  const id = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : null;
  const method = msg.method;

  if (!method) {
    if (id !== null) replyError(id, -32600, "缺少 method");
    return;
  }

  if (id === null) return; // 通知，不需要回执

  try {
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
        return;
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const p = msg.params || {};
        const out = callTool(index, archive, p.name, p.arguments);
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          isError: false,
        });
        return;
      }
      default:
        replyError(id, -32601, "不支持的方法：" + method);
    }
  } catch (err) {
    const text = err && err.message ? err.message : String(err);
    if (method === "tools/call") {
      reply(id, { content: [{ type: "text", text: "调用失败：" + text }], isError: true });
    } else {
      replyError(id, -32603, text);
    }
  }
}

function main() {
  archive = loadArchive();
  index = buildIndex(archive);
  process.stderr.write(
    "[" + SERVER_NAME + "] 已装载 " + archive.files.length + " 个文件 / " +
    archive.episodes.length + " 集 / " + index.shorts.length + " 短篇，版本 " + archive.version + "\n");

  // 词表与数据脱节会让模型照着不存在的设定编，所以启动就说清楚。
  // 走 stderr：stdout 只能有 JSON-RPC，写别的进去会让宿主解析失败。
  const worldProblems = auditWorld(index, archive);
  for (const p of worldProblems) {
    process.stderr.write("[" + SERVER_NAME + "] 世界词表待修：" + p + "\n");
  }

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (line) handle(line);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// 探针：--selftest 直接打印装载摘要后退出，便于排查
if (process.argv.indexOf("--selftest") >= 0) {
  archive = loadArchive();
  index = buildIndex(archive);
  const problems = auditWorld(index, archive);
  for (const p of problems) process.stderr.write("[selftest] 世界词表待修：" + p + "\n");
  process.stdout.write(JSON.stringify(tDescribe(index, archive), null, 2) + "\n");
  process.exit(0);
}

main();
