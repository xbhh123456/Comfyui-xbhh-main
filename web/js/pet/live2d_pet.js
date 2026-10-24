import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/**
 * XBHH Live2D Pet Extension
 * 实现一个常驻桌面的 Live2D 小人
 */

// AI 看板娘默认人设（正式配置在 ComfyUI 设置 → XBHH 看板娘 人设，此处仅兜底）
const XBHH_DEFAULT_PERSONA =
  "你是 ComfyUI 工作台上的 AI 看板娘，本体是 DeepSeek（一只聪明的小蓝鲸），" +
  "性格活泼、偶尔傲娇、爱撒娇。用中文口语聊天，每次回复控制在两三句话内，" +
  "不要用列表和 markdown。回复结尾必须附一个情绪标签，从这些里选一个：" +
  "[开心] [难过] [生气] [惊讶] [害羞] [疑惑] [激动] [平静]";

// ============================================================================
// LoRA 堆工具调用处理：AI 通过 add_lora / remove_lora / set_lora_strength
// 直接操作当前画布上的 XBHHMultiLoraLoader（用户自写的 LoRA 堆）节点
// ============================================================================
function xbhhFindLoraLoaderNodes() {
  const graph = app && app.graph;
  if (!graph || !graph._nodes) return [];
  const types = ["XBHHMultiLoraLoader", "XBHHMultiLoraLoaderPlus"];
  return graph._nodes.filter(
    (n) => types.includes(n.type) || types.includes(n.comfyClass),
  );
}

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

async function xbhhFetchLoraList() {
  try {
    const resp = await fetch("/xbhh/loras");
    return (await resp.json()) || [];
  } catch (e) {
    console.warn("[XBHH] fetch /xbhh/loras failed:", e);
    return [];
  }
}

function xbhhLoraBasename(name) {
  return String(name || "").split(/[\/\\]/).pop();
}

function xbhhLoraStem(name) {
  return xbhhLoraBasename(name).replace(/\.[^.]+$/, "");
}

// 模糊匹配：完整名 / 文件名（含、不含扩展名）精确命中优先，其次包含关系
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

// 在节点已加载的 LoRA 中匹配（精确优先，其次包含）
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
// 优先级：节点标题匹配 → 堆内已加载 LoRA 的分类统计匹配 → 兜底第一个
function xbhhPickLoraNode(nodes, target) {
  if (!nodes.length) return null;
  if (nodes.length === 1) return nodes[0];
  const t = String(target || "").toLowerCase().trim();
  if (!t) return nodes[0];

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
  console.log("[XBHH ckpt] 已切换大模型:", best.value);
  return `🖼️ 已切换大模型「${basename(best.value)}」`;
}

// 暴露给 loader 的自主创作流程使用（autoInspire 也会调用）
window.xbhhHandleLoraToolCalls = xbhhHandleLoraToolCalls;

export class Live2DPet {
  constructor() {
    // 关键：清理旧版 V4 实例 —— 从 V2 切回 V4 时，旧版 live2d_pet.js
    // 模块缓存可能导致新旧两个 V4 实例并存，旧版已加载的实例占用了
    // PIXI 和 WebGL 资源，新版 init 时读不到应有的全局变量（如 PIXI.live2d）。
    if (window.xbhhLive2DPet && window.xbhhLive2DPet !== this) {
      try {
        window.xbhhLive2DPet.destroy?.();
      } catch (e) {
        console.warn("[XBHH] Error destroying stale V4 instance:", e);
      }
      window.xbhhLive2DPet = null;
    }
    this.destroyed = false;
    this._lastExecError = null; // 最近一次工作流执行错误（execution_error 事件缓存）
    this._execErrorHandler = (detail) => {
      // ComfyUI 执行出错：缓存详情（节点类型/异常/堆栈），供 AI 诊断用
      const d = detail || {};
      const tb = Array.isArray(d.traceback) ? d.traceback.join("\n") : "";
      this._lastExecError = {
        time: Date.now(),
        text:
          `节点类型: ${d.node_type || "(未知)"}（ID: ${d.node_id || "?"}）\n` +
          `异常类型: ${d.exception_type || ""}\n` +
          `异常信息: ${d.exception_message || d.exception_message || ""}` +
          (tb ? `\n堆栈（末尾）:\n${tb.slice(-1200)}` : ""),
      };
      console.warn("[XBHH pet] 捕获执行错误:", this._lastExecError.text);
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
                console.warn("[XBHH pet] 捕获提交失败:", window.__xbhhLastError.text);
              }
            }
          }
        } catch (_) { /* 解析失败不影响原有流程 */ }
        return resp;
      };
    }
    this.pixiApp = null;
    this.model = null;
    this.container = null;
    this.canvas = null;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.tipsTimer = null;
    this.idleTimer = null;
    this.config = {
      visible: true,
      x: 50,
      y: 50,
      scale: 0.15,
      sensitivity: 1.0,
      modelPath: "", // 默认为空，由初始化逻辑决定
      enabled: true,
      minimized: false, // 是否处于最小化状态
      canvasWidth: 300,
      canvasHeight: 400,
      lockPosition: true, // 新增：默认开启位移锁定（左键穿透）
    };

    this.isResizing = false;
    this.resizerSize = { w: 0, h: 0 };
    this.resizerStart = { x: 0, y: 0 };

    this.motions = {};
    this.motionKeybinds = {};
    this.activeExpressions = new Set();
    // VTube Studio 模型自带热键（.vtube.json → Hotkeys）
    this.vtubeHotkeys = {};
    this._vtubeHotkeyList = [];
    this._vtsPressed = new Set();
    this._expressionFiles = [];
    this._expressionHotkeyHints = {};
    this._motionHotkeyHints = {};
    // 动作播完后的强制复位（不依赖库内部的 auto-idle）
    this._motionRestoreTimer = null;
    this._motionWatchFn = null;
    this._motionFinishHandler = null;
    this._motionSeq = 0;
    this._faceSuppressed = false;
    // 动作排队：正在播时不打断，播完复位后再播下一个
    this._motionBusy = false;
    this._motionQueue = null;
    this._motionCurrent = null;
    this._motionStarted = false;
    this._motionStartAt = 0;
    this._motionPlayAt = 0;
    // 动作结束后平滑回落默认值的逐帧回调
    this._paramFadeFn = null;
    // 面部捕捉运行时状态
    this._faceTrack = {
      enabled: false,
      starting: false,
      running: false,
      stream: null,
      video: null,
      faceMesh: null,
      applyFn: null,
      timerId: null,
      busy: false,
      params: null,
      smooth: {},
      paramIds: null,
      cdn: "",
    };
    this._faceMeshLibPromise = null;
    this.loadMotionKeybinds();

    this.loadConfig();
    this.init();
  }

  loadConfig() {
    const saved = localStorage.getItem("xbhh_live2d_config");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // 确保新属性有默认值
        if (parsed.lockPosition === undefined) parsed.lockPosition = true;
        this.config = { ...this.config, ...parsed };
      } catch (e) {
        console.error("[XBHH] Failed to load Live2D config", e);
      }
    }
  }

  saveConfig() {
    localStorage.setItem("xbhh_live2d_config", JSON.stringify(this.config));
  }

  async init() {
    // 获取扩展路径
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split("/");
    const extensionsIdx = pathSegments.indexOf("extensions");
    this.extName =
      extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : "xbhh-lora";
    this.extBaseUrl = `/extensions/${this.extName}`;

    // 如果模型路径为空，则设置一个默认值
    if (!this.config.modelPath) {
      this.config.modelPath = `${this.extBaseUrl}/live2d/v4/zyby/真夜白音.model3.json`;
      this.saveConfig();
    }

    // 重启后重置可见性（隐藏标记已被 loader 清除，但配置中 visible: false 可能残留）
    this.config.visible = true;

    // 创建容器
    this.createContainer();

    try {
      // 动态加载库
      await this.loadLibraries();
      if (this.destroyed) return;

      // 初始化 PIXI
      await this.initPIXI();
      if (this.destroyed) return;

      // 加载模型
      await this.loadModel();
      if (this.destroyed) return;
    } catch (e) {
      // 关键：失败时不要销毁容器，否则小人"不显示"且没有任何反馈。
      // 保留容器并显示错误气泡，用户可右键菜单重试/切换模型排查。
      console.error("[XBHH] Live2D V5 init failed:", e);
      try {
        this.showMessage(
          `⚠️ Live2D 加载失败：${(e && e.message) || e}`,
          8000,
          10,
        );
      } catch (e2) {}
      this.bindEvents();
      return;
    }

    // 绑定事件
    this.bindEvents();

    this._onSwitchModel = this.onSwitchModel.bind(this);
    window.addEventListener("xbhh-live2d-switch", this._onSwitchModel);

    // 页面不可见时自动暂停渲染，减少后台 CPU 占用
    this._onVisibilityChange = () => {
      if (!this.pixiApp || !this.pixiApp.ticker) return;
      if (document.hidden) {
        this.pixiApp.ticker.stop();
      } else if (this.config.visible && !this.config.minimized) {
        this.pixiApp.ticker.start();
      }
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  destroy() {
    this.destroyed = true;
    this._clearMotionResetTimer();
    this.stopFaceTracking();
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
    // 兜底清理 V2 残留实例（防止切换后老渲染循环仍在跑，破坏 V4 显示）
    if (window.xbhhModelInstance) {
      try {
        window.xbhhModelInstance.destroy?.();
      } catch (e) {
        console.warn("[XBHH] Error destroying leftover V2 instance:", e);
      }
      window.xbhhModelInstance = null;
    }
    if (this._onSwitchModel) {
      window.removeEventListener("xbhh-live2d-switch", this._onSwitchModel);
    }
    if (this._motionKeyHandler) {
      window.removeEventListener("keydown", this._motionKeyHandler, true);
      this._motionKeyHandler = null;
    }
    if (this._vtubeKeyHandler) {
      window.removeEventListener("keydown", this._vtubeKeyHandler, true);
      this._vtubeKeyHandler = null;
    }
    if (this._vtubeKeyUpHandler) {
      window.removeEventListener("keyup", this._vtubeKeyUpHandler, true);
      window.removeEventListener("blur", this._vtubeKeyUpHandler, true);
      this._vtubeKeyUpHandler = null;
    }
    if (this._onWindowContextMenu) {
      window.removeEventListener("contextmenu", this._onWindowContextMenu);
    }
    if (this.pixiApp) {
      this.pixiApp.destroy(true, {
        children: true,
        texture: true,
        baseTexture: true,
      });
      this.pixiApp = null;
    }
    this._unregisterOverlayHitTest();
    if (this.container) this.container.remove();
  }

  async onSwitchModel(e) {
    const { version, modelPath } = e.detail;
    if (version === "v5") {
      // V5 内部切换模型
      this.config.modelPath = modelPath;
      this.saveConfig();
      await this.loadModel();
      this.showMessage("模型已切换！", 3000, 9); // 确保切换模型后有提示
    } else if (version === "v2") {
      // 切换到 V2
      await this.switchToV2(modelPath);
      this.showMessage("已切换到 V2 模型！", 3000, 9); // 确保切换模型后有提示
    }
  }

  bindGlobalEvents() {
    // 已移至 constructor
  }

  async switchToV2(modelPath) {
    // 1. 清理
    this.destroy();

    // 2. 持久化配置
    localStorage.setItem("xbhh_live2d_version", "v2");

    // 3. 加载 V2
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split("/");
    const extensionsIdx = pathSegments.indexOf("extensions");
    const extName =
      extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : "xbhh-lora";

    const { Live2DV2Pet } = await import(
      `${this.extBaseUrl}/js/pet/live2d_v2_pet.js?v=${Date.now()}`
    );
    window.xbhhLive2DPet = new Live2DV2Pet();
  }

  async loadLibraries() {
    // 动态获取插件名
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split("/");
    const extensionsIdx = pathSegments.indexOf("extensions");
    const extName =
      extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : "xbhh-lora";

    const baseUrl = `${this.extBaseUrl}/lib/live2d`;
    const version = Date.now(); // 强刷缓存

    const scripts = [
      `${baseUrl}/pixi.min.jslib`,
      `${baseUrl}/live2dcubismcore.min.jslib`,
      `${baseUrl}/pixi-live2d-display.min.jslib`,
    ];

    for (const srcBase of scripts) {
      const srcUrl = `${srcBase}?v=${version}`;
      // 防止重复加载
      if (!document.querySelector(`script[src^="${srcBase}"]`)) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = srcUrl;
          script.onload = () => {
            if (srcBase.includes("pixi.min.js")) {
              window.PIXI = PIXI;
            }
            resolve();
          };
          script.onerror = (e) => {
            console.error(`[XBHH] Failed to load script: ${srcBase}`, e);
            reject(new Error(`Failed to load ${srcBase}`));
          };
          document.head.appendChild(script);
        });
      }
    }
  }

  createContainer() {
    this.container = document.createElement("div");
    this.container.id = "xbhh-live2d-container";
    this.container.style.cssText = `
            position: fixed;
            left: ${this.config.x}px;
            top: ${this.config.y}px;
            width: ${this.config.canvasWidth}px;
            height: ${this.config.canvasHeight}px;
            z-index: 9999;
            pointer-events: ${this.config.lockPosition ? "none" : "auto"};
            cursor: move;
            user-select: none;
            display: ${this.config.visible ? "block" : "none"};
            transition: border-radius 0.3s;
        `;

    this.canvas = document.createElement("canvas");
    // 注意：不用 "live2d" 这个 id —— V2 老库 (waifu/xbhh.js) 通过
    // getElementById("live2d") 定位它的 canvas，若与 V4 共用同名 id，
    // V2 残留代码会在 V4 的 canvas 上再取 WebGL context，导致 V4 渲染被破坏。
    this.canvas.id = "xbhh-live2d-canvas-v5";
    this.canvas.style.cssText =
      "position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: block; z-index: 10000;";

    // 创建对话框
    this.tips = document.createElement("div");
    this.tips.id = "xbhh-waifu-tips";
    this.tips.style.cssText = `
        opacity: 0;
        position: absolute;
        top: -100px;
        left: 50%;
        transform: translateX(-50%);
        width: 250px;
        min-height: 70px;
        background: rgba(30, 30, 30, 0.85);
        border: 1px solid #444;
        border-radius: 12px;
        padding: 10px 15px;
        color: #fff;
        font-size: 14px;
        line-height: 1.4;
        text-align: center;
        pointer-events: none;
        transition: opacity 0.3s;
        z-index: 10005;
        box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        backdrop-filter: blur(5px);
    `;

    // 创建球体（最小化后的图标）
    this.sphere = document.createElement("div");
    this.sphere.id = "xbhh-live2d-sphere";
    this.sphere.style.cssText = `
        display: none;
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: linear-gradient(135deg, #fa0 0%, #d48800 100%);
        box-shadow: 0 4px 15px rgba(0,0,0,0.4), inset 0 2px 5px rgba(255,255,255,0.2);
        border: 2px solid #fff;
        cursor: pointer;
        text-align: center;
        line-height: 46px;
        font-size: 24px;
        z-index: 10001;
        pointer-events: auto;
    `;
    this.sphere.innerHTML = "🐱";

    // 创建缩放权柄
    this.resizer = document.createElement("div");
    this.resizer.id = "xbhh-live2d-resizer";
    this.resizer.style.cssText = `
        position: absolute;
        right: 0;
        bottom: 0;
        width: 12px;
        height: 12px;
        cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 50%, #555 50%);
        border-bottom-right-radius: 8px;
        z-index: 10002;
        pointer-events: auto;
    `;

    this.container.appendChild(this.canvas);
    this.container.appendChild(this.tips);
    this.container.appendChild(this.sphere);
    this.container.appendChild(this.resizer);
    document.body.appendChild(this.container);

    // 根据初始状态设置
    if (this.config.minimized) {
      this.applyMinimizedState(true);
    }
  }

  applyMinimizedState(min) {
    if (min) {
      // 关闭对话气泡，避免显示异常
      this.closeChatBox();
      // 暂停渲染循环，释放 CPU
      if (this.pixiApp && this.pixiApp.ticker) {
        this.pixiApp.ticker.stop();
      }
      this.container.style.width = "50px";
      this.container.style.height = "50px";
      this.container.style.borderRadius = "50%";
      this.container.style.pointerEvents = "auto"; // 最小化时必须可点击
      this.canvas.style.display = "none";
      this.sphere.style.display = "block";
      this.resizer.style.display = "none";
      this.tips.style.opacity = "0";
      this.tips.style.display = "none";
    } else {
      // 恢复渲染循环
      if (this.pixiApp && this.pixiApp.ticker) {
        this.pixiApp.ticker.start();
      }
      this.container.style.width = this.config.canvasWidth + "px";
      this.container.style.height = this.config.canvasHeight + "px";
      this.container.style.borderRadius = "8px";
      const pe = this.config.lockPosition ? "none" : "auto";
      this.container.style.pointerEvents = pe;
      this.canvas.style.pointerEvents = pe;
      this.canvas.style.display = "block";
      this.sphere.style.display = "none";
      this.resizer.style.display = "block";
      this.tips.style.display = "block";
    }
  }

  toggleMinimize() {
    this.config.minimized = !this.config.minimized;
    this.applyMinimizedState(this.config.minimized);
    this.saveConfig();
  }

  async initPIXI() {
    if (!window.PIXI) {
      throw new Error(
        "PIXI is not defined. Library loading sequence might be broken.",
      );
    }
    this.pixiApp = new PIXI.Application({
      view: this.canvas,
      autoStart: true,
      width: this.config.canvasWidth,
      height: this.config.canvasHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
    });

    // 帧率限制：从配置读取，默认 30fps
    const targetFPS = this.config.targetFPS || 30;
    this.pixiApp.ticker.maxFPS = targetFPS;
  }

  async loadModel() {
    try {
      // 清理旧模型
      if (this.model) {
        this.pixiApp.stage.removeChild(this.model);
        this.model.destroy({
          children: true,
          texture: true,
          baseTexture: true,
        });
        this.model = null;
      }

      // 换模型时清掉动作排队与看门狗状态
      this._clearMotionResetTimer();
      this._motionBusy = false;
      this._motionStarted = false;
      this._motionCurrent = null;
      this._motionQueue = null;

      const modelUrl = `${this.config.modelPath}?v=${Date.now()}`;

      this.model = await PIXI.live2d.Live2DModel.from(modelUrl);
      this.pixiApp.stage.addChild(this.model);

      // 调整模型到中心
      this.model.anchor.set(0.5, 0.5);
      this.model.scale.set(this.config.scale);
      this.updateModelPosition();

      // 开启交互支持 (即使穿透，追踪仍通过外部监听实现)
      this.model.interactive = true;

      // 初始化提示语系统
      this.initTips();

      // 提取表情列表并预加载表情参数数据
      this.expressions = [];
      this.expressionData = []; // 缓存每个表情的参数定义
      this._expressionFiles = [];
      this.activeExpressions = new Set();
      const settings = this.model.internalModel.settings;
      if (settings && (settings.expressions || settings.Expressions)) {
        const rawExprs = settings.expressions || settings.Expressions;
        this.expressions = rawExprs.map(
          (exp) => exp.name || exp.Name || "Unknown",
        );
        this._expressionFiles = rawExprs.map((exp) =>
          String(exp.file || exp.File || "").toLowerCase(),
        );
        // 异步加载所有表情文件的参数定义
        this._loadExpressionData(rawExprs);
      }

      // 提取动画列表
      this.motions = {};
      if (settings && settings.motions) {
        this.motions = settings.motions;
      }
      // 非 idle 动作改成播放一次，播完由库自动回落 idle
      this._normalizeMotionLoops();

      this.bindMotionKeyListener();

      // 自动识别模型自带的 VTS 热键（同目录 .vtube.json）
      this.vtubeHotkeys = {};
      this._vtubeHotkeyList = [];
      this._expressionHotkeyHints = {};
      this._motionHotkeyHints = {};
      this.loadVTubeHotkeys();

      // 面捕模型自动恢复（上次开过且当前模型支持标准面部参数）
      this._initFaceTrackingState();

      // 绑定点击交互 (Hit Test) - 注意：穿透模式下此监听将失效，这是符合预期的
      // 摸头：随机台词
      this.model.on("pointerdown", (e) => {
        const hitAreas = this.model.hitTest(e.data.global.x, e.data.global.y);
        if (hitAreas.includes("Head") || hitAreas.includes("head")) {
          if (this.tipsData) {
            const texts = this.tipsData.message.hoverBody || ["别摸我头！"];
            this.showMessage(
              texts[Math.floor(Math.random() * texts.length)],
              4000,
              8,
            );
          }
        }
      });

      // 点身体：打开 AI 聊天输入框（pointertap 不会与拖拽冲突）
      // 穿透模式下点击会穿透，请用右键菜单「💬 和我聊天」进入
      this.model.on("pointertap", (e) => {
        const hitAreas = this.model.hitTest(e.data.global.x, e.data.global.y);
        if (hitAreas.includes("Body") || hitAreas.includes("body")) {
          this.openChatBox();
        }
      });
    } catch (e) {
      console.error("[XBHH] Failed to load Live2D model.", e);
      if (e.message && e.message.includes("Network error")) {
        console.warn(
          "[XBHH] Path might be incorrect or server not serving the live2d folder. Check if 'live2d' is inside the root directory.",
        );
      }
      // 模型加载失败：保留容器并显示错误提示，而不是静默销毁（否则"小人消失"无反馈）
      try {
        this.showMessage(
          `⚠️ 模型加载失败：${(e && e.message) || e}`,
          8000,
          10,
        );
      } catch (e2) {}
    }
  }

  updateModelPosition() {
    if (this.model) {
      this.model.x = this.config.canvasWidth / 2;
      this.model.y = this.config.canvasHeight / 2;
    }
  }

  _unregisterOverlayHitTest() {
    if (this._overlayHitTest && Array.isArray(window.__xbhhOverlayHitTests)) {
      const idx = window.__xbhhOverlayHitTests.indexOf(this._overlayHitTest);
      if (idx !== -1) window.__xbhhOverlayHitTests.splice(idx, 1);
    }
    this._overlayHitTest = null;
  }

  bindEvents() {
    // 守护：实例可能在异步 init 期间被销毁（切 V2/V4、重启等），
    // 此时 container 已被置空，直接返回避免空引用崩溃。
    if (this.destroyed || !this.container) {
      console.warn("[XBHH] bindEvents skipped (instance destroyed or container missing).");
      return;
    }
    // 穿透模式下容器是 pointer-events:none，外部扩展无法用 DOM 命中判断，
    // 这里注册坐标命中测试，供 LoRA 堆等自定义右键菜单让位
    if (!window.__xbhhOverlayHitTests) window.__xbhhOverlayHitTests = [];
    this._overlayHitTest = (x, y) => {
      if (this.destroyed || !this.container) return false;
      if (!this.config || !this.config.visible || this.config.minimized) return false;
      const r = this.container.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    window.__xbhhOverlayHitTests.push(this._overlayHitTest);

    // 1. 全局右键监听，用于实现穿透模式下的菜单唤出
    this._onWindowContextMenu = (e) => {
      if (!this.config.visible || this.config.minimized) return;
      
      const rect = this.container.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
          e.preventDefault();
          e.stopPropagation();
          this.showContextMenu(e.clientX, e.clientY);
      }
    };
    window.addEventListener("contextmenu", this._onWindowContextMenu, true);

    // 2. 拖拽逻辑 (仅在 lockPosition 为 false 时响应容器上的事件)
    this.container.addEventListener("mousedown", (e) => {
      if (this.config.lockPosition) return; // 穿透模式下不响应容器拖拽
      if (e.button !== 0) return; // 仅左键拖拽
      
      this.isDragging = true;
      this.dragOffset.x = e.clientX - this.container.offsetLeft;
      this.dragOffset.y = e.clientY - this.container.offsetTop;
      this.container.style.cursor = "grabbing";
      this.container.style.opacity = "0.8"; // 拖拽时轻微透明
      // 拖拽期间临时提升帧率到 60fps，防止低帧率下模型闪烁
      if (this.pixiApp && this.pixiApp.ticker) {
        this.pixiApp.ticker.maxFPS = 60;
      }
      e.stopPropagation();
    });

    this.container.addEventListener("dblclick", (e) => {
      if (this.config.lockPosition) return;
      // 触发双击对话
      if (this.tipsData && this.tipsData.message.click) {
        const texts = this.tipsData.message.click;
        this.showMessage(
          texts[Math.floor(Math.random() * texts.length)],
          3000,
          7,
        );
      }
      e.stopPropagation();
    });

    window.addEventListener("mousemove", (e) => {
      // 1. 缩放逻辑
      if (this.isResizing) {
        const deltaX = e.clientX - this.resizerStart.x;
        const deltaY = e.clientY - this.resizerStart.y;

        let newW = Math.max(100, this.resizerSize.w + deltaX);
        let newH = Math.max(100, this.resizerSize.h + deltaY);

        this.config.canvasWidth = newW;
        this.config.canvasHeight = newH;

        this.container.style.width = newW + "px";
        this.container.style.height = newH + "px";

        // 同步 PIXI 渲染区域
        if (this.pixiApp) {
          this.pixiApp.renderer.resize(newW, newH);
        }
        this.updateModelPosition();
        return; // 缩放时不触发拖拽
      }

      // 2. 拖拽逻辑优先
      if (this.isDragging) {
        let x = e.clientX - this.dragOffset.x;
        let y = e.clientY - this.dragOffset.y;

        // 边界检查
        x = Math.max(
          0,
          Math.min(window.innerWidth - this.config.canvasWidth, x),
        );
        y = Math.max(
          0,
          Math.min(window.innerHeight - this.config.canvasHeight, y),
        );

        this.container.style.left = x + "px";
        this.container.style.top = y + "px";
        this.config.x = x;
        this.config.y = y;

        // 触发拖拽对话 (频率限制)
        const now = Date.now();
        if (!this._lastDragTipTime || now - this._lastDragTipTime > 5000) {
          if (this.tipsData && this.tipsData.message.drag) {
            const texts = this.tipsData.message.drag;
            this.showMessage(
              texts[Math.floor(Math.random() * texts.length)],
              2000,
              6,
            );
            this._lastDragTipTime = now;
          }
        }
      }

      // 2. 头部追踪逻辑（节流 100ms，减少 CPU 占用）
      if (!this._lastTrackTime || Date.now() - this._lastTrackTime > 100) {
        this._lastTrackTime = Date.now();
        try {
          this.updateHeadTracking(e);
        } catch (err) {
          // 仅打印一次以避免淹没控制台
          if (!this._trackingErrorLog) {
            console.error("[XBHH] Head tracking error:", err);
            this._trackingErrorLog = true;
          }
        }
      }
    });

    window.addEventListener("mouseup", () => {
      if (this.isDragging || this.isResizing) {
        this.isDragging = false;
        this.isResizing = false;
        this.container.style.cursor = "move";
        this.container.style.opacity = "1.0";
        // 恢复原始帧率
        if (this.pixiApp && this.pixiApp.ticker) {
          this.pixiApp.ticker.maxFPS = this.config.targetFPS || 30;
        }
        this.saveConfig();
      }
    });

    // 缩放手柄事件
    if (this.resizer) {
      this.resizer.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        this.isResizing = true;
        this.resizerStart.x = e.clientX;
        this.resizerStart.y = e.clientY;
        this.resizerSize.w = this.config.canvasWidth;
        this.resizerSize.h = this.config.canvasHeight;
        // 缩放期间临时提升帧率到 60fps，防止低帧率下模型闪烁
        if (this.pixiApp && this.pixiApp.ticker) {
          this.pixiApp.ticker.maxFPS = 60;
        }
        e.stopPropagation();
        e.preventDefault();
      });
    }

    // 双击球体还原
    if (this.sphere) {
      this.sphere.addEventListener("dblclick", () => this.toggleMinimize());
    }

    // 右键菜单
    this.container.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showContextMenu(e.clientX, e.clientY);
    });
  }

  updateHeadTracking(e) {
    // 面捕开启时由摄像头接管，避免两套参数互相覆盖
    if (this._faceTrack && this._faceTrack.enabled) return;
    if (
      !this.model ||
      !this.model.internalModel ||
      !this.model.internalModel.coreModel
    )
      return;

    // 如果模型进入不可见状态（如移出屏幕触发 PIXI 优化），跳过参数更新
    if (this.model.worldAlpha <= 0 || !this.model.renderable) return;

    const rect = this.container.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // 计算归一化位置 (-1 到 1)，增加安全边界
    let x = (e.clientX - centerX) / (window.innerWidth / 2);
    let y = (e.clientY - centerY) / (window.innerHeight / 2);

    if (isNaN(x) || isNaN(y)) return;

    const pose = {
      ParamAngleX: x * 30 * this.config.sensitivity,
      ParamAngleY: -y * 30 * this.config.sensitivity,
      ParamEyeBallX: x,
      ParamEyeBallY: y,
    };

    const core = this.model.internalModel.coreModel;
    for (const [id, value] of Object.entries(pose)) {
      try {
        if (core.setParameterValueById) {
          core.setParameterValueById(id, value);
        } else if (core.setParamFloat) {
          core.setParamFloat(id, value);
        }
      } catch (err) {}
    }
  }

  // ==================== 面部捕捉（MediaPipe FaceMesh） ====================
  // 自动识别：模型只要带标准面部参数（ParamAngleX + ParamMouthOpenY）就视为支持面捕

  isFaceTrackingSupported() {
    const core = this.model?.internalModel?.coreModel;
    if (
      !core ||
      typeof core.getParameterCount !== "function" ||
      typeof core.getParameterId !== "function"
    )
      return false;
    try {
      const count = core.getParameterCount();
      let hasAngleX = false;
      let hasMouth = false;
      for (let i = 0; i < count; i++) {
        const id = core.getParameterId(i);
        if (id === "ParamAngleX") hasAngleX = true;
        else if (id === "ParamMouthOpenY") hasMouth = true;
        if (hasAngleX && hasMouth) return true;
      }
    } catch (e) {}
    return false;
  }

  _collectFaceParamIds() {
    const core = this.model?.internalModel?.coreModel;
    const ids = new Set();
    if (
      !core ||
      typeof core.getParameterCount !== "function" ||
      typeof core.getParameterId !== "function"
    )
      return ids;
    try {
      const count = core.getParameterCount();
      for (let i = 0; i < count; i++) ids.add(core.getParameterId(i));
    } catch (_) {}
    return ids;
  }

  // 动态加载 FaceMesh（脚本 + wasm + 模型全走 jsdelivr，不访问 Google 存储）
  _ensureFaceMeshLib() {
    if (window.FaceMesh) return Promise.resolve(window.FaceMesh);
    if (this._faceMeshLibPromise) return this._faceMeshLibPromise;
    const base =
      "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619";
    this._faceMeshLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${base}/face_mesh.js`;
      script.crossOrigin = "anonymous";
      script.onload = () => {
        if (window.FaceMesh) {
          this._faceTrack.cdn = base;
          resolve(window.FaceMesh);
        } else {
          this._faceMeshLibPromise = null;
          reject(new Error("面部捕捉组件未正确初始化"));
        }
      };
      script.onerror = () => {
        this._faceMeshLibPromise = null;
        reject(new Error("面部捕捉组件下载失败（jsdelivr 不可达）"));
      };
      document.head.appendChild(script);
    });
    return this._faceMeshLibPromise;
  }

  toggleFaceTracking() {
    if (this._faceTrack.enabled) {
      this.stopFaceTracking({ clearPref: true });
      this.showMessage("📷 面部捕捉已关闭", 2000, 10);
    } else {
      this.startFaceTracking();
    }
  }

  async startFaceTracking(options = {}) {
    const silent = !!options.silent;
    const ft = this._faceTrack;
    if (this.destroyed || !this.model) return;
    if (ft.enabled || ft.starting) return;
    if (!this.isFaceTrackingSupported()) {
      if (!silent) this.showMessage("当前模型缺少标准面部参数，无法面捕", 3000, 10);
      return;
    }
    ft.starting = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("浏览器不支持摄像头访问");
      }
      const FaceMesh = await this._ensureFaceMeshLib();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: "user" },
        audio: false,
      });
      if (this.destroyed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play().catch(() => {});

      const base =
        ft.cdn || "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619";
      const faceMesh = new FaceMesh({
        locateFile: (file) => `${base}/${file}`,
      });
      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      faceMesh.onResults((res) => this._onFaceResults(res));

      ft.stream = stream;
      ft.video = video;
      ft.faceMesh = faceMesh;
      ft.running = true;
      ft.enabled = true;
      ft.params = null;
      ft.smooth = {};
      ft.paramIds = this._collectFaceParamIds();

      // 每帧把面捕结果写回模型（LOW 优先级，保证在库 update 之后生效）
      ft.applyFn = () => this._faceApplyFrame();
      const low =
        PIXI.UPDATE_PRIORITY && PIXI.UPDATE_PRIORITY.LOW !== undefined
          ? PIXI.UPDATE_PRIORITY.LOW
          : undefined;
      if (this.pixiApp && this.pixiApp.ticker) {
        this.pixiApp.ticker.add(ft.applyFn, null, low);
      }

      this._faceCameraLoop();
      localStorage.setItem("xbhh_face_tracking", "1");
      if (!silent) this.showMessage("📷 面部捕捉已开启", 2000, 10);
    } catch (e) {
      console.warn("[XBHH] Face tracking failed:", e);
      this.stopFaceTracking();
      if (!silent) {
        this.showMessage(`面部捕捉启动失败：${(e && e.message) || e}`, 5000, 10);
      }
    } finally {
      ft.starting = false;
    }
  }

  stopFaceTracking(options = {}) {
    const ft = this._faceTrack;
    if (!ft) return;
    ft.running = false;
    ft.enabled = false;
    if (ft.timerId) {
      clearTimeout(ft.timerId);
      ft.timerId = null;
    }
    if (ft.applyFn && this.pixiApp && this.pixiApp.ticker) {
      this.pixiApp.ticker.remove(ft.applyFn);
    }
    ft.applyFn = null;
    if (ft.stream) {
      try {
        ft.stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      ft.stream = null;
    }
    if (ft.video) {
      try {
        ft.video.pause();
      } catch (_) {}
      try {
        ft.video.srcObject = null;
      } catch (_) {}
      ft.video = null;
    }
    if (ft.faceMesh) {
      try {
        ft.faceMesh.close();
      } catch (_) {}
      ft.faceMesh = null;
    }
    ft.params = null;
    ft.smooth = {};
    if (options && options.clearPref) {
      localStorage.removeItem("xbhh_face_tracking");
    }
  }

  // 换模型后：旧流必须重建；上次开过且新模型支持则自动恢复
  _initFaceTrackingState() {
    if (this._faceTrack.enabled || this._faceTrack.starting) {
      this.stopFaceTracking();
    }
    if (localStorage.getItem("xbhh_face_tracking") !== "1") return;
    setTimeout(() => {
      if (this.destroyed || !this.model) return;
      if (this.isFaceTrackingSupported()) this.startFaceTracking({ silent: true });
    }, 1200);
  }

  _faceCameraLoop() {
    const ft = this._faceTrack;
    if (!ft.running || !ft.video || !ft.faceMesh) return;
    const step = async () => {
      if (!ft.running || !ft.video || !ft.faceMesh) return;
      // send() 不能并发，上一帧没算完就跳过
      if (!ft.busy && ft.video.readyState >= 2) {
        ft.busy = true;
        try {
          await ft.faceMesh.send({ image: ft.video });
        } catch (_) {}
        ft.busy = false;
      }
      if (ft.running) ft.timerId = setTimeout(step, 55); // ≈18fps
    };
    step();
  }

  // 关键点 → Live2D 参数
  _onFaceResults(res) {
    const ft = this._faceTrack;
    const lm = res && res.multiFaceLandmarks && res.multiFaceLandmarks[0];
    if (!lm) return;

    const video = ft.video;
    const W = (video && video.videoWidth) || 320;
    const H = (video && video.videoHeight) || 240;
    const pt = (i) => lm[i];
    const dist = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

    // 头部朝向：鼻尖相对眼中点 / 面部尺寸
    const eyeMidX = (pt(33).x + pt(263).x) / 2;
    const eyeMidY = (pt(33).y + pt(263).y) / 2;
    const faceW = Math.max(1, dist(pt(234), pt(454)));
    const faceH = Math.max(1, dist(pt(10), pt(152)));
    const yawRatio = ((pt(1).x - eyeMidX) * W) / faceW;
    const pitchRatio = ((pt(1).y - eyeMidY) * H) / faceH;
    const angleX = clamp(yawRatio * 200, -30, 30);
    const angleY = -clamp((pitchRatio - 0.18) * 200, -30, 30);
    const rollRad = Math.atan2(
      (pt(263).y - pt(33).y) * H,
      (pt(263).x - pt(33).x) * W,
    );
    const angleZ = clamp((rollRad * 180) / Math.PI, -30, 30);

    // 眨眼：EAR（上下眼睑距离 / 眼角距离）
    const ear = (a, b, c, d, e, f) =>
      (dist(b, e) + dist(c, f)) / (2 * Math.max(1e-4, dist(a, d)));
    const earR = ear(pt(33), pt(160), pt(158), pt(133), pt(153), pt(144));
    const earL = ear(pt(362), pt(385), pt(387), pt(263), pt(373), pt(380));
    const openR = clamp((earR - 0.13) / 0.12, 0, 1);
    const openL = clamp((earL - 0.13) / 0.12, 0, 1);

    // 张嘴：上下唇间距 / 脸高
    const mouthGap = dist(pt(13), pt(14)) / faceH;
    const mouthOpen = clamp((mouthGap - 0.01) / 0.14, 0, 1);

    const target = {
      ParamAngleX: angleX,
      ParamAngleY: angleY,
      ParamAngleZ: angleZ,
      ParamBodyAngleX: angleX * 0.5,
      ParamEyeLOpen: openL,
      ParamEyeROpen: openR,
      ParamEyeBallX: clamp(angleX / 30, -1, 1),
      ParamEyeBallY: clamp(-angleY / 30, -1, 1),
      ParamMouthOpenY: mouthOpen,
    };

    // 指数平滑，抑制抖动
    const smooth = ft.smooth;
    for (const k in target) {
      const prev = smooth[k];
      smooth[k] = prev === undefined ? target[k] : prev + (target[k] - prev) * 0.45;
    }
    ft.params = smooth;
  }

  _faceApplyFrame() {
    const ft = this._faceTrack;
    if (!ft.enabled || !ft.params || this._faceSuppressed || !this.model) return;
    const core = this.model.internalModel?.coreModel;
    if (!core) return;
    const ids = ft.paramIds;
    for (const id in ft.params) {
      if (ids && ids.size && !ids.has(id)) continue;
      const value = ft.params[id];
      try {
        if (typeof core.setParameterValueById === "function") {
          core.setParameterValueById(id, value);
        } else if (typeof core.setParamFloat === "function") {
          core.setParamFloat(id, value);
        }
      } catch (_) {}
    }
  }

  showContextMenu(x, y) {
    const menu = document.createElement("div");
    menu.className = "xbhh-live2d-menu";
    menu.style.cssText = `
            position: fixed;
            left: ${x}px;
            top: ${y}px;
            background: rgba(30, 30, 30, 0.9);
            backdrop-filter: blur(5px);
            border: 1px solid #444;
            border-radius: 6px;
            padding: 5px 0;
            z-index: 10001;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            color: white;
            font-family: "Microsoft YaHei", sans-serif;
            font-size: 13px;
            min-width: 120px;
        `;

    // 基础样式注入
    const styleId = "xbhh-live2d-menu-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
            .xbhh-live2d-menu-item {
                padding: 8px 15px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background 0.2s;
                position: relative;
            }
            .xbhh-live2d-menu-item:hover {
                background: #444;
            }
            .xbhh-live2d-submenu {
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
            .xbhh-live2d-menu-item:hover > .xbhh-live2d-submenu,
            .xbhh-live2d-menu-item.active > .xbhh-live2d-submenu {
                display: block;
            }
        `;
      document.head.appendChild(style);
    }

    const createItem = (text, action, hasSubmenu = false) => {
      const div = document.createElement("div");
      div.className = "xbhh-live2d-menu-item";
      div.innerHTML = `<span>${text}</span>${hasSubmenu ? '<span style="font-size:10px;margin-left:10px;">▶</span>' : ""}`;
      if (!hasSubmenu && action) {
        div.onclick = (e) => {
          e.stopPropagation();
          if (action) action();
          if (menu.parentNode) document.body.removeChild(menu);
        };
      }
      return div;
    };

    // 聊天入口置顶 (LLM 对话；API 在侧边栏「看板娘设置」配置)
    menu.appendChild(createItem("💬 和我聊天", () => this.openChatBox()));

    // 0. 模型二级菜单 (动态获取)
    const modelItem = createItem("👤 模型切换", null, true);
    const modelSubmenu = document.createElement("div");
    modelSubmenu.className = "xbhh-live2d-submenu";
    modelItem.appendChild(modelSubmenu);
    menu.appendChild(modelItem);

    // 延迟加载模型列表
    fetch("/xbhh/live2d_models")
      .then((r) => r.json())
      .then((data) => {
        if (data.v2 && data.v2.length > 0) {
          const v2Header = document.createElement("div");
          v2Header.style.cssText =
            "padding: 5px 15px; color: #888; font-size: 10px; border-bottom: 1px solid #333;";
          v2Header.innerText = "SDK 2.0 (V2)";
          modelSubmenu.appendChild(v2Header);
          data.v2.forEach((m) => {
            modelSubmenu.appendChild(
              createItem("· " + m.name, () => {
                window.dispatchEvent(
                  new CustomEvent("xbhh-live2d-switch", {
                    detail: { version: "v2", modelPath: m.path },
                  }),
                );
              }),
            );
          });
        }
        if (data.v5 && data.v5.length > 0) {
          const v5Header = document.createElement("div");
          v5Header.style.cssText =
            "padding: 5px 15px; color: #888; font-size: 10px; border-bottom: 1px solid #333; margin-top: 5px;";
          v5Header.innerText = "SDK 4.0/5.0 (V5)";
          modelSubmenu.appendChild(v5Header);
          data.v5.forEach((m) => {
            modelSubmenu.appendChild(
              createItem("· " + m.name, () => {
                window.dispatchEvent(
                  new CustomEvent("xbhh-live2d-switch", {
                    detail: { version: "v5", modelPath: m.path },
                  }),
                );
              }),
            );
          });
        }
      });

    // 1. 表情二级菜单
    const expItem = createItem("🎭 表情", null, true);
    const expSubmenu = document.createElement("div");
    expSubmenu.className = "xbhh-live2d-submenu";
    expSubmenu.style.maxHeight = "500px";
    expSubmenu.style.overflowY = "auto";
    expSubmenu.style.minWidth = "180px";

    if (this.expressions && this.expressions.length > 0) {
      // 模型自带 VTS 热键开关（默认开启，读取同目录 .vtube.json）
      const vtsCount = (this._vtubeHotkeyList || []).length;
      if (vtsCount > 0) {
        const vtsOn = this.isVTubeHotkeysEnabled();
        const vtsItem = createItem(
          `⌨️ 模型自带热键 ${vtsOn ? "开" : "关"}（${vtsCount}）`,
          () => this.setVTubeHotkeysEnabled(!this.isVTubeHotkeysEnabled()),
        );
        vtsItem.style.color = vtsOn ? "#66bb6a" : "#888";
        expSubmenu.appendChild(vtsItem);
        const vtsSep = document.createElement("div");
        vtsSep.style.cssText = "border-top: 1px solid #444; margin: 4px 0;";
        expSubmenu.appendChild(vtsSep);
      }

      // 全部取消按钮
      const clearAllItem = document.createElement("div");
      clearAllItem.className = "xbhh-live2d-menu-item";
      clearAllItem.innerHTML = `<span style="color:#ef5350;">🗑️ 清除所有表情</span>`;
      clearAllItem.onclick = (e) => {
        e.stopPropagation();
        this.clearAllExpressions();
        if (menu.parentNode) document.body.removeChild(menu);
      };
      if (this.activeExpressions.size > 0) {
        expSubmenu.appendChild(clearAllItem);
        const sep = document.createElement("div");
        sep.style.cssText = "border-top: 1px solid #444; margin: 4px 0;";
        expSubmenu.appendChild(sep);
      }

      this.expressions.forEach((name, index) => {
        const isActive = this.activeExpressions.has(index);
        const label = isActive ? `✓ ${name}` : `   ${name}`;
        const hotkeyLabel = this._expressionHotkeyHints[index];
        const item = document.createElement("div");
        item.className = "xbhh-live2d-menu-item";
        item.innerHTML =
          `<span>${label}</span>` +
          (hotkeyLabel
            ? `<span style="margin-left:12px;color:#888;font-size:11px;">${hotkeyLabel}</span>`
            : "");
        if (isActive) {
          item.style.color = "#66bb6a";
          item.style.background = "rgba(102, 187, 106, 0.1)";
        }
        item.onclick = (e) => {
          e.stopPropagation();
          this.toggleExpression(index, name);
          if (menu.parentNode) document.body.removeChild(menu);
        };
        expSubmenu.appendChild(item);
      });
    } else {
      const placeholder = createItem("（未检测到表情）", null);
      placeholder.style.color = "#888";
      placeholder.style.fontStyle = "italic";
      expSubmenu.appendChild(placeholder);
    }
    expItem.appendChild(expSubmenu);
    menu.appendChild(expItem);

    // 1.5 动画菜单
    const motionItem = createItem("🎬 动画", null, true);
    const motionSubmenu = document.createElement("div");
    motionSubmenu.className = "xbhh-live2d-submenu";
    motionSubmenu.style.maxHeight = "400px";
    motionSubmenu.style.overflowY = "auto";
    motionSubmenu.style.minWidth = "180px";
    const motionGroups = Object.keys(this.motions || {}).filter(g => g.toLowerCase() !== "idle");
    if (motionGroups.length > 0) {
      motionGroups.forEach((group) => {
        const keybind = Object.entries(this.motionKeybinds).find(([k, v]) => v === group);
        const vtsLabel = this._motionHotkeyHints[group];
        const keyLabel = keybind
          ? ` [${keybind[0]}]`
          : vtsLabel
            ? ` [${vtsLabel}]`
            : "";

        const itemDiv = document.createElement("div");
        itemDiv.className = "xbhh-live2d-menu-item";
        itemDiv.style.display = "flex";
        itemDiv.style.justifyContent = "space-between";
        itemDiv.style.alignItems = "center";
        itemDiv.style.gap = "8px";

        const nameSpan = document.createElement("span");
        nameSpan.style.flex = "1";
        nameSpan.style.cursor = "pointer";
        nameSpan.textContent = group + keyLabel;
        nameSpan.onclick = (e) => {
          e.stopPropagation();
          this.playMotion(group);
          if (menu.parentNode) document.body.removeChild(menu);
        };

        const keyBtn = document.createElement("span");
        keyBtn.textContent = "⌨";
        keyBtn.title = "绑定快捷键";
        keyBtn.style.cssText = "cursor:pointer; font-size:14px; opacity:0.6; padding:2px 4px; border-radius:3px; transition: all 0.2s;";
        keyBtn.onmouseenter = () => { keyBtn.style.opacity = "1"; keyBtn.style.background = "rgba(255,255,255,0.1)"; };
        keyBtn.onmouseleave = () => { keyBtn.style.opacity = "0.6"; keyBtn.style.background = "none"; };
        keyBtn.onclick = (e) => {
          e.stopPropagation();
          nameSpan.textContent = group + " ⏳ 请按组合键...";
          nameSpan.style.color = "#4fc3f7";
          const onKey = (ev) => {
            if (["Control", "Shift", "Alt", "Meta"].includes(ev.key)) return;
            ev.preventDefault();
            ev.stopPropagation();
            const combo = this._buildKeyCombo(ev);
            for (const [k, v] of Object.entries(this.motionKeybinds)) {
              if (k === combo || v === group) delete this.motionKeybinds[k];
            }
            this.motionKeybinds[combo] = group;
            this.saveMotionKeybinds();
            nameSpan.textContent = group + ` [${combo}]`;
            nameSpan.style.color = "#66bb6a";
            this.showMessage(`快捷键 [${combo}] 已绑定到动画 "${group}"`, 3000, 10);
            setTimeout(() => { nameSpan.style.color = ""; }, 1500);
            window.removeEventListener("keydown", onKey, true);
          };
          window.addEventListener("keydown", onKey, true);
        };

        itemDiv.appendChild(nameSpan);
        itemDiv.appendChild(keyBtn);
        motionSubmenu.appendChild(itemDiv);
      });

      if (Object.keys(this.motionKeybinds).length > 0) {
        const sep = document.createElement("div");
        sep.style.cssText = "border-top: 1px solid #444; margin: 4px 0;";
        motionSubmenu.appendChild(sep);
        const clearItem = createItem("🗑️ 清除所有快捷键", () => {
          this.motionKeybinds = {};
          this.saveMotionKeybinds();
          this.showMessage("已清除所有动画快捷键", 2000, 10);
        });
        clearItem.style.color = "#ef5350";
        motionSubmenu.appendChild(clearItem);
      }

      // 恢复初始化选项
      const resetSep = document.createElement("div");
      resetSep.style.cssText = "border-top: 1px solid #444; margin: 4px 0;";
      motionSubmenu.appendChild(resetSep);
      const resetItem = createItem("🔄 恢复初始化", () => {
        this.resetMotion();
      });
      resetItem.style.color = "#4fc3f7";
      motionSubmenu.appendChild(resetItem);
    } else {
      const ph = createItem("（未检测到动画）", null);
      ph.style.color = "#888";
      motionSubmenu.appendChild(ph);
    }
    motionItem.appendChild(motionSubmenu);
    menu.appendChild(motionItem);

    // 1.6 面部捕捉（自动识别模型是否带标准面部参数）
    const faceSupported = this.isFaceTrackingSupported();
    const faceOn = !!(this._faceTrack && this._faceTrack.enabled);
    const faceItem = createItem(
      faceSupported
        ? `📷 面部捕捉 ${faceOn ? "开" : "关"}`
        : "📷 面部捕捉（当前模型不支持）",
      faceSupported ? () => this.toggleFaceTracking() : null,
    );
    faceItem.style.color = faceSupported ? (faceOn ? "#66bb6a" : "#888") : "#555";
    menu.appendChild(faceItem);

    // 显示设置聚合容器（倍率/帧率/最小化/隐藏收进来，给顶层菜单瘦身）
    const dispItem = createItem("⚙️ 显示设置", null, true);
    const dispSubmenu = document.createElement("div");
    dispSubmenu.className = "xbhh-live2d-submenu";
    dispSubmenu.style.minWidth = "180px";

    // 2. 倍率调节 (滑块 + 输入框并排联动)
    const scaleItem = createItem("🔍 倍率调节", null, true);
    const scaleSubmenu = document.createElement("div");
    scaleSubmenu.className = "xbhh-live2d-submenu";
    scaleSubmenu.style.cssText += "padding: 12px; min-width: 200px;";

    const scaleLayout = document.createElement("div");
    scaleLayout.style.cssText =
      "display: flex; align-items: center; gap: 10px;";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.01";
    slider.max = "0.5";
    slider.step = "0.01";
    slider.value = this.config.scale;
    slider.style.flex = "1";
    slider.style.cursor = "pointer";

    const numInput = document.createElement("input");
    numInput.type = "number";
    numInput.min = "0.01";
    numInput.max = "1.0";
    numInput.step = "0.01";
    numInput.value = this.config.scale;
    numInput.style.cssText =
      "width: 55px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 3px 5px; font-size: 12px; outline: none;";

    const applyScale = (val) => {
      val = parseFloat(val);
      if (isNaN(val) || val <= 0) return;
      this.config.scale = val;
      if (this.model) this.model.scale.set(val);
      numInput.value = val; // 只更新数值框，不更新滑块自身（避免平滑度问题）
      this.saveConfig();
    };

    slider.oninput = (e) => {
      applyScale(e.target.value);
      e.stopPropagation(); // 阻止事件冒泡到菜单甚至 ComfyUI 全局
    };

    // 关键修复：防止拖动滑块时干扰其他交互，并确保菜单不关闭
    const stopEvents = (e) => {
      e.stopPropagation();
      if (e.type === "mousedown" || e.type === "pointerdown") {
        scaleItem.classList.add("active");

        const endDrag = () => {
          scaleItem.classList.remove("active");
          window.removeEventListener("pointerup", endDrag);
          window.removeEventListener("mouseup", endDrag);
        };
        window.addEventListener("pointerup", endDrag);
        window.addEventListener("mouseup", endDrag);
      }
    };

    slider.onmousedown = stopEvents;
    slider.onmousemove = stopEvents;
    slider.onpointerdown = stopEvents;
    slider.onpointermove = stopEvents;

    numInput.onchange = (e) => applyScale(e.target.value);
    numInput.onmousedown = (e) => e.stopPropagation();
    numInput.onpointerdown = (e) => e.stopPropagation();

    scaleLayout.appendChild(slider);
    scaleLayout.appendChild(numInput);
    scaleSubmenu.appendChild(scaleLayout);
    scaleItem.appendChild(scaleSubmenu);
    dispSubmenu.appendChild(scaleItem);

    // 4. 锁定/解锁模式 (控制穿透)
    const lockText = this.config.lockPosition ? "🔓 开启互动 (关闭穿透)" : "🔒 锁定位置 (开启穿透)";
    const lockBtn = createItem(lockText, () => {
        this.config.lockPosition = !this.config.lockPosition;
        const pe = this.config.lockPosition ? "none" : "auto";
        this.container.style.pointerEvents = pe;
        this.canvas.style.pointerEvents = pe;
        this.saveConfig();
        this.showMessage(this.config.lockPosition ? "已开启穿透模式" : "已开启互动模式", 2000, 10);
    });
    menu.appendChild(lockBtn);

    // 5. 帧率调节
    const fpsItem = createItem("🎬 渲染帧率", null, true);
    const fpsSubmenu = document.createElement("div");
    fpsSubmenu.className = "xbhh-live2d-submenu";
    const currentFPS = this.config.targetFPS || 30;
    const fpsOptions = [10, 15, 24, 30, 60];
    fpsOptions.forEach(fps => {
      const label = fps === currentFPS ? `✓ ${fps} FPS` : `  ${fps} FPS`;
      fpsSubmenu.appendChild(createItem(label, () => {
        this.config.targetFPS = fps;
        if (this.pixiApp && this.pixiApp.ticker) {
          this.pixiApp.ticker.maxFPS = fps;
        }
        this.saveConfig();
        this.showMessage(`帧率已设为 ${fps} FPS`, 2000, 10);
      }));
    });
    fpsItem.appendChild(fpsSubmenu);
    dispSubmenu.appendChild(fpsItem);

    // 4. 最小化/还原（收进显示设置，减少顶层菜单占用）
    dispSubmenu.appendChild(
      createItem(
        this.config.minimized ? "📺 还原模型" : "🎈 最小化",
        () => this.toggleMinimize(),
      ),
    );

    // 5. 隐藏小人
    dispSubmenu.appendChild(createItem("🙈 隐藏小人", () => this.hide()));

    dispItem.appendChild(dispSubmenu);
    menu.appendChild(dispItem);

    document.body.appendChild(menu);

    // 优化：点击面板外部或菜单外部立即关闭
    const closeMenu = (e) => {
      // 检查点击目标是否在菜单及其子项内
      if (!menu.contains(e.target)) {
        if (menu.parentNode) document.body.removeChild(menu);
        document.removeEventListener("pointerdown", closeMenu, true);
      }
    };

    // 使用 pointerdown 并配合 capture 确保在其他交互前拦截
    document.addEventListener("pointerdown", closeMenu, true);
  }

  async showFoodStore() {
    // 移除旧商店
    const oldStore = document.getElementById("xbhh-food-store");
    if (oldStore) oldStore.remove();

    // 获取金币和食物
    const [walletResp, foodsResp] = await Promise.all([
        fetch("/xbhh/wallet/stats"),
        fetch("/xbhh/pet/foods")
    ]);
    const wallet = await walletResp.json();
    const foods = await foodsResp.json();

    const store = document.createElement("div");
    store.id = "xbhh-food-store";
    store.style.cssText = `
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 550px;
        max-height: 80vh;
        background: rgba(20, 20, 20, 0.95);
        backdrop-filter: blur(25px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 24px;
        padding: 30px;
        z-index: 20000;
        color: white;
        box-shadow: 0 30px 60px rgba(0,0,0,0.9);
        display: flex;
        flex-direction: column;
        gap: 20px;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    `;

    const header = document.createElement("div");
    header.style.cssText = "display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid rgba(255,255,255,0.05); padding-bottom: 20px; flex-shrink: 0;";
    header.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 36px; height: 36px; background: linear-gradient(135deg, #fa0, #d48800); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px;">🥪</div>
            <div style="font-size: 22px; font-weight: 600; letter-spacing: 0.5px;">宠物商店</div>
        </div>
        <div style="background: rgba(255, 215, 0, 0.15); color: #ffd700; padding: 6px 18px; border-radius: 12px; font-size: 16px; font-weight: 600; border: 1px solid rgba(255,215,0,0.3); box-shadow: 0 0 15px rgba(255,215,0,0.1);">
            <span style="font-size: 14px; opacity: 0.8; margin-right: 4px;">余额</span>💰 ${wallet.balance}
        </div>
    `;
    store.appendChild(header);

    const grid = document.createElement("div");
    grid.style.cssText = `
        display: flex; 
        flex-direction: column; 
        gap: 30px; 
        overflow-y: auto; 
        overflow-x: hidden;
        padding-right: 12px; 
        margin: 5px 0;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.2) transparent;
    `;
    
    // 自定义滚动条样式
    const styleId = "xbhh-store-scroll-style";
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            #xbhh-food-store ::-webkit-scrollbar { width: 6px; }
            #xbhh-food-store ::-webkit-scrollbar-track { background: transparent; }
            #xbhh-food-store ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 10px; }
            #xbhh-food-store ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
        `;
        document.head.appendChild(style);
    }
    
    // 按等级分组
    const tiers = ["传奇", "史诗", "稀有", "普通"];
    const grouped = tiers.reduce((acc, tier) => {
        acc[tier] = foods.filter(f => (f.tier || "普通") === tier);
        return acc;
    }, {});

    tiers.forEach(tier => {
        const tierFoods = grouped[tier];
        if (!tierFoods || tierFoods.length === 0) return;

        const section = document.createElement("div");
        section.innerHTML = `<div style="font-size: 14px; color: #aaa; margin-bottom: 15px; padding-left: 5px; display: flex; align-items: center; gap: 10px; font-weight: 500;">
            <span style="width: 4px; height: 16px; background: ${this.getTierColor(tier)}; border-radius: 2px; box-shadow: 0 0 8px ${this.getTierColor(tier)}88;"></span>
            ${tier}等级
        </div>`;
        
        const tierGrid = document.createElement("div");
        tierGrid.style.cssText = "display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px;";

        tierFoods.forEach(food => {
            const item = document.createElement("div");
            item.style.cssText = `
                background: rgba(255, 255, 255, 0.04);
                border-radius: 16px;
                padding: 15px 10px;
                text-align: center;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                border: 1px solid rgba(255,255,255,0.06);
                position: relative;
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                height: 165px;
                box-sizing: border-box;
            `;
            
            const tierColor = this.getTierColor(tier);

            item.innerHTML = `
                <div style="width: 100%; aspect-ratio: 1/1; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.15); border-radius: 12px; overflow: hidden; box-sizing: border-box; flex-shrink: 0;">
                    <img src="${food.url}" style="width: 100%; height: 100%; object-fit: cover; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.3)); transition: transform 0.5s;">
                </div>
                <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 4px; min-height: 40px;">
                    <div style="font-size: 13px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 4px; font-weight: 500;">${food.name}</div>
                    <div style="font-size: 15px; color: ${tierColor}; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 3px;">
                        ${food.price} <span style="font-size: 10px; opacity: 0.8;">CUI</span>
                    </div>
                </div>
            `;

            item.onmouseenter = () => {
                item.style.background = "rgba(255, 255, 255, 0.08)";
                item.style.borderColor = tierColor;
                item.style.transform = "translateY(-6px) scale(1.02)";
                item.style.boxShadow = `0 10px 20px ${tierColor}15`;
            };
            item.onmouseleave = () => {
                item.style.background = "rgba(255, 255, 255, 0.04)";
                item.style.borderColor = "rgba(255,255,255,0.06)";
                item.style.transform = "translateY(0) scale(1)";
                item.style.boxShadow = "none";
            };

            item.onclick = async () => {
                await this.feedPet(food);
            };

            tierGrid.appendChild(item);
        });

        section.appendChild(tierGrid);
        grid.appendChild(section);
    });

    store.appendChild(grid);

    const closeBtn = document.createElement("div");
    closeBtn.innerText = "完成离开";
    closeBtn.style.cssText = "background: #444; color: white; text-align: center; padding: 12px; border-radius: 12px; cursor: pointer; font-size: 14px; transition: background 0.2s;";
    closeBtn.onmouseenter = () => closeBtn.style.background = "#555";
    closeBtn.onmouseleave = () => closeBtn.style.background = "#444";
    closeBtn.onclick = () => store.remove();
    store.appendChild(closeBtn);

    document.body.appendChild(store);

    // 点击外部关闭
    setTimeout(() => {
        const handleClickOutside = (e) => {
            if (!store.contains(e.target)) {
                store.remove();
                document.removeEventListener("mousedown", handleClickOutside);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
    }, 10);
  }

  getTierColor(tier) {
    switch(tier) {
        case "传奇": return "#ff4d4f";
        case "史诗": return "#722ed1";
        case "稀有": return "#1890ff";
        default: return "#888";
    }
  }

  async feedPet(food) {
    try {
        const resp = await fetch("/xbhh/pet/feed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                food_id: food.id,
                food_name: food.name,
                price: food.price
            })
        });

        const result = await resp.json();
        if (result.success) {
            // 喂食成功： Live2D 反馈
            this.showMessage(`😋 好吃！谢谢主人投喂的 ${food.name} ~`, 4000, 10);
            
            // 触发模型表情 (如果存在)
            if (this.model) {
                // 尝试播放一个开心的表情（通常 index 0 或 名字含 Happy 的）
                try {
                    const settings = this.model.internalModel.settings;
                    const exprs = settings.expressions || settings.Expressions || [];
                    let happyIdx = exprs.findIndex(e => (e.name || e.Name || "").toLowerCase().includes("happy"));
                    if (happyIdx === -1) happyIdx = 0; // 默认第一个
                    this.setExpression(happyIdx);
                    
                    // 3秒后恢复默认或第一个表情
                    setTimeout(() => this.setExpression(0), 3000);
                } catch (err) {}
            }
            
            // 更新商店余额显示
            const balanceDiv = document.querySelector("#xbhh-food-store div[style*='color: #ffd700']");
            if (balanceDiv) balanceDiv.innerHTML = `💰 ${result.balance} CUI`;
            
        } else {
            this.showMessage(`⚠️ ${result.message}`, 3000, 10);
        }
    } catch (e) {
        console.error("[XBHH] Feed Error:", e);
        this.showMessage("⚠️ 喂食失败，服务器无响应", 3000, 10);
    }
  }

  // 异步加载所有表情文件的参数数据
  async _loadExpressionData(rawExprs) {
    const modelPath = this.config.modelPath;
    const basePath = modelPath.substring(0, modelPath.lastIndexOf("/") + 1);
    
    this.expressionData = new Array(rawExprs.length).fill(null);
    
    const promises = rawExprs.map(async (exp, index) => {
      const file = exp.file || exp.File;
      if (!file) return;
      try {
        const url = basePath + file;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          this.expressionData[index] = data.Parameters || [];
        }
      } catch (e) {
        console.warn(`[XBHH] Failed to load expression file for ${this.expressions[index]}:`, e);
      }
    });
    
    await Promise.all(promises);
  }

  toggleExpression(index, name) {
    if (!this.model) return;
    try {
      if (this.activeExpressions.has(index)) {
        this.activeExpressions.delete(index);
        this.showMessage(`已取消表情: ${name}`, 2000, 8);
      } else {
        this.activeExpressions.add(index);
        this.showMessage(`已应用表情: ${name}`, 2000, 8);
      }
      this._applyMergedExpressions();
    } catch (e) {
      console.warn("[XBHH] Expression error", e);
    }
  }

  clearAllExpressions() {
    if (!this.model) return;
    try {
      this.activeExpressions.clear();
      this._stopExpressionUpdater();
      // 使用与动画重置相同的完整参数恢复逻辑
      this._resetAllParametersToDefault();
      this.showMessage("已清除所有表情", 2000, 8);
    } catch (e) {
      console.warn("[XBHH] Clear expressions error", e);
    }
  }

  // 彻底恢复所有模型参数到默认值（与动画重置使用相同逻辑）
  _resetAllParametersToDefault() {
    if (!this.model) return;
    const im = this.model.internalModel;
    const core = im.coreModel;
    if (!core) return;

    // 禁止库的表情管理器干扰
    const expMgr = im.motionManager?.expressionManager;
    if (expMgr) {
      if (typeof expMgr.resetExpression === "function") expMgr.resetExpression();
      if ("currentExpression" in expMgr) expMgr.currentExpression = null;
      if ("_currentExpression" in expMgr) expMgr._currentExpression = null;
    }

    // 重置所有参数到默认值
    if (core && typeof core.getParameterCount === "function") {
      const count = core.getParameterCount();
      for (let i = 0; i < count; i++) {
        const defVal = core.getParameterDefaultValue(i);
        core.setParameterValueByIndex(i, defVal);
      }
    } else if (core && core._model) {
      const model = core._model;
      const defaults = model._parameterDefaultValues || model.parameters?.defaultValues;
      const values = model._parameterValues || model.parameters?.values;
      if (defaults && values) {
        for (let i = 0; i < defaults.length; i++) {
          values[i] = defaults[i];
        }
      }
    } else if (core && typeof core.setParamFloat === "function") {
      core.saveParam();
      core.loadParam();
    }

    // 播放 Idle 动画作为兜底，确保模型恢复自然状态（动作播放中不打断）
    const idleGroup = Object.keys(this.motions || {}).find(g => g.toLowerCase() === "idle");
    if (idleGroup) {
      setTimeout(() => {
        if (this.model && !this._motionBusy) {
          this.model.motion(idleGroup, 0, 3);
        }
      }, 100);
    }
  }

  // 核心：合并所有激活表情的参数并直接写入模型
  _applyMergedExpressions() {
    if (!this.model) return;
    const core = this.model.internalModel.coreModel;
    if (!core) return;

    // 如果没有激活的表情，执行完整的参数恢复
    if (this.activeExpressions.size === 0) {
      this._stopExpressionUpdater();
      this._resetAllParametersToDefault();
      return;
    }

    // 彻底禁用库的表情管理器（防止它每帧覆盖我们的参数）
    this._disableLibraryExpressionManager();

    // 构建完整参数表（包含所有表情参数的默认值 + 激活表情的叠加值）
    const fullParamMap = new Map();

    // 步骤1：收集所有表情涉及的参数，先全部设为默认值
    if (this.expressionData && typeof core.getParameterCount === "function") {
      const defaultValues = new Map();
      const count = core.getParameterCount();
      for (let i = 0; i < count; i++) {
        if (typeof core.getParameterId === "function") {
          defaultValues.set(core.getParameterId(i), core.getParameterDefaultValue(i));
        }
      }
      for (const params of this.expressionData) {
        if (!params) continue;
        for (const p of params) {
          if (defaultValues.has(p.Id)) {
            fullParamMap.set(p.Id, defaultValues.get(p.Id));
          }
        }
      }
    }

    // 步骤2：计算激活表情的合并参数，覆盖默认值
    const activeParams = new Map();
    for (const idx of this.activeExpressions) {
      const params = this.expressionData?.[idx];
      if (!params) continue;
      for (const p of params) {
        const blend = (p.Blend || "Add").toLowerCase();
        if (blend === "add") {
          const prev = activeParams.get(p.Id) || 0;
          activeParams.set(p.Id, prev + p.Value);
        } else if (blend === "multiply") {
          const prev = activeParams.get(p.Id) || 1;
          activeParams.set(p.Id, prev * p.Value);
        } else {
          activeParams.set(p.Id, p.Value);
        }
      }
    }
    for (const [id, value] of activeParams) {
      fullParamMap.set(id, value);
    }

    // 先立即应用一次
    this._writeParamsToCore(core, fullParamMap);

    // 缓存参数表，供 ticker 持续使用
    this._cachedExpressionParams = fullParamMap;

    // 启动持续应用（使用 PIXI ticker 确保在库的 update 之后执行）
    this._startExpressionUpdater();
  }

  // 彻底禁用库自带的表情管理器
  _disableLibraryExpressionManager() {
    const expMgr = this.model?.internalModel?.motionManager?.expressionManager;
    if (!expMgr) return;

    // 清空当前表情
    if (typeof expMgr.resetExpression === "function") expMgr.resetExpression();
    if ("currentExpression" in expMgr) expMgr.currentExpression = null;
    if ("_currentExpression" in expMgr) expMgr._currentExpression = null;

    // 关键：monkey-patch 库的 update 方法，阻止它每帧重新应用表情
    if (!expMgr._xbhhOriginalUpdate) {
      expMgr._xbhhOriginalUpdate = expMgr.update;
      expMgr.update = function(model, now) {
        // 当我们有自定义表情激活时，跳过库的表情更新
        return false;
      };
    }
  }

  // 恢复库的表情管理器
  _enableLibraryExpressionManager() {
    const expMgr = this.model?.internalModel?.motionManager?.expressionManager;
    if (!expMgr || !expMgr._xbhhOriginalUpdate) return;
    expMgr.update = expMgr._xbhhOriginalUpdate;
    delete expMgr._xbhhOriginalUpdate;
  }

  // 将参数表写入模型核心
  _writeParamsToCore(core, paramMap) {
    if (typeof core.setParameterValueById === "function") {
      for (const [id, value] of paramMap) {
        try { core.setParameterValueById(id, value); } catch (_) {}
      }
    } else if (typeof core.setParamFloat === "function") {
      for (const [id, value] of paramMap) {
        try { core.setParamFloat(id, value); } catch (_) {}
      }
    }
  }

  // 停止表情持续更新器
  _stopExpressionUpdater() {
    if (this._expressionTickerFn && this.pixiApp) {
      this.pixiApp.ticker.remove(this._expressionTickerFn);
      this._expressionTickerFn = null;
    }
    // 兼容旧的 RAF 方式
    if (this._expressionUpdateId) {
      cancelAnimationFrame(this._expressionUpdateId);
      this._expressionUpdateId = null;
    }
    this._cachedExpressionParams = null;
    // 恢复库的表情管理器
    this._enableLibraryExpressionManager();
  }

  // 持续应用表情参数（使用 PIXI ticker，在模型 update 之后执行）
  _startExpressionUpdater() {
    // 先清理旧的 ticker 回调（但不清空缓存和不恢复库表情管理器）
    if (this._expressionTickerFn && this.pixiApp) {
      this.pixiApp.ticker.remove(this._expressionTickerFn);
      this._expressionTickerFn = null;
    }
    if (this._expressionUpdateId) {
      cancelAnimationFrame(this._expressionUpdateId);
      this._expressionUpdateId = null;
    }

    if (this.activeExpressions.size === 0) return;
    if (!this.pixiApp || !this.model) return;

    const core = this.model.internalModel.coreModel;
    if (!core) return;

    if (!this._cachedExpressionParams) return;
    const paramMap = this._cachedExpressionParams;

    // 禁用库的表情管理器
    this._disableLibraryExpressionManager();

    // 使用 PIXI ticker 注册回调，这确保在同一帧中库更新后再覆盖参数
    this._expressionTickerFn = () => {
      if (this.activeExpressions.size === 0 || !this.model) {
        this._stopExpressionUpdater();
        return;
      }
      this._writeParamsToCore(core, paramMap);
    };
    this.pixiApp.ticker.add(this._expressionTickerFn, null, PIXI.UPDATE_PRIORITY.LOW);
  }

  setExpression(index) {
    if (!this.model) return;
    try {
      this.model.expression(index);
    } catch (e) {
      console.warn("[XBHH] Expression error", e);
    }
  }

  // 模型自带的 motion3.json 大多写了 Meta.Loop=true（VTube Studio 习惯），
  // 库会认为动画永远播不完，因此不会回落 idle，表现为"停在最后一帧不恢复"。
  // 这里包装 loadMotion：非 idle 组的动作加载后统一关闭循环，idle 组保持循环。
  _normalizeMotionLoops() {
    const mgr = this.model && this.model.internalModel && this.model.internalModel.motionManager;
    if (!mgr || typeof mgr.loadMotion !== "function" || mgr.__xbhhLoopPatched) return;
    mgr.__xbhhLoopPatched = true;
    const idleGroup = String((mgr.groups && mgr.groups.idle) || "Idle").toLowerCase();
    const isIdle = (group) => String(group).toLowerCase() === idleGroup;

    const original = mgr.loadMotion.bind(mgr);
    mgr.loadMotion = function (group, index) {
      const promise = original(group, index);
      if (!promise || typeof promise.then !== "function") return promise;
      return promise.then((motion) => {
        if (!isIdle(group) && motion && typeof motion.setIsLoop === "function") {
          motion.setIsLoop(false);
        }
        return motion;
      });
    };

    // 后台预加载非 idle 动作，避免首次播放时补丁还没打上
    const definitions = mgr.definitions || this.motions || {};
    Object.keys(definitions).forEach((group) => {
      if (isIdle(group)) return;
      const list = definitions[group] || [];
      for (let i = 0; i < list.length; i++) {
        Promise.resolve().then(() => mgr.loadMotion(group, i)).catch(() => {});
      }
    });
  }

  // 播放动画：正在播时不打断，排队等当前动作自然播完、复位后再播
  playMotion(group, index = 0, priority = 3) {
    if (!this.model) return;
    const isIdle = String(group).toLowerCase() === "idle";
    if (isIdle) {
      // idle 是兜底动作，直接播并清空排队
      this._motionQueue = null;
      this._motionBusy = false;
      this._motionStarted = false;
      this._motionCurrent = null;
      this._clearMotionResetTimer();
      this._faceSuppressed = false;
      this._playMotionNow(group, index, priority);
      return;
    }
    if (this._motionBusy) {
      const cur = this._motionCurrent;
      if (cur && cur.group === group && cur.index === index) return;
      // 只保留最后一个待播动作，避免排队堆积
      this._motionQueue = { group, index, priority };
      return;
    }
    this._startMotionCycle(group, index, priority);
  }

  _playMotionNow(group, index, priority) {
    try {
      const r = this.model.motion(group, index, priority);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (e) {
      console.warn("[XBHH] playMotion error:", e);
    }
  }

  _startMotionCycle(group, index, priority) {
    if (!this.model) return;
    // 叠加表情每帧都在写参数，会和动作互相覆盖 → 先清掉
    this._clearExpressionOverlay();
    this._clearMotionResetTimer();
    const seq = this._motionSeq;
    this._motionBusy = true;
    this._motionCurrent = { group, index };
    this._motionStarted = false;
    this._motionStartAt = performance.now();
    this._motionPlayAt = 0;
    this._faceSuppressed = true;
    this._playMotionNow(group, index, priority);
    this._armMotionWatcher(seq, group, index);
  }

  // 结束检测：motionFinish 事件（按 group 过滤）+ 看门狗兜底
  _armMotionWatcher(seq, group, index) {
    const mgr = this.model?.internalModel?.motionManager;
    const key = String(group).toLowerCase();

    if (mgr && typeof mgr.on === "function") {
      const handler = () => {
        if (seq !== this._motionSeq) return;
        // 事件在 state.complete() 之前触发，此时 currentGroup 仍是刚结束的组
        const done = mgr.state && mgr.state.currentGroup;
        if (!done || String(done).toLowerCase() !== key) return;
        setTimeout(() => {
          if (seq === this._motionSeq) this._onMotionEnd(seq);
        }, 0);
      };
      this._motionFinishHandler = handler;
      try {
        mgr.on("motionFinish", handler);
      } catch (_) {
        this._motionFinishHandler = null;
      }
    }

    if (!this.pixiApp || !this.pixiApp.ticker) return;

    const dur = this._motionDurationOf(group, index);
    const limit = (dur > 0 ? dur * 1000 : 15000) + 1500;
    const low =
      PIXI.UPDATE_PRIORITY && PIXI.UPDATE_PRIORITY.UTILITY !== undefined
        ? PIXI.UPDATE_PRIORITY.UTILITY
        : undefined;

    this._motionWatchFn = () => {
      if (this.destroyed || seq !== this._motionSeq || !this.model) {
        this._clearMotionResetTimer();
        return;
      }
      const m = this.model.internalModel?.motionManager;
      if (!m) return;
      const playingGroup = m.state && m.state.currentGroup;
      const isMine = !!playingGroup && String(playingGroup).toLowerCase() === key;

      if (!this._motionStarted) {
        // 等动作真正开始播（异步加载期间不能判结束，否则会把刚点的动作掐掉）
        if (isMine && m.playing) {
          this._motionStarted = true;
          this._motionPlayAt = performance.now();
          return;
        }
        if (performance.now() - this._motionStartAt > 3000) this._onMotionEnd(seq);
        return;
      }

      if (!isMine) { this._onMotionEnd(seq); return; }
      if (performance.now() - this._motionPlayAt > limit) this._onMotionEnd(seq);
    };
    this.pixiApp.ticker.add(this._motionWatchFn, null, low);
  }

  _onMotionEnd(seq) {
    if (seq !== this._motionSeq) return;
    if (this.destroyed || !this.model) return;
    this._clearMotionResetTimer();
    this._motionStarted = false;
    this._motionCurrent = null;
    const next = this._motionQueue;
    this._motionQueue = null;
    // 只清表情层，不硬停动作：动作已自然播完，库会自己回落 idle
    this.activeExpressions.clear();
    this._stopExpressionUpdater();
    this._resetLibraryExpression();
    // 参数逐帧平滑衰减回默认值，避免"播完瞬间跳回去"的画面割裂
    this._faceSuppressed = true;
    this._fadeParamsToDefault(700, () => {
      if (this.destroyed || !this.model) return;
      this._motionBusy = false;
      this._faceSuppressed = false;
      const nx = next || this._motionQueue;
      this._motionQueue = null;
      if (nx) this._startMotionCycle(nx.group, nx.index, nx.priority);
      else this._resumeIdle();
    });
  }

  // 清掉库自带表情管理器的当前表情（不写参数）
  _resetLibraryExpression() {
    const expMgr = this.model?.internalModel?.motionManager?.expressionManager;
    if (!expMgr) return;
    try {
      if (typeof expMgr.resetExpression === "function") expMgr.resetExpression();
      else if (typeof expMgr.setExpression === "function") expMgr.setExpression(null);
    } catch (_) {}
    if ("currentExpression" in expMgr) expMgr.currentExpression = null;
    if ("_currentExpression" in expMgr) expMgr._currentExpression = null;
  }

  // 逐帧把参数平滑衰减到默认值（指数衰减，不会与库自身的 idle 写入打架）
  _fadeParamsToDefault(duration = 700, done) {
    const core = this.model?.internalModel?.coreModel;
    const ticker = this.pixiApp && this.pixiApp.ticker;
    if (!core || !ticker || typeof core.getParameterCount !== "function") {
      this._resetCoreParams();
      if (done) done();
      return;
    }
    this._stopParamFade();
    const count = core.getParameterCount();
    const defs = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      try {
        defs[i] = core.getParameterDefaultValue(i);
      } catch (_) {
        defs[i] = 0;
      }
    }
    const tau = Math.max(60, duration / 4);
    const deadline = performance.now() + duration;
    let last = performance.now();
    const low =
      PIXI.UPDATE_PRIORITY && PIXI.UPDATE_PRIORITY.UTILITY !== undefined
        ? PIXI.UPDATE_PRIORITY.UTILITY
        : undefined;

    const fn = () => {
      if (this.destroyed || !this.model) {
        if (this._paramFadeFn === fn) this._stopParamFade();
        return;
      }
      const now = performance.now();
      const dt = Math.min(120, Math.max(0, now - last));
      last = now;
      const a = 1 - Math.exp(-dt / tau);
      const c = this.model.internalModel.coreModel;
      try {
        for (let i = 0; i < count; i++) {
          const v = c.getParameterValueByIndex(i);
          c.setParameterValueByIndex(i, v + (defs[i] - v) * a);
        }
      } catch (_) {}
      if (now >= deadline) {
        if (this._paramFadeFn === fn) this._stopParamFade();
        if (done) done();
      }
    };
    this._paramFadeFn = fn;
    ticker.add(fn, null, low);
  }

  _stopParamFade() {
    if (this._paramFadeFn) {
      try {
        if (this.pixiApp && this.pixiApp.ticker) {
          this.pixiApp.ticker.remove(this._paramFadeFn);
        }
      } catch (_) {}
      this._paramFadeFn = null;
    }
  }

  // 强制停掉所有动作并清表情（参数回落交给 _fadeParamsToDefault 平滑处理）
  _restoreToDefault() {
    if (!this.model) return;
    this.activeExpressions.clear();
    this._stopExpressionUpdater();
    const im = this.model.internalModel;
    const mgr = im && im.motionManager;
    try {
      if (mgr) {
        if (typeof mgr.stopAllMotions === "function") mgr.stopAllMotions();
        if (mgr._currentAudio) {
          try { mgr._currentAudio.pause(); } catch (_) {}
          mgr._currentAudio = undefined;
        }
        ["_motionQueueEntries", "motionQueueEntries", "_motions"].forEach((prop) => {
          if (Array.isArray(mgr[prop])) mgr[prop].length = 0;
        });
        if ("currentMotion" in mgr) mgr.currentMotion = null;
      }
      this._resetLibraryExpression();
    } catch (e) {
      console.warn("[XBHH] restore default failed:", e);
    }
  }

  _resumeIdle() {
    const defs =
      this.motions && Object.keys(this.motions).length
        ? this.motions
        : this.model?.internalModel?.motionManager?.definitions || {};
    const idleGroup = Object.keys(defs).find(
      (g) => String(g).toLowerCase() === "idle"
    );
    if (!idleGroup) return;
    setTimeout(() => {
      if (this.destroyed || !this.model || this._motionBusy) return;
      const m = this.model.internalModel?.motionManager;
      const cur = m && m.state && m.state.currentGroup;
      // 库已经自己回了 idle 就不再重播，避免重复起跳
      if (cur && String(cur).toLowerCase() === "idle" && m.playing) return;
      this._playMotionNow(idleGroup, 0, 3);
    }, 100);
  }

  // 清掉外部叠加的表情层（只清表情，不重置参数，避免打断即将播放的动作）
  _clearExpressionOverlay() {
    if (!this.model) return;
    this.activeExpressions.clear();
    this._stopExpressionUpdater();
    const expMgr = this.model.internalModel?.motionManager?.expressionManager;
    if (!expMgr) return;
    try {
      if (typeof expMgr.resetExpression === "function") expMgr.resetExpression();
    } catch (_) {}
    if ("currentExpression" in expMgr) expMgr.currentExpression = null;
    if ("_currentExpression" in expMgr) expMgr._currentExpression = null;
  }

  // 把所有参数写回默认值（Cubism4 优先，SDK2 兜底）
  _resetCoreParams() {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return false;
    try {
      if (typeof core.getParameterCount === "function") {
        const count = core.getParameterCount();
        for (let i = 0; i < count; i++) {
          core.setParameterValueByIndex(i, core.getParameterDefaultValue(i));
        }
        return true;
      }
      if (core._model) {
        const model = core._model;
        const defaults =
          model._parameterDefaultValues || model.parameters?.defaultValues;
        const values = model._parameterValues || model.parameters?.values;
        if (defaults && values) {
          for (let i = 0; i < defaults.length; i++) values[i] = defaults[i];
          return true;
        }
      }
    } catch (e) {
      console.warn("[XBHH] reset core params failed:", e);
    }
    return false;
  }

  _clearMotionResetTimer() {
    this._motionSeq++;
    this._stopParamFade();
    if (this._motionRestoreTimer) {
      clearTimeout(this._motionRestoreTimer);
      this._motionRestoreTimer = null;
    }
    if (this._motionWatchFn && this.pixiApp && this.pixiApp.ticker) {
      this.pixiApp.ticker.remove(this._motionWatchFn);
      this._motionWatchFn = null;
    }
    if (this._motionFinishHandler) {
      const mgr = this.model?.internalModel?.motionManager;
      try {
        if (mgr && typeof mgr.off === "function") {
          mgr.off("motionFinish", this._motionFinishHandler);
        } else if (mgr && typeof mgr.removeListener === "function") {
          mgr.removeListener("motionFinish", this._motionFinishHandler);
        }
      } catch (_) {}
      this._motionFinishHandler = null;
    }
    this._faceSuppressed = false;
  }

  // 读取动作真实时长（秒），拿不到返回 0
  _motionDurationOf(group, index) {
    const mgr = this.model?.internalModel?.motionManager;
    const cached = mgr && mgr.motionGroups && mgr.motionGroups[group];
    const motion = cached && cached[index];
    if (!motion) return 0;
    let dur = 0;
    try {
      if (typeof motion.getLoopDuration === "function") {
        dur = motion.getLoopDuration();
      }
      if (!dur && motion._motionData && motion._motionData.duration) {
        dur = motion._motionData.duration;
      }
    } catch (_) {}
    return typeof dur === "number" && isFinite(dur) && dur > 0 ? dur : 0;
  }

  resetMotion(options = {}) {
    if (!this.model) return;
    const silent = !!(options && options.silent);
    // 先取消待执行的看门狗，避免自我递归
    this._clearMotionResetTimer();
    this._motionStarted = false;
    this._motionCurrent = null;
    this._motionQueue = null;
    this._motionBusy = true;
    this._faceSuppressed = true;
    this._restoreToDefault();
    // 平滑回落，结束后再恢复 idle（期间点动画会排队）
    this._fadeParamsToDefault(320, () => {
      if (this.destroyed || !this.model) return;
      this._motionBusy = false;
      this._faceSuppressed = false;
      const nx = this._motionQueue;
      this._motionQueue = null;
      if (nx) this._startMotionCycle(nx.group, nx.index, nx.priority);
      else this._resumeIdle();
    });
    if (!silent) this.showMessage("已恢复初始状态", 2000, 10);
  }

  loadMotionKeybinds() {
    try {
      const saved = localStorage.getItem("xbhh_motion_keybinds");
      if (saved) this.motionKeybinds = JSON.parse(saved);
    } catch (e) { this.motionKeybinds = {}; }
  }

  saveMotionKeybinds() {
    localStorage.setItem("xbhh_motion_keybinds", JSON.stringify(this.motionKeybinds));
  }

  _buildKeyCombo(e) {
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    return parts.join("+");
  }

  bindMotionKeyListener() {
    if (this._motionKeyHandler) {
      window.removeEventListener("keydown", this._motionKeyHandler, true);
    }
    this._motionKeyHandler = (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const combo = this._buildKeyCombo(e);
      const group = this.motionKeybinds[combo];
      if (group && this.motions[group]) {
        e.preventDefault();
        this.playMotion(group);
        this.showMessage(`🎬 播放动画: ${group}`, 2000, 8);
      }
    };
    window.addEventListener("keydown", this._motionKeyHandler, true);
  }

  // ================= VTube Studio 热键自动识别 =================
  // 数据源：模型同目录的 <模型名>.vtube.json 里的 Hotkeys（VTS 导出时自带的按键表）
  isVTubeHotkeysEnabled() {
    try {
      return localStorage.getItem("xbhh_vtube_hotkeys") !== "0";
    } catch (e) {
      return true;
    }
  }

  setVTubeHotkeysEnabled(enabled) {
    try {
      localStorage.setItem("xbhh_vtube_hotkeys", enabled ? "1" : "0");
    } catch (e) {}
    this.showMessage(
      enabled ? "⌨️ 模型热键已开启" : "⌨️ 模型热键已关闭",
      2000,
      8,
    );
  }

  getVTubeConfigUrl() {
    const modelPath = this.config.modelPath || "";
    if (!modelPath.endsWith(".model3.json")) return null;
    return modelPath.slice(0, -".model3.json".length) + ".vtube.json";
  }

  async loadVTubeHotkeys() {
    const url = this.getVTubeConfigUrl();
    if (!url) return;
    try {
      const resp = await fetch(`${url}?v=${Date.now()}`);
      if (!resp.ok) return;
      const data = await resp.json();
      const hotkeys = Array.isArray(data.Hotkeys) ? data.Hotkeys : [];
      for (const hk of hotkeys) {
        const combo = this._vtubeTriggersToCombo(hk.Triggers);
        if (!combo) continue; // 鼠标触发等无法映射成键盘的组合直接跳过
        const target = this._resolveVTubeTarget(
          hk.Action,
          hk.File,
          hk.Name,
        );
        if (!target) continue;
        const label = this._formatHotkeyLabel(combo);
        const entry = {
          codes: combo.codes,
          mods: combo.mods,
          action: hk.Action,
          name: hk.Name || "",
          target,
          label,
        };
        this.vtubeHotkeys[label] = entry;
        this._vtubeHotkeyList.push(entry);
        if (target.type === "expression") {
          this._expressionHotkeyHints[target.index] = label;
        } else if (target.type === "motion") {
          this._motionHotkeyHints[target.group] = label;
        }
      }
      // 按键多的组合优先匹配（例如「小键盘.+3」优先于单键）
      this._vtubeHotkeyList.sort(
        (a, b) => b.codes.length - a.codes.length || b.mods.length - a.mods.length,
      );
      const count = this._vtubeHotkeyList.length;
      if (count > 0) {
        console.log(
          `[XBHH] 已从 .vtube.json 识别 ${count} 个热键`,
          this._vtubeHotkeyList,
        );
      }
    } catch (e) {
      console.warn("[XBHH] Failed to load .vtube.json hotkeys:", e);
    }
    this.bindVTubeKeyListener();
  }

  _resolveVTubeTarget(action, file, name) {
    const targetFile = String(file || "").toLowerCase();
    if (action === "RemoveAllExpressions") return { type: "clear" };
    if (action === "ToggleExpression") {
      if (!this.expressions || !this.expressions.length) return null;
      let idx = -1;
      if (targetFile) {
        idx = this._expressionFiles.findIndex(
          (f) => f && (f === targetFile || f.endsWith("/" + targetFile)),
        );
      }
      if (idx === -1 && name) idx = this.expressions.indexOf(name);
      return idx === -1 ? null : { type: "expression", index: idx };
    }
    if (action === "TriggerAnimation") {
      if (!targetFile) return null;
      const groups = Object.keys(this.motions || {});
      for (const group of groups) {
        const hit = (this.motions[group] || []).some((m) => {
          const mf = String((m && (m.file || m.File)) || "").toLowerCase();
          return mf && (mf === targetFile || mf.endsWith("/" + targetFile));
        });
        if (hit) return { type: "motion", group };
      }
      const stem = targetFile
        .replace(/^.*\//, "")
        .replace(/\.motion3\.json$/, "");
      const byName = groups.find((g) => g.toLowerCase() === stem);
      return byName ? { type: "motion", group: byName } : null;
    }
    return null;
  }

  _vtubeTriggersToCombo(triggers) {
    if (!triggers) return null;
    const mods = [];
    const codes = [];
    for (const raw of [
      triggers.Trigger1,
      triggers.Trigger2,
      triggers.Trigger3,
    ]) {
      if (!raw) continue;
      const token = String(raw).trim();
      if (!token) continue;
      const low = token.toLowerCase();
      if (/^(left|right)?(control|ctrl)$/.test(low)) {
        if (!mods.includes("Ctrl")) mods.push("Ctrl");
        continue;
      }
      if (/^(left|right)?(alt|option)$/.test(low)) {
        if (!mods.includes("Alt")) mods.push("Alt");
        continue;
      }
      if (/^(left|right)?shift$/.test(low)) {
        if (!mods.includes("Shift")) mods.push("Shift");
        continue;
      }
      if (/^(left|right)?(meta|win|super)$/.test(low)) {
        if (!mods.includes("Meta")) mods.push("Meta");
        continue;
      }
      const code = this._vtubeTokenToCode(token);
      if (!code) return null; // 含鼠标键等无法用键盘复现的组合
      if (!codes.includes(code)) codes.push(code);
    }
    if (!codes.length) return null;
    return { codes, mods };
  }

  _vtubeTokenToCode(token) {
    const named = {
      Decimal: "NumpadDecimal",
      Multiply: "NumpadMultiply",
      Divide: "NumpadDivide",
      Add: "NumpadAdd",
      Subtract: "NumpadSubtract",
      Space: "Space",
      Tab: "Tab",
      Enter: "Enter",
      Backspace: "Backspace",
      Delete: "Delete",
      Insert: "Insert",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
    };
    if (named[token]) return named[token];
    let m = /^Numpad(\d)$/.exec(token);
    if (m) return `Numpad${m[1]}`;
    m = /^N(\d)$/.exec(token); // VTS 用 N1~N0 表示上排数字键
    if (m) return `Digit${m[1]}`;
    m = /^F(\d{1,2})$/i.exec(token);
    if (m) return `F${m[1]}`;
    if (/^[A-Za-z]$/.test(token)) return `Key${token.toUpperCase()}`;
    return null;
  }

  _formatHotkeyLabel(combo) {
    const parts = [...combo.mods];
    for (const code of combo.codes) {
      if (/^Key[A-Z]$/.test(code)) parts.push(code.slice(3));
      else if (/^Digit\d$/.test(code)) parts.push(code.slice(5));
      else if (code === "NumpadDecimal") parts.push("小键盘.");
      else if (code === "NumpadMultiply") parts.push("小键盘*");
      else if (code === "NumpadDivide") parts.push("小键盘/");
      else if (code === "NumpadAdd") parts.push("小键盘+");
      else if (code === "NumpadSubtract") parts.push("小键盘-");
      else if (/^Numpad\d$/.test(code)) parts.push("小键盘" + code.slice(6));
      else parts.push(code);
    }
    return parts.join("+");
  }

  _findVTubeHotkey(e) {
    const list = this._vtubeHotkeyList;
    if (!list || !list.length) return null;
    const code = e.code || "";
    const pressed = this._vtsPressed;
    for (const hk of list) {
      if (!hk.codes.includes(code)) continue;
      let ok = true;
      for (const c of hk.codes) {
        if (!pressed.has(c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!!e.ctrlKey !== hk.mods.includes("Ctrl")) continue;
      if (!!e.altKey !== hk.mods.includes("Alt")) continue;
      if (!!e.shiftKey !== hk.mods.includes("Shift")) continue;
      if (!!e.metaKey !== hk.mods.includes("Meta")) continue;
      return hk;
    }
    return null;
  }

  bindVTubeKeyListener() {
    if (this._vtubeKeyHandler) {
      window.removeEventListener("keydown", this._vtubeKeyHandler, true);
    }
    if (this._vtubeKeyUpHandler) {
      window.removeEventListener("keyup", this._vtubeKeyUpHandler, true);
      window.removeEventListener("blur", this._vtubeKeyUpHandler, true);
    }
    this._vtsPressed = new Set();
    this._vtubeKeyHandler = (e) => {
      if (e.code) this._vtsPressed.add(e.code);
      if (this.destroyed || !this.model) return;
      if (!this.isVTubeHotkeysEnabled()) return;
      if (!this._vtubeHotkeyList || !this._vtubeHotkeyList.length) return;
      const t = e.target;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      if (e.repeat) return;
      const hk = this._findVTubeHotkey(e);
      if (!hk) return;
      e.preventDefault();
      e.stopPropagation();
      const target = hk.target || {};
      if (target.type === "clear") {
        this.clearAllExpressions();
      } else if (target.type === "expression") {
        this.toggleExpression(target.index, this.expressions[target.index]);
      } else if (target.type === "motion") {
        this.playMotion(target.group);
        this.showMessage(`🎬 播放动画: ${target.group}`, 2000, 8);
      }
    };
    this._vtubeKeyUpHandler = (e) => {
      if (e && e.type === "keyup" && e.code) {
        this._vtsPressed.delete(e.code);
      } else {
        this._vtsPressed.clear();
      }
    };
    window.addEventListener("keydown", this._vtubeKeyHandler, true);
    window.addEventListener("keyup", this._vtubeKeyUpHandler, true);
    window.addEventListener("blur", this._vtubeKeyUpHandler, true);
  }

  hide() {
    this.destroyed = true;
    this.config.visible = false;
    this.saveConfig();

    // 持久化隐藏状态（loader 重启时会清除此标记）
    localStorage.setItem("xbhh_live2d_hidden", "true");

    // 停止 PIXI 渲染循环
    if (this.pixiApp && this.pixiApp.ticker) {
      this.pixiApp.ticker.stop();
    }

    // 销毁 Live2D 模型
    if (this.model && this.pixiApp) {
      try {
        this.pixiApp.stage.removeChild(this.model);
        this.model.destroy({ children: true, texture: true, baseTexture: true });
      } catch (e) {
        console.warn("[XBHH] Error destroying model:", e);
      }
      this.model = null;
    }

    // 销毁 PIXI 应用
    if (this.pixiApp) {
      try {
        this.pixiApp.destroy(true, { children: true, texture: true, baseTexture: true });
      } catch (e) {
        console.warn("[XBHH] Error destroying PIXI app:", e);
      }
      this.pixiApp = null;
    }

    // 清理定时器
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.tipsTimer) { clearTimeout(this.tipsTimer); this.tipsTimer = null; }

    // 清理事件监听器
    if (this._motionKeyHandler) {
      window.removeEventListener("keydown", this._motionKeyHandler, true);
      this._motionKeyHandler = null;
    }
    if (this._vtubeKeyHandler) {
      window.removeEventListener("keydown", this._vtubeKeyHandler, true);
      this._vtubeKeyHandler = null;
    }
    if (this._vtubeKeyUpHandler) {
      window.removeEventListener("keyup", this._vtubeKeyUpHandler, true);
      window.removeEventListener("blur", this._vtubeKeyUpHandler, true);
      this._vtubeKeyUpHandler = null;
    }
    if (this._onSwitchModel) {
      window.removeEventListener("xbhh-live2d-switch", this._onSwitchModel);
    }
    if (this._onWindowContextMenu) {
      window.removeEventListener("contextmenu", this._onWindowContextMenu);
    }
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
    }

    // 注销命中测试
    this._unregisterOverlayHitTest();

    // 移除 DOM
    if (this.container) { this.container.remove(); this.container = null; }
    this.canvas = null;
  }



  show() {
    this.config.visible = true;
    this.container.style.display = "block";
    this.saveConfig();
  }

  // 对话系统实现
  async initTips() {
    try {
      // 动态获取插件名
      const url_tips = new URL(import.meta.url);
      const pathSegments_tips = url_tips.pathname.split("/");
      const extensionsIdx_tips = pathSegments_tips.indexOf("extensions");
      const extName_tips =
        extensionsIdx_tips !== -1
          ? pathSegments_tips[extensionsIdx_tips + 1]
          : "xbhh-lora";

      const resp = await fetch(
        `/extensions/${extName_tips}/js/pet/waifu-tips.json?v=` + Date.now(),
      );
      this.tipsData = await resp.json();
      this.showWelcomeMessage();
      this.startIdleTimer();
      this.bindGlobalInteractions();
    } catch (e) {
      console.error("[XBHH] Failed to load waifu-tips.json", e);
    }
  }

  showWelcomeMessage() {
    if (!this.tipsData) return;
    const hour = new Date().getHours();
    let text = "你好！";
    for (const item of this.tipsData.time) {
      const range = item.hour.split("-");
      if (hour >= parseInt(range[0]) && hour <= parseInt(range[1])) {
        text = Array.isArray(item.text) ? item.text[0] : item.text;
        break;
      }
    }
    this.showMessage(text, 5000, 10);
  }

  showMessage(text, timeout = 3000, priority = 0) {
    if (!text || this.currentPriority > priority || this.config.minimized)
      return;
    if (this.tipsTimer) clearTimeout(this.tipsTimer);

    this.currentPriority = priority;
    this.tips.innerHTML = text;
    this.tips.style.opacity = "1";
    this.tips.style.pointerEvents = "auto"; // 允许悬停暂停关闭

    this._tipsStartTime = Date.now();
    this._tipsTimeout = timeout;

    const startTimer = (remaining) => {
      if (this.tipsTimer) clearTimeout(this.tipsTimer);
      this.tipsTimer = setTimeout(() => {
        this.tips.style.opacity = "0";
        this.tips.style.pointerEvents = "none";
        this.currentPriority = -1;
      }, remaining);
    };

    startTimer(timeout);

    // 绑定悬停行为（只绑定一次）
    if (!this._tipsHoverBound) {
      this._tipsHoverBound = true;
      this.tips._xbhhMouseOn = false;
      this.tips.addEventListener("mouseenter", () => {
        this.tips._xbhhMouseOn = true;
        if (this.tipsTimer) {
          clearTimeout(this.tipsTimer);
          this.tipsTimer = null;
        }
      });
      this.tips.addEventListener("mouseleave", () => {
        this.tips._xbhhMouseOn = false;
        if (this.tips.style.opacity !== "1") return;
        const minDisplay = 3000; // 最小显示时间 3 秒
        const elapsed = Date.now() - this._tipsStartTime;
        const remaining = Math.max(this._tipsTimeout - elapsed, minDisplay - elapsed, 1000);
        startTimer(remaining);
      });
    }
  }

  startIdleTimer() {
    const resetTimer = () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.tipsData && this.tipsData.message.default) {
          const texts = this.tipsData.message.default;
          const text = texts[Math.floor(Math.random() * texts.length)];
          this.showMessage(text, 5000, 5);
        }
        resetTimer();
      }, 30000);
    };
    resetTimer();
  }

  bindGlobalInteractions() {
    window.addEventListener("copy", () => {
      if (this.tipsData) this.showMessage(this.tipsData.message.copy, 5000, 9);
    });
    window.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.tipsData) {
        this.showMessage(this.tipsData.message.visibilitychange, 5000, 9);
      }
    });
  }

  // ==========================================================================
  // 工作流运行支持 (测试按钮 / 为后续 AI 自动绘画铺垫)
  //   - 提交走 ComfyUI 原生 POST /prompt，避免依赖内部 queue_prompt 版本差异
  //   - 进度通过 ComfyUI 前端 api 的 websocket 事件回传到 live2d 气泡
  //   - 后续 AI 自动绘画只需把 promptData 替换成 AI 构造的工作流即可复用
  //   runWorkflow / runCurrentCanvasWorkflow / runSavedWorkflow
  // ==========================================================================

  /** 幂等地订阅 ComfyUI 执行进度事件，跟踪本次提交的 prompt_id */
  _ensureWorkflowProgressTracker() {
    if (this._wfTrackerAttached) return;
    this._wfTrackerAttached = true;
    this._wfTrackingPromptId = null;
    this._wfArmed = false; // 提交后未拿到 prompt_id 时，捕获第一个开始的任务
    this._wfExecutedCount = 0;
    this._wfCachedCount = 0;
    this._wfDone = true;

    // api 不可用或无事件机制时，静默降级，不影响工作流提交
    if (!api || typeof api.addEventListener !== "function") return;

    // 兼容不同 ComfyUI 版本事件 detail 形状：{data:{...}} 或 {...}
    const detailOf = (e) => {
      const raw = e.detail || {};
      return raw.data || raw;
    };
    // 仅响应当前追踪的 prompt_id（未设置时响应全部，便于被动观察）
    const match = (e) => {
      const d = detailOf(e);
      return (
        !this._wfTrackingPromptId ||
        d.prompt_id === this._wfTrackingPromptId
      );
    };

    // 整个 prompt 成功结束时调用一次（新版 execution_success / 旧版 executing node=null 都走这里）
    const finishOk = () => {
      if (this._wfDone) return;
      this._wfDone = true;
      this._wfTrackingPromptId = null;
      if (this._wfExecutedCount === 0) {
        // 关键诊断：一瞬间完成且没有任何节点真正执行
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
      // armed：刚由本小人提交（queuePrompt 不返回 prompt_id），捕获第一个开始的任务
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
        // 旧版 ComfyUI：node 为 null 表示整个 prompt 执行完毕
        finishOk();
      } else {
        this._wfExecutedCount++;
        this.showMessage(
          `🎨 正在绘画… 节点 ${this._wfExecutedCount}`,
          2500,
          10,
        );
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
      const msg =
        d.exception_message || d.exception_type || d.error || "未知错误";
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
   * @param {object} promptData API 格式 prompt
   * @param {string} label 提示语里显示的工作流名称
   */
  async runWorkflow(promptData, label = "工作流") {
    this._ensureWorkflowProgressTracker();
    if (
      !promptData ||
      (typeof promptData === "object" &&
        Object.keys(promptData).length === 0)
    ) {
      this.showMessage("⚠️ 工作流为空，无法运行", 3000, 10);
      return;
    }
    // 复用浏览器当前 websocket 的 client_id，确保进度事件能回传到本页
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
        console.error("[XBHH] runWorkflow submit failed:", result);
        return;
      }
      this._wfTrackingPromptId = result.prompt_id;
      this.showMessage(`🚀 已提交「${label}」，排队中…`, 3000, 10);
    } catch (e) {
      this.showMessage(`❌ 网络错误：${e.message || e}`, 5000, 10);
      console.error("[XBHH] runWorkflow error:", e);
    }
  }

  /** 运行当前 ComfyUI 画布上的工作流 (主测试入口，与原生运行按钮等价) */
  // 记录错误详情（弹窗/提交失败/执行错误统一入口），供 AI 诊断用
  // 同时写入 window.__xbhhLastError，供全局 fetch 拦截共享
  _xbhhRecordError(text) {
    const t = String(text || "").trim();
    if (!t) return;
    this._lastExecError = { time: Date.now(), text: t.slice(0, 1500) };
    window.__xbhhLastError = this._lastExecError;
    console.warn("[XBHH pet] 记录错误详情:", t.slice(0, 200));
  }

  async runCurrentCanvasWorkflow() {
    this._ensureWorkflowProgressTracker();
    // arm：提交后捕获第一个开始执行的任务（queuePrompt 不返回 prompt_id）
    this._wfTrackingPromptId = null;
    this._wfArmed = true;
    try {
      if (typeof app.queuePrompt === "function") {
        // 与 ComfyUI 原生「运行」按钮完全一致：
        // 官方序列化 + 官方错误弹窗 + seed 控件 afterQueued（randomize 等）全部生效
        await app.queuePrompt(0);
        this.showMessage("🚀 已提交当前画布工作流", 2500, 10);
      } else if (typeof app.graphToPrompt === "function") {
        // 兜底：手动序列化后走原生 POST /prompt
        const parsed = await app.graphToPrompt();
        const promptData = parsed.output || parsed;
        await this.runWorkflow(promptData, "当前画布工作流");
      } else {
        this.showMessage("⚠️ 当前环境不支持运行画布工作流", 3000, 10);
      }
    } catch (e) {
      this._xbhhRecordError(`【工作流提交失败】\n${(e && e.message) || e}`);
      this.showMessage(
        `⚠️ 提交失败：${(e && e.message) || e}`,
        5000,
        10,
      );
      console.error("[XBHH] runCurrentCanvasWorkflow error:", e);
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
      const resp = await fetch(
        `/xbhh/pet/workflows/${encodeURIComponent(name)}`,
      );
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
      this.showMessage(
        `❌ 读取工作流出错：${(e && e.message) || e}`,
        5000,
        10,
      );
      console.error("[XBHH] runSavedWorkflow error:", e);
    }
  }

  // ==========================================================================
  // AI 对话 (LLM 聊天，OpenAI 兼容格式，默认 DeepSeek)
  //   配置：ComfyUI 设置 → XBHH 看板娘 AI 接口地址 / API Key / 模型名 / 人设
  //   入口：点小人身体（互动模式）或右键菜单「💬 和我聊天」
  // ==========================================================================

  openChatBox() {
    if (!this.chatBox) this._createChatBox();
    // 最小化状态下先还原，否则看不到输入框
    if (this.config.minimized) this.toggleMinimize();
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

  _createChatBox() {
    window.__xbhhEnsureChatStyles &&
      window.__xbhhEnsureChatStyles();

    const QUICK = [
      { label: "🎨 画一张", text: "帮我画一张好看的图" },
      { label: "🔀 换画风", text: "随机添加几个画风lora，权重总和1.2以内，然后启动" },
      { label: "🐞 报错诊断", text: "刚才的报错怎么解决？" },
      { label: "🎲 随机人物", text: "随机来一个人物lora，然后启动" },
    ];

    this.chatBox = document.createElement("div");
    this.chatBox.id = "xbhh-live2d-chatbox";
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

    // 阻止事件冒泡：防止触发容器拖拽 / ComfyUI 全局快捷键
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
        if (images.length) console.log(`[XBHH] 自动附带最近 ${images.length} 张图片`);
      } catch (e) {
        console.warn("[XBHH] 自动附带图片失败:", e);
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
          console.log("[XBHH ckpt] 切换大模型结果:", ckptMsg);
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
          lines.push(prompt ? `${clean}\n🎨 主题：${prompt}` : clean);
          this.showMessage(lines.join("\n"), 8000, 10);
          // 运行当前画布工作流（提示词注入将由专属 AI 输入节点实现，待开发）
          setTimeout(() => this.runCurrentCanvasWorkflow(), 1200);
        } else if (runCall) {
          const clean = data.reply
            ? this._applyEmotion(data.reply)
            : "好嘞，这就开画～";
          const lines = [];
          if (actionMsg) lines.push(actionMsg);
          lines.push(clean);
          this.showMessage(lines.join("\n"), 8000, 10);
          console.log("[XBHH AI] run_workflow 工具调用，运行当前画布工作流");
          setTimeout(() => this.runCurrentCanvasWorkflow(), 1200);
        } else if (actionMsg) {
          const clean = data.reply
            ? this._applyEmotion(data.reply)
            : "好嘞，配置已更新～";
          this.showMessage(`${actionMsg}\n${clean}`, 8000, 10);
        } else if (data.reply) {
          // 剥离结尾情绪标签并联动表情
          const clean = this._applyEmotion(data.reply);
          this.showMessage(clean, 12000, 10);
        } else {
          this.showMessage("（模型没有返回内容）", 4000, 10);
        }
      } else {
        // 失败时回滚这条用户消息，保持上下文干净
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
      console.error("[XBHH] sendChat error:", e);
    } finally {
      this._chatBusy = false;
      if (this.chatSendBtn) this.chatSendBtn.disabled = false;
    }
  }

  /**
   * 识别回复结尾的情绪标签（如「[开心]」「（害羞）」）：
   * 返回剥掉标签后的正文；识别成功则触发表情联动
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

  /** 情绪 → Live2D 表情联动：按关键词模糊匹配模型自带表情名，6 秒后还原 */
  _triggerEmotion(tag) {
    if (!this.model || !this.expressions || !this.expressions.length) return;
    const KEYWORDS = {
      开心: ["happy", "smile", "joy", "laugh"],
      得意: ["happy", "smile", "proud"],
      卖萌: ["cute", "happy", "smile"],
      难过: ["sad", "cry", "tear"],
      生气: ["angry", "mad", "pout"],
      惊讶: ["surprise", "shock", "amaze"],
      害羞: ["shy", "blush", "embarrass"],
      疑惑: ["doubt", "question", "think"],
      激动: ["excite", "happy"],
    };
    const keys = KEYWORDS[tag] || [];
    if (!keys.length) return;

    const lower = this.expressions.map((n) => (n || "").toLowerCase());
    let idx = -1;
    for (const k of keys) {
      idx = lower.findIndex((n) => n.includes(k));
      if (idx !== -1) break;
    }
    if (idx === -1) {
      console.log(`[XBHH] 情绪 ${tag} 未匹配到表情，跳过联动`);
      return;
    }
    try {
      this.setExpression(idx);
      if (this._emotionTimer) clearTimeout(this._emotionTimer);
      this._emotionTimer = setTimeout(() => {
        try {
          this.setExpression(0);
        } catch (e) {}
      }, 6000);
      console.log(
        `[XBHH] 情绪联动: ${tag} → 表情「${this.expressions[idx]}」`,
      );
    } catch (e) {
      console.warn("[XBHH] 情绪联动失败:", e);
    }
  }
}

// 移除自执行逻辑，由 loader 统一调度实例化
// (function() { ... })();
