import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

// ============================================================================
// XBHH LoRA 测试堆前端
// 与 Multi Lora Loader Plus 界面/功能一致，区别：
// - 无强度交互（权重固定 1.0）
// - 顶部有 测试位置 / 进度 / 开始·停止·重置 控件
// - 每次执行完成后自动将测试位置 +1 并重新排队，依次跑完全部 LoRA
// ============================================================================

const NODE_NAME = "XBHHLoraTestLoader";
const IMAGE_SIZE = 300;

// 图片图标（Remix Icon image-2-fill）：颜色跟随行内文字色，启用 #ddd / 关闭 #777
const IMAGE_ICON_PATH = "M5 11.1l2-2 5.5 5.5 3.5-3.5 3 3V5H5v6.1zM4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm11.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z";

function imageIconSvg(size, color) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"><path fill="${color}" d="${IMAGE_ICON_PATH}"/></svg>`;
}

// canvas 绘制用：按文字色预加载两态图标
const imageIconCanvas = {
    on: new Image(),
    off: new Image()
};
imageIconCanvas.on.src = "data:image/svg+xml," + encodeURIComponent(imageIconSvg(14, "#ddd"));
imageIconCanvas.off.src = "data:image/svg+xml," + encodeURIComponent(imageIconSvg(14, "#777"));

// ============================================================================
// 前缀树 (Trie Tree) 模糊搜索引擎
// ============================================================================
// 搜索归一化：小写并彻底去除分隔符（空格/_-./\ 等），使 "chen bin" 与 "chen-bin_v4" 互相命中
// 注意：与 lora_manager.html 内的同名函数保持规则一致
function normalizeSearchKey(s) {
    return String(s || "").toLowerCase().replace(/[\/\\_\-\s.]+/g, "");
}

// 模糊匹配：查询按空格拆词，每个词都命中归一化文本才算（AND 语义）
function fuzzyTokenMatch(text, query) {
    const nText = normalizeSearchKey(text);
    if (!nText) return false;
    return query.split(/\s+/).filter(Boolean).every(t => nText.includes(normalizeSearchKey(t)));
}

class TrieNode {
    constructor() {
        this.children = {};
        this.items = new Set();
    }
}

class Trie {
    constructor() {
        this.root = new TrieNode();
    }

    insert(word, item) {
        word = normalizeSearchKey(word);
        if (!word) return;
        let node = this.root;
        for (const char of word) {
            if (!node.children[char]) {
                node.children[char] = new TrieNode();
            }
            node = node.children[char];
            node.items.add(item);
        }
    }

    search(prefix) {
        prefix = normalizeSearchKey(prefix);
        if (!prefix) return [];
        let node = this.root;
        for (const char of prefix) {
            if (!node.children[char]) return [];
            node = node.children[char];
        }
        return Array.from(node.items);
    }
}

// ============================================================================
// 全局数据
// ============================================================================
let loraImages = {};
let loraList = [];
let loraTrie = new Trie();

let shiftKeyPressed = false;
window.addEventListener("keydown", e => { if (e.key === "Shift") shiftKeyPressed = true; }, true);
window.addEventListener("keyup", e => { if (e.key === "Shift") shiftKeyPressed = false; }, true);
window.addEventListener("blur", () => { shiftKeyPressed = false; });

function encodeRFC3986URIComponent(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// 显示用：去掉 .safetensors 后缀，避免文本过长（仅用于展示，不影响实际取用的名称）
function stripSafetensorsExt(name) {
    return typeof name === "string" ? name.replace(/\.safetensors$/i, "") : name;
}

// 行内文件名展示（含路径切分）
function displayNameOf(loraName) {
    return loraName ? stripSafetensorsExt(String(loraName).split(/[\/\\]/).pop()) : "";
}

function rebuildLoraTrie() {
    loraTrie = new Trie();
    for (const loraName of loraList) {
        loraTrie.insert(loraName, loraName);
        const filename = loraName.split(/[\/\\]/).pop();
        loraTrie.insert(filename, loraName);
        const filenameNoExt = filename.substring(0, filename.lastIndexOf('.')) || filename;
        loraTrie.insert(filenameNoExt, loraName);
        const parts = loraName.split(/[\/\_\-\s\.]/);
        for (const part of parts) {
            if (part && part.length > 1) {
                loraTrie.insert(part, loraName);
            }
        }
    }
}

async function loadLoraData() {
    try {
        const [images, loras] = await Promise.all([
            api.fetchApi("/xbhh/images/loras").then(r => r.json()),
            api.fetchApi("/xbhh/loras").then(r => r.json())
        ]);
        loraImages = images;
        loraList = loras;
        rebuildLoraTrie();
    } catch (error) {
        console.error("XBHH: Error loading lora data", error);
    }
}

// 静默清理：文件已被移动/删除的 LoRA，自动移除测试堆内空占位行
function pruneStaleLoraRows() {
    if (!loraList.length || !app.graph?._nodes) return;
    const valid = new Set(loraList);
    for (const node of app.graph._nodes) {
        if (node.type !== NODE_NAME || !Array.isArray(node.loraWidgets)) continue;
        const stale = node.loraWidgets.filter(w => {
            const n = Array.isArray(w.value?.lora) ? w.value.lora[0] : w.value?.lora;
            return n && n !== "None" && !valid.has(n);
        });
        for (const w of stale) {
            console.warn(`[XBHH] LoRA 文件已不存在，自动移除测试堆内空行: ${w.value?.lora}`);
            node.removeLoraWidget(w);
        }
        if (stale.length) {
            try {
                node.size[1] = node.computeSize()[1];
                node.setDirtyCanvas(true, true);
            } catch (e) { /* 忽略尺寸计算异常 */ }
        }
    }
}

// 后台刷新 LoRA 列表：新添加的文件无需刷新页面即可在选择器中搜到
let loraRefreshPromise = null;
function refreshLoraList() {
    if (loraRefreshPromise) return loraRefreshPromise;
    loraRefreshPromise = (async () => {
        try {
            const r = await api.fetchApi("/xbhh/loras");
            const fresh = await r.json();
            if (Array.isArray(fresh)) {
                const known = new Set(loraList);
                if (fresh.some(n => !known.has(n))) {
                    api.fetchApi("/xbhh/images/loras")
                        .then(r => r.json())
                        .then(imgs => { if (imgs && typeof imgs === "object") loraImages = imgs; })
                        .catch(() => {});
                }
                loraList = fresh;
                rebuildLoraTrie();
            }
        } catch (e) {
            console.warn("XBHH: 刷新 LoRA 列表失败", e);
        } finally {
            loraRefreshPromise = null;
        }
        pruneStaleLoraRows();
    })();
    return loraRefreshPromise;
}

// ============================================================================
// 图片预览
// ============================================================================
let imageHostTest = null;

function getImageHost() {
    if (!imageHostTest) {
        imageHostTest = $el("img", {
            className: "xbhh-preview-image-test",
            style: {
                position: "fixed",
                left: "0",
                top: "0",
                width: `${IMAGE_SIZE}px`,
                height: `${IMAGE_SIZE}px`,
                objectFit: "contain",
                zIndex: "100002",
                pointerEvents: "none",
                background: "#1a1a1a",
                border: "2px solid #444",
                borderRadius: "8px",
                display: "none"
            }
        });
        document.body.appendChild(imageHostTest);
    }
    return imageHostTest;
}

function showPreviewAt(loraName, x, y) {
    const host = getImageHost();
    if (!loraName || !loraImages[loraName]) {
        hidePreview();
        return;
    }

    host.src = `/xbhh/view/${encodeRFC3986URIComponent(loraImages[loraName])}?${+new Date()}`;
    host.style.display = "block";

    let left = x + 10;
    let top = y - IMAGE_SIZE / 2;

    const bw = window.innerWidth;
    const bh = window.innerHeight;

    if (left + IMAGE_SIZE > bw) left = x - IMAGE_SIZE - 10;
    if (top + IMAGE_SIZE > bh) top = bh - IMAGE_SIZE - 10;
    if (top < 10) top = 10;

    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
}

function hidePreview() {
    const host = getImageHost();
    host.style.display = "none";
}

// 当前是否有文本输入框获得焦点（如权重编辑弹窗 canvas.prompt 的输入框）。
// 用于抑制悬浮预览，避免预览图盖住正在编辑的输入框。
function isTextInputFocused() {
    const ae = document.activeElement;
    if (!ae) return false;
    return ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable === true;
}

// 在指定矩形（如 LoRA 选择弹窗）旁边显示预览图，避免弹窗遮挡预览
function showPreviewBeside(loraName, rect, gap = 12) {
    const host = getImageHost();
    if (!loraName || !loraImages[loraName]) {
        hidePreview();
        return;
    }

    host.src = `/xbhh/view/${encodeRFC3986URIComponent(loraImages[loraName])}?${+new Date()}`;
    host.style.display = "block";

    const bw = window.innerWidth;
    const bh = window.innerHeight;

    // 优先放在矩形右侧，右侧空间不足则放到左侧
    let left = rect.right + gap;
    if (left + IMAGE_SIZE > bw - 10) left = rect.left - IMAGE_SIZE - gap;
    if (left < 10) left = 10;

    let top = rect.top + (rect.height - IMAGE_SIZE) / 2;
    if (top + IMAGE_SIZE > bh - 10) top = bh - IMAGE_SIZE - 10;
    if (top < 10) top = 10;

    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
}

// ============================================================================
// 测试循环驱动
// 全局单例：同一时间只允许一个测试堆在跑。
// 流程：开始 → 重置索引为 0 并排队 → 本轮执行结束（队列空闲）→ 索引 +1 再排队
//       → 直到跑完全部 LoRA 自动停止并归零
// 可靠性设计：
// - 推进位置以后端 executed 回传的 ui.index（实际执行到的位置）为准，
//   本地 widget 值仅作兜底，避免本地值过期导致同一轮反复执行
// - ran 标志防双推进（executing null / execution_success 只消费一次）
// - 排队后开启看门狗，超过 4 秒未开始执行自动重试排队
// ============================================================================
const testState = {
    node: null,        // 当前正在测试的节点实例
    running: false,    // 循环是否进行中
    ran: false,        // 本轮执行中测试节点是否真的执行过（防止无关队列触发推进）
    ui: null,          // 后端返回的最新执行信息 {index, total, lora, status}
    awaitingStart: false, // 已排队、等待 execution_start
    watchdogTimer: null
};

function getTestSeq(node) {
    return (node.loraWidgets || []).filter(w =>
        w.value?.lora && w.value.lora !== "None" && w.value.on !== false);
}

function getTestIndex(node) {
    const v = Number(node?._testIdxWidget?.value) || 0;
    return Math.max(0, Math.floor(v));
}

function setTestIndex(node, v) {
    if (node?._testIdxWidget) {
        node._testIdxWidget.value = Math.max(0, Math.floor(v) || 0);
    }
}

function queueTestRound(tag) {
    const node = testState.node;
    testState.awaitingStart = true;
    try {
        app.queuePrompt(0);
        console.log(`[XBHH test] 已排队下一轮(${tag})`);
    } catch (e) {
        console.warn("[XBHH test] 排队失败:", e);
    }
    // 看门狗：排队后长时间未开始执行则重试一次（覆盖排队被静默吞掉的场景）
    if (testState.watchdogTimer) clearTimeout(testState.watchdogTimer);
    testState.watchdogTimer = setTimeout(() => {
        testState.watchdogTimer = null;
        if (testState.running && testState.awaitingStart) {
            console.warn("[XBHH test] 排队后 4 秒仍未开始执行，重试排队");
            try { app.queuePrompt(0); } catch (e) { /* 忽略 */ }
        }
    }, 4000);
}

function stopLoopInternal() {
    testState.running = false;
    testState.awaitingStart = false;
    if (testState.watchdogTimer) {
        clearTimeout(testState.watchdogTimer);
        testState.watchdogTimer = null;
    }
    testState.node?.setDirtyCanvas?.(true, true);
}

function startTest(node) {
    const seq = getTestSeq(node);
    if (!seq.length) {
        alert("请先添加 LoRA 再开始测试");
        return;
    }
    if (testState.running && testState.node && testState.node !== node) {
        alert("已有另一个测试堆在运行中，请先停止它");
        return;
    }
    testState.node = node;
    testState.running = true;
    testState.ran = false;
    testState.ui = null;
    setTestIndex(node, 0);
    node.setDirtyCanvas(true, true);
    queueTestRound("start");
}

function stopTest(node) {
    if (!node || testState.node === node) {
        stopLoopInternal();
    }
}

function resetTest(node) {
    setTestIndex(node, 0);
    if (testState.node === node) testState.ui = null;
    node.setDirtyCanvas(true, true);
}

function advanceTest() {
    // 防双推进：本轮的 executed 只允许消费一次
    if (!testState.ran) return;
    testState.ran = false;

    const node = testState.node;
    if (!node || !testState.running) return;

    const localIdx = getTestIndex(node);
    // 以后端实际执行到的位置为准（本地 widget 值可能因各种原因过期）
    const uiIdx = Number(testState.ui?.index);
    const ranIdx = Number.isFinite(uiIdx) ? Math.max(0, Math.floor(uiIdx)) : localIdx;
    const total = getTestSeq(node).length;
    const next = ranIdx + 1;

    console.log(`[XBHH test] 本轮完成: 实际=${ranIdx} 本地=${localIdx} 共=${total}`);

    if (next >= total) {
        // 全部跑完：自动停止并归零
        stopLoopInternal();
        testState.node = null;
        testState.ui = null;
        setTestIndex(node, 0);
        node.setDirtyCanvas(true, true);
        console.log("[XBHH test] 全部 LoRA 测试完成");
    } else {
        setTestIndex(node, next);
        node.setDirtyCanvas(true, true);
        queueTestRound(`idx=${next}`);
    }
}

api.addEventListener("execution_start", () => {
    testState.awaitingStart = false;
    testState.ran = false;
});

api.addEventListener("executed", ({ detail }) => {
    try {
        if (!testState.running || !testState.node) return;
        // node id 统一按字符串比较，规避 number/string 类型差异
        if (String(detail?.node) !== String(testState.node.id)) return;
        testState.ran = true;
        // ComfyUI executed 消息的 ui 数据在 output 字段（兼容旧的 data 字段）
        const raw = detail?.output?.test?.[0] ?? detail?.data?.test?.[0];
        if (raw) {
            testState.ui = JSON.parse(raw);
            testState.node.setDirtyCanvas(true, true);
        }
    } catch (e) { /* 忽略解析异常 */ }
});

api.addEventListener("executing", ({ detail }) => {
    try {
        // 仅在整个队列空闲（本轮执行结束）时推进下一轮
        // detail 可能为 null 或 {node: null, prompt_id}，两种形态都视为空闲
        if (detail && detail.node !== null && detail.node !== undefined) return;
        if (testState.running && testState.ran) advanceTest();
    } catch (e) { /* 忽略 */ }
});

// 兜底：部分前端版本执行完成会派发 execution_success
api.addEventListener("execution_success", () => {
    try {
        if (testState.running && testState.ran) advanceTest();
    } catch (e) { /* 忽略 */ }
});

api.addEventListener("execution_error", () => {
    if (testState.running) {
        console.warn("[XBHH test] 执行出错，测试循环停止");
        stopLoopInternal();
    }
});

api.addEventListener("execution_interrupted", () => {
    if (testState.running) {
        console.warn("[XBHH test] 执行被中断，测试循环停止");
        stopLoopInternal();
    }
});

// ============================================================================
// 预设导入/导出对话框
// ============================================================================
function showPresetDialog(node, mode) {
    const existing = document.querySelector(".xbhh-preset-dialog-test");
    if (existing) existing.remove();

    const dialog = $el("div.xbhh-preset-dialog-test", {
        style: {
            position: "fixed",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: "500px",
            background: "#1e1e24",
            border: "1px solid #3d3d4e",
            borderRadius: "12px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
            zIndex: "10000",
            fontFamily: "Arial, sans-serif",
            overflow: "hidden"
        }
    });

    // 标题栏
    const header = $el("div", {
        style: {
            padding: "15px 20px",
            background: "#282832",
            borderBottom: "1px solid #3d3d4e",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
        }
    });

    const title = $el("span", {
        style: {
            color: "#60a5fa",
            fontWeight: "bold",
            fontSize: "16px"
        },
        textContent: mode === "export" ? "📤 导出 LoRA 预设" : "📥 导入 LoRA 预设"
    });

    const closeBtn = $el("button", {
        style: {
            background: "none",
            border: "none",
            color: "#888",
            fontSize: "20px",
            cursor: "pointer",
            padding: "0 5px"
        },
        textContent: "✕",
        onclick: () => dialog.remove()
    });
    closeBtn.onmouseenter = () => { closeBtn.style.color = "#ff6b6b"; };
    closeBtn.onmouseleave = () => { closeBtn.style.color = "#888"; };

    header.appendChild(title);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    // 内容区域
    const content = $el("div", {
        style: {
            padding: "20px"
        }
    });

    // 提示文字
    const hint = $el("div", {
        style: {
            color: "#aaa",
            fontSize: "12px",
            marginBottom: "10px"
        },
        textContent: mode === "export"
            ? "以下是当前测试堆 LoRA 配置的预设文本，可复制保存（权重固定 1.0）："
            : "粘贴预设文本到下方，然后点击导入（权重固定 1.0）："
    });
    content.appendChild(hint);

    // 文本区域
    const textarea = $el("textarea", {
        style: {
            width: "100%",
            height: "200px",
            background: "#1a1a1a",
            border: "1px solid #444",
            borderRadius: "6px",
            color: "#ddd",
            fontSize: "12px",
            fontFamily: "Consolas, monospace",
            padding: "10px",
            resize: "vertical",
            boxSizing: "border-box"
        },
        placeholder: "格式: enabled|lora_name|strength_model|strength_clip\n例如: 1|my_lora.safetensors|1.0|1.0"
    });

    // 如果是导出模式，生成预设文本
    if (mode === "export") {
        const lines = [];
        for (const w of node.loraWidgets || []) {
            if (w.value?.lora && w.value.on) {
                const enabled = "1";
                const lora = w.value.lora;
                const trigger = w.value.trigger || "";
                lines.push(`${enabled}|${lora}|1.0|1.0|${trigger}|1.0`);
            }
        }
        textarea.value = lines.join("\n");
        textarea.readOnly = false;
    }

    content.appendChild(textarea);

    // 按钮区域
    const buttons = $el("div", {
        style: {
            marginTop: "15px",
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px"
        }
    });

    if (mode === "export") {
        // 复制按钮
        const copyBtn = $el("button", {
            style: {
                padding: "8px 20px",
                background: "#3b82f6",
                border: "none",
                borderRadius: "6px",
                color: "#fff",
                fontSize: "14px",
                cursor: "pointer"
            },
            textContent: "📋 复制到剪贴板",
            onclick: async () => {
                try {
                    await navigator.clipboard.writeText(textarea.value);
                    copyBtn.textContent = "✅ 已复制!";
                    setTimeout(() => { copyBtn.textContent = "📋 复制到剪贴板"; }, 2000);
                } catch (e) {
                    textarea.select();
                    document.execCommand("copy");
                    copyBtn.textContent = "✅ 已复制!";
                    setTimeout(() => { copyBtn.textContent = "📋 复制到剪贴板"; }, 2000);
                }
            }
        });
        buttons.appendChild(copyBtn);
    } else {
        // 导入按钮（解析权重字段：strength_model|strength_clip|trigger|trigger_weight）
        const importBtn = $el("button", {
            style: {
                padding: "8px 20px",
                background: "#3b82f6",
                border: "none",
                borderRadius: "6px",
                color: "#fff",
                fontSize: "14px",
                cursor: "pointer"
            },
            textContent: "📥 导入",
            onclick: () => {
                const text = textarea.value.trim();
                if (!text) {
                    alert("请输入预设文本");
                    return;
                }

                // 先关掉所有已启用的 LoRA，再按预设内容重新启用
                for (const w of node.loraWidgets || []) {
                    if (w.value?.on) w.value.on = false;
                }

                const lines = text.split("\n");
                for (const line of lines) {
                    const parts = line.trim().split("|");
                    if (parts.length >= 2) {
                        const enabled = parts[0] === "1";
                        const loraName = parts[1];
                        const strength = parseFloat(parts[2]) || 1.0;
                        const strengthTwo = parseFloat(parts[3]) || strength;
                        const trigger = parts[4] || "";
                        const triggerWeight = parseFloat(parts[5]) || 1.0;

                        let existingW = (node.loraWidgets || []).find(w => w.value?.lora === loraName);
                        if (existingW) {
                            existingW.value.on = enabled;
                            existingW.value.strength = strength;
                            existingW.value.strengthTwo = strengthTwo;
                            if (trigger) existingW.value.trigger = trigger;
                            existingW.value.triggerWeight = triggerWeight;
                        } else {
                            const w = node.addLoraRow(loraName);
                            w.value.on = enabled;
                            w.value.strength = strength;
                            w.value.strengthTwo = strengthTwo;
                            w.value.trigger = trigger;
                            w.value.triggerWeight = triggerWeight;
                        }
                    }
                }

                node.setDirtyCanvas(true, true);
                dialog.remove();
            }
        });
        buttons.appendChild(importBtn);
    }

    // 关闭按钮
    const cancelBtn = $el("button", {
        style: {
            padding: "8px 20px",
            background: "#444",
            border: "none",
            borderRadius: "6px",
            color: "#ccc",
            fontSize: "14px",
            cursor: "pointer"
        },
        textContent: "关闭",
        onclick: () => dialog.remove()
    });
    buttons.appendChild(cancelBtn);

    content.appendChild(buttons);
    dialog.appendChild(content);
    document.body.appendChild(dialog);
}

// ============================================================================
// 自定义LoRA选择对话框 (带搜索功能)
// ============================================================================
function showLoraChooserDialog(event, callback, options = {}) {
    const singleSelect = !!options.singleSelect;
    const existing = document.querySelector(".xbhh-lora-dialog-test");
    if (existing) existing.remove();

    const splitBy = /[\/\\]/;

    const dialog = $el("div.xbhh-lora-dialog-test", {
        style: {
            position: "fixed",
            left: `${event.clientX || 100}px`,
            top: `${event.clientY || 100}px`,
            background: "#222",
            border: "1px solid #555",
            borderRadius: "6px",
            padding: "0",
            minWidth: "280px",
            maxWidth: "450px",
            maxHeight: "70vh",
            zIndex: "100001",
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
            fontSize: "13px",
            display: "flex",
            flexDirection: "column"
        }
    });

    const selectedItems = new Set();

    function reposition() {
        if (!dialog.parentNode) return;
        const rect = dialog.getBoundingClientRect();
        const curX = event.clientX || 100;
        const curY = event.clientY || 100;

        let targetLeft = curX + 20; // 默认显示在右侧
        if (targetLeft + rect.width > window.innerWidth - 10) {
            targetLeft = curX - rect.width - 20; // 空间不足则显示在左侧
        }
        if (targetLeft < 10) targetLeft = 10;

        let targetTop = curY - rect.height / 2; // 垂直居中于光标

        if (targetTop + rect.height > window.innerHeight - 10) {
            targetTop = window.innerHeight - rect.height - 10;
        }
        if (targetTop < 10) targetTop = 10;

        dialog.style.left = `${targetLeft}px`;
        dialog.style.top = `${targetTop}px`;
    }

    // 搜索框容器
    const searchContainer = $el("div", {
        style: {
            padding: "8px",
            borderBottom: "1px solid #444",
            background: "#2a2a2a"
        }
    });

    const searchInput = $el("input", {
        type: "text",
        placeholder: "🔍 搜索 LoRA...",
        style: {
            width: "100%",
            padding: "6px 10px",
            border: "1px solid #555",
            borderRadius: "4px",
            background: "#333",
            color: "#fff",
            fontSize: "13px",
            outline: "none",
            boxSizing: "border-box"
        }
    });
    searchContainer.appendChild(searchInput);
    dialog.appendChild(searchContainer);

    // 内容容器
    const contentContainer = $el("div", {
        style: {
            overflowY: "auto",
            flex: "1",
            maxHeight: "calc(70vh - 50px)"
        }
    });
    dialog.appendChild(contentContainer);

    const allItems = [];
    const allFolders = [];

    function createLoraItem(loraName, indent = 0) {
        const fileName = loraName.split(splitBy).pop();
        const displayName = stripSafetensorsExt(fileName);
        const hasImg = loraImages[loraName];

        const item = $el("div.xbhh-lora-item", {
            dataset: { lora: loraName, filename: fileName.toLowerCase() },
            style: {
                padding: "6px 12px",
                paddingLeft: `${12 + indent * 16}px`,
                cursor: "pointer",
                color: "#ddd",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                display: "flex",
                flexWrap: "nowrap",
                alignItems: "center"
            },
            onmouseenter: (e) => {
                item.style.background = selectedItems.has(loraName) ? "#2b384e" : "#3a3a3a";
                if (hasImg) {
                    showPreviewBeside(loraName, dialog.getBoundingClientRect());
                }
            },
            onmouseleave: () => {
                item.style.background = selectedItems.has(loraName) ? "#1e293b" : "";
                hidePreview();
            },
            onclick: () => {
                hidePreview();
                if (singleSelect) {
                    // 单选模式：直接确认并关闭
                    dialog.remove();
                    document.removeEventListener("pointerdown", closeHandler, true);
                    document.removeEventListener("keydown", escHandler);
                    callback([loraName]);
                    return;
                }
                if (selectedItems.has(loraName)) {
                    selectedItems.delete(loraName);
                    checkbox.checked = false;
                    item.style.background = "";
                } else {
                    selectedItems.add(loraName);
                    checkbox.checked = true;
                    item.style.background = "#1e293b";
                }
                if (typeof updateConfirmBtn === "function") updateConfirmBtn();
            }
        });

        const checkbox = $el("input", {
            type: "checkbox",
            style: { marginRight: "8px", pointerEvents: "none", display: singleSelect ? "none" : "" }
        });

        const textSpan = $el("span", {
            style: {
                display: "flex",
                alignItems: "center",
                gap: "5px",
                minWidth: "0",
                overflow: "hidden"
            }
        });
        if (hasImg) {
            textSpan.innerHTML = imageIconSvg(13, "#ddd");
        }
        textSpan.appendChild($el("span", {
            style: { overflow: "hidden", textOverflow: "ellipsis" },
            textContent: displayName
        }));

        item.appendChild(checkbox);
        item.appendChild(textSpan);

        allItems.push({ element: item, loraName, fileName: fileName.toLowerCase() });
        return item;
    }

    function createFolder(name, content, indent = 0) {
        const folder = $el("div.xbhh-lora-folder");

        const header = $el("div.xbhh-folder-header", {
            style: {
                padding: "6px 12px",
                paddingLeft: `${12 + indent * 16}px`,
                cursor: "pointer",
                color: "#aaa",
                fontWeight: "bold"
            },
            textContent: `📁 ${name}`,
            onmouseenter: () => { header.style.background = "#333"; },
            onmouseleave: () => { header.style.background = ""; }
        });

        const children = $el("div.xbhh-folder-children", { style: { display: "none" } });

        for (const [subName, subContent] of content.entries()) {
            if (typeof subName === "symbol") continue;
            children.appendChild(createFolder(subName, subContent, indent + 1));
        }

        const items = content.get(Symbol.for("items")) || [];
        for (const loraName of items) {
            children.appendChild(createLoraItem(loraName, indent + 1));
        }

        header.onclick = () => {
            const isOpen = children.style.display !== "none";
            children.style.display = isOpen ? "none" : "block";
            header.textContent = isOpen ? `📁 ${name}` : `📂 ${name}`;
            requestAnimationFrame(reposition);
        };

        allFolders.push({ header, children, name });

        folder.appendChild(header);
        folder.appendChild(children);
        return folder;
    }

    function buildTree() {
        const folderMap = new Map();
        const rootItems = [];

        for (const loraName of loraList) {
            const path = loraName.split(splitBy);

            if (path.length === 1) {
                rootItems.push(loraName);
                continue;
            }

            let currentLevel = folderMap;
            for (let i = 0; i < path.length - 1; i++) {
                if (!currentLevel.has(path[i])) {
                    currentLevel.set(path[i], new Map());
                }
                currentLevel = currentLevel.get(path[i]);
            }

            if (!currentLevel.has(Symbol.for("items"))) {
                currentLevel.set(Symbol.for("items"), []);
            }
            currentLevel.get(Symbol.for("items")).push(loraName);
        }

        const noneItem = $el("div", {
            style: {
                padding: "6px 12px",
                cursor: "pointer",
                color: "#888",
                borderBottom: "1px solid #333"
            },
            textContent: "❌ None",
            onmouseenter: () => { noneItem.style.background = "#333"; },
            onmouseleave: () => { noneItem.style.background = ""; },
            onclick: () => {
                dialog.remove();
                callback("None");
            }
        });
        contentContainer.appendChild(noneItem);

        for (const [name, content] of folderMap.entries()) {
            contentContainer.appendChild(createFolder(name, content));
        }

        for (const loraName of rootItems) {
            contentContainer.appendChild(createLoraItem(loraName));
        }
    }

    buildTree();

    // 打开时后台刷新列表：新添加的 LoRA 无需刷新页面即可搜到，刷新完成后原地重建列表
    refreshLoraList().then(() => {
        if (!dialog.parentNode) return; // 弹窗已关闭
        allItems.length = 0;
        allFolders.length = 0;
        contentContainer.innerHTML = "";
        buildTree();
        if (searchInput.value.trim()) searchInput.oninput(); // 保持当前搜索状态
        requestAnimationFrame(reposition);
    });

    searchInput.oninput = () => {
        const query = searchInput.value.toLowerCase().trim();

        if (!query) {
            allItems.forEach(({ element }) => {
                element.style.display = "flex";
                element.style.paddingLeft = "";
            });
            allFolders.forEach(({ header, children }) => {
                header.style.display = "";
                children.style.display = "none";
                header.textContent = header.textContent.replace("📂", "📁");
            });
            requestAnimationFrame(reposition);
            return;
        }

        allFolders.forEach(({ header, children }) => {
            header.style.display = "none";
            children.style.display = "block";
        });

        const trieMatches = loraTrie.search(query);
        allItems.forEach(({ element, loraName, fileName }) => {
            // 分隔符模糊化：空格/_- 等价，多词 AND 匹配
            const matches = trieMatches.includes(loraName) || fuzzyTokenMatch(loraName, query) || fuzzyTokenMatch(fileName, query);
            element.style.display = matches ? "flex" : "none";
            if (matches) {
                element.style.paddingLeft = "12px";
            }
        });
        requestAnimationFrame(reposition);
    };

    setTimeout(() => searchInput.focus(), 50);

    document.body.appendChild(dialog);

    // 单选模式不显示底部确认栏
    if (!singleSelect) {
        const bottomBar = $el("div", {
            style: {
                padding: "10px",
                borderTop: "1px solid #444",
                background: "#2a2a2a",
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px"
            }
        });

        const confirmBtn = $el("button", {
            style: {
                padding: "6px 12px",
                background: "#4caf50",
                border: "none",
                borderRadius: "4px",
                color: "#fff",
                cursor: "pointer",
                fontWeight: "bold"
            },
            textContent: "添加选中 (0)",
            onclick: () => {
                hidePreview();
                dialog.remove();
                document.removeEventListener("pointerdown", closeHandler, true);
                document.removeEventListener("keydown", escHandler);
                callback(Array.from(selectedItems));
            }
        });

        window.updateConfirmBtn = function() {
            confirmBtn.textContent = `添加选中 (${selectedItems.size})`;
            confirmBtn.style.opacity = selectedItems.size > 0 ? "1" : "0.5";
            confirmBtn.disabled = selectedItems.size === 0;
        }
        updateConfirmBtn();

        bottomBar.appendChild(confirmBtn);
        dialog.appendChild(bottomBar);
    }

    reposition();

    // 点击外部关闭弹窗
    const closeHandler = (e) => {
        if (!dialog.contains(e.target)) {
            hidePreview();
            dialog.remove();
            document.removeEventListener("pointerdown", closeHandler, true);
            document.removeEventListener("keydown", escHandler);
        }
    };

    // ESC 键关闭弹窗
    const escHandler = (e) => {
        if (e.key === "Escape") {
            hidePreview();
            dialog.remove();
            document.removeEventListener("pointerdown", closeHandler, true);
            document.removeEventListener("keydown", escHandler);
        }
    };

    // 使用 requestAnimationFrame 确保在当前事件处理完成后再添加监听器
    requestAnimationFrame(() => {
        document.addEventListener("pointerdown", closeHandler, true);
        document.addEventListener("keydown", escHandler);
    });
}

// ============================================================================
// 触发词编辑（与 Plus 同语义：无预设走 prompt，有预设走多选组合弹窗）
// ============================================================================
async function openLoraPresetComboDialog(node, widget) {
    const loraName = widget.value.lora;
    if (!loraName) return;

    let dbProfiles = [];
    let dbActiveTrigger = "";

    try {
        const [resProfiles, resTrigger] = await Promise.all([
            api.fetchApi(`/xbhh/lora/profiles?name=${encodeURIComponent(loraName)}`),
            api.fetchApi(`/xbhh/lora/trigger?name=${encodeURIComponent(loraName)}`)
        ]);
        const dataProfiles = await resProfiles.json();
        dbProfiles = dataProfiles.profiles || [];

        const dataTrigger = await resTrigger.json();
        if (dataTrigger && dataTrigger.active_trigger !== undefined) {
            dbActiveTrigger = dataTrigger.active_trigger || "";
        }
    } catch (e) {
        console.error("Error fetching profiles or trigger:", e);
    }

    // 数据库为准：弹窗打开时用数据库最新触发词预填并刷新 widget 缓存
    let currentTrigger = dbActiveTrigger || widget.value.trigger || "";
    if (dbActiveTrigger && dbActiveTrigger !== widget.value.trigger) {
        widget.value.trigger = dbActiveTrigger;
        node.setDirtyCanvas(true, true);
    }
    if (currentTrigger === undefined || currentTrigger === null) {
        currentTrigger = "";
    }

    // 如果没有任何预设，走常规单行 Prompt 输入
    if (dbProfiles.length === 0) {
        app.canvas.prompt("触发词", currentTrigger, v => {
            if (v !== null && v !== undefined) {
                widget.value.trigger = v;
                node.setDirtyCanvas(true, true);
                api.fetchApi("/xbhh/lora/trigger/update", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: loraName, trigger: v })
                }).catch(err => console.error("Error saving trigger:", err));
            }
        });
        return;
    }

    // 如果存在预设，显示多选组合与在线修改弹窗
    let modalOverlay = document.getElementById("xbhh-test-preset-combo-modal");
    if (modalOverlay) modalOverlay.remove();

    modalOverlay = document.createElement("div");
    modalOverlay.id = "xbhh-test-preset-combo-modal";
    modalOverlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0, 0, 0, 0.75); z-index: 10000;
        display: flex; align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, sans-serif; color: #fff;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
        background: #1e1e24; border: 1px solid #3a3a4c; border-radius: 12px;
        width: 540px; max-height: 85vh; display: flex; flex-direction: column;
        padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);
    `;

    let profilesCopy = JSON.parse(JSON.stringify(dbProfiles));
    profilesCopy.forEach(p => { if (p.enabled === undefined) p.enabled = true; });

    const updatePreview = () => {
        const combined = profilesCopy
            .filter(p => p.enabled && p.trigger && p.trigger.trim())
            .map(p => p.trigger.trim())
            .join(", ");
        previewBox.value = combined;
    };

    const headerContainer = document.createElement("div");
    headerContainer.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;";

    const titleEl = document.createElement("h3");
    titleEl.style.cssText = "margin:0; font-size:15px; color:#8ab4f8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:380px;";
    titleEl.innerText = `📦 预设组合与编辑: ${stripSafetensorsExt(loraName.split('/').pop())}`;

    const addBtn = document.createElement("button");
    addBtn.innerText = "➕ 添加预设";
    addBtn.style.cssText = "background:rgba(45,120,245,0.25); border:1px solid rgba(45,120,245,0.5); color:#9cd2f8; padding:4px 12px; border-radius:6px; font-size:12px; cursor:pointer; font-weight:bold;";

    headerContainer.appendChild(titleEl);
    headerContainer.appendChild(addBtn);
    dialog.appendChild(headerContainer);

    const listContainer = document.createElement("div");
    listContainer.style.cssText = "flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:10px; max-height:45vh; padding-right:4px; margin-bottom:15px;";

    const renderList = () => {
        listContainer.innerHTML = "";
        profilesCopy.forEach((prof, idx) => {
            const item = document.createElement("div");
            item.style.cssText = "background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:8px 10px; display:flex; flex-direction:column; gap:6px;";

            const topRow = document.createElement("div");
            topRow.style.cssText = "display:flex; align-items:center; gap:8px;";

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !!prof.enabled;
            cb.style.cssText = "width:16px; height:16px; cursor:pointer; accent-color:#2d78f5;";
            cb.onchange = () => { prof.enabled = cb.checked; updatePreview(); };

            const nameInp = document.createElement("input");
            nameInp.type = "text";
            nameInp.value = prof.name || `预设 ${idx + 1}`;
            nameInp.style.cssText = "flex:1; background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.15); border-radius:4px; color:#9cd2f8; padding:3px 8px; font-size:12px; font-weight:bold;";
            nameInp.onchange = () => { prof.name = nameInp.value.trim(); };

            const delBtn = document.createElement("button");
            delBtn.innerText = "🗑️";
            delBtn.style.cssText = "background:rgba(255,80,80,0.2); border:1px solid rgba(255,80,80,0.4); color:#ff8888; border-radius:4px; padding:2px 6px; font-size:11px; cursor:pointer;";
            delBtn.onclick = () => {
                profilesCopy.splice(idx, 1);
                renderList();
                updatePreview();
            };

            topRow.appendChild(cb);
            topRow.appendChild(nameInp);
            topRow.appendChild(delBtn);

            const txt = document.createElement("textarea");
            txt.value = prof.trigger || "";
            txt.placeholder = "输入提示词 (逗号分隔)...";
            txt.style.cssText = "width:100%; height:42px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); border-radius:4px; color:#fff; font-size:11px; padding:4px; box-sizing:border-box;";
            txt.oninput = () => { prof.trigger = txt.value; updatePreview(); };

            item.appendChild(topRow);
            item.appendChild(txt);
            listContainer.appendChild(item);
        });
    };

    dialog.appendChild(listContainer);

    const previewHeader = document.createElement("div");
    previewHeader.innerText = "⚡ 组合后的最终生效提示词预览：";
    previewHeader.style.cssText = "font-size:12px; color:#aaa; margin-bottom:4px;";

    const previewBox = document.createElement("textarea");
    previewBox.readOnly = true;
    previewBox.style.cssText = "width:100%; height:48px; background:rgba(0,0,0,0.5); border:1px solid #444; border-radius:6px; color:#7ef; font-size:11px; padding:6px; box-sizing:border-box; margin-bottom:15px;";

    dialog.appendChild(previewHeader);
    dialog.appendChild(previewBox);

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex; justify-content:flex-end; gap:10px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.innerText = "取消";
    cancelBtn.style.cssText = "background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#ccc; padding:6px 16px; border-radius:6px; font-size:12px; cursor:pointer;";
    cancelBtn.onclick = () => modalOverlay.remove();

    const saveBtn = document.createElement("button");
    saveBtn.innerText = "💾 保存预设并应用";
    saveBtn.style.cssText = "background:#2d78f5; border:none; color:#fff; padding:6px 20px; border-radius:6px; font-size:12px; font-weight:bold; cursor:pointer;";

    saveBtn.onclick = async () => {
        saveBtn.innerText = "保存中...";
        const finalTrigger = previewBox.value;

        try {
            await api.fetchApi("/xbhh/lora/profiles/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: loraName, profiles: profilesCopy })
            });

            await api.fetchApi("/xbhh/lora/trigger/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: loraName, trigger: finalTrigger })
            });

            widget.value.trigger = finalTrigger;
            node.setDirtyCanvas(true, true);
            modalOverlay.remove();
        } catch (err) {
            console.error("Error saving presets:", err);
            alert("保存预设失败: " + err);
        }
    };

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    dialog.appendChild(footer);
    modalOverlay.appendChild(dialog);
    document.body.appendChild(modalOverlay);

    renderList();
    updatePreview();

    addBtn.onclick = () => {
        profilesCopy.push({
            id: "prof_" + Date.now(),
            name: `预设 ${profilesCopy.length + 1}`,
            trigger: "",
            enabled: true
        });
        renderList();
        updatePreview();
    };
}

// ============================================================================
// 测试控件绘制辅助
// ============================================================================

// 测试位置行（显示并可点击修改当前测试到第几个 LoRA）
function drawIndexWidget(ctx, node, w, posY, h) {
    const x = 10;
    const y = posY;
    const width = node.size[0] - 20;
    const height = 24;
    const midY = y + height / 2;

    ctx.fillStyle = "rgba(59, 130, 246, 0.10)";
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 6);
    ctx.fill();
    ctx.strokeStyle = "rgba(59, 130, 246, 0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();

    const total = getTestSeq(node).length;
    const idx = getTestIndex(node);
    const shown = total ? Math.min(idx + 1, total) : 0;
    const text = total
        ? `📍 当前测试: 第 ${shown} 个 / 共 ${total} 个（点击设置）`
        : "📍 当前测试: - （未添加 LoRA）";

    ctx.fillStyle = "#9cd2f8";
    ctx.font = "11px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    let truncated = text;
    while (ctx.measureText(truncated).width > width - 16 && truncated.length > 4) {
        truncated = truncated.slice(0, -4) + "...";
    }
    ctx.fillText(truncated, x + 8, midY);
}

// 进度行（运行状态 + 后端回传的当前轮信息）
function drawProgressWidget(ctx, node, w, posY, h) {
    const x = 10;
    const y = posY;
    const width = node.size[0] - 20;
    const height = 24;
    const midY = y + height / 2;

    const isMine = testState.node === node;
    const running = isMine && testState.running;

    ctx.fillStyle = running ? "rgba(74, 222, 128, 0.10)" : "rgba(255, 255, 255, 0.05)";
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 6);
    ctx.fill();
    ctx.strokeStyle = running ? "rgba(74, 222, 128, 0.35)" : "#333";
    ctx.lineWidth = 1;
    ctx.stroke();

    const seq = getTestSeq(node);
    const total = seq.length;
    const idx = getTestIndex(node);
    let curName = "";
    if (isMine && testState.ui?.lora) {
        curName = displayNameOf(testState.ui.lora);
    } else if (total) {
        curName = displayNameOf(seq[Math.min(idx, total - 1)]?.value?.lora);
    }
    const pos = total ? `${Math.min(idx + 1, total)}/${total}` : "0/0";
    const text = total === 0
        ? "○ 待测试 0/0"
        : running
            ? `● 测试中 ${pos} · ${curName}`
            : `○ 待测试 ${pos} · ${curName}`;

    ctx.fillStyle = running ? "#4ade80" : "#888";
    ctx.font = "11px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    let truncated = text;
    while (ctx.measureText(truncated).width > width - 16 && truncated.length > 4) {
        truncated = truncated.slice(0, -4) + "...";
    }
    ctx.fillText(truncated, x + 8, midY);
}

// 控制按钮行：开始 / 停止 / 重置
function drawTestButtons(ctx, node, w, posY, h) {
    const x = 10;
    const y = posY;
    const totalWidth = node.size[0] - 20;
    const height = 24;
    const gap = 6;
    const btnWidth = (totalWidth - gap * 2) / 3;

    const isMine = testState.node === node;
    const running = isMine && testState.running;

    const drawBtn = (bx, label, bg, fg, stroke) => {
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.roundRect(bx, y, btnWidth, height, 6);
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = fg;
        ctx.font = "bold 11px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, bx + btnWidth / 2, y + height / 2);
    };

    drawBtn(x, running ? "▶ 测试中…" : "▶ 开始测试",
        running ? "rgba(74,222,128,0.15)" : "rgba(34,120,60,0.55)",
        running ? "#4ade80" : "#b6f0c2",
        running ? "rgba(74,222,128,0.4)" : "#2d5a3d");
    drawBtn(x + btnWidth + gap, "■ 停止",
        running ? "rgba(150,50,50,0.55)" : "rgba(255,255,255,0.06)",
        running ? "#ffb3b3" : "#777",
        running ? "#7a2e2e" : "#3a3a3a");
    drawBtn(x + (btnWidth + gap) * 2, "↺ 重置",
        "rgba(255,255,255,0.06)", "#ccc", "#3a3a3a");
}

// 控制按钮行点击处理
function handleTestButtonsMouse(event, pos, node) {
    if (event.type !== "pointerdown") return false;

    const x = 10;
    const totalWidth = node.size[0] - 20;
    const gap = 6;
    const btnWidth = (totalWidth - gap * 2) / 3;
    const localX = pos[0];

    if (localX >= x && localX <= x + btnWidth) {
        const isMine = testState.node === node;
        if (isMine && testState.running) {
            alert("测试已在进行中");
        } else {
            startTest(node);
        }
        return true;
    }
    if (localX >= x + btnWidth + gap && localX <= x + (btnWidth + gap) * 2) {
        stopTest(node);
        return true;
    }
    if (localX >= x + (btnWidth + gap) * 2 && localX <= x + totalWidth) {
        resetTest(node);
        return true;
    }
    return false;
}

// ============================================================================
// 节点扩展
// ============================================================================
app.registerExtension({
    name: "xbhh.LoraTestLoader",

    async init() {
        await loadLoraData();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            onNodeCreated?.apply(this, arguments);

            this.loraCounter = 0;
            this.loraWidgets = [];
            this.serialize_widgets = true;

            // —— 测试位置行 ——
            const idxWidget = this.addWidget("custom", "test_index", 0, () => {});
            this._testIdxWidget = idxWidget;
            idxWidget.computeSize = () => [this.size[0] - 20, 24];
            idxWidget.serializeValue = () => getTestIndex(this);
            idxWidget.draw = (ctx, node, w, posY, h) => drawIndexWidget(ctx, node, w, posY, h);
            idxWidget.mouse = (event, pos, node) => {
                if (event.type === "pointerdown") {
                    const total = Math.max(getTestSeq(node).length, 1);
                    app.canvas.prompt(
                        `测试第几个 LoRA (1-${total})`,
                        Math.min(getTestIndex(node) + 1, total),
                        v => {
                            const parsed = parseInt(v, 10);
                            if (!isNaN(parsed)) {
                                setTestIndex(node, Math.min(Math.max(parsed, 1), total) - 1);
                                node.setDirtyCanvas(true, true);
                            }
                        },
                        event
                    );
                    return true;
                }
                return false;
            };

            // —— 进度行 ——
            const progressWidget = this.addWidget("custom", "test_progress", null, () => {});
            progressWidget.computeSize = () => [this.size[0] - 20, 24];
            progressWidget.draw = (ctx, node, w, posY, h) => drawProgressWidget(ctx, node, w, posY, h);

            // —— 开始 / 停止 / 重置 按钮行 ——
            const testBtns = this.addWidget("custom", "test_buttons", null, () => {});
            testBtns.computeSize = () => [this.size[0] - 20, 26];
            testBtns.draw = (ctx, node, w, posY, h) => drawTestButtons(ctx, node, w, posY, h);
            testBtns.mouse = (event, pos, node) => handleTestButtonsMouse(event, pos, node);

            // —— 添加 LoRA 按钮 (自定义绘制) ——
            const addLoraBtn = this.addWidget("custom", "➕ Add Lora", null, () => {});
            addLoraBtn.computeSize = () => [this.size[0] - 20, 26];
            addLoraBtn.draw = (ctx, node, w, posY, h) => {
                const x = 10;
                const y = posY;
                const width = node.size[0] - 20;
                const height = 24;

                ctx.fillStyle = "#2a2a2a";
                ctx.beginPath();
                ctx.roundRect(x, y, width, height, 6);
                ctx.fill();

                ctx.strokeStyle = "#444";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = "#fff";
                ctx.font = "bold 12px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("➕ Add Lora", x + width / 2, y + height / 2);
            };
            addLoraBtn.mouse = (event, pos, node) => {
                if (event.type === "pointerdown") {
                    showLoraChooserDialog(event, values => {
                        if (values) {
                            if (typeof values === "string") values = [values];
                            values.forEach(val => {
                                if (val !== "None") node.addLoraRow(val);
                            });
                        }
                    });
                    return true;
                }
                return false;
            };

            // —— 导入/导出预设按钮行 ——
            const presetBtns = this.addWidget("custom", "preset_buttons", null, () => {});
            presetBtns.computeSize = () => [this.size[0] - 20, 26];
            presetBtns.draw = (ctx, node, w, posY, h) => {
                const x = 10;
                const y = posY;
                const totalWidth = node.size[0] - 20;
                const height = 24;
                const gap = 6;
                const btnWidth = (totalWidth - gap) / 2;

                // 导出按钮
                ctx.fillStyle = "#2a2a2a";
                ctx.beginPath();
                ctx.roundRect(x, y, btnWidth, height, 6);
                ctx.fill();
                ctx.strokeStyle = "#444";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = "#ccc";
                ctx.font = "11px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("📤 导出预设", x + btnWidth / 2, y + height / 2);

                // 导入按钮
                const importX = x + btnWidth + gap;
                ctx.fillStyle = "#2a2a2a";
                ctx.beginPath();
                ctx.roundRect(importX, y, btnWidth, height, 6);
                ctx.fill();
                ctx.strokeStyle = "#444";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = "#ccc";
                ctx.fillText("📥 导入预设", importX + btnWidth / 2, y + height / 2);
            };
            presetBtns.mouse = (event, pos, node) => {
                if (event.type === "pointerdown") {
                    const x = 10;
                    const totalWidth = node.size[0] - 20;
                    const gap = 6;
                    const btnWidth = (totalWidth - gap) / 2;
                    const localX = pos[0];

                    if (localX >= x && localX <= x + btnWidth) {
                        showPresetDialog(node, "export");
                        return true;
                    } else if (localX >= x + btnWidth + gap && localX <= x + totalWidth) {
                        showPresetDialog(node, "import");
                        return true;
                    }
                }
                return false;
            };

            this.size[0] = Math.max(this.size[0] || 0, 320);
        };

        // 添加一行 LoRA（行尾权重可调：滚轮 / 拖拽 / 点击输入）
        nodeType.prototype.addLoraRow = function(loraName) {
            if (Array.isArray(loraName)) loraName = loraName[0];

            if (loraName && loraName !== "None") {
                const existing = (this.loraWidgets || []).find(w => w.value?.lora === loraName);
                if (existing) {
                    existing.value.on = true;
                    this.setDirtyCanvas(true, true);
                    return existing;
                }
            }

            this.loraCounter++;
            const widgetName = `lora_${this.loraCounter}`;

            const widget = this.addWidget("custom", widgetName, {
                on: true,
                lora: loraName,
                strength: 1.0,
                strengthTwo: 1.0,
                trigger: "",
                triggerWeight: 1.0
            }, () => {});

            // 自动从数据库填充触发词
            if (loraName && loraName !== "None") {
                const requestedLora = loraName;
                api.fetchApi(`/xbhh/lora/trigger?name=${encodeURIComponent(loraName)}`)
                    .then(r => r.json())
                    .then(data => {
                        // 竞态守卫：响应回来时该行已换成其他 LoRA（或 widget 已被移除），丢弃过期结果
                        if (widget.value?.lora !== requestedLora) return;
                        if (data && data.active_trigger) {
                            widget.value.trigger = data.active_trigger;
                            this.setDirtyCanvas(true, true);
                        }
                    })
                    .catch(e => console.error("Error fetching trigger word:", e));
            }

            widget.computeSize = () => [this.size[0] - 20, 22];
            widget.serializeValue = () => widget.value;

            widget.draw = (ctx, node, w, posY, h) => {
                // 确保 widget.value 存在
                if (!widget.value) {
                    widget.value = { on: true, lora: null, strength: 1.0, strengthTwo: 1.0, trigger: "", triggerWeight: 1.0 };
                }

                const x = 10;
                const y = posY;
                const width = node.size[0] - 20;
                const height = 20;
                const midY = y + height / 2;

                const isOn = widget.value.on ?? true;
                ctx.fillStyle = isOn ? "rgba(255, 255, 255, 0.07)" : "rgba(0, 0, 0, 0.25)";
                ctx.beginPath();
                ctx.roundRect(x, y, width, height, 3);
                ctx.fill();

                ctx.strokeStyle = isOn ? "rgba(255, 255, 255, 0.12)" : "#2a2a2a";
                ctx.lineWidth = 1;
                ctx.stroke();

                const toggleX = x + 4;
                const toggleSize = 12;
                ctx.fillStyle = isOn ? "#3b82f6" : "#444";
                ctx.beginPath();
                ctx.roundRect(toggleX, midY - toggleSize/2, toggleSize, toggleSize, 2);
                ctx.fill();

                if (isOn) {
                    ctx.fillStyle = "#fff";
                    ctx.font = "bold 9px Arial";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText("✓", toggleX + toggleSize/2, midY);
                }

                if (Array.isArray(widget.value.lora)) {
                    widget.value.lora = widget.value.lora[0];
                }
                const name = stripSafetensorsExt(widget.value.lora?.split(/[\/\\]/).pop()) || "None";
                let nameX = toggleX + toggleSize + 6;

                // 有预览图的 LoRA：文件名前绘制图片图标（颜色跟随文字色）
                const hasImg = !!loraImages[widget.value.lora];
                const icon = hasImg ? imageIconCanvas[isOn ? "on" : "off"] : null;
                let iconDrawn = false;
                if (icon && icon.complete && icon.naturalWidth > 0) {
                    ctx.drawImage(icon, nameX, midY - 7, 14, 14);
                    nameX += 18;
                    iconDrawn = true;
                }

                ctx.fillStyle = isOn ? "#ddd" : "#777";
                ctx.font = "11px Arial";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";

                const maxNameWidth = width - (nameX - x) - 70;
                let truncatedName = name;
                while (ctx.measureText(truncatedName).width > maxNameWidth && truncatedName.length > 3) {
                    truncatedName = truncatedName.slice(0, -4) + "...";
                }
                ctx.fillText(truncatedName, nameX, midY);

                // 行尾权重显示（滚轮 / 拖拽 / 点击输入调整）
                const strength = widget.value.strength ?? 1.0;
                ctx.textAlign = "right";
                ctx.fillStyle = isOn ? "#60a5fa" : "#777";
                ctx.fillText(strength.toFixed(2), width + x - 4, midY);

                // Shift 快捷删除提示：按住 Shift 悬停时红色高亮 + 删除提示
                if (shiftKeyPressed && node._hoverLoraWidget === widget) {
                    ctx.fillStyle = "rgba(244, 63, 94, 0.18)";
                    ctx.beginPath();
                    ctx.roundRect(x, y, width, height, 3);
                    ctx.fill();
                    ctx.fillStyle = "#fb7185";
                    ctx.font = "bold 10px Arial";
                    ctx.textAlign = "right";
                    ctx.textBaseline = "middle";
                    ctx.fillText("Shift+点击删除", x + width - 4, midY);
                }
            };

            widget.mouse = (event, pos, node) => {
                const localX = pos[0];
                const margin = 10;

                // —— 权重调节：滚轮 ——
                if (event.type === "wheel" || event.type === "mousewheel") {
                    const delta = event.deltaY ? -Math.sign(event.deltaY) * 0.05 : (event.wheelDelta ? Math.sign(event.wheelDelta) * 0.05 : 0);
                    if (delta !== 0) {
                        const newStrength = Math.round(((widget.value.strength ?? 1.0) + delta) * 100) / 100;
                        widget.value.strength = newStrength;
                        widget.value.strengthTwo = newStrength;
                        widget.value.triggerWeight = newStrength;
                        node.setDirtyCanvas(true, true);
                    }
                    return true;
                }

                // —— 权重调节：横向拖拽 ——
                if (event.type === "pointermove") {
                    if (widget._isDragging && widget._dragStartX != null) {
                        const deltaX = event.canvasX - widget._dragStartX;
                        if (Math.abs(deltaX) > 3) widget._hasMoved = true;
                        if (widget._hasMoved) {
                            const val = Math.round((widget._dragStartStrength + deltaX * 0.01) * 100) / 100;
                            widget.value.strength = val;
                            widget.value.strengthTwo = val;
                            widget.value.triggerWeight = val;
                            node.setDirtyCanvas(true, true);
                        }
                        return true;
                    }
                    return false;
                }

                // —— 权重调节：松开未拖动则弹窗输入 ——
                if (event.type === "pointerup") {
                    if (widget._isDragging) {
                        const hasMoved = widget._hasMoved;
                        widget._isDragging = false;
                        widget._hasMoved = false;
                        widget._dragStartX = null;
                        widget._dragStartStrength = null;
                        if (!hasMoved) {
                            // 打开权重编辑弹窗前先收起悬浮预览，避免预览图盖住输入框
                            hidePreview();
                            app.canvas.prompt("强度值", widget.value.strength, v => {
                                const parsed = parseFloat(v);
                                if (!isNaN(parsed)) {
                                    widget.value.strength = parsed;
                                    widget.value.strengthTwo = parsed;
                                    widget.value.triggerWeight = parsed;
                                    node.setDirtyCanvas(true, true);
                                }
                            }, event);
                        }
                        return true;
                    }
                    return false;
                }

                if (event.type === "pointerdown") {
                    // Shift+点击：快捷删除该行（批量删除场景，无需右键菜单）
                    if (shiftKeyPressed) {
                        node.removeLoraWidget(widget);
                        return true;
                    }

                    // 开关区域
                    if (localX >= margin && localX <= margin + 20) {
                        widget.value.on = !widget.value.on;
                        node.setDirtyCanvas(true, true);
                        return true;
                    }

                    // LoRA名称区域
                    if (localX >= margin + 24 && localX <= node.size[0] - 60) {
                        hidePreview();
                        showLoraChooserDialog(event, values => {
                            if (values && values.length > 0) {
                                const selectedLora = values[0];
                                if (selectedLora && selectedLora !== "None") {
                                    const existing = (node.loraWidgets || []).find(w => w !== widget && w.value?.lora === selectedLora);
                                    if (existing) {
                                        existing.value.on = true;
                                        node.removeLoraWidget(widget);
                                        node.setDirtyCanvas(true, true);
                                        return;
                                    }
                                }

                                widget.value.lora = selectedLora;
                                if (selectedLora && selectedLora !== "None") {
                                    const requestedLora = selectedLora;
                                    api.fetchApi(`/xbhh/lora/trigger?name=${encodeURIComponent(selectedLora)}`)
                                        .then(r => r.json())
                                        .then(data => {
                                            // 竞态守卫：响应回来时行内已再次切换 LoRA，丢弃过期结果
                                            if (widget.value?.lora !== requestedLora) return;
                                            if (data && data.active_trigger !== undefined) {
                                                widget.value.trigger = data.active_trigger;
                                                node.setDirtyCanvas(true, true);
                                            }
                                        })
                                        .catch(e => console.error("Error fetching trigger word:", e));
                                } else {
                                    widget.value.trigger = "";
                                }
                                node.setDirtyCanvas(true, true);
                            }
                        }, { singleSelect: true });
                        return true;
                    }

                    // 权重区域 - 开始拖拽（松开未拖动则弹窗输入）
                    if (localX >= node.size[0] - 60) {
                        widget._isDragging = true;
                        widget._dragStartX = event.canvasX;
                        widget._dragStartStrength = widget.value.strength;
                        widget._hasMoved = false;
                        return true;
                    }
                }
                return false;
            };

            // 将按钮移到最后（行插入到测试控件之后、按钮之前）
            const btnNames = ["➕ Add Lora", "preset_buttons"];
            const buttons = [];
            for (const name of btnNames) {
                const idx = this.widgets.findIndex(w => w.name === name);
                if (idx >= 0) {
                    buttons.push(...this.widgets.splice(idx, 1));
                }
            }
            this.widgets.push(...buttons);

            this.loraWidgets.push(widget);
            this.size[1] = Math.max(this.size[1], this.computeSize()[1]);
            this.setDirtyCanvas(true, true);

            return widget;
        };

        nodeType.prototype.removeLoraWidget = function(widget) {
            const idx = this.widgets.indexOf(widget);
            if (idx >= 0) {
                this.widgets.splice(idx, 1);
                this.loraWidgets = this.loraWidgets.filter(w => w !== widget);
                // 高度自动收缩，避免删除后留白
                try {
                    this.size[1] = this.computeSize()[1];
                } catch (e) { /* 忽略尺寸计算异常 */ }
                this.setDirtyCanvas(true, true);
            }
        };

        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function(info) {
            while (this.widgets?.length) this.widgets.pop();
            this.loraCounter = 0;
            this.loraWidgets = [];
            this._testIdxWidget = null;

            // —— 测试控件（与 onNodeCreated 相同顺序）——
            const idxWidget = this.addWidget("custom", "test_index", 0, () => {});
            this._testIdxWidget = idxWidget;
            idxWidget.computeSize = () => [this.size[0] - 20, 24];
            idxWidget.serializeValue = () => getTestIndex(this);
            idxWidget.draw = (ctx, node, w, posY, h) => drawIndexWidget(ctx, node, w, posY, h);
            idxWidget.mouse = (event, pos, node) => {
                if (event.type === "pointerdown") {
                    const total = Math.max(getTestSeq(node).length, 1);
                    app.canvas.prompt(
                        `测试第几个 LoRA (1-${total})`,
                        Math.min(getTestIndex(node) + 1, total),
                        v => {
                            const parsed = parseInt(v, 10);
                            if (!isNaN(parsed)) {
                                setTestIndex(node, Math.min(Math.max(parsed, 1), total) - 1);
                                node.setDirtyCanvas(true, true);
                            }
                        },
                        event
                    );
                    return true;
                }
                return false;
            };

            const progressWidget = this.addWidget("custom", "test_progress", null, () => {});
            progressWidget.computeSize = () => [this.size[0] - 20, 24];
            progressWidget.draw = (ctx, node, w, posY, h) => drawProgressWidget(ctx, node, w, posY, h);

            const testBtns = this.addWidget("custom", "test_buttons", null, () => {});
            testBtns.computeSize = () => [this.size[0] - 20, 26];
            testBtns.draw = (ctx, node, w, posY, h) => drawTestButtons(ctx, node, w, posY, h);
            testBtns.mouse = (event, pos, node) => handleTestButtonsMouse(event, pos, node);

            // —— 恢复 LoRA 行 ——
            for (const v of info.widgets_values || []) {
                if (v?.lora !== undefined) {
                    const w = this.addLoraRow(v.lora);
                    w.value = { on: true, strength: 1.0, strengthTwo: 1.0, triggerWeight: 1.0, ...v };
                }
            }

            // —— 恢复测试位置 ——
            for (const v of info.widgets_values || []) {
                if (typeof v === "number") {
                    idxWidget.value = Math.max(0, Math.floor(v) || 0);
                    break;
                }
            }

            // —— 添加 LoRA 按钮 (自定义绘制) ——
            const addLoraBtn = this.addWidget("custom", "➕ Add Lora", null, () => {});
            addLoraBtn.computeSize = () => [this.size[0] - 20, 26];
            addLoraBtn.draw = (ctx, node, w, posY, h) => {
                const x = 10;
                const y = posY;
                const width = node.size[0] - 20;
                const height = 24;

                ctx.fillStyle = "#2a2a2a";
                ctx.beginPath();
                ctx.roundRect(x, y, width, height, 6);
                ctx.fill();

                ctx.strokeStyle = "#444";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = "#fff";
                ctx.font = "bold 12px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("➕ Add Lora", x + width / 2, y + height / 2);
            };
            addLoraBtn.mouse = (event, pos, node) => {
                if (event.type === "pointerdown") {
                    showLoraChooserDialog(event, values => {
                        if (values) {
                            if (typeof values === "string") values = [values];
                            values.forEach(val => {
                                if (val !== "None") node.addLoraRow(val);
                            });
                        }
                    });
                    return true;
                }
                return false;
            };

            // —— 导入/导出预设按钮行 ——
            const presetBtns = this.addWidget("custom", "preset_buttons", null, () => {});
            presetBtns.computeSize = () => [this.size[0] - 20, 26];
            presetBtns.draw = (ctx, node, w, posY, h) => {
                const x = 10;
                const y = posY;
                const totalWidth = node.size[0] - 20;
                const height = 24;
                const gap = 6;
                const btnWidth = (totalWidth - gap) / 2;

                ctx.fillStyle = "#2a2a2a";
                ctx.beginPath();
                ctx.roundRect(x, y, btnWidth, height, 6);
                ctx.fill();
                ctx.strokeStyle = "#444";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = "#ccc";
                ctx.font = "11px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("📤 导出预设", x + btnWidth / 2, y + height / 2);

                const importX = x + btnWidth + gap;
                ctx.fillStyle = "#2a2a2a";
                ctx.beginPath();
                ctx.roundRect(importX, y, btnWidth, height, 6);
                ctx.fill();
                ctx.strokeStyle = "#444";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = "#ccc";
                ctx.fillText("📥 导入预设", importX + btnWidth / 2, y + height / 2);
            };
            presetBtns.mouse = (event, pos, node) => {
                if (event.type === "pointerdown") {
                    const x = 10;
                    const totalWidth = node.size[0] - 20;
                    const gap = 6;
                    const btnWidth = (totalWidth - gap) / 2;
                    const localX = pos[0];

                    if (localX >= x && localX <= x + btnWidth) {
                        showPresetDialog(node, "export");
                        return true;
                    } else if (localX >= x + btnWidth + gap && localX <= x + totalWidth) {
                        showPresetDialog(node, "import");
                        return true;
                    }
                }
                return false;
            };

            configure?.apply(this, arguments);

            // 工作流加载后后台刷新列表并清理失效行（文件已被移动/删除的 LoRA）
            refreshLoraList();

            // 从数据库同步各行的触发词显示：widget 的 trigger 只是添加时的缓存快照，
            // 用户在 LoRA 管理器修改提示词后重开工作流，行内显示与输出保持一致（数据库为准）
            for (const w of this.loraWidgets || []) {
                const loraName = w.value?.lora;
                if (!loraName || loraName === "None") continue;

                const requestedLora = loraName;
                api.fetchApi(`/xbhh/lora/trigger?name=${encodeURIComponent(loraName)}`)
                    .then(r => r.json())
                    .then(data => {
                        // 竞态守卫：响应回来时行已换 LoRA / widget 已被移除，丢弃过期结果
                        if (w.value?.lora !== requestedLora) return;
                        const latest = data && data.active_trigger;
                        // 数据库有值且与当前缓存不同 → 覆盖（数据库为准，过期值直接刷掉）
                        if (latest && latest !== w.value.trigger) {
                            w.value.trigger = latest;
                            this.setDirtyCanvas(true, true);
                        }
                    })
                    .catch(() => { /* 静默失败，保持现有值 */ });
            }
        };

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(_, options) {
            getExtraMenuOptions?.apply(this, arguments);

            const mouse = app.canvas.graph_mouse;
            const localY = mouse[1] - this.pos[1];

            let onRow = false;
            for (const w of this.loraWidgets || []) {
                if (w.last_y && localY >= w.last_y && localY < w.last_y + 24) {
                    onRow = true;
                    options.unshift(
                        { content: "🗑️ 删除", callback: () => this.removeLoraWidget(w) },
                        {
                            content: "✏️ 设置触发词",
                            callback: () => openLoraPresetComboDialog(this, w)
                        },
                        null
                    );
                    break;
                }
            }

            // 非行区域：批量管理入口（配合行首开关，先关掉不要的再一键清除）
            if (!onRow) {
                const widgets = [...(this.loraWidgets || [])];
                const offWidgets = widgets.filter(w => w.value?.on === false);
                if (offWidgets.length > 0) {
                    options.unshift({
                        content: `🧹 清除已关闭的 LoRA（${offWidgets.length} 个）`,
                        callback: () => {
                            for (const w of offWidgets) this.removeLoraWidget(w);
                        }
                    });
                }
                if (widgets.length > 0) {
                    options.unshift({
                        content: `🗑️ 清空全部 LoRA（${widgets.length} 个）`,
                        callback: () => {
                            if (confirm(`确定清空全部 ${widgets.length} 个 LoRA 吗？`)) {
                                for (const w of widgets) this.removeLoraWidget(w);
                            }
                        }
                    });
                }
                options.unshift({ content: "💡 提示：按住 Shift 点击行可快速删除", disabled: true }, null);
            }
        };

        const onMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function(event, pos) {
            onMouseMove?.apply(this, arguments);

            // 选择弹窗打开时不再显示行内悬浮预览，避免预览被弹窗遮挡或盖住弹窗
            if (document.querySelector(".xbhh-lora-dialog-test")) {
                this._hoverLoraWidget = null;
                hidePreview();
                return;
            }

            // 权重等文本输入框聚焦时（如 canvas.prompt 弹窗），抑制悬浮预览，避免预览图盖住输入框
            if (isTextInputFocused()) {
                this._hoverLoraWidget = null;
                hidePreview();
                return;
            }

            const localY = pos[1];
            let found = false;

            for (const w of this.loraWidgets || []) {
                if (w.last_y && localY >= w.last_y && localY < w.last_y + 24) {
                    // 记录悬停行（Shift 快捷删除的红色高亮用）
                    if (this._hoverLoraWidget !== w) {
                        this._hoverLoraWidget = w;
                        if (shiftKeyPressed) this.setDirtyCanvas(true, true);
                    }
                    if (w.value.lora && loraImages[w.value.lora]) {
                        const screenPos = app.canvas.convertOffsetToCanvas([
                            this.pos[0] + this.size[0],
                            this.pos[1] + w.last_y
                        ]);
                        showPreviewAt(w.value.lora, screenPos[0], screenPos[1]);
                        found = true;
                    }
                    break;
                }
            }

            if (this._hoverLoraWidget && !found && !(this.loraWidgets || []).some(w => w.last_y && localY >= w.last_y && localY < w.last_y + 24)) {
                this._hoverLoraWidget = null;
                if (shiftKeyPressed) this.setDirtyCanvas(true, true);
            }
            if (!found) hidePreview();
        };

        const onMouseLeave = nodeType.prototype.onMouseLeave;
        nodeType.prototype.onMouseLeave = function() {
            this._hoverLoraWidget = null;
            hidePreview();
            onMouseLeave?.apply(this, arguments);
        };

        // 背景样式：遵循 ComfyUI 原生节点背景样式
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
            if (this.flags.collapsed) return;
            onDrawBackground?.apply(this, arguments);
        };
    }
});
