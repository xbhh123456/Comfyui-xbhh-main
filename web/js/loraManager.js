import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// ============================================================================
// LoRA 堆桥接 — 供「LoRA 数据管理器」标签页把 LoRA 加入画布上的 LoRA 堆节点
// ----------------------------------------------------------------------------
// 管理器是用 window.open 打开的独立标签页，拿不到本窗口的 app / 画布，
// 因此这里在 ComfyUI 窗口挂一个全局对象 window.__xbhhLoraStack，
// 由管理器通过 window.opener 调用（同源，可直接跨窗口取用）。
// 注意：ComfyUI 的多工作流标签页只有「当前激活」的那个挂在 app.graph 上，
// 所以列表里会带上当前工作流名，避免用户加错工作流。
// ============================================================================

// 可作为「LoRA 堆」的节点类型（测试堆已下线注册，仍列上以便日后恢复）
const LORA_STACK_NODE_TYPES = [
    "XBHHMultiLoraLoaderPlus",
    "XBHHMultiLoraLoader",
    "XBHHLoraTestLoader",
];

// 当前激活工作流名。ComfyUI 各版本 API 不一，逐层特性探测，取不到返回 ""。
function xbhhActiveWorkflowName() {
    try {
        const wm = app.workflowManager;
        if (wm) {
            const wf = wm.activeWorkflow;
            if (wf && typeof wf === "object" && wf.name) return String(wf.name);
            if (typeof wf === "string" && wf) return wf;
            const list = wm.workflows;
            if (Array.isArray(list)) {
                const act = list.find((w) => w && (w.active || w.isActive));
                if (act && act.name) return String(act.name);
            }
        }
    } catch (e) { /* 版本差异导致取不到，忽略 */ }
    return "";
}

// 已打开的工作流标签页列表（同样按特性探测，取不到返回空数组）
function xbhhListWorkflows() {
    try {
        const wm = app.workflowManager;
        const list = wm && wm.workflows;
        if (Array.isArray(list)) {
            return list.map((w) => ({
                name: String((w && (w.name || w.title)) || "未命名"),
                active: !!(w && (w.active || w.isActive || w === wm.activeWorkflow)),
            }));
        }
    } catch (e) { /* 忽略 */ }
    return [];
}

// 当前画布上所有 LoRA 堆节点的概要信息
function xbhhListLoraStacks() {
    const graph = app && app.graph;
    const nodes = (graph && (graph._nodes || graph.nodes)) || [];
    const stacks = [];
    for (const n of nodes) {
        if (!n || !LORA_STACK_NODE_TYPES.includes(n.type)) continue;
        const loras = (n.loraWidgets || [])
            .map((w) => (Array.isArray(w.value && w.value.lora) ? w.value.lora[0] : w.value && w.value.lora))
            .filter((x) => x && x !== "None");
        stacks.push({
            id: n.id,
            title: n.title || n.type,
            type: n.type,
            loras,
        });
    }
    return { workflow: xbhhActiveWorkflowName(), workflows: xbhhListWorkflows(), stacks };
}

// 标记画布脏，触发重绘（LiteGraph 上 graph 与 canvas 均有该方法，兜底都试一遍）
function xbhhMarkCanvasDirty(graph) {
    try {
        if (app.canvas && app.canvas.setDirtyCanvas) app.canvas.setDirtyCanvas(true, true);
        else if (graph && graph.setDirtyCanvas) graph.setDirtyCanvas(true, true);
    } catch (e) { /* 忽略 */ }
}

// 把某个 LoRA 加入指定堆节点；nodeIds 为空则加入当前工作流上的全部堆节点
function xbhhAddLoraToStacks(loraName, nodeIds) {
    if (!loraName) return { ok: false, error: "LoRA 名字为空" };
    const graph = app && app.graph;
    if (!graph) return { ok: false, error: "画布未就绪" };
    const nodes = (graph._nodes || graph.nodes) || [];
    let targets = nodes.filter((n) => n && LORA_STACK_NODE_TYPES.includes(n.type));
    if (Array.isArray(nodeIds) && nodeIds.length) {
        // 节点 id 在不同前端版本里可能是 number 或 string，统一按字符串比较，
        // 否则管理器传回的数字 id 匹配不上字符串 id，会被误判为「没有可用的 LoRA 堆节点」
        const wanted = new Set(nodeIds.map((x) => String(x)));
        targets = targets.filter((n) => wanted.has(String(n.id)));
    }
    if (!targets.length) return { ok: false, error: "当前工作流没有可用的 LoRA 堆节点" };

    let added = 0;
    for (const node of targets) {
        try {
            if (typeof node.addLoraRow !== "function") continue;
            node.addLoraRow(loraName);
            // 新增一行后节点高度不会自动长，手动按内容重算
            // 但内部滚动版节点(__xbhhScrollable)高度跟随拖拽边框，不自动增高
            if (typeof node.computeSize === "function" && !node.__xbhhScrollable) node.size[1] = node.computeSize()[1];
            added++;
        } catch (e) {
            console.error("[XBHH] 加入 LoRA 堆失败", e);
        }
    }
    xbhhMarkCanvasDirty(graph);
    return { ok: added > 0, count: added, error: added ? "" : "加入失败" };
}

// 批量把多个 LoRA 加入指定堆节点（管理器多选发送用）
// items 支持两种形态：
//   1) 名字数组 + 统一 strength：["a.safetensors"], 0.8
//   2) 行对象数组（可逐行带权重）：[{ name, strength, triggerWeight }]
// strength 缺失时保持原来的 1.0；triggerWeight 只在显式传入时覆盖，
// 否则沿用「默认 1.0 = 跟随模型强度」的语义。
function xbhhAddManyLorasToStacks(items, strength, nodeIds) {
    const list = (Array.isArray(items) ? items : [items])
        .map((it) => {
            if (it && typeof it === "object") {
                return {
                    name: it.name || it.lora,
                    strength: it.strength,
                    clip: it.clip != null ? it.clip : it.strengthTwo,
                    triggerWeight: it.triggerWeight,
                };
            }
            return { name: it, strength };
        })
        .filter((it) => it.name && it.name !== "None");
    // 同名去重（保留第一条），避免同一堆里出现重复行
    const seen = new Set();
    const rowsToAdd = [];
    for (const it of list) {
        const key = String(it.name).replace(/\\/g, "/").toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rowsToAdd.push(it);
    }
    if (!rowsToAdd.length) return { ok: false, error: "没有要加入的 LoRA" };
    const graph = app && app.graph;
    if (!graph) return { ok: false, error: "画布未就绪" };
    const nodes = (graph._nodes || graph.nodes) || [];
    let targets = nodes.filter((n) => n && LORA_STACK_NODE_TYPES.includes(n.type));
    if (Array.isArray(nodeIds) && nodeIds.length) {
        const wanted = new Set(nodeIds.map((x) => String(x)));
        targets = targets.filter((n) => wanted.has(String(n.id)));
    }
    if (!targets.length) return { ok: false, error: "当前工作流没有可用的 LoRA 堆节点" };

    const val = Number(strength);
    const hasStrength = Number.isFinite(val);
    let added = 0;
    let rows = 0;
    for (const node of targets) {
        try {
            if (typeof node.addLoraRow !== "function") continue;
            for (const it of rowsToAdd) {
                const w = node.addLoraRow(it.name);
                if (w && w.value) {
                    const s = Number(it.strength);
                    if (Number.isFinite(s)) w.value.strength = s;
                    else if (hasStrength) w.value.strength = val;
                    // CLIP 权重（strengthTwo）：只有显式给了数值才覆盖；
                    // null 保持原样 = 后端沿用模型强度
                    const clip = Number(it.clip);
                    if (it.clip != null && Number.isFinite(clip)) w.value.strengthTwo = clip;
                    // 显式给了提示词权重就覆盖；否则保持「1.0 = 跟随模型强度」
                    const tw = Number(it.triggerWeight);
                    if (Number.isFinite(tw)) w.value.triggerWeight = tw;
                    rows++;
                }
            }
            if (typeof node.computeSize === "function" && !node.__xbhhScrollable) node.size[1] = node.computeSize()[1];
            added++;
        } catch (e) {
            console.error("[XBHH] 批量加入 LoRA 堆失败", e);
        }
    }
    xbhhMarkCanvasDirty(graph);
    return { ok: added > 0, count: added, rows, error: added ? "" : "加入失败" };
}

// 在当前视口中央新建一个 LoRA 堆节点（Plus 版）并把 LoRA 加进去
function xbhhCreateLoraStackWithLora(loraName) {
    const graph = app && app.graph;
    if (!graph || typeof LiteGraph === "undefined") return { ok: false, error: "无法创建节点" };
    let node;
    try {
        node = LiteGraph.createNode("XBHHMultiLoraLoaderPlus");
        if (!node) return { ok: false, error: "LoRA 堆节点类型未注册" };
        // 放在当前视口中央：graph 坐标 = 屏幕坐标 / 缩放 - 偏移
        let pos = [120, 120];
        try {
            const canvas = app.canvas;
            const ds = canvas && canvas.ds;
            const el = canvas && canvas.canvas;
            if (ds && el && ds.scale && ds.offset) {
                const rect = el.getBoundingClientRect();
                pos = [rect.width / (2 * ds.scale) - ds.offset[0], rect.height / (2 * ds.scale) - ds.offset[1]];
            }
        } catch (e) { /* 用默认坐标 */ }
        node.pos = pos;
        graph.add(node);
    } catch (e) {
        return { ok: false, error: String(e) };
    }
    const r = xbhhAddLoraToStacks(loraName, [node.id]);
    return { ok: r.ok, count: r.count || 0, nodeId: node.id, error: r.error || "" };
}

// 把预设文本（每行 enabled|lora_name|strength|strength_clip||trigger_weight）
// 应用到指定堆节点；nodeIds 为空则应用到当前工作流上的全部堆节点。
// 语义与节点「📥 导入预设」一致：先把所有行置为关闭，再逐行「已存在则改值 / 不存在则新增」。
// 三种堆节点（Plus / 普通 / 测试）都有 loraWidgets 与 addLoraRow，故在此统一实现，无需改各节点 JS。
function xbhhApplyPresetToStacks(text, nodeIds) {
    if (!text || !String(text).trim()) return { ok: false, error: "预设内容为空" };
    const graph = app && app.graph;
    if (!graph) return { ok: false, error: "画布未就绪" };
    const nodes = (graph._nodes || graph.nodes) || [];
    let targets = nodes.filter((n) => n && LORA_STACK_NODE_TYPES.includes(n.type));
    if (Array.isArray(nodeIds) && nodeIds.length) {
        const wanted = new Set(nodeIds.map((x) => String(x)));
        targets = targets.filter((n) => wanted.has(String(n.id)));
    }
    if (!targets.length) return { ok: false, error: "当前工作流没有可用的 LoRA 堆节点" };

    const lines = String(text).split("\n");
    let applied = 0;
    for (const node of targets) {
        try {
            if (typeof node.addLoraRow !== "function") continue;
            for (const w of node.loraWidgets || []) {
                if (w.value && w.value.on) w.value.on = false;
            }
            for (const line of lines) {
                const parts = line.trim().split("|");
                if (parts.length < 2) continue;
                const enabled = parts[0] === "1";
                const loraName = parts[1];
                if (!loraName) continue;
                const strength = parseFloat(parts[2]) || 1.0;
                const strengthTwo = parseFloat(parts[3]) || strength;
                const triggerWeight = parseFloat(parts[5]) || 1.0;
                let w = (node.loraWidgets || []).find((x) => x.value && x.value.lora === loraName);
                if (!w) w = node.addLoraRow(loraName);
                if (!w || !w.value) continue;
                w.value.on = enabled;
                w.value.strength = strength;
                w.value.strengthTwo = strengthTwo;
                w.value.triggerWeight = triggerWeight;
            }
            if (typeof node.computeSize === "function" && !node.__xbhhScrollable) node.size[1] = node.computeSize()[1];
            applied++;
        } catch (e) {
            console.error("[XBHH] 应用预设到 LoRA 堆失败", e);
        }
    }
    xbhhMarkCanvasDirty(graph);
    return { ok: applied > 0, count: applied, error: applied ? "" : "应用失败" };
}

window.__xbhhLoraStack = {
    list: xbhhListLoraStacks,
    add: xbhhAddLoraToStacks,
    addMany: xbhhAddManyLorasToStacks,
    create: xbhhCreateLoraStackWithLora,
    preset: xbhhApplyPresetToStacks,
};

// ============================================================================
// 画布桥接 — 「参考图 → 加载图片节点」
// ----------------------------------------------------------------------------
// 与上面的 LoRA 堆桥同理：管理器是独立标签页，只能通过 window.opener 拿本窗口的画布。
// 流程分两跳：① 后端把参考图复制进 ComfyUI 的 input/（/xbhh/lora/send-to-input），
// ② 按 dropLoader.js 的写入序列把返回的图片名写进节点的 image widget。
// 目标节点只认「有 name === "image" widget」的节点（即原生 LoadImage 一类）。
// ============================================================================

// 列出当前工作流上所有可加载图片的节点（带各自当前图片名，便于用户分辨目标）
function xbhhListImageNodes() {
    const graph = app && app.graph;
    if (!graph) return { workflow: "", nodes: [] };
    const nodes = (graph._nodes || graph.nodes) || [];
    const out = [];
    for (const n of nodes) {
        if (!n || !Array.isArray(n.widgets)) continue;
        const w = n.widgets.find((x) => x && x.name === "image");
        if (!w) continue;
        out.push({
            id: n.id,
            title: n.title || n.type,
            type: n.type,
            value: w.value || "",
        });
    }
    return { workflow: xbhhActiveWorkflowName(), nodes: out };
}

// 把图片名写进节点的 image widget（照 dropLoader.js 的序列，确保节点重新加载缩略图）
function xbhhSetNodeImage(node, widget, path) {
    if (widget.options && Array.isArray(widget.options.values)) {
        if (!widget.options.values.includes(path)) widget.options.values.push(path);
    }
    widget.value = path;
    try { widget.callback?.(path, app.canvas, node, [0, 0], null); } catch (e) { /* 忽略 */ }
    node.imgs = undefined;
    node.imageIndex = null;
    node.setDirtyCanvas?.(true, true);
    xbhhMarkCanvasDirty(app.graph);
}

// 参考图 → 指定加载图片节点：先调后端复制进 input/，再把图片名写进节点
async function xbhhSendRefImage(refPath, nodeId) {
    if (!refPath) return { ok: false, error: "参考图路径为空" };
    const graph = app && app.graph;
    if (!graph) return { ok: false, error: "画布未就绪" };
    const nodes = (graph._nodes || graph.nodes) || [];
    const wanted = String(nodeId);
    const node = nodes.find((n) => n && String(n.id) === wanted);
    if (!node) return { ok: false, error: "目标节点已不存在，请重新选择" };
    const widget = Array.isArray(node.widgets) ? node.widgets.find((w) => w && w.name === "image") : null;
    if (!widget) return { ok: false, error: "目标节点没有图片输入口" };

    let data;
    try {
        const resp = await api.fetchApi("/xbhh/lora/send-to-input", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: refPath }),
        });
        data = await resp.json();
        if (!resp.ok || !data || !data.ok) {
            return { ok: false, error: (data && data.error) || `复制失败 (HTTP ${resp.status})` };
        }
    } catch (e) {
        return { ok: false, error: String(e) };
    }

    const path = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
    try {
        xbhhSetNodeImage(node, widget, path);
    } catch (e) {
        return { ok: false, error: String(e) };
    }
    return { ok: true, nodeId: node.id, path };
}

// 在当前视口中央新建一个原生 LoadImage 节点并载入该参考图
async function xbhhCreateLoadImageNode(refPath) {
    const graph = app && app.graph;
    if (!graph || typeof LiteGraph === "undefined") return { ok: false, error: "无法创建节点" };
    let node;
    try {
        node = LiteGraph.createNode("LoadImage");
        if (!node) return { ok: false, error: "LoadImage 节点类型未注册" };
        // 放在当前视口中央：graph 坐标 = 屏幕坐标 / 缩放 - 偏移
        let pos = [120, 120];
        try {
            const canvas = app.canvas;
            const ds = canvas && canvas.ds;
            const el = canvas && canvas.canvas;
            if (ds && el && ds.scale && ds.offset) {
                const rect = el.getBoundingClientRect();
                pos = [rect.width / (2 * ds.scale) - ds.offset[0], rect.height / (2 * ds.scale) - ds.offset[1]];
            }
        } catch (e) { /* 用默认坐标 */ }
        node.pos = pos;
        graph.add(node);
    } catch (e) {
        return { ok: false, error: String(e) };
    }
    return xbhhSendRefImage(refPath, node.id);
}

window.__xbhhCanvasBridge = {
    listImageNodes: xbhhListImageNodes,
    sendRefImage: xbhhSendRefImage,
    createLoadImageNode: xbhhCreateLoadImageNode,
};

// ============================================================================
// 侧边栏按钮 — 点击打开 LoRA 数据管理器新标签页
// ============================================================================

// —— 侧边栏防冲突（规避 ComfyUI 前端已知 bug ComfyUI_frontend#4372）——
// 自定义侧边栏 tab 共用同一个内容容器，切换 tab 时旧扩展内容不会被销毁，
// 导致本面板残留并盖住其它扩展的侧边栏内容。
// 处理：轮询本 tab 按钮的选中态，非本 tab 激活时隐藏面板。
const LORA_PANEL_ID = "xbhh-lora-manager-panel";

function loraTabSelected() {
    const btn =
        document.querySelector('[data-testid="xbhh-lora-manager-tab-button"]') ||
        Array.from(document.querySelectorAll(".side-bar-button")).find(
            (b) => (b.getAttribute("aria-label") || "").includes("LoRA 数据"),
        );
    return (
        !!btn &&
        (btn.classList.contains("side-bar-button-selected") ||
            btn.classList.contains("selected"))
    );
}

function applyLoraPanelVisibility() {
    const panel = document.getElementById(LORA_PANEL_ID);
    if (panel) panel.style.display = loraTabSelected() ? "" : "none";
}

let loraPanelWatchTimer = null;
function watchLoraPanelVisibility() {
    applyLoraPanelVisibility();
    if (!loraPanelWatchTimer) {
        loraPanelWatchTimer = setInterval(applyLoraPanelVisibility, 400);
    }
}

// 打开 LoRA 数据管理器（独立标签页），侧边栏按钮与全局快捷键共用。
// 复用规则：先让已知窗口就地打开详情并聚焦；同时广播探测其它存活的管理器窗口。
// 只有在「拿不到可聚焦的窗口」时才兜底按固定窗口名重新打开——宁可多开一个，也不能点了没反应。
// （复制标签页得到的管理器会继承窗口名，但可能不在同一浏览上下文组，取不回引用）
const LORA_MANAGER_WIN_NAME = "xbhh_lora_manager";
const LORA_MANAGER_CHANNEL = "xbhh-lora-manager";
let loraManagerWin = null;

// 存活的管理器窗口：本页记住的引用，或管理器回写到 opener 的引用
function currentLoraManagerWin() {
    const candidates = [loraManagerWin, window.__xbhhLoraManagerWin];
    for (const w of candidates) {
        try {
            if (w && !w.closed) return w;
        } catch (e) { /* 失效引用，忽略 */ }
    }
    return null;
}

function xbhhOpenLoraManager(loraName) {
    const base = `${window.location.origin}/xbhh/lora-manager`;
    const url = loraName ? `${base}?lora=${encodeURIComponent(loraName)}` : base;
    const request = { type: "xbhh:open-lora", lora: loraName || null };

    // 兜底打开：按固定窗口名直接打开地址。同名窗口能访问到就复用并导航过去，
    // 访问不到（例如复制出来的标签页）就新建；最多多一个标签页，不会点了没反应。
    const openFresh = () => {
        try {
            const w = window.open(url, LORA_MANAGER_WIN_NAME);
            if (w) {
                loraManagerWin = w;
                return;
            }
        } catch (e) { /* 继续尝试 _blank */ }
        try {
            const w = window.open(url, "_blank");
            if (w) loraManagerWin = w;
        } catch (e) { /* 真开不了，只能放弃 */ }
    };

    // 让某个窗口就地打开详情并切到前台
    const deliver = (w) => {
        if (!w) return;
        try {
            w.postMessage(request, window.location.origin);
        } catch (e) { /* 忽略：引用可能已跨源或失效 */ }
        try {
            w.focus();
        } catch (e) { /* 忽略：浏览器可能不允许抢焦点 */ }
    };

    // 手上就有引用：先走最快路径，同时下面仍会广播探测，防止这个引用其实已无监听
    const known = currentLoraManagerWin();
    deliver(known);

    // 广播探测：reply 表示确实有活着且能处理请求的管理器窗口
    let reply = null;
    let bus = null;
    try {
        bus = new BroadcastChannel(LORA_MANAGER_CHANNEL);
        bus.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === "xbhh:open-lora-ack") reply = msg;
        };
        bus.postMessage(request);
    } catch (e) { /* 浏览器不支持广播 */ }

    const finish = () => {
        try { if (bus) bus.close(); } catch (e) { /* 忽略 */ }
        if (!reply) {
            // 没有窗口应答：要么压根没开，要么手里的引用指向已失效/无监听的页面
            openFresh();
            return;
        }
        // 有窗口应答：说明确实有管理器活着，且它收到广播后已经自己打开了详情。
        const win = currentLoraManagerWin();
        if (win) {
            // 拿得到引用就能把它提到前台，不新开
            deliver(win);
            return;
        }
        // 拿不到引用（用户手动打开的窗口 / 复制出来的标签页）：脚本无法聚焦这种窗口，
        // 浏览器也拒绝把后台窗口提到前台，所以只能重开一个带 ?lora= 深链的窗口，
        // 让用户点一下一定看得到东西。注意必须带 URL，不能用 window.open("", 名字)——
        // 那种写法在窗口不可访问时会新建 about:blank，表现为白屏。
        openFresh();
    };

    if (bus) setTimeout(finish, 150);
    else if (!known) finish();
}

// 供其它扩展模块（LoRA 堆右键「在管理器中查看」）复用，避免重复开标签页
window.__xbhhOpenLoraManager = xbhhOpenLoraManager;

// 全局快捷键只绑定一次，避免扩展热重载时重复注册
let xbhhLoraManagerHotkeyBound = false;

app.registerExtension({
    name: "xbhh.LoraManager",

    async init() {
        // 全局快捷键：Ctrl/Cmd + Shift + L 打开 LoRA 数据管理器
        if (!xbhhLoraManagerHotkeyBound) {
            xbhhLoraManagerHotkeyBound = true;
            document.addEventListener("keydown", (e) => {
                if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
                if ((e.key || "").toLowerCase() !== "l") return;
                // 正在输入框里打字时不劫持按键
                const t = e.target;
                if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
                e.preventDefault();
                xbhhOpenLoraManager();
            });
        }

        // 注册侧边栏标签页
        if (app.extensionManager?.registerSidebarTab) {
            app.extensionManager.registerSidebarTab({
                id: "xbhh-lora-manager",
                icon: "pi pi-database",
                title: "LoRA 数据",
                tooltip: "打开 LoRA 数据管理器",
                type: "custom",
                render: (el) => {
                    // 只移除自己的旧面板（容器可能与其它扩展的侧边栏内容共存，不能 innerHTML 清空）
                    const prev = document.getElementById(LORA_PANEL_ID);
                    if (prev) prev.remove();
                    const panel = document.createElement("div");
                    panel.id = LORA_PANEL_ID;

                    const container = document.createElement("div");
                    container.style.cssText = "padding:20px; display:flex; flex-direction:column; align-items:center; gap:16px; height:100%;";

                    // 图标
                    const icon = document.createElement("div");
                    icon.style.cssText = "font-size:48px; margin-top:40px;";
                    icon.textContent = "📊";
                    container.appendChild(icon);

                    // 标题
                    const title = document.createElement("h3");
                    title.style.cssText = "color:#ddd; margin:0; font-size:16px;";
                    title.textContent = "LoRA 数据管理器";
                    container.appendChild(title);

                    // 描述
                    const desc = document.createElement("p");
                    desc.style.cssText = "color:#888; font-size:12px; text-align:center; line-height:1.6; margin:0;";
                    desc.textContent = "浏览 LoRA 文件、查看训练参数、标签频率等元数据信息";
                    container.appendChild(desc);

                    // 打开按钮
                    const btn = document.createElement("button");
                    btn.style.cssText = `
                        padding: 10px 24px;
                        background: linear-gradient(135deg, #2d5a3d, #1a8a4a);
                        border: none;
                        border-radius: 8px;
                        color: #fff;
                        font-size: 14px;
                        font-weight: bold;
                        cursor: pointer;
                        transition: all 0.2s;
                        box-shadow: 0 2px 8px rgba(26, 138, 74, 0.3);
                    `;
                    btn.textContent = "🚀 打开管理器";
                    btn.onmouseenter = () => {
                        btn.style.transform = "scale(1.05)";
                        btn.style.boxShadow = "0 4px 16px rgba(26, 138, 74, 0.5)";
                    };
                    btn.onmouseleave = () => {
                        btn.style.transform = "scale(1)";
                        btn.style.boxShadow = "0 2px 8px rgba(26, 138, 74, 0.3)";
                    };
                    btn.onclick = () => xbhhOpenLoraManager();
                    container.appendChild(btn);

                    panel.appendChild(container);
                    el.appendChild(panel);
                    watchLoraPanelVisibility();
                }
            });
        }
    }
});
