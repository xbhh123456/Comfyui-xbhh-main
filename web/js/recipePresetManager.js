// ============================================================================
// XBHH 预设管理（配方）— 节点内嵌 DOM 面板
// ----------------------------------------------------------------------------
// 与 ComfyUI 常规节点不同：本节点没有可见的连线式控件，而是在节点内部挂一块
// 自定义 HTML 面板（通过 addDOMWidget），用卡片列表展示「LoRA 数据管理器」里
// 维护好的配方。
//
// 写入方式：
//   - LoRA：点击卡片即把配方"无线"写入画布上勾选的 Lora堆Plus 节点
//           （window.__xbhhLoraStack.preset，见 web/js/loraManager.js）
//   - 提示词：把 prompt 输出（outputs[1]）用连线接到目标文本节点，点击「应用」
//             时把「非空」提示词直接赋值到该连线目标节点的文本框；为空则不写。
//
// 数据来源：
//   - 配方：GET /xbhh/lora/settings → settings.recipes
//   - 缩略图：GET /xbhh/lora/ref-image?path=...&thumb=160
//
// 持久化：node.properties.xbhhPmTargets（勾选的目标堆 id）
//         node.properties.xbhhPmSelectedRecipe（当前应用的配方 id）
//         node.properties.xbhhPmBackup（应用前的撤销快照；每个堆只存一份，
//           再次点击同一配方即按它恢复，恢复后销毁）
// ============================================================================

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_NAME = "XBHHRecipePresetManager";
const TARGET_STACK_TYPE = "XBHHMultiLoraLoaderPlus";
// 可作为连线目标的 LoRA 堆类型（与 loraManager.js 的画布桥接保持一致）
const STACK_NODE_TYPES = [TARGET_STACK_TYPE, "XBHHMultiLoraLoader", "XBHHLoraTestLoader"];
// 面板最小高度（实际高度由内容撑开，见 relayout）
const PANEL_MIN_HEIGHT = 160;

// ---------------------------------------------------------------------------
// 配方读取（带 3 秒短缓存，避免频繁请求）
// ---------------------------------------------------------------------------
let _recipeCache = { at: 0, list: [] };

async function loadRecipes(force) {
    const now = Date.now();
    if (!force && now - _recipeCache.at < 3000) return _recipeCache.list;
    try {
        const res = await api.fetchApi("/xbhh/lora/settings");
        const data = await res.json();
        const list = Array.isArray(data && data.recipes) ? data.recipes : [];
        _recipeCache = { at: now, list };
        return list;
    } catch (e) {
        console.error("[XBHH] 读取配方失败", e);
        return _recipeCache.list;
    }
}

// 与管理器 web/lora_manager.html 里的 fmtWeight / recipePresetText 保持一致
function fmtWeight(v) {
    const n = Number(v);
    if (!isFinite(n)) return "1";
    return String(Math.round(n * 1000) / 1000);
}

function recipePresetText(recipe) {
    const rows = (recipe && recipe.loras) || [];
    return rows
        .map((l) => `${l.on === false ? "0" : "1"}|${l.name}|${fmtWeight(l.weight)}|${fmtWeight(l.weightClip)}||${fmtWeight(l.triggerWeight)}`)
        .join("\n");
}

function recipeThumbUrl(recipe) {
    const p = recipe && recipe.preview;
    if (!p) return "";
    return `/xbhh/lora/ref-image?path=${encodeURIComponent(p)}&thumb=160`;
}

// ---------------------------------------------------------------------------
// 桥接与目标堆
// ---------------------------------------------------------------------------
function getBridge() {
    const b = window.__xbhhLoraStack;
    return b && typeof b.preset === "function" ? b : null;
}

function listTargetStacks() {
    const bridge = getBridge();
    if (!bridge) return { bridgeReady: false, workflow: "", stacks: [] };
    let info = null;
    try {
        info = bridge.list();
    } catch (e) {
        info = null;
    }
    const stacks = ((info && info.stacks) || []).filter((s) => s && s.type === TARGET_STACK_TYPE);
    return { bridgeReady: true, workflow: (info && info.workflow) || "", stacks };
}

// 勾选的目标堆：未设置过属性时返回 null（表示默认全选）
function getSelectedTargetIds(node) {
    const v = node.properties && node.properties.xbhhPmTargets;
    return Array.isArray(v) ? v.map(String) : null;
}

// 从某个输出口解析出「已连线的目标节点」
function resolveLinkedTargets(node, outputIndex) {
    const out = [];
    try {
        const graph = app && app.graph;
        if (!graph) return out;
        const o = node.outputs && node.outputs[outputIndex];
        const linkIds = (o && o.links) || [];
        for (const linkId of linkIds) {
            const links = graph.links;
            const link = links && (links[linkId] || (typeof links.get === "function" && links.get(linkId)));
            if (!link) continue;
            const target = typeof graph.getNodeById === "function" ? graph.getNodeById(link.target_id) : null;
            if (target && target.type !== NODE_NAME) out.push(target);
        }
    } catch (e) { /* 前端版本差异，忽略 */ }
    return out;
}

// preset_text 输出已连线的 Lora 堆节点 id 列表（「有线」方案，无需勾选目标堆）
function getWiredStackIds(node) {
    return resolveLinkedTargets(node, 0)
        .filter((t) => STACK_NODE_TYPES.includes(t.type))
        .map((t) => String(t.id));
}

function writePresetText(node, text) {
    const w = node.widgets && node.widgets.find((x) => x.name === "preset_text");
    if (w) w.value = text;
    try {
        app.graph.setDirtyCanvas(true, true);
    } catch (e) { /* 忽略 */ }
}

// 把当前选中配方的提示词写进隐藏 widget，执行时由节点的 prompt 输出口吐出
function writePromptText(node, text) {
    const w = node.widgets && node.widgets.find((x) => x.name === "prompt_text");
    if (w) w.value = text;
    try {
        app.graph.setDirtyCanvas(true, true);
    } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 提示词「有线」目标：prompt 输出（outputs[1]）连到哪个文本节点，就把提示词
// 直接赋值到那个节点的文本框。text 为空则直接跳过，不覆盖目标。
// ---------------------------------------------------------------------------
// 常见的文本框 widget 名，用于在目标节点上识别「可写入提示词的文本框」
const TEXT_WIDGET_NAMES = /^(text|prompt|positive|negative|prefix|suffix|clip_text|string|content)$/i;

function findTextWidget(n) {
    if (!n || !Array.isArray(n.widgets)) return null;
    for (const w of n.widgets) {
        if (!w || w.name === "xbhh_pm_panel") continue;
        if (typeof w.value !== "string") continue;
        const isText =
            w.type === "customtext" ||
            w.type === "text" ||
            !!(w.options && w.options.multiline) ||
            TEXT_WIDGET_NAMES.test(w.name || "");
        if (isText) return w;
    }
    return null;
}

// prompt 输出口已连线的目标节点（去重）
function getWiredPromptTargets(node) {
    const seen = new Set();
    const out = [];
    for (const t of resolveLinkedTargets(node, 1)) {
        const id = String(t.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(t);
    }
    return out;
}

// 把提示词直接赋值到 prompt 输出所连目标节点的文本框；为空则不写
function applyPromptToWiredTargets(node, text) {
    if (!text || !String(text).trim()) return 0;
    const graph = app && app.graph;
    if (!graph) return 0;
    let count = 0;
    for (const n of getWiredPromptTargets(node)) {
        const w = findTextWidget(n);
        if (!w) continue;
        try {
            w.value = text;
            // 触发 widget 回调，让节点（如动态提示词、标题）同步刷新
            if (typeof w.callback === "function") w.callback(w.value, app.canvas, n);
            count++;
        } catch (e) { /* 单个节点失败不影响其它节点 */ }
    }
    if (count) {
        try { graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
    }
    return count;
}

// ---------------------------------------------------------------------------
// 配方撤销快照
// 应用前记录每个目标堆的 LoRA 行状态（每个堆只保留一份，新应用直接覆盖），
// 再次点击同一配方时按快照恢复。多个堆各自独立，互不影响。
// ---------------------------------------------------------------------------
function widgetLoraName(v) {
    const lora = v && v.lora;
    return Array.isArray(lora) ? lora[0] : lora;
}

function findNodeById(id) {
    try {
        const graph = app && app.graph;
        if (!graph) return null;
        if (typeof graph.getNodeById === "function") {
            const n = graph.getNodeById(id);
            if (n) return n;
        }
        const nodes = graph._nodes || graph.nodes || [];
        return nodes.find((n) => n && String(n.id) === String(id)) || null;
    } catch (e) {
        return null;
    }
}

function snapshotStackRows(stackNode) {
    return (stackNode.loraWidgets || []).map((w) => {
        const v = w.value || {};
        return {
            lora: widgetLoraName(v) || null,
            on: v.on !== false,
            strength: v.strength,
            strengthTwo: v.strengthTwo,
            trigger: v.trigger,
            triggerWeight: v.triggerWeight,
        };
    });
}

function restoreStackRows(stackNode, rows) {
    if (!stackNode || typeof stackNode.addLoraRow !== "function") return false;
    // Windows 下同名 LoRA 大小写可能不一致，统一归一化后比较
    const normName = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
    const keep = new Set(rows.filter((r) => r && r.lora).map((r) => normName(r.lora)));

    // 1) 移除应用配方时新加的行（原状态里没有的 LoRA）
    for (const w of [...(stackNode.loraWidgets || [])]) {
        const name = widgetLoraName(w.value);
        if (!name || keep.has(normName(name))) continue;
        if (typeof stackNode.removeLoraWidget === "function") stackNode.removeLoraWidget(w);
        else w.value.on = false;
    }

    // 2) 原有行按快照恢复开关与数值；空行按顺序匹配
    for (const r of rows) {
        if (!r) continue;
        let w = null;
        if (r.lora) {
            w = (stackNode.loraWidgets || []).find((x) => normName(widgetLoraName(x.value)) === normName(r.lora));
            if (!w) w = stackNode.addLoraRow(r.lora);
        } else {
            w = (stackNode.loraWidgets || []).find((x) => !widgetLoraName(x.value) && !x.__pmRestored);
            if (w) w.__pmRestored = true;
        }
        if (!w || !w.value) continue;
        w.value.on = r.on;
        if (r.strength != null) w.value.strength = r.strength;
        w.value.strengthTwo = r.strengthTwo == null ? null : r.strengthTwo;
        w.value.trigger = r.trigger || "";
        w.value.triggerWeight = r.triggerWeight == null ? 1.0 : r.triggerWeight;
    }
    for (const w of stackNode.loraWidgets || []) delete w.__pmRestored;

    if (typeof stackNode.computeSize === "function" && !stackNode.__xbhhScrollable) {
        stackNode.size[1] = stackNode.computeSize()[1];
    }
    return true;
}

function snapshotPromptTargets(node) {
    return getWiredPromptTargets(node)
        .map((n) => {
            const w = findTextWidget(n);
            return w ? { id: String(n.id), name: w.name || "", value: w.value } : null;
        })
        .filter(Boolean);
}

function restorePromptTargets(items) {
    if (!items || !items.length) return 0;
    let count = 0;
    for (const it of items) {
        const n = findNodeById(it.id);
        if (!n) continue;
        let w = findTextWidget(n);
        if (w && it.name && w.name !== it.name) {
            w = (n.widgets || []).find((x) => x.name === it.name) || w;
        }
        if (!w) continue;
        try {
            w.value = it.value;
            if (typeof w.callback === "function") w.callback(w.value, app.canvas, n);
            count++;
        } catch (e) { /* 单个节点失败不影响其它节点 */ }
    }
    if (count) {
        try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
    }
    return count;
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

// ---------------------------------------------------------------------------
// 面板构建
// ---------------------------------------------------------------------------
function attachPanel(node) {
    const root = el("div", "pm-root");

    // ---- 目标区（可折叠） ----
    const secTargets = el("div", "pm-section");
    const headTargets = el("div", "pm-headrow pm-clickable");
    const caret = el("span", "pm-caret", "▾");
    headTargets.appendChild(caret);
    headTargets.appendChild(el("span", "pm-title", "🎯 目标 Lora堆Plus"));
    const counts = el("span", "pm-count", "");
    headTargets.appendChild(counts);
    const btnRefresh = el("button", "pm-btn pm-refresh", "⟳");
    btnRefresh.title = "刷新目标列表";
    headTargets.appendChild(btnRefresh);
    secTargets.appendChild(headTargets);

    const targetsBody = el("div", "pm-targets-body");
    const targetBox = el("div", "pm-targets");
    targetsBody.appendChild(targetBox);
    const hint = el("div", "pm-hint", "");
    targetsBody.appendChild(hint);
    secTargets.appendChild(targetsBody);
    root.appendChild(secTargets);

    // ---- 配方区 ----
    const secRecipes = el("div", "pm-section pm-section--grow");
    const headRecipes = el("div", "pm-headrow");
    headRecipes.appendChild(el("span", "pm-title", "🍰 配方"));
    const viewToggle = el("div", "pm-viewtoggle");
    const btnCard = el("button", "pm-viewbtn", "卡片");
    btnCard.title = "卡片视图";
    const btnList = el("button", "pm-viewbtn", "列表");
    btnList.title = "列表视图";
    viewToggle.appendChild(btnCard);
    viewToggle.appendChild(btnList);
    headRecipes.appendChild(viewToggle);
    const btnReload = el("button", "pm-btn pm-reload", "↻");
    btnReload.title = "重新读取配方";
    headRecipes.appendChild(btnReload);
    secRecipes.appendChild(headRecipes);

    const toolbar = el("div", "pm-toolbar");
    const search = el("input", "pm-search");
    search.type = "text";
    search.placeholder = "搜索配方…";
    search.value = node._pmSearch || "";
    const cat = el("select", "pm-cat");
    toolbar.appendChild(search);
    toolbar.appendChild(cat);
    secRecipes.appendChild(toolbar);

    const list = el("div", "pm-list");
    secRecipes.appendChild(list);

    const status = el("div", "pm-status", "");
    secRecipes.appendChild(status);
    root.appendChild(secRecipes);

    // ---- 面板状态 ----
    let recipeList = [];
    let lastSig = "";
    let currentCat = node._pmCat || "__all__";
    let view = (node.properties && node.properties.xbhhPmView) === "list" ? "list" : "card";
    let targetsCollapsed = !!(node.properties && node.properties.xbhhPmTargetsCollapsed);

    function applyTargetsCollapse() {
        targetsBody.style.display = targetsCollapsed ? "none" : "";
        caret.textContent = targetsCollapsed ? "▸" : "▾";
    }

    function applyView() {
        btnCard.classList.toggle("pm-on", view === "card");
        btnList.classList.toggle("pm-on", view === "list");
        list.classList.toggle("pm-list--list", view === "list");
    }

    function setStatus(msg, kind) {
        status.textContent = msg || "";
        status.className = "pm-status" + (kind ? " pm-" + kind : "");
    }

    // ---- 高度自适应：面板高度交给 ComfyUI 的 widget 空间分配（growable）----
    // 只要不设置 widget.computeSize，ComfyUI 就会把节点剩余空间分给这个 DOM widget，
    // 于是拖高节点时 .pm-root 会自动变高，配方区随之显示更多内容。
    let relayoutQueued = false;
    function relayout() {
        if (relayoutQueued) return;
        relayoutQueued = true;
        requestAnimationFrame(() => {
            relayoutQueued = false;
            try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
        });
    }

    function renderTargets(stacks) {
        targetBox.innerHTML = "";
        if (!stacks.length) {
            targetBox.appendChild(el("div", "pm-empty", "当前工作流没有 Lora堆Plus 节点"));
            counts.textContent = "";
            relayout();
            return;
        }
        const sel = getSelectedTargetIds(node);
        counts.textContent = String(stacks.length);
        for (const s of stacks) {
            const id = String(s.id);
            const row = el("label", "pm-target");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = sel === null || sel.includes(id);
            cb.addEventListener("change", () => {
                const next = [];
                for (const r of targetBox.querySelectorAll(".pm-target")) {
                    if (r.querySelector("input").checked) next.push(r.dataset.id);
                }
                node.properties.xbhhPmTargets = next;
            });
            const name = el("span", "pm-target-name", (s.title || s.type) + " #" + id);
            const nLo = el("span", "pm-target-meta", ((s.loras && s.loras.length) || 0) + " LoRA");
            row.dataset.id = id;
            row.appendChild(cb);
            row.appendChild(name);
            row.appendChild(nLo);
            targetBox.appendChild(row);
        }
        relayout();
    }

    function refreshTargets() {
        const { bridgeReady, workflow, stacks } = listTargetStacks();
        const sig = JSON.stringify(stacks.map((s) => ({ id: String(s.id), n: (s.loras || []).length, t: s.title })));
        if (sig === lastSig) return;
        lastSig = sig;
        renderTargets(stacks);

        if (!bridgeReady) hint.textContent = "画布桥接未就绪（请刷新页面）";
        else if (!workflow) hint.textContent = "当前工作流未命名";
        else hint.textContent = "当前工作流：" + workflow;
        relayout();
    }

    function renderCategoryOptions() {
        const cats = new Set();
        for (const r of recipeList) {
            if (r && r.category) cats.add(String(r.category));
        }
        cat.innerHTML = "";
        const all = el("option", null, "全部分类");
        all.value = "__all__";
        cat.appendChild(all);
        for (const c of Array.from(cats).sort()) {
            const o = el("option", null, c);
            o.value = c;
            cat.appendChild(o);
        }
        // 之前选的分类若已不存在，退回全部
        if (currentCat !== "__all__" && !cats.has(currentCat)) currentCat = "__all__";
        cat.value = currentCat;
    }

    // 缩略图：有预览图则显示，否则用占位 emoji
    function buildThumb(recipe, extraCls) {
        const thumbWrap = el("div", "pm-thumb" + (extraCls ? " " + extraCls : ""));
        const url = recipeThumbUrl(recipe);
        if (url) {
            const img = document.createElement("img");
            img.loading = "lazy";
            img.src = url;
            img.onerror = () => { img.remove(); thumbWrap.textContent = "🍰"; };
            thumbWrap.appendChild(img);
        } else {
            thumbWrap.textContent = "🍰";
        }
        return thumbWrap;
    }

    function recipeMetaText(r) {
        const nLora = (r.loras && r.loras.length) || 0;
        return `${nLora} 个 LoRA` + (r.category ? ` · ${r.category}` : "");
    }

    function buildCard(r, isActive) {
        const card = el("div", "pm-card pm-item");
        if (isActive) card.classList.add("pm-active");
        if (r.id != null) card.dataset.recipeId = String(r.id);

        const info = el("div", "pm-info");
        info.appendChild(el("div", "pm-name", r.name || "未命名配方"));
        info.appendChild(el("div", "pm-meta", recipeMetaText(r)));

        const applyBtn = el("button", "pm-apply", isActive ? "取消" : "应用");
        applyBtn.addEventListener("click", (ev) => { ev.stopPropagation(); apply(r); });

        card.appendChild(buildThumb(r));
        card.appendChild(info);
        card.appendChild(applyBtn);
        card.addEventListener("click", () => apply(r));
        return card;
    }

    function buildRow(r, isActive) {
        const row = el("div", "pm-row pm-item");
        if (isActive) row.classList.add("pm-active");
        if (r.id != null) row.dataset.recipeId = String(r.id);

        const applyBtn = el("button", "pm-apply pm-apply-sm", isActive ? "取消" : "应用");
        applyBtn.addEventListener("click", (ev) => { ev.stopPropagation(); apply(r); });

        row.appendChild(buildThumb(r, "pm-thumb-sm"));
        row.appendChild(el("div", "pm-row-name", r.name || "未命名配方"));
        row.appendChild(el("div", "pm-row-meta", recipeMetaText(r)));
        row.appendChild(applyBtn);
        row.addEventListener("click", () => apply(r));
        return row;
    }

    function renderRecipes() {
        const kw = (node._pmSearch || "").trim().toLowerCase();
        const filtered = recipeList.filter((r) => {
            if (!r) return false;
            if (currentCat !== "__all__" && String(r.category || "") !== currentCat) return false;
            if (kw && !String(r.name || "").toLowerCase().includes(kw)) return false;
            return true;
        });

        list.innerHTML = "";
        if (!filtered.length) {
            list.appendChild(el("div", "pm-empty", recipeList.length ? "没有匹配的配方" : "还没有配方，请在 LoRA 数据管理器中创建"));
            return;
        }

        const selectedId = node.properties && node.properties.xbhhPmSelectedRecipe;
        for (const r of filtered) {
            const isActive = selectedId != null && String(r.id) === String(selectedId);
            list.appendChild(view === "list" ? buildRow(r, isActive) : buildCard(r, isActive));
        }
    }

    // 只更新卡片选中态与按钮文案，避免整列表重建导致滚动位置丢失
    function syncActiveUi() {
        const selectedId = node.properties && node.properties.xbhhPmSelectedRecipe;
        for (const item of list.querySelectorAll(".pm-item")) {
            const active = selectedId != null && item.dataset.recipeId != null
                && String(item.dataset.recipeId) === String(selectedId);
            item.classList.toggle("pm-active", active);
            const btn = item.querySelector(".pm-apply");
            if (btn) btn.textContent = active ? "取消" : "应用";
        }
    }

    function readWidgetValue(name) {
        const w = node.widgets && node.widgets.find((x) => x.name === name);
        return w ? w.value : "";
    }

    // 取消应用：按快照把目标堆与提示词恢复成应用前的样子，并销毁快照
    function cancelApply(recipe) {
        const recipeName = recipe.name || "未命名";
        const backup = node.properties && node.properties.xbhhPmBackup;
        if (!backup) {
            // 旧版本应用的配方没有快照：只能取消选中，提示一下避免用户以为没生效
            node.properties.xbhhPmSelectedRecipe = null;
            syncActiveUi();
            relayout();
            setStatus(`「${recipeName}」是旧版本应用的，没有可恢复的快照，仅取消选中`, "err");
            return;
        }

        let stackCount = 0;
        for (const [id, rows] of Object.entries(backup.stacks || {})) {
            const stackNode = findNodeById(id);
            if (restoreStackRows(stackNode, rows || [])) stackCount++;
        }
        writePresetText(node, backup.presetText || "");
        writePromptText(node, backup.promptText || "");
        const promptRestored = restorePromptTargets(backup.promptTargets);

        delete node.properties.xbhhPmBackup;
        node.properties.xbhhPmSelectedRecipe = null;
        syncActiveUi();
        try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }

        const promptTail = promptRestored ? `，提示词已还原 ${promptRestored} 个节点` : "";
        if (stackCount) setStatus(`已取消「${recipeName}」→ ${stackCount} 个堆已还原${promptTail}`, "ok");
        else setStatus(`已取消「${recipeName}」${promptTail || "，已恢复为应用前状态"}`, "ok");
        refreshTargets();
        relayout();
    }

    function apply(recipe) {
        const recipeName = recipe.name || "未命名";
        const prompt = recipe.prompt == null ? "" : String(recipe.prompt);
        const hasPrompt = !!prompt.trim();
        const text = recipePresetText(recipe);

        // 再次点击已应用的配方 = 取消，恢复应用前状态
        const selectedId = node.properties && node.properties.xbhhPmSelectedRecipe;
        if (selectedId != null && String(selectedId) === String(recipe.id)) {
            cancelApply(recipe);
            return;
        }

        // 目标堆 = 勾选的目标堆 ∪ 已连线的堆；都没指定时默认全部堆
        const { stacks } = listTargetStacks();
        const hasStack = (id) => stacks.some((s) => String(s.id) === String(id));
        const wiredIds = getWiredStackIds(node).filter(hasStack);
        const sel = getSelectedTargetIds(node);
        let ids;
        if (sel === null) {
            ids = wiredIds.length ? wiredIds.slice() : stacks.map((s) => String(s.id));
        } else {
            const set = new Set(sel.map(String));
            for (const id of wiredIds) set.add(id);
            ids = Array.from(set);
        }
        const wired = wiredIds.length > 0;
        const hasLora = !!text.trim();

        // 有 LoRA 但一个目标堆都没有时才拦；纯提示词配方不依赖堆
        if (hasLora && !ids.length) {
            setStatus("请勾选至少一个目标堆，或将 preset_text 连到 Lora 堆的 lora_preset", "err");
            relayout();
            return;
        }

        // 记录被替代的状态：每个堆只保留一份，新配方直接覆盖旧快照
        const backup = {
            stacks: {},
            presetText: readWidgetValue("preset_text"),
            promptText: readWidgetValue("prompt_text"),
            promptTargets: snapshotPromptTargets(node),
        };
        if (hasLora) {
            for (const id of ids) {
                const stackNode = findNodeById(id);
                if (stackNode) backup.stacks[String(id)] = snapshotStackRows(stackNode);
            }
        }
        node.properties.xbhhPmBackup = backup;
        node.properties.xbhhPmSelectedRecipe = recipe.id;
        syncActiveUi();

        // 提示词：应用即把「非空」提示词直接赋值到 prompt 连线目标节点的文本框
        // （为空则校验不通过，不覆盖目标；无连线时仅写入 prompt 输出口）
        let promptWritten = 0;
        if (hasPrompt) {
            writePromptText(node, prompt);
            promptWritten = applyPromptToWiredTargets(node, prompt);
        }
        const promptTail = hasPrompt
            ? (promptWritten ? `，提示词→${promptWritten} 个连线节点` : "，提示词未连目标（仅写入输出）")
            : "";

        if (!hasLora) {
            // 没有 LoRA：提示词已按上面的逻辑输出，这里只做状态反馈
            if (hasPrompt) setStatus(`配方「${recipeName}」没有 LoRA${promptTail}`, "ok");
            else setStatus(`配方「${recipeName}」没有 LoRA（提示词为空，未输出）`, "err");
            relayout();
            return;
        }

        // 统一走前端桥接：直接改堆内的 LoRA 行，保证界面上看得见、执行时也一定生效。
        // （preset_text 仍会写出，供「有线」场景把文本继续传给后端。）
        const bridge = getBridge();
        if (!bridge) {
            setStatus("未找到画布桥接，请刷新页面后重试", "err");
            return;
        }
        let r;
        try {
            r = bridge.preset(text, ids);
        } catch (e) {
            r = { ok: false, error: String(e) };
        }
        if (!r || !r.ok) {
            setStatus(`应用失败：${(r && r.error) || "未知错误"}`, "err");
            return;
        }
        const stackCount = r.count;

        writePresetText(node, text);
        if (stackCount && wired) setStatus(`已应用「${recipeName}」→ ${stackCount} 个堆（含连线目标），再点一次可取消${promptTail}`, "ok");
        else if (stackCount) setStatus(`已应用「${recipeName}」→ ${stackCount} 个堆，再点一次可取消${promptTail}`, "ok");
        else setStatus(`已应用「${recipeName}」→ 已写入 preset_text（随连线发送）${promptTail}`, "ok");
        refreshTargets();
        relayout();
    }

    async function refreshRecipes(force) {
        recipeList = await loadRecipes(force);
        renderCategoryOptions();
        renderRecipes();
        relayout();
    }

    // ---- 事件绑定 ----
    search.addEventListener("input", () => {
        node._pmSearch = search.value;
        renderRecipes();
    });
    cat.addEventListener("change", () => {
        currentCat = cat.value;
        node._pmCat = currentCat;
        renderRecipes();
    });
    btnRefresh.addEventListener("click", () => {
        lastSig = ""; // 强制重绘
        refreshTargets();
    });
    btnReload.addEventListener("click", () => {
        setStatus("正在重新读取配方…", "");
        refreshRecipes(true).then(() => setStatus("配方已刷新", "ok"));
    });

    // 卡片 / 列表视图切换（记忆到节点属性，随工作流保存）
    btnCard.addEventListener("click", () => {
        view = "card";
        if (node.properties) node.properties.xbhhPmView = view;
        applyView();
        renderRecipes();
        relayout();
    });
    btnList.addEventListener("click", () => {
        view = "list";
        if (node.properties) node.properties.xbhhPmView = view;
        applyView();
        renderRecipes();
        relayout();
    });

    // 目标区折叠 / 展开（点标题行任意处，刷新按钮除外）
    headTargets.addEventListener("click", (e) => {
        if (btnRefresh.contains(e.target)) return;
        targetsCollapsed = !targetsCollapsed;
        if (node.properties) node.properties.xbhhPmTargetsCollapsed = targetsCollapsed;
        applyTargetsCollapse();
        relayout();
    });

    // ---- 首次渲染 + 定时刷新目标列表 ----
    applyView();
    applyTargetsCollapse();
    refreshTargets();
    refreshRecipes(false);
    const timer = setInterval(refreshTargets, 1500);
    node._pmTimer = timer;
    node._pmRefresh = () => {
        lastSig = "";
        refreshTargets();
        refreshRecipes(false);
    };

    return { root, relayout };
}

// ---------------------------------------------------------------------------
// 样式（作用域限定在 .pm-root 内，不污染 ComfyUI 主题）
// ---------------------------------------------------------------------------
const PM_STYLE_ID = "xbhh-pm-styles";
function injectStyles() {
    if (document.getElementById(PM_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PM_STYLE_ID;
    style.textContent = `
.pm-root {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 12px;
    color: #e6e8ef;
    background: linear-gradient(160deg, #1b1e2b 0%, #171a24 100%);
    border: 1px solid #2c3140;
    border-radius: 10px;
    overflow: hidden;
}
.pm-root * { box-sizing: border-box; }
.pm-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
    flex: 0 0 auto;
    background: rgba(255,255,255,0.03);
    border: 1px solid #2a2f3d;
    border-radius: 8px;
    padding: 8px;
}
/* 配方区随节点高度伸缩，列表跟着变高 */
.pm-section--grow { flex: 1 1 auto; }
.pm-headrow { display: flex; align-items: center; gap: 6px; }
.pm-title { font-weight: 600; font-size: 12px; color: #cfd4e6; flex: 1; }
.pm-count {
    font-size: 11px; color: #8f96ad;
    background: #232838; border-radius: 8px; padding: 0 6px; line-height: 16px;
}
.pm-btn {
    cursor: pointer;
    background: #2b3143; color: #d4d9ea; border: 1px solid #3a4157;
    border-radius: 6px; padding: 2px 8px; font-size: 12px; line-height: 16px;
}
.pm-btn:hover { background: #363d54; border-color: #4a5470; }
.pm-targets { max-height: 110px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.pm-target {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 6px; border-radius: 6px; cursor: pointer;
    background: rgba(255,255,255,0.02);
}
.pm-target:hover { background: rgba(255,255,255,0.06); }
.pm-target input { accent-color: #6d7cff; cursor: pointer; }
.pm-target-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-target-meta { font-size: 10px; color: #8f96ad; }
.pm-hint { font-size: 10px; color: #7d849b; }
.pm-clickable { cursor: pointer; user-select: none; }
.pm-caret { width: 12px; flex: 0 0 12px; text-align: center; color: #8f96ad; font-size: 10px; }
.pm-targets-body { display: flex; flex-direction: column; gap: 6px; }
.pm-viewtoggle { display: flex; border: 1px solid #3a4157; border-radius: 6px; overflow: hidden; }
.pm-viewbtn {
    cursor: pointer; background: #2b3143; color: #a7adc4; border: none;
    padding: 2px 8px; font-size: 11px; line-height: 16px;
}
.pm-viewbtn:hover { background: #363d54; }
.pm-viewbtn.pm-on { background: #5563e6; color: #fff; }
.pm-toolbar { display: flex; gap: 6px; }
.pm-search {
    flex: 1; min-width: 0; background: #141824; color: #e6e8ef;
    border: 1px solid #2f3648; border-radius: 6px; padding: 4px 8px; font-size: 12px;
}
.pm-cat {
    background: #141824; color: #e6e8ef; border: 1px solid #2f3648;
    border-radius: 6px; padding: 4px 6px; font-size: 12px; max-width: 110px;
}
.pm-search:focus, .pm-cat:focus { outline: none; border-color: #6d7cff; }
.pm-list {
    flex: 1 1 auto;
    height: auto;
    min-height: 120px;
    overflow-y: auto;
    padding-right: 2px;
    /* 卡片视图：CSS Grid 自适应排布，浏览器按容器宽度自动决定列数，无需 JS 计算边长 */
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
    gap: 8px;
    align-content: start;
}
.pm-list--list {
    /* 列表视图：改回单列紧凑排布 */
    display: flex;
    flex-direction: column;
    gap: 3px;
}
.pm-card {
    display: flex; flex-direction: column; gap: 5px;
    padding: 6px; border-radius: 8px; cursor: pointer;
    background: #202434; border: 1px solid #2b3143;
    transition: border-color .12s, background .12s;
    min-width: 0;
}
.pm-card:hover { border-color: #4a5470; background: #252a3d; }
.pm-card.pm-active { border-color: #6d7cff; box-shadow: 0 0 0 1px #6d7cff inset; }
/* 卡片内的缩略图占满整宽并保持正方形 */
.pm-card > .pm-thumb {
    width: 100%; height: auto; flex: none;
    aspect-ratio: 1 / 1; font-size: 28px;
}
.pm-card .pm-info { align-items: center; text-align: center; gap: 3px; }
.pm-card .pm-name { font-size: 11px; }
.pm-card .pm-meta { font-size: 9px; }
.pm-card .pm-apply { width: 100%; padding: 4px 0; font-size: 11px; }
.pm-row {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 6px; border-radius: 6px; cursor: pointer;
    background: #202434; border: 1px solid transparent;
    transition: border-color .12s, background .12s;
}
.pm-row:hover { background: #252a3d; border-color: #4a5470; }
.pm-row.pm-active { border-color: #6d7cff; background: #232a45; }
.pm-thumb-sm { width: 24px; height: 24px; flex: 0 0 24px; border-radius: 4px; font-size: 13px; }
.pm-row-name { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-row-meta { flex: 0 0 auto; font-size: 10px; color: #8f96ad; }
.pm-apply-sm { padding: 3px 8px; font-size: 11px; }
.pm-thumb {
    width: 40px; height: 40px; flex: 0 0 40px;
    border-radius: 6px; background: #141824; color: #5a6178;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; overflow: hidden;
}
.pm-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pm-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pm-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-meta { font-size: 10px; color: #8f96ad; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-apply {
    flex: 0 0 auto; cursor: pointer;
    background: linear-gradient(180deg, #6d7cff, #5563e6); color: #fff;
    border: none; border-radius: 6px; padding: 5px 10px; font-size: 12px; font-weight: 600;
}
.pm-apply:hover { filter: brightness(1.1); }
.pm-empty { color: #7d849b; font-size: 11px; padding: 8px 4px; text-align: center; }
.pm-status { font-size: 11px; color: #8f96ad; min-height: 14px; }
.pm-status.pm-ok { color: #6fd18a; }
.pm-status.pm-err { color: #ff7a8a; }
.pm-list::-webkit-scrollbar, .pm-targets::-webkit-scrollbar { width: 8px; }
.pm-list::-webkit-scrollbar-thumb, .pm-targets::-webkit-scrollbar-thumb {
    background: #3a4157; border-radius: 4px;
}
.pm-list::-webkit-scrollbar-track, .pm-targets::-webkit-scrollbar-track { background: transparent; }
`;
    document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// 扩展注册
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "xbhh.RecipePresetManager",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            injectStyles();

            // 序列化隐藏 widget，保证 preset_text / prompt_text 随工作流保存
            this.serialize_widgets = true;

            // 隐藏 preset_text / prompt_text widget（仍参与序列化，值由面板写入）
            for (const name of ["preset_text", "prompt_text"]) {
                const w = this.widgets && this.widgets.find((x) => x.name === name);
                if (w) {
                    w.hidden = true;
                    w.computeSize = () => [0, -4];
                }
            }

            // 挂载自定义 DOM 面板
            try {
                const panel = attachPanel(this);
                if (typeof this.addDOMWidget === "function") {
                    const w = this.addDOMWidget("xbhh_pm_panel", "div", panel.root, {
                        serialize: false,
                        hideOnZoom: false,
                        getMinHeight: () => PANEL_MIN_HEIGHT,
                    });
                    if (w) {
                        // 不设置 w.computeSize：留空才会被 ComfyUI 当作「可伸缩 widget」，
                        // 拖高节点时面板才会跟着分配更多高度（详见 relayout 注释）。
                        //
                        // 宽度必须锁在节点宽度上：ComfyUI 1.5x 的属性面板会用 WidgetLegacy
                        // 渲染选中节点的 widget，把面板内那个容器的像素宽度写进 widget.width
                        // （Comfy-Org/ComfyUI_frontend#12443、#12444 未合并）。而画布上的
                        // DOM widget 取 widget.width || node.size[0] 作为宽度，于是一旦被写入
                        // 就永久钉死在那个窄值上，面板再也跟不上节点宽度。这里把 width 设为
                        // 只读派生值，让前端的赋值静默失效。
                        const node = this;
                        Object.defineProperty(w, "width", {
                            configurable: true,
                            enumerable: false,
                            get: () => node.size[0],
                            set: () => {},
                        });
                        this._pmPanelWidget = w;
                        panel.relayout();
                    }
                } else {
                    console.warn("[XBHH] 当前前端不支持 addDOMWidget，预设管理面板无法显示");
                }
            } catch (e) {
                console.error("[XBHH] 预设管理面板初始化失败", e);
            }

            this.size = [380, 560];
            this.resizable = true;
            this.color = "#2a3050";
            this.bgcolor = "#1b1e2b";

            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            setTimeout(() => this._pmRefresh && this._pmRefresh(), 0);
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (this._pmTimer) clearInterval(this._pmTimer);
            this._pmTimer = null;
            return onRemoved ? onRemoved.apply(this, arguments) : undefined;
        };
    },
});
