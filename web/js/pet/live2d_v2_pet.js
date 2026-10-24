import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// AI 看板娘默认人设（正式配置在 ComfyUI 设置 → XBHH 看板娘 人设，此处仅兜底）
const XBHH_DEFAULT_PERSONA =
  "你是 ComfyUI 工作台上的 AI 看板娘，本体是 DeepSeek（一只聪明的小蓝鲸），" +
  "性格活泼、偶尔傲娇、爱撒娇。用中文口语聊天，每次回复控制在两三句话内，" +
  "不要用列表和 markdown。回复结尾必须附一个情绪标签，从这些里选一个：" +
  "[开心] [难过] [生气] [惊讶] [害羞] [疑惑] [激动] [平静]";

/**
 * XBHH Live2D Pet SDK 2.0 (Pio) Adapter
 * 采用标准化移植方案：从 test/1 (live2d-widget) 完整平移逻辑，并适配 ComfyUI 环境。
 */
// ============================================================================
// LoRA 堆工具调用处理：AI 通过 add_lora / remove_lora / set_lora_strength
// 直接操作当前画布上的 XBHHMultiLoraLoader（用户自写的 LoRA 堆）节点
// ============================================================================
/**
 * 定位画布上的正向提示词输入节点（自动看图优化用）。
 * 优先级：采样器 positive 输入回溯 > 标题含 positive/正向 > widgets_values
 * 大文本（≥12字）> 第一个 CLIPTextEncode > 第一个带 text/string/prompt
 * widget 的节点。ShowText|pysssss 节点在黑名单里，在提示词路径上时继续
 * 回溯其输入源。
 */
function xbhhFindPromptNode() {
  const graph = app && app.graph;
  if (!graph) return null;
  const nodes = (graph._nodes || graph.nodes) || [];
  const black = (n) => /ShowText|pysssss/i.test((n && n.type) || "");
  const textW = (n) =>
    (n.widgets || []).find(
      (w) => w && ["text", "string", "prompt"].includes(w.name || ""),
    ) || null;
  const isNeg = (n) => /negative|负向/i.test(`${(n && n.title) || ""}${(n && n.type) || ""}`);
  const isSampler = (n) =>
    /^(KSampler|KSamplerAdvanced|SamplerCustom.*|.*Sampler)$/.test((n && n.type) || "");
  // 沿输入链回溯：黑名单/无文本 widget 的节点跳过，找其上游
  const trace = (n, depth) => {
    if (!n || depth > 8) return null;
    if (!black(n) && !isNeg(n)) {
      const tw = textW(n);
      if (tw) return { node: n, widget: tw };
    }
    if (n.inputs && n.inputs.length && typeof n.getInputNode === "function") {
      const slot = n.inputs.findIndex((i) => i && i.link != null);
      if (slot >= 0) {
        const src = n.getInputNode(slot);
        if (src) return trace(src, depth + 1);
      }
    }
    return null;
  };
  // 1) 采样器 positive 输入回溯
  for (const n of nodes) {
    if (!isSampler(n) || !n.inputs) continue;
    const slot = n.inputs.findIndex(
      (i) => i && i.link != null && /positive|正向/i.test(i.name || ""),
    );
    if (slot < 0) continue;
    const hit = trace(n.getInputNode(slot), 0);
    if (hit) return hit;
  }
  // 2) 标题关键词
  for (const n of nodes) {
    if (black(n) || isNeg(n)) continue;
    if (/positive|正向/i.test(n.title || "")) {
      const tw = textW(n);
      if (tw) return { node: n, widget: tw };
    }
  }
  // 3) widgets_values 大文本
  for (const n of nodes) {
    if (black(n) || isNeg(n)) continue;
    const vals = n.widgets_values;
    if (
      Array.isArray(vals) &&
      vals.some((v) => typeof v === "string" && v.length >= 12)
    ) {
      const tw = textW(n);
      if (tw) return { node: n, widget: tw };
    }
  }
  // 4) 第一个 CLIPTextEncode
  for (const n of nodes) {
    if (black(n) || isNeg(n)) continue;
    if (/CLIPTextEncode/i.test(n.type || "")) {
      const tw = textW(n);
      if (tw) return { node: n, widget: tw };
    }
  }
  // 5) 第一个带文本 widget 的节点
  for (const n of nodes) {
    if (black(n) || isNeg(n)) continue;
    const tw = textW(n);
    if (tw) return { node: n, widget: tw };
  }
  return null;
}

/**
 * 按分类名定位画布上的提示词槽位节点（AI 分类提示词填写用）。
 * 定位顺序：① 用户在设置里配置的绑定映射（promptSlotMap: 分类名→节点ID，最高优先）
 * ② 标题精确等于分类名 > ③ 标题包含分类名 > ④ 分类名包含标题
 * （均忽略大小写/空白；标题过短(<2字)不参与双向包含，防误匹配）。
 * 仅排除 ShowText|pysssss 黑名单；重名取第一个；找不到返回 null，
 * 不做全局兜底（兜底由 xbhhHandlePromptToolCalls 统一决定，避免填错节点）。
 */
function xbhhFindPromptSlotNode(category) {
  const graph = app && app.graph;
  if (!graph) return null;
  const cat = String(category || "").trim();
  if (!cat) return null;
  // ① 用户配置的绑定映射优先（绑定的节点被删除/无文本框则继续走标题匹配）
  // 绑定可能随工作流保存在 graph.extra 里，优先走工作流读取接口
  const map =
    (window.xbhhGetBoundMap
      ? window.xbhhGetBoundMap("promptSlotMap")
      : (window.xbhhSettings && window.xbhhSettings.get("promptSlotMap", {}))) || {};
  const boundId = map[cat];
  if (boundId !== undefined && boundId !== null && String(boundId).trim() !== "") {
    const bn = xbhhNodeById(boundId);
    const bw = bn && xbhhStringWidget(bn);
    if (bn && bw) return { node: bn, widget: bw, bound: true };
  }
  const nodes = (graph._nodes || graph.nodes) || [];
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const catN = norm(cat);
  let includesHit = null;
  let reverseHit = null;
  for (const n of nodes) {
    if (!xbhhIsTextNode(n)) continue; // 只认文本输入节点（输出 STRING），排除 CLIP文本编码等
    const titleN = norm(n.title);
    if (!titleN) continue;
    if (titleN === catN) return { node: n, widget: xbhhStringWidget(n) };
    if (!includesHit && titleN.includes(catN)) includesHit = { node: n, widget: xbhhStringWidget(n) };
    if (!reverseHit && titleN.length >= 2 && catN.includes(titleN)) reverseHit = { node: n, widget: xbhhStringWidget(n) };
  }
  return includesHit || reverseHit || null;
}

/** 按 ID 精确定位画布节点（write_prompts 的 node_id 参数用） */
function xbhhNodeById(id) {
  const graph = app && app.graph;
  if (!graph || id === null || id === undefined || id === "") return null;
  const want = String(id).trim();
  const nodes = (graph._nodes || graph.nodes) || [];
  return nodes.find((n) => n && String(n.id) === want) || null;
}

/** 取节点的文本输入 widget：优先按类型 STRING 判定（文本输入节点的 widget 名不固定），名字/字符串值兜底 */
function xbhhStringWidget(n) {
  const ws = (n && n.widgets) || [];
  return (
    ws.find((w) => w && String(w.type || "").toUpperCase() === "STRING") ||
    ws.find((w) =>
      w && ["text", "string", "prompt"].includes(String(w.name || "").toLowerCase()),
    ) ||
    ws.find((w) => w && typeof w.value === "string") ||
    null
  );
}

/**
 * 判定「文本输入节点」：输出槽里有 STRING 类型的输出（文本输入节点的特征，
 * 输出 string 接给 CLIP 文本编码等下游），并带文本输入 widget。
 * 借此排除 CLIPTextEncode（输出 CONDITIONING）等非文本节点；ShowText|pysssss 黑名单。
 */
function xbhhIsTextNode(n) {
  if (!n || /ShowText|pysssss/i.test(n.type || "")) return false;
  const hasStringOut = (n.outputs || []).some(
    (o) => o && String(o.type || "").toUpperCase() === "STRING",
  );
  return hasStringOut && !!xbhhStringWidget(n);
}

/** 列出画布上全部文本输入节点（设置面板绑定下拉选项用） */
function xbhhListTextNodes() {
  const graph = app && app.graph;
  const nodes = (graph && (graph._nodes || graph.nodes)) || [];
  return nodes
    .filter(xbhhIsTextNode)
    .slice(0, 20)
    .map((n) => ({ id: String(n.id), title: String(n.title || n.type || "").trim() }));
}
window.xbhhListTextNodes = xbhhListTextNodes;

/**
 * 处理 LLM 返回的 write_prompts 工具调用：把分类提示词写入画布节点。
 * 放置方案（先定方案再统一写入，避免同节点被写两次）：
 * 1) 分类名匹配槽位节点 → 直接写入；
 * 2) 未命中的分类：画布有「其他」节点 → 拼接追加进去；
 * 3) 无「其他」且命中数 ≤1（画布只有"人物"一个入口或只有"正向提示词"）→
 *    全部分类按序拼接后整段写入唯一可用节点（命中1个用那个，0个用 xbhhFindPromptNode）；
 * 4) 命中 ≥2 且无「其他」→ 未命中分类逐条警告，不乱写。
 * 返回结果文案数组（供气泡展示）。
 */
async function xbhhHandlePromptToolCalls(calls) {
  const results = [];
  const allCalls = (calls || []).filter((t) => t.name === "write_prompts");
  if (!allCalls.length) return results;
  // 汇总所有 {category, nodeId, content}（容忍一次消息里多次调用；node_id 可选，优先于分类名）
  const entries = [];
  for (const call of allCalls) {
    const arr = (call.arguments && call.arguments.prompts) || [];
    for (const p of arr) {
      const cat = String((p && p.category) || "").trim();
      const content = String((p && p.content) || "").trim();
      const rawId =
        p && (p.node_id !== undefined && p.node_id !== null ? p.node_id : p.nodeId);
      const nodeId =
        rawId === undefined || rawId === null || rawId === "" ? null : String(rawId).trim();
      if (content && (cat || nodeId)) entries.push({ category: cat, nodeId, content });
    }
  }
  if (!entries.length) {
    results.push("⚠️ write_prompts 没有可写入的提示词内容");
    return results;
  }
  const graph = app && app.graph;
  if (!graph) {
    results.push("⚠️ 画布未就绪，无法写入提示词");
    return results;
  }

  // 第一轮：node_id 直接定位（优先） > 分类名匹配槽位节点
  const placed = []; // {node, widget, category, nodeId, content}
  const missed = [];
  for (const e of entries) {
    if (e.nodeId) {
      const n = xbhhNodeById(e.nodeId);
      const tw = n && xbhhStringWidget(n);
      if (n && tw) {
        placed.push({ ...e, node: n, widget: tw });
        continue;
      }
      results.push(`⚠️ 节点#${e.nodeId} 不存在或没有文本输入，改按分类名匹配`);
    }
    const hit = xbhhFindPromptSlotNode(e.category);
    if (hit) placed.push({ ...e, node: hit.node, widget: hit.widget });
    else missed.push(e);
  }

  // 展示标签：分类名优先，node_id 条目无分类时显示 节点#id
  const label = (e) => e.category || (e.nodeId ? `节点#${e.nodeId}` : "?");

  // 第二轮：未命中分类的兜底放置
  if (missed.length) {
    const otherHit = xbhhFindPromptSlotNode("其他");
    if (otherHit) {
      // 追加进「其他」节点：保留原内容，逗号拼接未命中分类
      const base = String(otherHit.widget.value || "").trim();
      const merged = (base ? base + ", " : "") + missed.map((m) => m.content).join(", ");
      // 若「其他」节点已被槽位命中过，更新那条的内容而不是重复写
      const dup = placed.find(
        (p) => p.node === otherHit.node && p.widget === otherHit.widget,
      );
      if (dup) dup.content = (dup.content ? dup.content + ", " : "") + merged;
      else placed.push({ category: "其他", nodeId: null, content: merged, node: otherHit.node, widget: otherHit.widget });
      for (const m of missed) results.push(`📝「${label(m)}」未找到对应节点，已合并进「其他」`);
    } else if (placed.length <= 1) {
      // 整段兜底：全部分类按 entries 顺序拼接，写入唯一可用节点
      const combined = entries.map((e) => e.content).join(", ");
      const target =
        placed.length === 1
          ? { node: placed[0].node, widget: placed[0].widget }
          : xbhhFindPromptNode();
      if (target && target.widget) {
        placed.length = 0; // 清空槽位方案，避免同节点被写两次
        placed.push({ category: "全部", nodeId: null, content: combined, node: target.node, widget: target.widget });
        results.push(`📝 画布无分类入口，已全部写入「${target.node.title || target.node.type}」`);
      } else {
        results.push("⚠️ 画布没找到任何可写入的提示词文本节点");
      }
    } else {
      for (const m of missed) results.push(`⚠️ 画布没找到标题含「${label(m)}」的文本节点`);
    }
  }

  // 统一执行写入（同一节点被多次命中时内容合并，避免后写的被静默丢弃）
  const writeMap = new Map(); // key -> {node, widget, contents, labels}
  for (const p of placed) {
    const key = `${p.node.id}:${p.widget.name || ""}`;
    if (!writeMap.has(key))
      writeMap.set(key, { node: p.node, widget: p.widget, contents: [], labels: [] });
    const wm = writeMap.get(key);
    wm.contents.push(p.content);
    wm.labels.push(p.category || (p.nodeId ? `节点#${p.nodeId}` : ""));
  }
  for (const wm of writeMap.values()) {
    try {
      wm.widget.value = wm.contents.join(", ");
      if (wm.node.setDirtyCanvas) wm.node.setDirtyCanvas(true, true);
      const title = wm.node.title || wm.node.type;
      if (wm.labels.length === 1 && wm.labels[0] === "全部") continue; // 整段兜底已有提示
      if (wm.labels.length === 1 && wm.labels[0] === "其他") {
        results.push(`✍️ 未匹配分类已合并进「${title}」`);
      } else {
        results.push(`✍️「${wm.labels.filter(Boolean).join("、")}」已写入「${title}」`);
      }
    } catch (e) {
      results.push(`⚠️ 写入失败：${(e && e.message) || e}`);
    }
  }
  if (app.canvas && app.canvas.setDirty) app.canvas.setDirty(true, true);
  return results;
}

/** 随机化画布上采样器节点的 seed（自动优化重跑时保证出图有变化） */
function xbhhRandomizeCanvasSeeds() {
  const graph = app && app.graph;
  const nodes = (graph && (graph._nodes || graph.nodes)) || [];
  for (const n of nodes) {
    if (!/^(KSampler|KSamplerAdvanced|SamplerCustom.*|.*Sampler)$/.test(n.type || "")) continue;
    const seedW = (n.widgets || []).find((w) => w && w.name === "seed");
    if (seedW) seedW.value = Math.floor(Math.random() * 1e14) + 1;
    const ctrlW = (n.widgets || []).find(
      (w) => w && (w.name === "control_after_generate" || w.name === "control_after_queue"),
    );
    if (ctrlW) ctrlW.value = "randomize";
  }
}

function xbhhFindLoraLoaderNodes() {
  const graph = app && app.graph;
  if (!graph || !graph._nodes) return [];
  const types = ["XBHHMultiLoraLoader", "XBHHMultiLoraLoaderPlus"];
  return graph._nodes.filter(
    (n) => types.includes(n.type) || types.includes(n.comfyClass),
  );
}

async function xbhhFetchLoraList() {
  try {
    const resp = await fetch("/xbhh/loras");
    return (await resp.json()) || [];
  } catch (e) {
    console.warn("[XBHH V2] fetch /xbhh/loras failed:", e);
    return [];
  }
}

function xbhhLoraBasename(name) {
  return String(name || "").split(/[\/\\]/).pop();
}

function xbhhLoraStem(name) {
  return xbhhLoraBasename(name).replace(/\.[^.]+$/, "");
}

async function xbhhFindLoraByName(input) {
  const target = String(input || "").toLowerCase().trim();
  if (!target) return null;
  const list = await xbhhFetchLoraList();
  for (const name of list) {
    const base = xbhhLoraBasename(name).toLowerCase();
    if (
      name.toLowerCase() === target ||
      base === target ||
      xbhhLoraStem(name).toLowerCase() === target
    ) {
      return name;
    }
  }
  for (const name of list) {
    const base = xbhhLoraBasename(name).toLowerCase();
    if (base.includes(target) || target.includes(base)) return name;
  }
  return null;
}

function xbhhMatchLoadedWidget(node, input) {
  const target = String(input || "").toLowerCase().trim();
  if (!target || !node.loraWidgets || !node.loraWidgets.length) return null;
  let fuzzy = null;
  for (const w of node.loraWidgets) {
    const name = String((w.value && w.value.lora) || "");
    if (!name) continue;
    const base = xbhhLoraBasename(name).toLowerCase();
    if (
      name.toLowerCase() === target ||
      base === target ||
      xbhhLoraStem(name).toLowerCase() === target
    ) {
      return w;
    }
    if (!fuzzy && (base.includes(target) || target.includes(base))) fuzzy = w;
  }
  return fuzzy;
}

// 从 LoRA 完整路径推断分类（与后端 infer_category_from_path 同逻辑）：
// 跳过根目录噪音（diy/loras 等）和底模层（ill/noob 等），取第一个有意义目录段
const XBHH_LORA_PATH_NOISE = ["diy", "loras", "my", "models", "custom", "自定义"];
const XBHH_LORA_BASE_KEYWORDS = [
  "ill", "illust", "illustrious", "illxl", "ill-xl",
  "noob", "noobai", "noobai-xl", "noob-x",
  "pony", "animagine", "anything",
  "sd15", "sd1.5", "sdxl", "sdxl-base", "flux",
];
function xbhhInferLoraCategoryFromPath(name) {
  const parts = String(name || "").split(/[\/\\]+/).filter(Boolean);
  if (parts.length < 2) return "";
  const dirs = parts.slice(0, -1);
  for (const d of dirs) {
    const dl = d.toLowerCase().trim();
    if (!dl || XBHH_LORA_PATH_NOISE.includes(dl)) continue;
    if (XBHH_LORA_BASE_KEYWORDS.some((k) => dl === k || dl.startsWith(k))) continue;
    return d.trim();
  }
  return "";
}

// 多堆路由：按 target（堆用途关键词/节点标题）挑选目标 LoRA 堆节点
// 优先级：用户绑定映射 → 节点标题匹配 → 堆内已加载 LoRA 的分类统计匹配 → 兜底第一个
function xbhhPickLoraNode(nodes, target) {
  if (!nodes.length) return null;
  if (nodes.length === 1) return nodes[0];
  const t = String(target || "").toLowerCase().trim();
  if (!t) return nodes[0];

  // 0) 设置里配置的堆绑定（分类名→节点ID），绑定可能随工作流保存在 graph.extra
  //    先找分类名完全相同的，再找互相包含的
  const map =
    (window.xbhhGetBoundMap ? window.xbhhGetBoundMap("loraHeapMap") : null) || {};
  const keys = Object.keys(map);
  let boundId;
  const exact = keys.find((k) => k.toLowerCase().trim() === t);
  if (exact !== undefined) boundId = map[exact];
  if (boundId === undefined) {
    const partial = keys.find((k) => {
      const kl = k.toLowerCase().trim();
      return kl && (kl.includes(t) || t.includes(kl));
    });
    if (partial !== undefined) boundId = map[partial];
  }
  if (boundId !== undefined && boundId !== null && String(boundId).trim() !== "") {
    const bn = nodes.find((n) => String(n.id) === String(boundId));
    if (bn) return bn;
  }

  // 1) 节点标题匹配（用户可给堆节点改标题，如「人物堆」「画风堆」）
  for (const n of nodes) {
    const title = String(n.title || n.type || "").toLowerCase();
    if (title && title.includes(t)) return n;
  }

  // 2) 按堆内已加载 LoRA 的分类推断：哪个堆 majority 分类命中 target 就选谁
  let best = null;
  let bestHits = 0;
  for (const n of nodes) {
    const cats = (n.loraWidgets || [])
      .map((w) => xbhhInferLoraCategoryFromPath(w.value && w.value.lora))
      .filter(Boolean);
    if (!cats.length) continue;
    let hits = 0;
    for (const c of cats) {
      const cl = c.toLowerCase();
      if (cl === t || cl.includes(t) || t.includes(cl)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = n;
    }
  }
  if (best) return best;

  // 3) 兜底：第一个
  return nodes[0];
}

// 大模型切换：AI 通过 set_checkpoint 操作画布上的 Checkpoint/UNET 加载节点
// 图像模型 → CheckpointLoaderSimple.ckpt_name；视频模型 → UNETLoader.unet_name
function xbhhSetCheckpoint(inputName) {
  const target = String(inputName || "").toLowerCase().trim();
  if (!target) return "⚠️ set_checkpoint 缺少 checkpoint_name 参数";
  const graph = app && app.graph;
  if (!graph || !graph._nodes) return "⚠️ 画布上没有节点";

  const loaderTypes = [
    { type: "CheckpointLoaderSimple", widget: "ckpt_name" },
    { type: "CheckpointLoader", widget: "ckpt_name" },
    { type: "UNETLoader", widget: "unet_name" },
    { type: "UnetLoaderGGUF", widget: "unet_name" },
  ];
  const loaders = graph._nodes.filter((n) =>
    loaderTypes.some((l) => l.type === n.type || l.type === n.comfyClass),
  );
  if (!loaders.length) {
    return "⚠️ 画布上没找到大模型加载节点 (CheckpointLoaderSimple / UNETLoader)";
  }

  const basename = (s) => String(s || "").split(/[\/\\]/).pop();
  const stem = (s) => basename(s).replace(/\.[^.]+$/, "");

  // 逐加载器在其可选列表里匹配（精确 > 词干 > 包含），取命中的加载器
  let best = null; // {node, widget, value, score}
  for (const node of loaders) {
    const spec = loaderTypes.find(
      (l) => l.type === node.type || l.type === node.comfyClass,
    );
    const w = (node.widgets || []).find((x) => x.name === spec.widget);
    if (!w) continue;
    const options = (w.options && w.options.values) || [];
    for (const opt of options) {
      const b = basename(opt).toLowerCase();
      let score = 0;
      if (opt.toLowerCase() === target || b === target || stem(opt).toLowerCase() === target) score = 3;
      else if (b.includes(target) || target.includes(b)) score = 1;
      if (score && (!best || score > best.score)) {
        best = { node, widget: w, value: opt, score };
        if (score === 3) break;
      }
    }
    if (best && best.score === 3) break;
  }

  if (!best) {
    return `⚠️ 大模型列表里找不到「${inputName}」，请在画布加载节点里核对可用名称`;
  }
  best.widget.value = best.value;
  if (typeof best.widget.callback === "function") {
    try { best.widget.callback(best.value); } catch (e) { /* 忽略回调异常 */ }
  }
  best.node.setDirtyCanvas(true, true);
  console.log("[XBHH V2 ckpt] 已切换大模型:", best.value);
  return `🖼️ 已切换大模型「${basename(best.value)}」`;
}

async function xbhhHandleLoraToolCalls(toolCalls) {
  const names = ["add_lora", "remove_lora", "set_lora_strength", "auto_style_loras", "random_style_loras"];
  const loraCalls = (toolCalls || []).filter((t) => names.includes(t.name));
  if (!loraCalls.length) return null;

  const nodes = xbhhFindLoraLoaderNodes();
  const results = [];

  for (const call of loraCalls) {
    const args = call.arguments || {};
    const rawName = args.lora_name || args.name || args.lora || "";
    const strength =
      args.strength !== undefined && args.strength !== null
        ? parseFloat(args.strength)
        : NaN;

    console.log("[XBHH lora] 收到工具调用:", call.name, "参数:", args);

    if (!nodes.length) {
      results.push("⚠️ 画布上没找到 LoRA 堆节点 (XBHHMultiLoraLoader)");
      continue;
    }
    // 多堆路由：target 优先；画风/随机组合类调用没给 target 时用 category 兜底
    const targetHint =
      args.target ||
      (call.name === "auto_style_loras" || call.name === "random_style_loras"
        ? args.category || ""
        : "");
    const node = xbhhPickLoraNode(nodes, targetHint);
    if (nodes.length > 1) {
      console.log(
        "[XBHH lora] 多堆路由: target=" + (targetHint || "(无)") +
        " → " + (node.title || node.type) + (targetHint ? "" : "（兜底第一个）"),
      );
    }

    if (call.name === "auto_style_loras" || call.name === "random_style_loras") {
      // AI 自主搭配 / 系统随机抽取 LoRA：先关闭所有现有 LoRA（保留在堆中，设为禁用），
      // 再按列表重新添加（random_style_loras 的具体列表由后端真随机抽取后回填）
      const list = Array.isArray(args.loras)
        ? args.loras
        : Array.isArray(args.lora_list)
          ? args.lora_list
          : [];
      if (!list.length) {
        results.push(
          call.name === "random_style_loras"
            ? `⚠️ 随机抽取失败：没有符合条件（分类${args.category ? `「${args.category}」` : ""}${args.base ? ` 底模「${args.base}」` : ""}）的 LoRA`
            : "⚠️ auto_style_loras 没有给出 LoRA 列表",
        );
        continue;
      }
      // 先关闭所有现有 LoRA
      const disabled = [];
      if (node.loraWidgets && node.loraWidgets.length) {
        for (const w of node.loraWidgets) {
          const name = w.value && w.value.lora;
          w.value.on = false;
          if (name) disabled.push(xbhhLoraBasename(name));
        }
      }
      node.setDirtyCanvas(true, true);
      // 再按 AI 的列表重新添加
      const added = [];
      for (const item of list) {
        const itemName = item && (item.lora_name || item.name || item.lora) || "";
        if (!itemName.trim()) continue; // 跳过空名称
        let itemStrength =
          item && item.strength !== undefined && item.strength !== null
            ? parseFloat(item.strength)
            : NaN;
        if (isNaN(itemStrength)) itemStrength = 1.0;
        let fullName = xbhhMatchLoadedWidget(node, itemName);
        fullName = fullName ? fullName.value.lora : await xbhhFindLoraByName(itemName);
        if (!fullName) {
          results.push(`⚠️ 找不到名为「${itemName}」的 LoRA`);
          continue;
        }
        const w = node.addLoraRow(fullName);
        if (w) {
          w.value.strength = itemStrength;
          w.value.triggerWeight = itemStrength;
          added.push(`${xbhhLoraBasename(fullName)}@${itemStrength.toFixed(2)}`);
        }
      }
      if (node.computeSize) {
        node.size[1] = Math.max(80, node.computeSize()[1]);
      }
      node.setDirtyCanvas(true, true);
      const msg = [];
      if (disabled.length) msg.push(`已关闭 ${disabled.length} 个旧 LoRA`);
      if (added.length) msg.push(`已添加 LoRA：${added.join("、")}`);
      results.push(`🎨 ${msg.join("，")}`);
    } else if (call.name === "add_lora") {
      if (!rawName.trim()) {
        results.push("⚠️ 添加 LoRA 时名称不能为空");
        continue;
      }
      let fullName = xbhhMatchLoadedWidget(node, rawName);
      fullName = fullName ? fullName.value.lora : await xbhhFindLoraByName(rawName);
      if (!fullName) {
        results.push(`⚠️ 找不到名为「${rawName}」的 LoRA`);
        continue;
      }
      const w = node.addLoraRow(fullName);
      if (!isNaN(strength) && w) {
        w.value.strength = strength;
        w.value.triggerWeight = strength;
      }
      node.setDirtyCanvas(true, true);
      results.push(
        `➕ 已添加 LoRA「${xbhhLoraBasename(fullName)}」` +
          (!isNaN(strength) ? `，权重 ${strength.toFixed(2)}` : ""),
      );
    } else if (call.name === "set_lora_strength") {
      let widget = xbhhMatchLoadedWidget(node, rawName);
      if (!widget) {
        const full = await xbhhFindLoraByName(rawName);
        widget = full ? xbhhMatchLoadedWidget(node, full) : null;
      }
      if (!widget) {
        results.push(`⚠️ 没找到名为「${rawName}」的 LoRA，无法设置权重`);
        continue;
      }
      const v = isNaN(strength) ? 1.0 : strength;
      widget.value.strength = v;
      widget.value.triggerWeight = v;
      node.setDirtyCanvas(true, true);
      results.push(
        `⚖️ 已把「${xbhhLoraBasename(widget.value.lora)}」权重设为 ${v.toFixed(2)}`,
      );
    } else if (call.name === "remove_lora") {
      // 先直接匹配堆中已加载的，失败再从完整 LoRA 列表解析全名后二次匹配
      let widget = rawName ? xbhhMatchLoadedWidget(node, rawName) : null;
      if (!widget && rawName) {
        const full = await xbhhFindLoraByName(rawName);
        if (full) widget = xbhhMatchLoadedWidget(node, full);
      }
      // 没给名字且堆里只有一个时，视为删那一个（「删掉刚才加的」场景）
      if (!widget && !rawName && (node.loraWidgets || []).length === 1) {
        widget = node.loraWidgets[0];
      }
      if (!widget) {
        const loaded = (node.loraWidgets || [])
          .map((w) => w.value && w.value.lora)
          .filter(Boolean)
          .map(xbhhLoraBasename);
        console.warn("[XBHH lora] remove 未匹配到「" + rawName + "」，堆中现有：", loaded);
        results.push(
          `⚠️ 没找到名为「${rawName}」的 LoRA` +
            (loaded.length ? `，堆里现在有：${loaded.join("、")}` : "（堆是空的）"),
        );
        continue;
      }
      const removed = xbhhLoraBasename(widget.value.lora);
      node.removeLoraWidget(widget);
      // 收缩节点高度，避免留下空白
      if (node.computeSize) {
        node.size[1] = Math.max(80, node.computeSize()[1]);
      }
      node.setDirtyCanvas(true, true);
      results.push(`🗑️ 已移除 LoRA「${removed}」`);
    }
  }
  return results;
}

// 暴露给 loader 的自主创作流程使用（autoInspire 也会调用）
window.xbhhHandleLoraToolCalls = xbhhHandleLoraToolCalls;
// 供 loader 的自主创作流程使用（autoInspire 也会调用）
window.xbhhHandlePromptToolCalls = xbhhHandlePromptToolCalls;

/**
 * 收集提示词槽位上下文随聊天请求发给后端：
 * categories：设置里的分类列表 + 各分类定位到的节点 ID 与当前内容
 *            （定位顺序：用户配置的绑定映射 > 标题匹配；AI 只按分类名给内容，
 *              系统照配置写入，AI 无需关心节点本身）
 * skill_doc：用户自定义提示词编写文档（非空时后端用它替换内置编写规范）
 */
function xbhhCollectPromptSlots() {
  const s = window.xbhhSettings;
  // 分类名可能随工作流保存在 graph.extra，优先走工作流读取接口
  const cats = window.xbhhGetCategories
    ? window.xbhhGetCategories()
    : (s && s.get("promptCategories", [])) || [];
  const categories = (Array.isArray(cats) ? cats : [])
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .map((name) => {
      const hit = xbhhFindPromptSlotNode(name);
      return {
        name,
        node_id: hit ? hit.node.id : null,
        current: hit ? String(hit.widget.value || "").trim().slice(0, 150) : "",
      };
    });
  return {
    categories,
    skill_doc: String((s && s.get("promptSkillDoc")) || "").trim(),
  };
}
window.xbhhCollectPromptSlots = xbhhCollectPromptSlots;

export class Live2DV2Pet {
  constructor() {
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split('/');
    const extensionsIdx = pathSegments.indexOf('extensions');
    this.extName = extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : 'xbhh-lora';

    this.libPath = `/extensions/${this.extName}/lib/live2d/`;
    this.petPath = `/extensions/${this.extName}/js/pet/`;
    this.modelBasePath = `/extensions/${this.extName}/live2d/`;
    
    this.config = {
      visible: true,
      minimized: false,
      canvasWidth: 300,
      canvasHeight: 400,
    };

    this.loadConfig();

    // 对话与工作流相关状态
    this.currentPriority = -1;
    this.tipsTimer = null;
    this.chatBox = null;
    this.chatInput = null;
    this.chatHistory = [];
    this._chatBusy = false;

    this.init();

    // 捕获 ComfyUI 执行错误（execution_error 事件），供 AI 诊断用
    this._lastExecError = null;
    this._execErrorHandler = (detail) => {
      const d = detail || {};
      const tb = Array.isArray(d.traceback) ? d.traceback.join("\n") : "";
      this._lastExecError = {
        time: Date.now(),
        text:
          `节点类型: ${d.node_type || "(未知)"}（ID: ${d.node_id || "?"}）\n` +
          `异常类型: ${d.exception_type || ""}\n` +
          `异常信息: ${d.exception_message || ""}` +
          (tb ? `\n堆栈（末尾）:\n${tb.slice(-1200)}` : ""),
      };
      console.warn("[XBHH V2 pet] 捕获执行错误:", this._lastExecError.text);
      this.showMessage?.(
        `⚠️ 工作流出错了：${d.exception_message || d.node_type || "未知错误"}\n（可以问我怎么解决）`,
        8000, 9,
      );
    };
    api.addEventListener("execution_error", this._execErrorHandler);
    // 捕获 ComfyUI 错误弹窗（缺节点/校验失败等提交阶段错误，不走 execution_error 事件）
    this._lastDialogTxt = "";
    this._dialogObserver = new MutationObserver(() => {
      try {
        const el = document.querySelector(".comfy-modal-content");
        if (!el) return;
        const txt = (el.textContent || "").trim();
        if (!txt || txt === this._lastDialogTxt) return;
        if (/missing|not found|cannot|error|failed|invalid|错误|失败|无法|缺少/i.test(txt)) {
          this._lastDialogTxt = txt;
          this._xbhhRecordError(`【ComfyUI 弹窗错误】\n${txt}`);
        }
      } catch (e) { /* 忽略 */ }
    });
    this._dialogObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
    // 全局拦截 POST /prompt 的 4xx 响应（新旧前端通吃，含手动点 Queue 按钮）：
    // 400 响应体是 ComfyUI 后端生成的标准错误 JSON（error.message + node_errors），
    // 缺节点/缺模型/参数校验失败都在这里，比监听弹窗 DOM 可靠
    if (!window.__xbhhPromptFetchPatched) {
      window.__xbhhPromptFetchPatched = true;
      const _origFetch = window.fetch.bind(window);
      window.fetch = async function (...args) {
        const resp = await _origFetch(...args);
        try {
          if (resp.status >= 400 && resp.status < 500) {
            const url = String(args[0] || "");
            if (/\/(api\/)?prompt(\?|$)/.test(url) && args[1] && args[1].method === "POST") {
              const data = await resp.clone().json();
              const parts = [];
              if (data && data.error) {
                const e = data.error;
                parts.push(
                  `错误: ${e.message || e.type || ""}${e.details ? `\n详情: ${e.details}` : ""}`,
                );
              }
              const ne = data && data.node_errors;
              if (ne && typeof ne === "object") {
                for (const [id, info] of Object.entries(ne)) {
                  const errs = (info && info.errors) || [];
                  for (const er of errs) {
                    parts.push(
                      `节点 #${id}: ${er.message || er.type || ""}${er.details ? `（${er.details}）` : ""}`,
                    );
                  }
                }
              }
              if (parts.length) {
                window.__xbhhLastError = {
                  time: Date.now(),
                  text: `【工作流提交失败】(POST /prompt ${resp.status})\n${parts.join("\n").slice(0, 1500)}`,
                };
                console.warn("[XBHH V2 pet] 捕获提交失败:", window.__xbhhLastError.text);
              }
            }
          }
        } catch (_) { /* 解析失败不影响原有流程 */ }
        return resp;
      };
    }

    // 使用命名函数以便移除监听器
    this._onSwitchModel = this.onSwitchModel.bind(this);
    window.addEventListener("xbhh-live2d-switch", this._onSwitchModel);
  }

  destroy() {
    // 清理挂在 body 上的聊天悬浮窗与悬浮球
    if (this.chatBox && this.chatBox.parentNode) this.chatBox.remove();
    if (window.__xbhhChatWin) window.__xbhhChatWin.removeBall();
    if (this._chatTypingTimer) {
      clearInterval(this._chatTypingTimer);
      this._chatTypingTimer = null;
    }
    if (this._execErrorHandler) {
      api.removeEventListener("execution_error", this._execErrorHandler);
      this._execErrorHandler = null;
    }
    if (this._dialogObserver) {
      this._dialogObserver.disconnect();
      this._dialogObserver = null;
    }
    this.pauseRenderLoop();
    // 彻底销毁 Cubism2 渲染实例：xbhh.js 的 G 类自带 destroy()，
    // 会取消其内部 requestAnimationFrame 循环并释放 WebGL 资源。
    // 之前只停了节流循环，原始循环残留会在切换 V4 后继续跑，
    // 通过 getElementById("live2d") 拿到 V4 的 canvas 破坏其渲染（createProgram 崩溃）。
    if (window.xbhhModelInstance) {
        try {
            if (typeof window.xbhhModelInstance.destroy === "function") {
                window.xbhhModelInstance.destroy();
            }
        } catch (e) {
            console.warn("[XBHH] Error destroying Cubism2 instance:", e);
        }
        window.xbhhModelInstance = null;
    }
    if (this._onSwitchModel) {
        window.removeEventListener("xbhh-live2d-switch", this._onSwitchModel);
    }
    if (this._onVisibilityChange) {
        document.removeEventListener("visibilitychange", this._onVisibilityChange);
    }
    const canvas = document.getElementById("live2d");
    if (canvas) {
        if (this._onContextLost) canvas.removeEventListener("webglcontextlost", this._onContextLost);
        if (this._onContextRestored) canvas.removeEventListener("webglcontextrestored", this._onContextRestored);
    }
    const waifu = document.getElementById("waifu");
    if (waifu) waifu.remove();
    const toggle = document.getElementById("waifu-toggle");
    if (toggle) toggle.remove();
    // 同时也清理 V2 的样式
    const style = document.getElementById("waifu-css");
    if (style) style.remove();
    const fixStyle = document.getElementById("xbhh-v2-fix-style");
    if (fixStyle) fixStyle.remove();
  }

  onSwitchModel(e) {
    const { version, modelPath } = e.detail;
    if (version === "v2") {
        // V2 内部切换模型
        // 注意：window.xbhhModelInstance 是在 waifu-tips.js 加载后定义的
        if (window.xbhhModelInstance) {
            // 找到匹配的 modelId
            const models = window.xbhhModelInstance.models;
            const id = models.findIndex(m => m.paths.includes(modelPath));
            if (id !== -1) {
                window.xbhhModelInstance.modelId = id;
                window.xbhhModelInstance.modelTexturesId = 0;
                window.xbhhModelInstance.loadModel();
            }
        }
    } else {
        // 切换到 V5
        this.switchToV5(modelPath);
    }
  }

  bindGlobalEvents() {
      // 已移至 constructor
  }

  async switchToV5(modelPath) {
      // 1. 清理
      this.destroy();

      // 2. 持久化配置以便下次加载
      localStorage.setItem("xbhh_live2d_config", JSON.stringify({
          ...JSON.parse(localStorage.getItem("xbhh_live2d_config") || "{}"),
          modelPath: modelPath,
          enabled: true
      }));
      // 更新 loader 配置
      const loaderConfig = { enabled: true, version: "v5" };
      // 注意：这里无法直接修改 config_live2d.json，但可以通过 localStorage 覆盖 loader 逻辑
      // 我们改一下 live2d_loader.js 让其优先读取 localStorage
      localStorage.setItem("xbhh_live2d_version", "v5");

      // 3. 加载 V5：加载前先确保旧版 V4 实例已被销毁
      //    （Live2DPet 构造函数里也有清理，但这里有 bug 的话先清理更保险）
      if (window.xbhhLive2DPet) {
          try {
              if (typeof window.xbhhLive2DPet.destroy === "function") {
                  window.xbhhLive2DPet.destroy();
              }
          } catch (e) {
              console.warn("[XBHH] Error destroying stale V4 instance:", e);
          }
          window.xbhhLive2DPet = null;
      }
      const { Live2DPet } = await import(`/extensions/${this.extName}/js/pet/live2d_pet.js?v=${Date.now()}`);
      window.xbhhLive2DPet = new Live2DPet();
  }

  loadConfig() {
    const saved = localStorage.getItem("xbhh_live2d_v2_config");
    if (saved) {
      try {
        this.config = { ...this.config, ...JSON.parse(saved) };
      } catch (e) {
        console.error("[XBHH] Failed to load V2 config", e);
      }
    }
  }

  saveConfig() {
    localStorage.setItem("xbhh_live2d_v2_config", JSON.stringify(this.config));
  }

  /**
   * 标准外部资源加载器 (适配 ComfyUI 相对路径)
   */
  loadExternalResource(url, type) {
    return new Promise((resolve, reject) => {
        let tag;
        const finalUrl = url.includes('?') ? url : `${url}?v=${Date.now()}`;

        if (type === 'css') {
            tag = document.createElement('link');
            tag.rel = 'stylesheet';
            tag.href = finalUrl;
            tag.id = "waifu-css";
        } else if (type === 'js') {
            tag = document.createElement('script');
            // 原版是 module，但在 ComfyUI 某些库冲突下，核心驱动习惯作为全局脚本加载
            // 这里我们保持 module 还是全局脚本？
            // 根据 debug.html 成功经验，live2d.min.js 是全局脚本，waifu-tips.js 是 module
            if (url.includes('waifu-tips.js')) {
                tag.type = 'module';
            }
            tag.src = finalUrl;
        }

        if (tag) {
            tag.onload = () => resolve(url);
            tag.onerror = () => reject(new Error(`Failed to load: ${url}`));
            document.head.appendChild(tag);
        }
    });
  }

  async init() {
    
    try {
        // 1. 加载样式与核心驱动 (全局脚本)
        await Promise.all([
            this.loadExternalResource(this.libPath + 'waifu.css', 'css'),
            this.loadExternalResource(this.libPath + 'live2d.min.js', 'js')
        ]);

        // 2. 导入逻辑组件 (Module)
        // 注意：我们直接加载之前拷贝到 lib 下的 waifu-tips.js
        await import(this.libPath + 'waifu-tips.js');

        if (typeof window.initWidget === 'function') {
            // 增加安全性检查：校验 localStorage 中的模型索引是否越界，并强制重置显示状态
            const checkAndFixConfig = async () => {
                // 1. 强制清理显示限制，确保每次刷新都尝试显示
                localStorage.removeItem("waifu-display");
                localStorage.removeItem("Comfy.MenuPosition.Docked");
                // 确保样式强制可见
                const style = document.createElement("style");
                style.id = "xbhh-v2-fix-style";
                style.innerHTML = "#waifu { display: block !important; }";
                document.head.appendChild(style);
                
                try {
                    const resp = await fetch('/xbhh/live2d_models');
                    const data = await resp.json();

                    if (!data.v2 || data.v2.length === 0) {
                        console.warn("[XBHH] No V2 models found, destroying waifu container.");
                        document.getElementById("waifu")?.remove();
                        document.getElementById("xbhh-v2-fix-style")?.remove();
                        return false;
                    }
                    
                    // 2. 校验 V2 模型 Id
                    let modelId = parseInt(localStorage.getItem("modelId"), 10);
                    if (!isNaN(modelId)) {
                        if (modelId >= data.v2.length) {
                             console.warn("[XBHH] modelId out of bounds, resetting to 0");
                             localStorage.setItem("modelId", "0");
                             modelId = 0;
                        }
                        
                        // 3. 校验贴图/衣服 Id
                        let texturesId = parseInt(localStorage.getItem("modelTexturesId"), 10);
                        if (!isNaN(texturesId) && data.v2[modelId] && texturesId >= data.v2[modelId].clothes.length) {
                            console.warn("[XBHH] modelTexturesId out of bounds, resetting to 0");
                            localStorage.setItem("modelTexturesId", "0");
                        }
                    }
                    return true;
                } catch (e) {
                    console.error("[XBHH] Failed to check and fix config:", e);
                    return true;
                }
            };
            const valid = await checkAndFixConfig();
            if (valid === false) return;

            window.initWidget({
                waifuPath: '/xbhh/waifu-tips.json?v=' + Date.now(),
                cubism2Path: this.libPath + 'live2d.min.js',
                tools: ['hitokoto', 'switch-model', 'switch-texture', 'photo', 'quit'],
                logLevel: 'warn',
                drag: true
            });
            // 劫持 Cubism2 渲染循环，降帧率到 15fps
            this.throttleRenderLoop();

            // 改造外部浮动工具栏（X=隐藏模型 / 拍照=导出带工作流图片 / 新增快捷聊天）
            this.setupQuickTools();

            // 页面不可见时暂停渲染，切回页面时深度重置动画状态并恢复渲染循环
            this._onVisibilityChange = () => {
                if (document.hidden) {
                    this.pauseRenderLoop();
                } else {
                    this.pauseRenderLoop(); // 彻底清理旧的 rAF 句柄
                    try {
                        if (window.xbhhModelInstance && window.xbhhModelInstance.cubism2model) {
                            const cubism2 = window.xbhhModelInstance.cubism2model;
                            if (cubism2.dragMgr) {
                                cubism2.dragMgr.lastTimeSec = 0;
                            }
                            if (typeof cubism2.lookFront === "function") {
                                cubism2.lookFront();
                            }
                            const model = cubism2.live2DMgr?.getModel();
                            if (model) {
                                if (model.mainMotionManager) {
                                    model.mainMotionManager.currentPriority = 0;
                                    model.mainMotionManager.reservePriority = 0;
                                }
                                if (model.mainMotionManager?.isFinished()) {
                                    try { model.startRandomMotion("idle", 1); } catch(e){}
                                }
                            }
                        }
                    } catch(err) {
                        console.warn("[XBHH V2] Reset error on page resume:", err);
                    }
                    this.throttleRenderLoop();
                }
            };
            document.addEventListener("visibilitychange", this._onVisibilityChange);

            // 监听 WebGL 上下文丢失与恢复事件，防止显卡休眠/重置后动画永久卡死
            setTimeout(() => {
                const canvas = document.getElementById("live2d");
                if (canvas) {
                    this._onContextLost = (e) => {
                        e.preventDefault();
                        console.warn("[XBHH V2] WebGL Context Lost!");
                        this.pauseRenderLoop();
                    };
                    this._onContextRestored = () => {
                        if (window.xbhhModelInstance) {
                            window.xbhhModelInstance.loadModel();
                        }
                        this.throttleRenderLoop();
                    };
                    canvas.addEventListener("webglcontextlost", this._onContextLost, false);
                    canvas.addEventListener("webglcontextrestored", this._onContextRestored, false);
                }
                this.initSphere();
                this.initContextMenu();
                this.initInteractiveTips();
            }, 1000);
        } else {
            console.error("[XBHH] initWidget not found after import!");
        }
    } catch (e) {
        console.error("[XBHH] V2 Initialization failed:", e);
    }
  }

  async initContextMenu() {
      const waifu = document.getElementById("waifu");
      if (!waifu) return;

      waifu.addEventListener("contextmenu", async (e) => {
          e.preventDefault();
          this.showModelMenu(e.clientX, e.clientY);
      });
  }

  async showModelMenu(x, y) {
      // 移除旧菜单
      const oldMenu = document.getElementById("xbhh-live2d-v2-menu");
      if (oldMenu) oldMenu.remove();

      const menu = document.createElement("div");
      menu.id = "xbhh-live2d-v2-menu";
      menu.style.cssText = `
          position: fixed;
          left: ${x}px;
          top: ${y}px;
          background: rgba(30, 30, 30, 0.9);
          border: 1px solid #444;
          border-radius: 6px;
          padding: 5px 0;
          z-index: 10001;
          color: white;
          font-family: "Microsoft YaHei", sans-serif;
          font-size: 13px;
          min-width: 120px;
          box-shadow: 0 4px 15px rgba(0,0,0,0.5);
          backdrop-filter: blur(5px);
      `;

      // 注入二级菜单样式（与V5统一）
      const styleId = "xbhh-live2d-v2-menu-style";
      if (!document.getElementById(styleId)) {
          const style = document.createElement("style");
          style.id = styleId;
          style.textContent = `
              .xbhh-v2-menu-item {
                  padding: 8px 15px;
                  cursor: pointer;
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  transition: background 0.2s;
                  position: relative;
              }
              .xbhh-v2-menu-item:hover {
                  background: #444;
              }
              .xbhh-v2-submenu {
                  display: none;
                  position: absolute;
                  left: 100%;
                  top: 0;
                  background: rgba(30, 30, 30, 0.95);
                  border: 1px solid #444;
                  border-radius: 6px;
                  padding: 5px 0;
                  min-width: 100px;
                  box-shadow: 4px 4px 15px rgba(0,0,0,0.5);
              }
              .xbhh-v2-menu-item:hover > .xbhh-v2-submenu,
              .xbhh-v2-menu-item.active > .xbhh-v2-submenu {
                  display: block;
              }
          `;
          document.head.appendChild(style);
      }

      const createItem = (text, action, hasSubmenu = false) => {
          const div = document.createElement("div");
          div.className = "xbhh-v2-menu-item";
          div.innerHTML = `<span>${text}</span>${hasSubmenu ? '<span style="font-size:10px;margin-left:10px;">▶</span>' : ''}`;
          if (!hasSubmenu && action) {
              div.onclick = (e) => {
                  e.stopPropagation();
                  if (action) action();
                  menu.remove();
              };
          }
          return div;
      };

      // 聊天入口置顶 (LLM 对话；API 在侧边栏「看板娘设置」配置)
      menu.appendChild(createItem("💬 和我聊天", () => this.openChatBox()));

      // 1. 模型切换 — 二级子菜单
      const modelItem = createItem("👤 模型切换", null, true);
      const modelSubmenu = document.createElement("div");
      modelSubmenu.className = "xbhh-v2-submenu";
      modelItem.appendChild(modelSubmenu);
      menu.appendChild(modelItem);

      // 延迟加载模型列表
      fetch("/xbhh/live2d_models").then(r => r.json()).then(data => {
          if (data.v2 && data.v2.length > 0) {
              const v2Header = document.createElement("div");
              v2Header.style.cssText = "padding: 5px 15px; color: #888; font-size: 10px; border-bottom: 1px solid #333;";
              v2Header.innerText = "SDK 2.0 (V2)";
              modelSubmenu.appendChild(v2Header);
              data.v2.forEach(m => {
                  modelSubmenu.appendChild(createItem("· " + m.name, () => {
                      window.dispatchEvent(new CustomEvent("xbhh-live2d-switch", {
                          detail: { version: "v2", modelPath: m.path }
                      }));
                  }));
              });
          }
          if (data.v5 && data.v5.length > 0) {
              const v5Header = document.createElement("div");
              v5Header.style.cssText = "padding: 5px 15px; color: #888; font-size: 10px; border-bottom: 1px solid #333; margin-top: 5px;";
              v5Header.innerText = "SDK 4.0/5.0 (V5)";
              modelSubmenu.appendChild(v5Header);
              data.v5.forEach(m => {
                  modelSubmenu.appendChild(createItem("· " + m.name, () => {
                      window.dispatchEvent(new CustomEvent("xbhh-live2d-switch", {
                          detail: { version: "v5", modelPath: m.path }
                      }));
                  }));
              });
          }
      });

      // 2. 显示设置 — 把帧率/最小化/隐藏收进同一个子菜单，减少顶层占用
      const dispItem = createItem("⚙️ 显示设置", null, true);
      const dispSubmenu = document.createElement("div");
      dispSubmenu.className = "xbhh-v2-submenu";
      dispSubmenu.style.minWidth = "160px";

      // 2.1 渲染帧率 — 二级子菜单
      const fpsItem = createItem("🎬 渲染帧率", null, true);
      const fpsSubmenu = document.createElement("div");
      fpsSubmenu.className = "xbhh-v2-submenu";
      const currentFPS = this.config.targetFPS || 30;
      [10, 15, 24, 30, 60].forEach(fps => {
          const label = fps === currentFPS ? `✓ ${fps} FPS` : `  ${fps} FPS`;
          fpsSubmenu.appendChild(createItem(label, () => {
              this.config.targetFPS = fps;
              this.saveConfig();
              this.pauseRenderLoop();
              this._throttledDrawId = null;
              this.throttleRenderLoop();
          }));
      });
      fpsItem.appendChild(fpsSubmenu);
      dispSubmenu.appendChild(fpsItem);

      // 2.2 工具项
      dispSubmenu.appendChild(createItem("🎈 最小化小人", () => this.minimize()));
      dispSubmenu.appendChild(createItem("🙈 隐藏小人", () => this.hide()));

      dispItem.appendChild(dispSubmenu);
      menu.appendChild(dispItem);

      document.body.appendChild(menu);

      // 点击菜单外部关闭
      const closeMenu = (e) => {
          if (!menu.contains(e.target)) {
              menu.remove();
              document.removeEventListener("pointerdown", closeMenu, true);
          }
      };
      setTimeout(() => document.addEventListener("pointerdown", closeMenu, true), 10);
  }

  initSphere() {
      const waifu = document.getElementById("waifu");
      if (!waifu) return;

      this.sphere = document.createElement("div");
      this.sphere.id = "xbhh-live2d-v2-sphere";
      this.sphere.style.cssText = `
          display: none;
          position: absolute;
          bottom: 20px;
          left: 20px;
          width: 50px;
          height: 50px;
          border-radius: 50%;
          background: linear-gradient(135deg, #fa0 0%, #d48800 100%);
          box-shadow: 0 4px 15px rgba(0,0,0,0.4), inset 0 2px 5px rgba(255,255,255,0.2);
          border: 2px solid #fff;
          cursor: pointer;
          z-index: 10001;
          text-align: center;
          line-height: 46px;
          font-size: 24px;
          user-select: none;
      `;
      this.sphere.innerHTML = "🐱";
      waifu.parentNode.appendChild(this.sphere);

      // 实现拖拽功能
      let isDragging = false;
      let startX, startY;
      let initialLeft, initialTop;

      this.sphere.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          isDragging = true;
          startX = e.clientX;
          startY = e.clientY;
          initialLeft = this.sphere.offsetLeft;
          initialTop = this.sphere.offsetTop;
          this.sphere.style.transition = "none";
          e.stopPropagation();
      });

      window.addEventListener("mousemove", (e) => {
          if (!isDragging) return;
          const deltaX = e.clientX - startX;
          const deltaY = e.clientY - startY;

          let left = initialLeft + deltaX;
          let top = initialTop + deltaY;

          // 边界检查
          const rect = this.sphere.getBoundingClientRect();
          if (left < 0) left = 0;
          if (top < 0) top = 0;
          if (left > window.innerWidth - rect.width) left = window.innerWidth - rect.width;
          if (top > window.innerHeight - rect.height) top = window.innerHeight - rect.height;

          this.sphere.style.left = left + "px";
          this.sphere.style.top = top + "px";
      });

      window.addEventListener("mouseup", (e) => {
          if (isDragging) {
              isDragging = false;
              // 检查位移，如果位移很小则视为点击，触发恢复
              const deltaX = Math.abs(e.clientX - startX);
              const deltaY = Math.abs(e.clientY - startY);
              if (deltaX < 5 && deltaY < 5) {
                  this.restore();
              }
          }
      });
  }

  initInteractiveTips() {
      const waifu = document.getElementById("waifu");
      const canvas = document.getElementById("live2d");
      if (!waifu || !canvas) return;

      this._lastDragTipTime = 0;

      // 1. 双击对话
      // 将单次点击改为双击触发，避免误触
      canvas.addEventListener("dblclick", () => {
          if (this.config.minimized) return;
          window.dispatchEvent(new CustomEvent("live2d:click"));
      });

      // 2. 拖拽对话 (在 Live2DV2Pet 的拖拽逻辑中实现)
      // 实际上 V2 的拖拽是在 mousedown 事件里定义的。我们需要重构一下那部分的监听。
      // 但为了简单，我们可以直接在 window 的 mousemove 里检测是否正在拖拽 waifu。
      // 查阅下方的 mousedown 逻辑。
  }

  minimize() {
      const waifu = document.getElementById("waifu");
      const canvas = document.getElementById("waifu-canvas");
      const tools = document.getElementById("waifu-tool");
      const tips = document.getElementById("waifu-tips");
      if (waifu && this.sphere) {
          // 关闭对话气泡，避免显示异常
          this.closeChatBox();
          // 暂停渲染循环，释放 CPU
          this.pauseRenderLoop();

          waifu.style.pointerEvents = "none";
          if (canvas) canvas.style.display = "none";
          if (tools) tools.style.display = "none";
          if (tips) {
              tips.style.opacity = "0";
              tips.style.display = "none";
          }
          this.sphere.style.display = "block";
          this.config.minimized = true;
          this.saveConfig();
      }
  }

  restore() {
      const waifu = document.getElementById("waifu");
      const canvas = document.getElementById("waifu-canvas");
      const tools = document.getElementById("waifu-tool");
      const tips = document.getElementById("waifu-tips");
      if (waifu && this.sphere) {
          waifu.style.pointerEvents = "auto";
          if (canvas) canvas.style.display = "block";
          if (tools) tools.style.display = "flex";
          if (tips) tips.style.display = "block";
          this.sphere.style.display = "none";
          this.config.minimized = false;
          this.saveConfig();

          // 恢复渲染循环
          this.throttleRenderLoop();
      }
  }

  hide() {
      // 持久化隐藏状态（loader 重启时会清除此标记）
      localStorage.setItem("xbhh_live2d_hidden", "true");

      // 停止节流渲染循环
      this.pauseRenderLoop();

      // 清理 visibilitychange 监听
      if (this._onVisibilityChange) {
          document.removeEventListener("visibilitychange", this._onVisibilityChange);
      }

      // 销毁 Cubism2/5 模型实例（停止 WebGL 渲染循环）
      if (window.xbhhModelInstance) {
          try {
              if (window.xbhhModelInstance.cubism2model) {
                  window.xbhhModelInstance.cubism2model.destroy();
              }
              if (window.xbhhModelInstance.cubism5model) {
                  window.xbhhModelInstance.cubism5model.release();
              }
          } catch (e) {
              console.warn("[XBHH] Error destroying model instance:", e);
          }
          window.xbhhModelInstance = null;
      }

      // 移除 DOM 元素
      const waifu = document.getElementById("waifu");
      if (waifu) waifu.remove();
      const toggle = document.getElementById("waifu-toggle");
      if (toggle) toggle.remove();
      if (this.sphere) { this.sphere.remove(); this.sphere = null; }

      // 清理样式
      const style = document.getElementById("waifu-css");
      if (style) style.remove();
      const fixStyle = document.getElementById("xbhh-v2-fix-style");
      if (fixStyle) fixStyle.remove();

      // 清理事件监听器
      if (this._onSwitchModel) {
          window.removeEventListener("xbhh-live2d-switch", this._onSwitchModel);
      }
  }


  /**
   * 改造外部浮动工具栏：
   *   - 最后一个 X  → 隐藏模型（等价右键「隐藏小人」）
   *   - 拍照        → 导出带工作流元数据的 PNG（可再拖回 ComfyUI 还原）
   *   - 新增聊天按钮 → 直接打开聊天框，不必先右键
   * 工具栏由 waifu-tips.js 在模型加载完成后动态创建，故需轮询等待
   */
  setupQuickTools() {
      if (this._quickToolsTimer) clearInterval(this._quickToolsTimer);

      const apply = () => {
          const bar = document.getElementById("waifu-tool");
          const photo = document.getElementById("waifu-tool-photo");
          if (!bar || !photo) return false;
          // 工具栏被重建（隐藏后恢复/切换模型）时重新接管
          if (photo.dataset.xbhhQuick === "1") return true;

          const photoNode = this.rebindTool(photo, () => this.exportWorkflowImage());
          photoNode.id = "waifu-tool-photo";
          photoNode.title = "导出工作流图片";
          photoNode.dataset.xbhhQuick = "1";

          const quit = document.getElementById("waifu-tool-quit");
          if (quit) {
              const quitNode = this.rebindTool(quit, () => this.hide());
              quitNode.id = "waifu-tool-quit";
              quitNode.title = "隐藏模型";
          }

          // 快捷聊天：插到工具栏最前面
          if (!document.getElementById("waifu-tool-xbhh-chat")) {
              const chat = document.createElement("span");
              chat.id = "waifu-tool-xbhh-chat";
              chat.title = "和我聊天";
              chat.innerHTML =
                  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
                  '<path d="M256 448c141.4 0 256-93.1 256-208S397.4 32 256 32S0 125.1 0 240c0 45.1 17.7 86.8 47.7 120.9c-1.9 24.5-11.4 46.3-21.4 62.9c-5.5 9.2-11.1 16.6-15.2 21.6c-2.1 2.5-3.7 4.4-4.9 5.7c-.6 .7-1 1.1-1.3 1.4c-.3 .3-.6 .6-.7 .7l-.1 .1c-4.5 4.6-5.9 11.4-3.4 17.4c2.5 6 8.3 9.9 14.8 9.9c28.7 0 57.6-8.9 81.6-19.3c22.9-10 42.4-21.9 54.3-30.6c31.8 11.5 67 17.9 104.1 17.9zM128 208a32 32 0 1 1 0 64 32 32 0 1 1 0-64zm128 0a32 32 0 1 1 0 64 32 32 0 1 1 0-64zm96 32a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z"/>' +
                  "</svg>";
              chat.style.cursor = "pointer";
              chat.addEventListener("click", (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  this.openChatBox();
              });
              bar.insertBefore(chat, bar.firstChild);
          }
          return true;
      };

      let tries = 0;
      const wait = () => {
          if (apply()) return;
          if (++tries > 100) return; // 约 20 秒后放弃
          setTimeout(wait, 200);
      };
      wait();
      // 兜底：工具栏被移除重建后（切换模型等）重新接管
      this._quickToolsTimer = setInterval(() => {
          apply();
      }, 2000);
  }

  /**
   * 用 cloneNode 丢弃库内部 addEventListener 绑定的旧回调，再挂上新回调
   */
  rebindTool(el, handler) {
      const clone = el.cloneNode(true);
      clone.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          handler();
      };
      el.replaceWith(clone);
      return clone;
  }

  /**
   * 导出当前 ComfyUI 工作流为 PNG：画布截图 + workflow/prompt 元数据
   * 拖回 ComfyUI 即可还原工作流
   */
  async exportWorkflowImage() {
      try {
          this.showMessage("📸 正在导出工作流图片…", 2500, 9);

          let workflow = null;
          let prompt = null;
          try {
              workflow = window.app?.graph ? window.app.graph.serialize() : null;
          } catch (e) { /* 忽略 */ }
          try {
              if (typeof window.app?.graphToPrompt === "function") {
                  const res = await window.app.graphToPrompt();
                  prompt = res && res.output ? res.output : null;
              }
          } catch (e) { /* 忽略 */ }

          const canvas = this.getComfyCanvas();
          let dataUrl = null;
          if (canvas) {
              try {
                  dataUrl = canvas.toDataURL("image/png");
              } catch (e) {
                  console.warn("[XBHH V2] 画布截图失败（可能跨域污染）:", e);
              }
          }
          if (!dataUrl) dataUrl = this.blankWorkflowCanvas();

          const pngBytes = this.injectPngText(dataUrl, {
              workflow: workflow ? JSON.stringify(workflow) : "",
              prompt: prompt ? JSON.stringify(prompt) : "",
          });
          if (!pngBytes) throw new Error("PNG 编码失败");

          const blob = new Blob([pngBytes], { type: "image/png" });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const a = document.createElement("a");
          a.style.display = "none";
          a.href = URL.createObjectURL(blob);
          a.download = `workflow_${stamp}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);

          this.showMessage("✅ 已导出，拖回 ComfyUI 可还原工作流", 3000, 9);
      } catch (e) {
          console.error("[XBHH V2] 导出工作流图片失败:", e);
          this.showMessage("❌ 导出失败：" + (e && e.message ? e.message : e), 4000, 9);
      }
  }

  /** 取 ComfyUI 画布（优先主画布，排除看板娘自己的 live2d 画布） */
  getComfyCanvas() {
      const c = window.app && window.app.canvas;
      const el = (c && (c.canvas || c.canvasEl)) || document.querySelector("#graph-canvas canvas");
      if (el && typeof el.toDataURL === "function") return el;
      const list = document.querySelectorAll("canvas");
      for (const cv of list) {
          if (cv.id === "live2d") continue;
          if (cv.width > 300 && cv.height > 300) return cv;
      }
      return null;
  }

  /** 截图失败时的兜底底图 */
  blankWorkflowCanvas() {
      const cv = document.createElement("canvas");
      cv.width = 1024;
      cv.height = 576;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = "#8a8a8a";
      ctx.font = "20px Microsoft YaHei, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("ComfyUI Workflow", cv.width / 2, cv.height / 2);
      return cv.toDataURL("image/png");
  }

  /**
   * 往 PNG 里写入 iTXt 文本块（keyword=workflow/prompt），ComfyUI 依靠这些元数据还原工作流
   */
  injectPngText(dataUrl, texts) {
      const base64 = String(dataUrl).split(",")[1];
      if (!base64) return null;
      const bin = atob(base64);
      const raw = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);

      const enc = new TextEncoder();
      const chunks = [];
      for (const [key, value] of Object.entries(texts || {})) {
          if (!value) continue;
          chunks.push(
              this.makePngChunk("iTXt", this.buildITxtData(enc.encode(key), enc.encode(value))),
          );
      }
      if (!chunks.length) return raw;

      // IEND 固定是最后 12 字节，插到它前面
      const iend = raw.subarray(raw.length - 12);
      let total = raw.length - 12;
      chunks.forEach((c) => (total += c.length));
      const out = new Uint8Array(total + 12);
      out.set(raw.subarray(0, raw.length - 12), 0);
      let offset = raw.length - 12;
      chunks.forEach((c) => {
          out.set(c, offset);
          offset += c.length;
      });
      out.set(iend, offset);
      return out;
  }

  /** iTXt 数据段：keyword\0 | 压缩标记 | 压缩方法 | 语言标签\0 | 翻译关键词\0 | UTF-8 文本 */
  buildITxtData(keyBytes, textBytes) {
      const parts = [
          keyBytes,
          new Uint8Array([0, 0, 0]),
          new Uint8Array([0]),
          new Uint8Array([0]),
          textBytes,
      ];
      const len = parts.reduce((n, p) => n + p.length, 0);
      const data = new Uint8Array(len);
      let off = 0;
      parts.forEach((p) => {
          data.set(p, off);
          off += p.length;
      });
      return data;
  }

  /** 组装 PNG chunk：长度(4) + 类型(4) + 数据 + CRC32(4) */
  makePngChunk(type, data) {
      const len = data.length;
      const chunk = new Uint8Array(12 + len);
      const dv = new DataView(chunk.buffer);
      dv.setUint32(0, len);
      for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
      chunk.set(data, 8);
      dv.setUint32(8 + len, this.crc32(chunk.subarray(4, 8 + len)));
      return chunk;
  }

  crc32(bytes) {
      if (!Live2DV2Pet._crcTable) {
          const table = new Uint32Array(256);
          for (let n = 0; n < 256; n++) {
              let c = n;
              for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
              table[n] = c >>> 0;
          }
          Live2DV2Pet._crcTable = table;
      }
      const table = Live2DV2Pet._crcTable;
      let crc = 0xffffffff;
      for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * 劫持 Cubism2 的 requestAnimationFrame 渲染循环，限制到 30fps/targetFPS
   */
  throttleRenderLoop() {
      // 重新恢复渲染循环前，始终先清理现存的动画句柄，防止挂起卡死
      if (this._throttledDrawId) {
          window.cancelAnimationFrame(this._throttledDrawId);
          this._throttledDrawId = null;
      }

      const checkAndThrottle = () => {
          if (window.xbhhModelInstance && window.xbhhModelInstance.cubism2model) {
              const cubism2 = window.xbhhModelInstance.cubism2model;
              // 停止原始 60fps 循环
              if (cubism2._drawFrameId) {
                  window.cancelAnimationFrame(cubism2._drawFrameId);
                  cubism2._drawFrameId = null;
              }
              cubism2.isDrawStart = false;

              // 重置拖拽物体的计时器与 WebGL Viewport，防止切回页面时逻辑与绘制错乱
              if (cubism2.dragMgr) {
                  cubism2.dragMgr.lastTimeSec = 0;
              }
              if (cubism2.gl && !cubism2.gl.isContextLost() && typeof cubism2.gl.viewport === 'function') {
                  cubism2.gl.viewport(0, 0, cubism2.canvas.width, cubism2.canvas.height);
              }

              // 用节流循环替代（从 config 读取帧率，默认 30fps）
              const targetFPS = this.config.targetFPS || 30;
              const frameInterval = 1000 / targetFPS;
              let lastFrameTime = 0;

              const throttledDraw = (timestamp) => {
                  this._throttledDrawId = window.requestAnimationFrame(throttledDraw);
                  const elapsed = timestamp - lastFrameTime;
                  // 防止后台切回时由于巨大的 elapsed 导致状态卡死
                  if (elapsed > 1000) {
                      lastFrameTime = timestamp;
                      return;
                  }
                  if (elapsed >= frameInterval) {
                      lastFrameTime = timestamp - (elapsed % frameInterval);
                      try {
                          if (cubism2.gl && !cubism2.gl.isContextLost() && typeof cubism2.gl.createProgram === 'function') {
                              cubism2.draw();
                          }
                      } catch(e) {
                          // 忽略单帧渲染异常，保证渲染循环持续运行
                      }
                  }
              };
              this._throttledDrawId = window.requestAnimationFrame(throttledDraw);
          } else {
              // 引擎尚未就绪，稍后重试
              setTimeout(checkAndThrottle, 300);
          }
      };
      checkAndThrottle();
  }

  /**
   * 暂停渲染循环
   */
  pauseRenderLoop() {
      if (this._throttledDrawId) {
          window.cancelAnimationFrame(this._throttledDrawId);
          this._throttledDrawId = null;
      }
      // 也确保原始循环被停止
      if (window.xbhhModelInstance && window.xbhhModelInstance.cubism2model) {
          const cubism2 = window.xbhhModelInstance.cubism2model;
          if (cubism2._drawFrameId) {
              window.cancelAnimationFrame(cubism2._drawFrameId);
              cubism2._drawFrameId = null;
          }
          cubism2.isDrawStart = false;
      }
  }

  /**
   * 在 V2 (Cubism2) 气泡里显示自定义消息，兼容库内部 tips 的优先级占位机制
   */
  showMessage(text, timeout = 3000, priority = 0) {
    if (!text || this.currentPriority > priority || this.config.minimized)
      return;
    if (this.tipsTimer) clearTimeout(this.tipsTimer);
    this.currentPriority = priority;
    const tips = document.getElementById("waifu-tips");
    if (!tips) return;
    tips.innerHTML = text;
    tips.classList.add("waifu-tips-active");
    // 同步优先级占位，防止库内部（点击/拖拽/空闲等）随机 tips 覆盖本消息
    sessionStorage.setItem("waifu-message-priority", String(priority));

    this._tipsStartTime = Date.now();
    this._tipsTimeout = timeout;

    const startTimer = (remaining) => {
      if (this.tipsTimer) clearTimeout(this.tipsTimer);
      this.tipsTimer = setTimeout(() => {
        tips.classList.remove("waifu-tips-active");
        sessionStorage.removeItem("waifu-message-priority");
        this.currentPriority = -1;
      }, remaining);
    };

    startTimer(timeout);

    // 绑定悬停行为（只绑定一次）
    if (!this._tipsHoverBound) {
      this._tipsHoverBound = true;
      tips._xbhhMouseOn = false;
      tips.addEventListener("mouseenter", () => {
        tips._xbhhMouseOn = true;
        if (this.tipsTimer) {
          clearTimeout(this.tipsTimer);
          this.tipsTimer = null;
        }
      });
      tips.addEventListener("mouseleave", () => {
        tips._xbhhMouseOn = false;
        if (!tips.classList.contains("waifu-tips-active")) return;
        const minDisplay = 3000; // 最小显示时间 3 秒
        const elapsed = Date.now() - this._tipsStartTime;
        const remaining = Math.max(this._tipsTimeout - elapsed, minDisplay - elapsed, 1000);
        startTimer(remaining);
      });
    }
  }

  // ==========================================================================
  // 工作流运行支持 (测试按钮 / 为后续 AI 自动绘画铺垫)
  // ==========================================================================

  /** 幂等地订阅 ComfyUI 执行进度事件，跟踪本次提交的 prompt_id */
  _ensureWorkflowProgressTracker() {
    if (this._wfTrackerAttached) return;
    this._wfTrackerAttached = true;
    this._wfTrackingPromptId = null;
    this._wfArmed = false;
    this._wfExecutedCount = 0;
    this._wfCachedCount = 0;
    this._wfDone = true;

    if (!api || typeof api.addEventListener !== "function") return;

    const detailOf = (e) => {
      const raw = e.detail || {};
      return raw.data || raw;
    };
    const match = (e) => {
      const d = detailOf(e);
      return (
        !this._wfTrackingPromptId || d.prompt_id === this._wfTrackingPromptId
      );
    };

    const finishOk = () => {
      if (this._wfDone) return;
      this._wfDone = true;
      this._wfTrackingPromptId = null;
      if (this._wfExecutedCount === 0) {
        this.showMessage(
          this._wfCachedCount > 0
            ? `⚡ 瞬间完成：${this._wfCachedCount} 个节点全部命中缓存，没有真正重画。改一下 seed/参数再试，或把 KSampler 的 seed 设为 randomize`
            : "⚠️ 瞬间结束：没有执行任何节点（画布可能缺少 SaveImage 之类的输出节点）",
          8000,
          10,
        );
      } else {
        this.showMessage("✅ 绘画完成！主人来看看～", 5000, 10);
      }
    };

    api.addEventListener("execution_start", (e) => {
      const d = detailOf(e);
      if (this._wfArmed && !this._wfTrackingPromptId) {
        this._wfTrackingPromptId = d.prompt_id || null;
        this._wfArmed = false;
      }
      // 新一轮执行：不是自动优化触发的重跑 → 重置自检轮数
      if (!this._autoReviewRerunFlag) this._autoReviewRound = 0;
      this._autoReviewRerunFlag = false;
      if (!match(e)) return;
      this._wfExecutedCount = 0;
      this._wfCachedCount = 0;
      this._wfDone = false;
      this.showMessage("🖌️ 开始绘画啦～", 4000, 10);
    });

    api.addEventListener("executing", (e) => {
      if (!match(e)) return;
      const d = detailOf(e);
      if (d.node === null || d.node === undefined) {
        finishOk();
      } else {
        this._wfExecutedCount++;
        this.showMessage(`🎨 正在绘画… 节点 ${this._wfExecutedCount}`, 2500, 10);
      }
    });

    api.addEventListener("execution_cached", (e) => {
      if (!match(e)) return;
      const d = detailOf(e);
      this._wfCachedCount += (d.nodes || []).length;
    });

    api.addEventListener("execution_success", (e) => {
      if (!match(e)) return;
      finishOk();
      // 跑完自动看图自检（设置里开启才生效；内部有去重与轮数上限）
      this._maybeAutoReview();
    });

    api.addEventListener("execution_error", (e) => {
      if (!match(e)) return;
      const d = detailOf(e);
      const msg = d.exception_message || d.exception_type || d.error || "未知错误";
      this.showMessage(`❌ 绘画失败：${msg}`, 6000, 10);
      this._wfDone = true;
      this._wfTrackingPromptId = null;
    });

    api.addEventListener("execution_interrupted", (e) => {
      if (!match(e)) return;
      this.showMessage("⏸️ 绘画被中断了", 4000, 10);
      this._wfDone = true;
      this._wfTrackingPromptId = null;
    });
  }

  /**
   * 把一个 API 格式工作流 {node_id: {class_type, inputs}} 提交到 ComfyUI 队列。
   */
  async runWorkflow(promptData, label = "工作流") {
    this._ensureWorkflowProgressTracker();
    if (
      !promptData ||
      (typeof promptData === "object" && Object.keys(promptData).length === 0)
    ) {
      this.showMessage("⚠️ 工作流为空，无法运行", 3000, 10);
      return;
    }
    const clientId = (api.clientId || "").trim() || "xbhh-" + Date.now();
    try {
      const resp = await api.fetchApi("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: promptData, client_id: clientId }),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok || result.error) {
        const errs = result.node_errors || result.error;
        const firstErr =
          errs && typeof errs === "object"
            ? JSON.stringify(errs).slice(0, 180)
            : String(errs);
        this.showMessage(`❌ 提交失败：${firstErr}`, 6000, 10);
        console.error("[XBHH V2] runWorkflow submit failed:", result);
        return;
      }
      this._wfTrackingPromptId = result.prompt_id;
      this.showMessage(`🚀 已提交「${label}」，排队中…`, 3000, 10);
    } catch (e) {
      this.showMessage(`❌ 网络错误：${e.message || e}`, 5000, 10);
      console.error("[XBHH V2] runWorkflow error:", e);
    }
  }

  /** 运行当前 ComfyUI 画布上的工作流 (与原生运行按钮等价) */
  // 记录错误详情（弹窗/提交失败/执行错误统一入口），供 AI 诊断用
  // 同时写入 window.__xbhhLastError，供全局 fetch 拦截共享
  _xbhhRecordError(text) {
    const t = String(text || "").trim();
    if (!t) return;
    this._lastExecError = { time: Date.now(), text: t.slice(0, 1500) };
    window.__xbhhLastError = this._lastExecError;
    console.warn("[XBHH V2 pet] 记录错误详情:", t.slice(0, 200));
  }

  async runCurrentCanvasWorkflow() {
    this._ensureWorkflowProgressTracker();
    this._wfTrackingPromptId = null;
    this._wfArmed = true;
    try {
      if (typeof app.queuePrompt === "function") {
        await app.queuePrompt(0);
        this.showMessage("🚀 已提交当前画布工作流", 2500, 10);
      } else if (typeof app.graphToPrompt === "function") {
        const parsed = await app.graphToPrompt();
        const promptData = parsed.output || parsed;
        await this.runWorkflow(promptData, "当前画布工作流");
      } else {
        this.showMessage("⚠️ 当前环境不支持运行画布工作流", 3000, 10);
      }
    } catch (e) {
      this._xbhhRecordError(`【工作流提交失败】\n${(e && e.message) || e}`);
      this.showMessage(`⚠️ 提交失败：${(e && e.message) || e}`, 5000, 10);
      console.error("[XBHH V2] runCurrentCanvasWorkflow error:", e);
    }
  }

  /**
   * 跑图结束后的 AI 自检：拿最新一张图 + 当前提示词 → /xbhh/pet/auto_review
   * → 点评气泡；开启「自动优化重跑」且判定不合格时改写提示词、随机 seed 重跑
   * （单轮最多 3 次，_autoReviewRerunFlag 标记自动重跑以维持轮数）。
   */
  async _maybeAutoReview() {
    if (this._autoReviewBusy) return;
    const s = window.xbhhSettings;
    if (!s || !s.get("autoReview", false)) return;
    const baseURL = s.get("baseURL", "https://api.deepseek.com");
    const apiKey = s.get("apiKey", "");
    const isLocal = /localhost|127\.0\.0\.1/.test(baseURL);
    if (!apiKey && !isLocal) return; // 没配 Key 静默跳过
    this._autoReviewBusy = true;
    try {
      // 等文件落盘、history 登记完成
      await new Promise((r) => setTimeout(r, 2500));
      const metas = await this._fetchRecentImageMetas(1, 1);
      if (!metas.length) return;
      // 去重：同一张图不重复自检（自动重跑会产出新文件名，不受影响）
      if (metas[0].filename === this._lastReviewFilename) return;
      this._lastReviewFilename = metas[0].filename;
      const images = [];
      try {
        images.push(await this._imgUrlToDataUrl(metas[0].url));
      } catch (e) { /* 读取失败跳过 */ }
      if (!images.length) return;
      const pn = xbhhFindPromptNode();
      const prompt = pn && pn.widget ? String(pn.widget.value || "") : "";
      const round = this._autoReviewRound || 0;
      console.log(`[XBHH review] 第 ${round + 1} 轮自检，提示词 ${prompt.length} 字`);
      const resp = await fetch("/xbhh/pet/auto_review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images,
          prompt,
          round,
          config: {
            base_url: baseURL,
            api_key: apiKey,
            model: s.get("model", "deepseek-chat"),
            vision_base_url: s.get("visionBaseURL", ""),
            vision_api_key: s.get("visionAPIKey", ""),
            vision_model: s.get("visionModel", ""),
          },
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!data.success) {
        console.warn("[XBHH review] 自检失败:", data.message);
        this.showMessage(`⚠️ 自动看图失败：${(data.message || "").slice(0, 80)}`, 5000, 10);
        this._autoReviewRound = 0;
        return;
      }
      console.log("[XBHH review] 自检结果:", data);
      const comment = (data.comment || "").slice(0, 120);
      const canRerun =
        data.need_rerun &&
        data.optimized_prompt &&
        s.get("autoReviewRerun", false) &&
        round < 2 && // 第 1、2 轮可重跑，第 3 轮收手
        pn && pn.widget;
      this.showMessage(
        canRerun
          ? `🔍 自检（第 ${round + 1} 轮）：${comment || "有瑕疵"}\n🔁 我改了提示词重跑一张试试～`
          : `🔍 自检：${comment || "这张不错～"}`,
        8000, 10,
      );
      if (canRerun) {
        if (String(data.optimized_prompt).trim() !== prompt.trim()) {
          pn.widget.value = data.optimized_prompt;
          if (pn.node.setDirtyCanvas) pn.node.setDirtyCanvas(true, true);
          if (app.canvas && app.canvas.setDirty) app.canvas.setDirty(true, true);
        }
        xbhhRandomizeCanvasSeeds();
        this._autoReviewRound = round + 1;
        this._autoReviewRerunFlag = true; // execution_start 据此保持轮数
        setTimeout(() => this.runCurrentCanvasWorkflow(), 1800);
      } else {
        if (data.need_rerun && !s.get("autoReviewRerun", false)) {
          this.showMessage("💡 这张我不太满意，开「自动优化重跑」我可以自己改提示词重画～", 6000, 10);
        }
        this._autoReviewRound = 0;
      }
    } catch (e) {
      console.warn("[XBHH review] 自动看图异常:", e);
      this._autoReviewRound = 0;
    } finally {
      this._autoReviewBusy = false;
    }
  }

  /** 拉取并运行 data/workflows/ 下的某个已保存工作流 */
  async runSavedWorkflow(name) {
    try {
      const resp = await fetch(`/xbhh/pet/workflows/${encodeURIComponent(name)}`);
      if (!resp.ok) {
        this.showMessage(`⚠️ 读取工作流失败 (${resp.status})`, 3000, 10);
        return;
      }
      const data = await resp.json();
      if (data.error) {
        this.showMessage(`⚠️ ${data.error}`, 3000, 10);
        return;
      }
      await this.runWorkflow(data.workflow, name);
    } catch (e) {
      this.showMessage(`❌ 读取工作流出错：${(e && e.message) || e}`, 5000, 10);
      console.error("[XBHH V2] runSavedWorkflow error:", e);
    }
  }

  // ==========================================================================
  // AI 对话 (LLM 聊天，OpenAI 兼容格式，默认 DeepSeek)
  // ==========================================================================

  // ===== 气泡 Messenger 风聊天 UI（方案 A） =====
  // 全局样式由 live2d_loader.js 的 window.__xbhhEnsureChatStyles 注入（V2/V4 共用）

  _createChatBox() {
    const container = document.getElementById("waifu");
    if (!container) return;
    window.__xbhhEnsureChatStyles && window.__xbhhEnsureChatStyles();

    const QUICK = [
      { label: "🎨 画一张", text: "帮我画一张好看的图" },
      { label: "🔀 换画风", text: "随机添加几个画风lora，权重总和1.2以内，然后启动" },
      { label: "🐞 报错诊断", text: "刚才的报错怎么解决？" },
      { label: "🎲 随机人物", text: "随机来一个人物lora，然后启动" },
    ];

    this.chatBox = document.createElement("div");
    this.chatBox.id = "xbhh-live2d-v2-chatbox";
    this.chatBox.className = "xbhhchat-box";

    // 顶栏：标题 + 状态 + 重新开始 + 收起
    const head = document.createElement("div");
    head.className = "xbhhchat-head";
    head.innerHTML = `<div class="xbhhchat-title">💬 和看板娘聊天</div>`;
    this.chatStatusEl = document.createElement("div");
    this.chatStatusEl.className = "xbhhchat-status";
    this.chatStatusEl.innerHTML = '<span class="xbhhchat-dot"></span><span>在线</span>';
    head.appendChild(this.chatStatusEl);
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "xbhhchat-clear";
    clearBtn.innerText = "重新开始";
    clearBtn.title = "清空历史，重新对话";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "xbhhchat-close";
    closeBtn.innerText = "收起 ✕";
    head.appendChild(clearBtn);
    head.appendChild(closeBtn);

    // 消息区
    const msgArea = document.createElement("div");
    msgArea.className = "xbhhchat-msgs";
    this.chatMsgArea = msgArea;

    // 快捷指令胶囊
    const quickRow = document.createElement("div");
    quickRow.className = "xbhhchit-quick";
    for (const q of QUICK) {
      const chip = document.createElement("div");
      chip.className = "xbhhchit-chip";
      chip.innerText = q.label;
      chip.title = q.text;
      chip.onclick = () => {
        if (this._chatBusy) return;
        this.chatInput.value = q.text;
        this.sendChat();
      };
      quickRow.appendChild(chip);
    }

    // 输入行：🖼 选图 + 输入框 + 发送
    const inputRow = document.createElement("div");
    inputRow.className = "xbhhchat-inputrow";
    const imgBtn = document.createElement("button");
    imgBtn.type = "button";
    imgBtn.className = "xbhhchat-imgbtn";
    imgBtn.innerText = "🖼";
    imgBtn.title = "选择最近生成的图片给 AI 看";
    imgBtn.onclick = () => this._openImagePicker();
    const input = document.createElement("textarea");
    input.rows = 1;
    input.placeholder = "跟她说点什么… (Enter 发送 / Shift+Enter 换行)";
    input.className = "xbhhchat-input";
    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "xbhhchat-send";
    sendBtn.innerText = "发送";
    inputRow.appendChild(imgBtn);
    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);

    this.chatBox.appendChild(head);
    this.chatBox.appendChild(msgArea);
    this.chatBox.appendChild(quickRow);
    this.chatBox.appendChild(inputRow);
    // 悬浮窗：挂在 body 上（不随看板娘容器），支持拖拽/缩放/最小化悬浮球/字体
    document.body.appendChild(this.chatBox);
    if (window.__xbhhChatWin) window.__xbhhChatWin.init(this.chatBox);
    this.chatInput = input;
    this.chatSendBtn = sendBtn;
    if (!this.chatHistory) this.chatHistory = [];
    this._chatTypingTimer = null;
    this._pendingImages = [];
    // 支持从资源管理器把本地图片文件拖进聊天窗当附件
    if (window.__xbhhEnableChatImageDrop) {
      window.__xbhhEnableChatImageDrop(this.chatBox, (files) => this._addLocalImages(files));
    }

    this.chatBox.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendChat();
      } else if (e.key === "Escape") {
        this.closeChatBox();
      }
    });
    // textarea 自适应高度
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 72) + "px";
    });
    sendBtn.onclick = () => this.sendChat();
    clearBtn.onclick = () => {
      this.chatHistory = [];
      this._renderChatHistory();
      this.showMessage("已重新开始对话～", 2500, 10);
    };
    closeBtn.onclick = () => this.closeChatBox();
    this._renderChatHistory();
  }

  openChatBox() {
    if (!this.chatBox) this._createChatBox();
    if (this.config.minimized) this.restore();
    if (window.__xbhhChatWin) window.__xbhhChatWin.open(this.chatBox);
    else {
      this.chatBox.style.display = "flex";
      this.chatBox.classList.add("xbhh-open");
    }
    this._renderChatHistory();
    setTimeout(() => this.chatInput && this.chatInput.focus(), 80);
  }

  closeChatBox() {
    if (this.chatBox) {
      this.chatBox.classList.remove("xbhh-open");
      this.chatBox.style.display = "none";
    }
  }

  _setChatStatus(typing) {
    if (!this.chatStatusEl) return;
    this.chatStatusEl.innerHTML = typing
      ? '<span class="xbhhchat-dot xbhh-typing" style="background:#f7941e;box-shadow:0 0 6px #f7941e88"></span><span>正在输入…</span>'
      : '<span class="xbhhchat-dot"></span><span>在线</span>';
  }

  _fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  _msgRow(role, html, ts, cls) {
    const row = document.createElement("div");
    row.className = "xbhhchat-row" + (role === "user" ? " xbhh-me" : "");
    const av = document.createElement("div");
    av.className = "xbhhchat-avatar";
    av.innerText = role === "user" ? "你" : "Pet";
    const body = document.createElement("div");
    body.className = "xbhhchat-body";
    const bubble = document.createElement("div");
    bubble.className = "xbhhchat-bubble" + (cls ? " " + cls : "");
    bubble.innerHTML = html;
    const time = document.createElement("div");
    time.className = "xbhhchat-time";
    time.innerText = this._fmtTime(ts);
    body.appendChild(bubble);
    body.appendChild(time);
    row.appendChild(av);
    row.appendChild(body);
    return row;
  }

  /** 轻量 markdown：**粗体** `代码` 换行保持 */
  _mdLite(text) {
    let s = this._escapeHtml(String(text));
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    return s;
  }

  _appendMsgToArea(role, content, cls) {
    if (!this.chatMsgArea) return null;
    const empty = this.chatMsgArea.querySelector(".xbhhchat-empty");
    if (empty) empty.remove();
    const row = this._msgRow(role, this._mdLite(content), Date.now(), cls);
    this.chatMsgArea.appendChild(row);
    this.chatMsgArea.scrollTop = this.chatMsgArea.scrollHeight;
    // 最小化状态下有新回复 → 悬浮球角标 +1
    if (role === "assistant" && window.__xbhhChatWin) window.__xbhhChatWin.notify();
    return row;
  }

  /** 打字机：往最后一条 AI 气泡里逐字输出 */
  _typewriter(bubble, fullText, done) {
    if (this._chatTypingTimer) {
      clearInterval(this._chatTypingTimer);
      this._chatTypingTimer = null;
    }
    const html = this._mdLite(fullText);
    // 用纯文本逐字打（md 标记整体保留），结束后替换成完整富文本
    const plain = String(fullText);
    let i = 0;
    const step = Math.max(1, Math.round(plain.length / 60)); // 约 60 帧打完
    const cur = '<span class="xbhhchat-cursor"></span>';
    this._chatTypingTimer = setInterval(() => {
      i += step;
      if (i >= plain.length) {
        clearInterval(this._chatTypingTimer);
        this._chatTypingTimer = null;
        bubble.innerHTML = html;
        this._setChatStatus(false);
        if (done) done();
      } else {
        bubble.innerHTML = this._escapeHtml(plain.slice(0, i)) + cur;
      }
      this.chatMsgArea.scrollTop = this.chatMsgArea.scrollHeight;
    }, 16);
  }

  _renderChatHistory() {
    if (!this.chatMsgArea) return;
    if (!this.chatHistory || !this.chatHistory.length) {
      this.chatMsgArea.innerHTML =
        '<div class="xbhhchat-empty">还没有聊天记录，来聊点什么吧～<br/>试试下面的快捷指令 ✨</div>';
      return;
    }
    this.chatMsgArea.innerHTML = "";
    for (const msg of this.chatHistory) {
      if (msg.role === "user" || msg.role === "assistant") {
        this.chatMsgArea.appendChild(this._msgRow(msg.role, this._mdLite(msg.content), msg.ts));
      }
    }
    this.chatMsgArea.scrollTop = this.chatMsgArea.scrollHeight;
  }

  _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  async sendChat() {
    const text = ((this.chatInput && this.chatInput.value) || "").trim();
    if (!text) return;
    if (this._chatBusy) {
      this.showMessage("慢点啦，我还在想上一句呢～", 2500, 10);
      return;
    }
    // 看图：手动挑选的图片优先；未挑选且命中看图关键词时自动附带最近 3 张生成图
    let images = Array.isArray(this._pendingImages) ? this._pendingImages.slice() : [];
    if (
      !images.length &&
      /看图|看看图|看看刚|图片|这几张|选一张|选个|挑一张|挑个|哪张|哪张好|点评|评价|对比|好看吗|画得/.test(text)
    ) {
      try {
        images = await this._fetchRecentOutputImages(3);
        if (images.length) console.log(`[XBHH V2] 自动附带最近 ${images.length} 张图片`);
      } catch (e) {
        console.warn("[XBHH V2] 自动附带图片失败:", e);
      }
    }
    const userContent = text + (images.length ? `\n📎 附带 ${images.length} 张图片` : "");
    this._chatBusy = true;
    if (this.chatSendBtn) this.chatSendBtn.disabled = true;
    this.chatInput.value = "";
    this.chatInput.style.height = "auto";
    this._pendingImages = [];
    this._renderAttachChips();
    this.chatHistory.push({ role: "user", content: userContent, ts: Date.now() });
    this._appendMsgToArea("user", userContent);
    this._showTypingRow();
    this._setChatStatus(true);

    try {
      // 配置来自独立设置面板（window.xbhhSettings，见 live2d_loader.js）
      const s = window.xbhhSettings;
      const config = {
        base_url: s?.get?.("baseURL", "https://api.deepseek.com") ?? "https://api.deepseek.com",
        api_key: s?.get?.("apiKey", "") ?? "",
        model: s?.get?.("model", "deepseek-chat") ?? "deepseek-chat",
        system_prompt: s?.get?.("persona", XBHH_DEFAULT_PERSONA) ?? XBHH_DEFAULT_PERSONA,
        vision_base_url: s?.get?.("visionBaseURL", "") ?? "",
        vision_api_key: s?.get?.("visionAPIKey", "") ?? "",
        vision_model: s?.get?.("visionModel", "") ?? "",
      };

      // 报错诊断：用户提到报错/解决且 30 分钟内有缓存的执行错误 → 附给 AI
      // 来源优先级：本实例记录（执行错误/弹窗/提交失败） > 全局 fetch 拦截（手动 Queue 的 400）
      const _err = this._lastExecError || window.__xbhhLastError;
      let errorContext = "";
      if (
        _err &&
        /报错|错误|出错|失败|崩|修复|解决|怎么了|为什么/.test(text) &&
        Date.now() - _err.time < 30 * 60 * 1000
      ) {
        errorContext = _err.text;
      }

      const resp = await fetch("/xbhh/pet/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: this.chatHistory.slice(-20),
          config,
          // 技能开关：关闭的技能后端不下发对应工具、不注入对应指令
          skills: {
            prompt: s?.get?.("skillPrompt", true) !== false,
            lora: s?.get?.("skillLora", true) !== false,
            model: s?.get?.("skillModel", true) !== false,
          },
          prompt_slots: xbhhCollectPromptSlots(),
          ...(images.length ? { images } : {}),
          ...(errorContext ? { error_context: errorContext } : {}),
        }),
      });
      const data = await resp.json().catch(() => ({}));

      if (data.success) {
        // 打印 AI 完整响应到控制台，方便调试
        console.log("[XBHH AI] 回复：", data.reply || "(空)");
        console.log("[XBHH AI] 工具调用：", data.tool_calls || []);
        // 对话完成 → 小鲸鱼冒泡提示本次 token 消耗与今日已用金额
        if (typeof window.xbhhShowPetTokenNote === "function") {
          window.xbhhShowPetTokenNote(data.usage);
        }
        const _tc = data.tool_calls || [];
        if (data.reply) {
          // 标记该回复是否附带了工具调用，帮助模型在后续对话中区分"说过了"和"做过了"
          const content =
            _tc.length > 0
              ? `${data.reply}（已调用工具执行操作）`
              : data.reply;
          this.chatHistory.push({ role: "assistant", content, ts: Date.now() });
          if (this.chatHistory.length > 20)
            this.chatHistory = this.chatHistory.slice(-20);
        } else if (_tc.length > 0) {
          // 只有工具调用没有文字时，也记一条占位，保持对话结构完整
          this.chatHistory.push({
            role: "assistant",
            content: "（已调用工具执行操作）",
            ts: Date.now(),
          });
          if (this.chatHistory.length > 20)
            this.chatHistory = this.chatHistory.slice(-20);
        }
        this._hideTypingRow();
        const lastMsg = this.chatHistory[this.chatHistory.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          const row = this._appendMsgToArea("assistant", lastMsg.content);
          if (row)
            this._typewriter(
              row.querySelector(".xbhhchat-bubble"),
              lastMsg.content,
            );
        } else {
          this._setChatStatus(false);
        }

        // 处理 LoRA 堆工具调用（add_lora / remove_lora / set_lora_strength）
        const toolCalls = data.tool_calls || [];
        if (toolCalls.length) {
          console.log("[XBHH lora] LLM 返回的工具调用：", toolCalls);
        }
        // 处理分类提示词写入（write_prompts）——先填词，后续跑图才能带上新内容
        let promptMsgs = [];
        const promptCalls = toolCalls.filter((t) => t.name === "write_prompts");
        if (promptCalls.length) {
          try {
            promptMsgs = await xbhhHandlePromptToolCalls(promptCalls);
          } catch (e) {
            console.warn("[XBHH prompt] write_prompts 执行失败:", e);
            promptMsgs = [`⚠️ 提示词写入失败：${(e && e.message) || e}`];
          }
          console.log("[XBHH prompt] 提示词写入结果：", promptMsgs);
        }
        let loraMsg = null;
        const hasLoraCall = toolCalls.some((t) =>
          ["add_lora", "remove_lora", "set_lora_strength", "auto_style_loras", "random_style_loras"].includes(t.name),
        );
        if (hasLoraCall) {
          const results = await xbhhHandleLoraToolCalls(toolCalls);
          if (results && results.length) {
            loraMsg = results.join("\n");
            console.log("[XBHH lora] 工具调用结果：", results);
          }
        }

        // 处理大模型切换工具调用
        let ckptMsg = null;
        const ckptCall = toolCalls.find((t) => t.name === "set_checkpoint");
        if (ckptCall) {
          ckptMsg = xbhhSetCheckpoint(ckptCall.arguments && ckptCall.arguments.checkpoint_name);
          console.log("[XBHH V2 ckpt] 切换大模型结果:", ckptMsg);
        }
        // 合并 LoRA / 大模型操作结果，统一展示
        const actionMsg = [loraMsg, ckptMsg].filter(Boolean).join("\n");

        // 检测 AI 是否请求调用「生成图片」工具
        const toolCall = toolCalls.find((t) => t.name === "generate_image");
        // 检测 AI 是否请求「运行工作流」（用户说启动/运行但没有描述新画面）
        const runCall = toolCalls.find((t) => t.name === "run_workflow");

        if (toolCall) {
          const prompt =
            (toolCall.arguments && toolCall.arguments.prompt) || "";
          const clean = data.reply
            ? this._applyEmotion(data.reply)
            : "收到～我这就去画！";

          const lines = [];
          if (actionMsg) lines.push(actionMsg);
          if (promptMsgs.length) lines.push(promptMsgs.join("\n"));
          lines.push(prompt ? `${clean}\n🎨 主题：${prompt}` : clean);
          this.showMessage(lines.join("\n"), 8000, 10);
          // 运行当前画布工作流（write_prompts 已同步写入完成，跑图即带上新提示词）
          setTimeout(() => this.runCurrentCanvasWorkflow(), 1200);
        } else if (runCall) {
          const clean = data.reply
            ? this._applyEmotion(data.reply)
            : "好嘞，这就开画～";
          const lines = [];
          if (actionMsg) lines.push(actionMsg);
          if (promptMsgs.length) lines.push(promptMsgs.join("\n"));
          lines.push(clean);
          this.showMessage(lines.join("\n"), 8000, 10);
          console.log("[XBHH V2 AI] run_workflow 工具调用，运行当前画布工作流");
          setTimeout(() => this.runCurrentCanvasWorkflow(), 1200);
        } else if (actionMsg || promptMsgs.length) {
          const clean = data.reply
            ? this._applyEmotion(data.reply)
            : "好嘞，配置已更新～";
          const lines = [];
          if (promptMsgs.length) lines.push(promptMsgs.join("\n"));
          if (actionMsg) lines.push(actionMsg);
          lines.push(clean);
          this.showMessage(lines.join("\n"), 8000, 10);
        } else if (data.reply) {
          const clean = this._applyEmotion(data.reply);
          this.showMessage(clean, 12000, 10);
        } else {
          this.showMessage("（模型没有返回内容）", 4000, 10);
        }
      } else {
        this.chatHistory.pop();
        this._hideTypingRow();
        this._setChatStatus(false);
        this._appendMsgToArea("assistant", `⚠️ ${data.message || "对话失败"}`, "xbhh-err");
        this.showMessage(`⚠️ ${data.message || "对话失败"}`, 6000, 10);
      }
    } catch (e) {
      this.chatHistory.pop();
      this._hideTypingRow();
      this._setChatStatus(false);
      this._appendMsgToArea("assistant", `❌ 网络错误：${(e && e.message) || e}`, "xbhh-err");
      this.showMessage(`❌ 网络错误：${(e && e.message) || e}`, 5000, 10);
      console.error("[XBHH V2] sendChat error:", e);
    } finally {
      this._chatBusy = false;
      if (this.chatSendBtn) this.chatSendBtn.disabled = false;
    }
  }

  _showTypingRow() {
    if (!this.chatMsgArea) return;
    this._hideTypingRow();
    const row = document.createElement("div");
    row.className = "xbhhchat-row xbhhchat-typingrow";
    row.innerHTML =
      '<div class="xbhhchat-avatar">Pet</div><div class="xbhhchat-body"><div class="xbhhchat-bubble">' +
      '<span class="xbhhchat-tdot"></span><span class="xbhhchat-tdot"></span><span class="xbhhchat-tdot"></span>' +
      "</div></div>";
    this._chatTypingRowEl = row;
    this.chatMsgArea.appendChild(row);
    this.chatMsgArea.scrollTop = this.chatMsgArea.scrollHeight;
  }

  _hideTypingRow() {
    if (this._chatTypingRowEl && this._chatTypingRowEl.parentNode) {
      this._chatTypingRowEl.remove();
    }
    this._chatTypingRowEl = null;
  }

  // ===== 看图：读取 ComfyUI 最近输出 → data URL，供多模态 AI 分析 =====

  /** ComfyUI /history 拉取最近输出图的元信息（新的在前）
   * perRun：限制单次执行（一次跑图）最多贡献几张，防止批量出图霸占名额 */
  async _fetchRecentImageMetas(maxN, perRun) {
    const resp = await fetch(`/history?max_items=${Math.max(8, (maxN || 3) * 4)}`);
    const hist = await resp.json();
    const items = Object.keys(hist || {})
      .map((k) => hist[k])
      .filter(Boolean);
    // prompt[0] 是入队时间戳，倒序 = 新的在前
    items.sort(
      (a, b) => ((b.prompt && b.prompt[0]) || 0) - ((a.prompt && a.prompt[0]) || 0),
    );
    const metas = [];
    for (const it of items) {
      // 单次执行内收集所有输出节点的图（官方/自定义保存节点都会登记）
      const runImgs = [];
      const outputs = it.outputs || {};
      for (const nid of Object.keys(outputs)) {
        for (const im of outputs[nid].images || []) {
          if ((im.type || "output") !== "output") continue;
          runImgs.push({
            filename: im.filename,
            subfolder: im.subfolder || "",
            url:
              `/view?filename=${encodeURIComponent(im.filename)}` +
              `&subfolder=${encodeURIComponent(im.subfolder || "")}&type=output`,
          });
        }
      }
      const capped = perRun ? runImgs.slice(-perRun) : runImgs;
      for (const m of capped) {
        metas.push(m);
        if (metas.length >= maxN) return metas;
      }
    }
    return metas;
  }

  /** canvas 压缩：长边 ≤ maxEdge 的 JPEG（透明底填白）。
   * 多模态按 token 计费，原图动辄数 MB；压到 768 边长的 JPEG 足够看图，token 降约 90% */
  _compressDataUrl(dataUrl, maxEdge, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
          const cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(img.width * scale));
          cv.height = Math.max(1, Math.round(img.height * scale));
          const ctx = cv.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, cv.width, cv.height);
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL("image/jpeg", quality));
        } catch (e) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async _imgUrlToDataUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("fetch image " + resp.status);
    const blob = await resp.blob();
    const raw = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
    return await this._compressDataUrl(raw, 768, 0.75);
  }

  /** 拉最近 N 张输出图并转成压缩后的 data URL（发给后端的格式） */
  async _fetchRecentOutputImages(maxN) {
    // perRun=2：一次跑图最多占 2 个名额，剩下的留给上一次执行
    const metas = await this._fetchRecentImageMetas(maxN || 3, 2);
    const urls = [];
    for (const m of metas) {
      try {
        urls.push(await this._imgUrlToDataUrl(m.url));
      } catch (e) {
        /* 跳过读取失败的图 */
      }
    }
    return urls;
  }

  /** 🖼 图片选择面板：挑最近生成的图（最多 4 张）随下一条消息发给 AI */
  _openImagePicker() {
    if (!this.chatBox) return;
    const old = this.chatBox.querySelector(".xbhhchat-imgpanel");
    if (old) {
      old.remove();
      return;
    }
    const panel = document.createElement("div");
    panel.className = "xbhhchat-imgpanel";
    const head = document.createElement("div");
    head.style.cssText = "font-size:11px;color:#8b93a8;margin-bottom:6px;";
    head.textContent = "选择要给 AI 看的图片（最多 4 张，新的在前）";
    const grid = document.createElement("div");
    grid.className = "xbhhchat-imggrid";
    grid.innerHTML =
      '<div style="color:#6b7386;font-size:11px;padding:8px;">加载中…</div>';
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "xbhhchat-send";
    confirmBtn.style.cssText = "width:100%;margin-top:8px;padding:6px 0;font-size:12px;display:none;";
    confirmBtn.innerText = "确定";
    panel.appendChild(head);
    panel.appendChild(grid);
    panel.appendChild(confirmBtn);
    this.chatBox.appendChild(panel);
    // 点击面板外关闭（🖼 按钮本身不关，交给 toggle）
    const closer = (ev) => {
      if (!panel.parentNode) {
        document.removeEventListener("pointerdown", closer, true);
        return;
      }
      if (panel.contains(ev.target)) return;
      if (ev.target.closest && ev.target.closest(".xbhhchat-imgbtn")) return;
      document.removeEventListener("pointerdown", closer, true);
      panel.remove();
    };
    document.addEventListener("pointerdown", closer, true);

    const selected = [];
    this._fetchRecentImageMetas(12, 3)
      .then((metas) => {
        grid.innerHTML = "";
        if (!metas.length) {
          grid.innerHTML =
            '<div style="color:#6b7386;font-size:11px;padding:8px;">最近没有生成图片</div>';
          return;
        }
        metas.forEach((m, i) => {
          const th = document.createElement("div");
          th.className = "xbhhchat-thumb";
          th.innerHTML = `<img src="${m.url}" loading="lazy"/><span class="n">${i + 1}</span>`;
          th.onclick = () => {
            const idx = selected.findIndex((s) => s.url === m.url);
            if (idx >= 0) {
              selected.splice(idx, 1);
              th.classList.remove("sel");
            } else if (selected.length >= 4) {
              this.showMessage("最多选 4 张～", 2000, 10);
              return;
            } else {
              selected.push(m);
              th.classList.add("sel");
            }
            confirmBtn.style.display = selected.length ? "" : "none";
            confirmBtn.innerText = `确定（${selected.length} 张）`;
          };
          grid.appendChild(th);
        });
      })
      .catch(() => {
        grid.innerHTML =
          '<div style="color:#6b7386;font-size:11px;padding:8px;">读取历史失败</div>';
      });

    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true;
      confirmBtn.innerText = "读取图片中…";
      const urls = [];
      for (const m of selected) {
        try {
          urls.push(await this._imgUrlToDataUrl(m.url));
        } catch (e) {
          /* skip */
        }
      }
      this._pendingImages = urls;
      this._renderAttachChips();
      panel.remove();
    };
  }

  /** 把本地拖入的图片文件加入待发送附件（≤4 张，压缩成 JPEG dataURL） */
  async _addLocalImages(files) {
    const imgs = (files || []).filter((f) => f && f.type && f.type.startsWith("image/"));
    if (!imgs.length) {
      this.showMessage("这里只能放图片文件哦～", 2000, 10);
      return;
    }
    if (!this._pendingImages) this._pendingImages = [];
    const room = 4 - this._pendingImages.length;
    if (room <= 0) {
      this.showMessage("最多 4 张啦，先删掉一张再拖～", 2000, 10);
      return;
    }
    if (imgs.length > room) this.showMessage(`最多 4 张，只收下前 ${room} 张～`, 2200, 10);
    for (const f of imgs.slice(0, room)) {
      try {
        const raw = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(f);
        });
        this._pendingImages.push(await this._compressDataUrl(raw, 768, 0.75));
      } catch (e) {
        /* 单张读取失败则跳过 */
      }
    }
    this._renderAttachChips();
  }

  /** 输入框上方的待发送图片缩略胶囊 */
  _renderAttachChips() {
    if (!this.chatBox) return;
    const old = this.chatBox.querySelector(".xbhhchat-attach");
    if (old) old.remove();
    const imgs = this._pendingImages || [];
    const btn = this.chatBox.querySelector(".xbhhchat-imgbtn");
    if (btn) btn.classList.toggle("has", imgs.length > 0);
    if (!imgs.length) return;
    const row = document.createElement("div");
    row.className = "xbhhchat-attach";
    imgs.forEach((im, i) => {
      const chip = document.createElement("div");
      chip.className = "xbhhchat-attachchip";
      chip.innerHTML = `<img src="${im}"/><span>图${i + 1}</span><span class="x" title="移除">✕</span>`;
      chip.querySelector(".x").onclick = () => {
        this._pendingImages.splice(i, 1);
        this._renderAttachChips();
      };
      row.appendChild(chip);
    });
    const inputRow = this.chatBox.querySelector(".xbhhchat-inputrow");
    if (inputRow) this.chatBox.insertBefore(row, inputRow);
  }

  /**
   * 识别回复结尾的情绪标签，返回剥掉标签后的正文
   */
  _applyEmotion(reply) {
    const EMOTIONS =
      "开心|难过|生气|惊讶|害羞|疑惑|激动|得意|卖萌|平静|无语";
    const re = new RegExp(
      `[（(\\[【]\\s*(${EMOTIONS})\\s*[）)\\]】]\\s*$`,
    );
    const m = String(reply).match(re);
    const clean = m ? String(reply).replace(re, "").trim() : String(reply).trim();
    if (m) this._triggerEmotion(m[1]);
    return clean || String(reply).trim();
  }

  /** V2 (Cubism2) 表情联动暂未接入，此处仅保留标签记录，后续可按需扩展 */
  _triggerEmotion(tag) {
    console.log(`[XBHH V2] 情绪标签: ${tag}（表情联动暂未接入）`);
  }

}
