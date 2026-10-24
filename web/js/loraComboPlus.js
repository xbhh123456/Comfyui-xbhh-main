import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_NAME = "XBHHMultiLoraLoaderPlus";
const IMAGE_SIZE = 300;

// LoRA 堆内部滚动：单行高度（与旧版 22 + 4 行距一致，视觉不变）与默认可见行数
const LORA_ROW_HEIGHT = 26;
const LORA_LIST_DEFAULT_ROWS = 6;

// 图片图标（Remix Icon image-2-fill）：有预览图的 LoRA 在文件名前显示，替代原 🖼️ emoji
// 颜色跟随行内文字色：启用 #ddd / 关闭 #777
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
// 注意：与 lora_manager.html / loraTestCombo.js 内的同名函数保持规则一致
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
            if (!node.children[char]) {
                return [];
            }
            node = node.children[char];
        }
        return Array.from(node.items);
    }
}

// ============================================================================
// 数据存储
// ============================================================================
let loraImages = {};
let loraList = [];
let loraTrie = new Trie();

// Shift 键状态跟踪：Shift+点击 LoRA 行 = 快捷删除（批量删除场景；Alt 与官方快捷键冲突故用 Shift）
let shiftKeyPressed = false;
window.addEventListener("keydown", e => { if (e.key === "Shift") shiftKeyPressed = true; }, true);
window.addEventListener("keyup", e => { if (e.key === "Shift") shiftKeyPressed = false; }, true);
window.addEventListener("blur", () => { shiftKeyPressed = false; });

// ============================================================================
// 工具函数
// ============================================================================
function encodeRFC3986URIComponent(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// 显示用：去掉 .safetensors 后缀，避免文本过长（仅用于展示，不影响实际取用的名称）
function stripSafetensorsExt(name) {
    return typeof name === "string" ? name.replace(/\.safetensors$/i, "") : name;
}

function rebuildLoraTrie() {
    loraTrie = new Trie();
    for (const loraName of loraList) {
        loraTrie.insert(loraName, loraName);
        const filename = loraName.split(/[\/\\]/).pop();
        loraTrie.insert(filename, loraName);
        const filenameNoExt = filename.substring(0, filename.lastIndexOf('.')) || filename;
        loraTrie.insert(filenameNoExt, loraName);
        // 切割出关键词
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

// 重命名同步：LoRA 管理器（独立标签页）改名成功后会把「旧名 → 新名」写进 localStorage。
// 堆节点是按名字匹配的，不同步的话旧名对不上会被当成失效行删掉（文件其实还在）。
// 这里监听 storage 事件即时改成新名；工作流加载时也会读一次。
const LORA_RENAME_MAP_KEY = "xbhh_lora_rename_map";

function resolveRenamedLora(name, map) {
    let cur = name;
    const seen = new Set();
    while (map[cur] && map[cur] !== cur && !seen.has(cur)) {
        seen.add(cur);
        cur = map[cur];
    }
    return cur;
}

function remapRenamedLoraRows() {
    if (!app.graph?._nodes || !loraList.length) return;
    let map;
    try {
        map = JSON.parse(localStorage.getItem(LORA_RENAME_MAP_KEY) || "{}");
    } catch (e) { return; }
    if (!map || typeof map !== "object" || !Object.keys(map).length) return;

    const valid = new Set(loraList);
    for (const node of app.graph._nodes) {
        if (node.type !== NODE_NAME || !Array.isArray(node.loraWidgets)) continue;
        let changed = false;
        for (const w of node.loraWidgets) {
            const cur = Array.isArray(w.value?.lora) ? w.value.lora[0] : w.value?.lora;
            if (!cur || cur === "None") continue;
            // 旧名仍指向有效文件时不动它（防止旧名被新建的 LoRA 复用后被错误改写）
            if (valid.has(cur)) continue;
            const next = resolveRenamedLora(cur, map);
            // 只认落到了真实存在的新文件上，否则交给 pruneStaleLoraRows 当删除处理
            if (next !== cur && valid.has(next)) {
                w.value.lora = next;
                changed = true;
            }
        }
        if (changed) node.setDirtyCanvas(true, true);
    }
}

// 管理器改名会写 localStorage 触发 storage 事件：先刷新列表拿到新名字，
// prune 流程里再按改名映射把旧名同步成新名（顺带补上新名字的预览图）
window.addEventListener("storage", (e) => {
    if (e && e.key === LORA_RENAME_MAP_KEY) refreshLoraList();
});

// 静默清理：文件已被移动/删除的 LoRA，自动移除堆内空占位行
function pruneStaleLoraRows() {
    if (!app.graph?._nodes) return;
    // 先按改名映射把旧名换成新名，避免刚改名的行被误判为失效删掉
    remapRenamedLoraRows();
    if (!loraList.length) return;
    const valid = new Set(loraList);
    for (const node of app.graph._nodes) {
        if (node.type !== NODE_NAME || !Array.isArray(node.loraWidgets)) continue;
        const stale = node.loraWidgets.filter(w => {
            const n = Array.isArray(w.value?.lora) ? w.value.lora[0] : w.value?.lora;
            return n && n !== "None" && !valid.has(n);
        });
        for (const w of stale) {
            console.warn(`[XBHH] LoRA 文件已不存在，自动移除堆内空行: ${w.value?.lora}`);
            node.removeLoraWidget(w);
        }
        if (stale.length) {
            try {
                // 内部滚动模式：不再重算节点高度（行被隐藏，computeSize 不反映行数）
                if (typeof node._clampLoraScroll === "function") node._clampLoraScroll();
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
                    // 有新增文件：后台补拉预览图映射（不阻塞选择器）
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
        // 用最新列表清理失效行
        pruneStaleLoraRows();
    })();
    return loraRefreshPromise;
}

// 数据库为准同步所有堆节点的触发词显示：
// 从 LoRA 管理器修改提示词切回画布时（页面重新可见），行内显示自动刷新为最新值
let triggerSyncInProgress = false;
function syncAllLoraTriggersFromDB() {
    if (triggerSyncInProgress) return;
    const graph = (typeof app !== "undefined" && app.graph) ? app.graph : null;
    if (!graph || !graph.nodes) return;
    triggerSyncInProgress = true;
    setTimeout(() => { triggerSyncInProgress = false; }, 2000); // 节流，避免频繁切换标签时刷屏

    for (const node of graph.nodes) {
        if (!node.loraWidgets || node.loraWidgets.length === 0) continue;
        for (const w of node.loraWidgets) {
            const loraName = w.value?.lora;
            if (!loraName || loraName === "None") continue;

            const requestedLora = loraName;
            api.fetchApi(`/xbhh/lora/trigger?name=${encodeURIComponent(loraName)}`)
                .then(r => r.json())
                .then(data => {
                    // 竞态守卫：响应回来时行已换 LoRA / widget 已被移除，丢弃过期结果
                    if (w.value?.lora !== requestedLora) return;
                    const latest = data && data.active_trigger;
                    // 数据库有值且与当前缓存不同 → 覆盖刷新（数据库为准）
                    if (latest && latest !== w.value.trigger) {
                        w.value.trigger = latest;
                        node.setDirtyCanvas(true, true);
                    }
                })
                .catch(() => { /* 静默失败，保持现有值 */ });
        }
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        syncAllLoraTriggersFromDB();
    }
});

// ============================================================================
// 图片预览
// ============================================================================
let imageHostPlus = null;

function getImageHost() {
    if (!imageHostPlus) {
        imageHostPlus = $el("img", {
            className: "xbhh-preview-image-plus",
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
        document.body.appendChild(imageHostPlus);
    }
    return imageHostPlus;
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
// 预设导入/导出对话框
// ============================================================================
function showPresetDialog(node, mode) {
    const existing = document.querySelector(".xbhh-preset-dialog");
    if (existing) existing.remove();
    
    const dialog = $el("div.xbhh-preset-dialog", {
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
            ? "以下是当前 LoRA 配置的预设文本，可复制保存：" 
            : "粘贴预设文本到下方，然后点击导入："
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
        placeholder: "格式: enabled|lora_name|strength_model|strength_clip|(触发词段留空)|trigger_weight\n例如: 1|my_lora.safetensors|1.0|1.0||1.0"
    });
    
    // 如果是导出模式，生成预设文本
    if (mode === "export") {
        const lines = [];
        for (const w of node.loraWidgets || []) {
            if (w.value?.lora && w.value.on) {
                const enabled = "1";
                const lora = w.value.lora;
                const strength = w.value.strength ?? 1.0;
                const strengthTwo = w.value.strengthTwo ?? strength;
                // 触发词段恒为空：触发词以数据库为唯一来源，预设只承载权重
                const triggerWeight = w.value.triggerWeight ?? 1.0;
                lines.push(`${enabled}|${lora}|${strength}|${strengthTwo}||${triggerWeight}`);
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
        // 导入按钮
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
                
                // 解析并导入
                const lines = text.split("\n");
                for (const line of lines) {
                    const parts = line.trim().split("|");
                    if (parts.length >= 2) {
                        const enabled = parts[0] === "1";
                        const loraName = parts[1];
                        const strength = parseFloat(parts[2]) || 1.0;
                        const strengthTwo = parseFloat(parts[3]) || strength;
                        // 第 5 段（触发词）忽略：触发词以数据库为唯一来源
                        const triggerWeight = parseFloat(parts[5]) || 1.0;
                        
                        let existingW = (node.loraWidgets || []).find(w => w.value?.lora === loraName);
                        if (existingW) {
                            existingW.value.on = enabled;
                            existingW.value.strength = strength;
                            existingW.value.strengthTwo = strengthTwo;
                            existingW.value.triggerWeight = triggerWeight;
                        } else {
                            const w = node.addLoraRow(loraName);
                            w.value.on = enabled;
                            w.value.strength = strength;
                            w.value.strengthTwo = strengthTwo;
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
    const existing = document.querySelector(".xbhh-lora-dialog-plus");
    if (existing) existing.remove();
    
    const splitBy = /[\/\\]/;

    const dialog = $el("div.xbhh-lora-dialog-plus", {
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
// 属性面板自动弹出防御
// 官方 RightSidePanel.vue 里有：
//   watchEffect(() => { if (!isActiveTabAvailable()) openPanel(tabs[0].value) })
// 当 activeTab 停在 info（依赖单选节点）/ errors 等页签时，点画布、点节点、切换工作流
// 都会让该页签「失效」，watchEffect 随即强制 openPanel()，并把
// Comfy.RightSidePanel.IsOpen 写回 true 持久化 —— 表现为「点到哪都弹出属性面板」，
// 面板停靠后还会把画布挤窄。
//
// 防御策略：盯住 IsOpen 的「关 → 开」跳变。只有跳变前一小段时间内用户确实点过
// 面板开关 / 节点信息 / 面板内页签，才算他主动打开；其余一律还原为关闭。
// 这样无论触发源是画布、节点、工作流标签还是别的扩展，都能兜住。
// ============================================================================
function installPropertiesPanelAutoOpenGuard() {
    if (window.__xbhhRightSidePanelGuard) return;
    window.__xbhhRightSidePanelGuard = true;

    const SETTING_KEY = "Comfy.RightSidePanel.IsOpen";
    // 判定「用户主动打开」的时间窗（毫秒）
    const USER_INTENT_MS = 600;
    // 启动宽限期：页面初始化期间的状态跳变不算「被强制打开」
    const BOOT_GRACE_MS = 1500;
    // 允许主动打开面板的入口
    const OPEN_INTENT_SELECTOR = [
        '[aria-label="开关属性面板"]',
        '[aria-label="节点信息"]',
        '[data-testid="error-overlay-see-errors"]',
        '[data-testid="properties-panel"]',
        '[data-testid^="panel-tab-"]',
        // 顶栏按钮（不同语言版本 aria-label 会变，兜底按容器匹配）
        '[data-testid="action-bar-buttons"] button',
    ].join(", ");
    const startedAt = Date.now();

    // 官方 Pinia store（拿不到时回退到设置项读写）
    const panelStore = () => {
        try {
            return app?.extensionManager?._p?._s?.get?.("rightSidePanel") || null;
        } catch (e) {
            return null;
        }
    };
    const readPanelOpen = () => {
        const rs = panelStore();
        if (rs && typeof rs.isOpen === "boolean") return rs.isOpen;
        try {
            return !!app.ui.settings.getSettingValue(SETTING_KEY);
        } catch (e) {
            return null;
        }
    };
    const closePanel = () => {
        try {
            const rs = panelStore();
            if (rs && typeof rs.closePanel === "function") {
                rs.closePanel();
                return;
            }
            if (app.ui.settings.getSettingValue(SETTING_KEY)) {
                app.ui.settings.setSettingValue(SETTING_KEY, false);
            }
        } catch (e) {
            // 忽略：不同前端版本接口不同
        }
    };

    let lastIntentAt = 0;
    window.addEventListener("pointerdown", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(OPEN_INTENT_SELECTOR)) lastIntentAt = Date.now();
    }, true);

    let lastOpen = readPanelOpen();
    setInterval(() => {
        const open = readPanelOpen();
        if (open === lastOpen) return;
        lastOpen = open;
        if (open !== true) return;
        if (Date.now() - startedAt < BOOT_GRACE_MS) return;
        if (Date.now() - lastIntentAt <= USER_INTENT_MS) return;
        closePanel();
        lastOpen = false;
    }, 200);
}

// ============================================================================
// 节点扩展
// ============================================================================
app.registerExtension({
    name: "xbhh.MultiLoraLoaderPlus",

    async init() {
        installPropertiesPanelAutoOpenGuard();
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

            // 内部滚动模式：行 widget 隐藏、由容器 widget 统一绘制/交互，节点高度不再随行数增长
            this.__xbhhScrollable = true;
            this._loraScroll = 0;
            this._loraDrag = null;
            this._loraListWidget = null;
            this._ensureLoraListWidget();

            // 提示词权重控制：全局开关（隐藏 widget 承载布尔值，参与序列化并作为 prompt 输入发给后端）
            this._triggerWeightControl = (this._triggerWeightControl !== false);
            this._triggerWeightControlWidget = null;
            this._ensureTriggerWeightControlWidget();

            // 添加 LoRA 按钮 (自定义绘制)
            const addLoraBtn = this.addWidget("custom", "➕ Add Lora", null, () => {});
            addLoraBtn.computeSize = () => [this.size[0] - 20, 26];
            addLoraBtn.draw = (ctx, node, w, posY, h) => {
                const x = 10;
                const y = posY;
                const width = node.size[0] - 20;
                const height = 24;
                
                // 绘制圆角背景
                ctx.fillStyle = "#2a2a2a";
                ctx.beginPath();
                ctx.roundRect(x, y, width, height, 6);
                ctx.fill();
                
                ctx.strokeStyle = "#444";
                ctx.lineWidth = 1;
                ctx.stroke();
                
                // 绘制文字（垂直居中）
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
            
            // 导入/导出按钮合并为一行 (自定义绘制)
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
                        // 导出
                        showPresetDialog(node, "export");
                        return true;
                    } else if (localX >= x + btnWidth + gap && localX <= x + totalWidth) {
                        // 导入
                        showPresetDialog(node, "import");
                        return true;
                    }
                }
                return false;
            };
            
            this.size[0] = Math.max(this.size[0] || 0, 320);

            // 排好 widget 顺序（容器在行与按钮之间），并把高度设为默认可见若干行
            this._orderLoraWidgets();
            try {
                const base = this.computeSize()[1];
                this.size[1] = Math.max(this.size[1] || 0, base + (LORA_LIST_DEFAULT_ROWS - 1) * LORA_ROW_HEIGHT);
            } catch (e) { /* 忽略尺寸计算异常 */ }
        };

        // ====================================================================
        // 内部滚动：容器 widget 与滚动状态管理
        // ====================================================================

        // 惰性创建/复用容器 widget：
        // 只实现 computeLayoutSize（不实现 computeSize），高度由节点剩余空间分配，
        // 因此节点高度不会再随 LoRA 行数无限增长。
        nodeType.prototype._ensureLoraListWidget = function() {
            if (this._loraListWidget && Array.isArray(this.widgets) && this.widgets.includes(this._loraListWidget)) {
                return this._loraListWidget;
            }
            // 旧容器若还在数组里先移除
            if (this._loraListWidget && Array.isArray(this.widgets)) {
                const oldIdx = this.widgets.indexOf(this._loraListWidget);
                if (oldIdx >= 0) this.widgets.splice(oldIdx, 1);
            }
            const container = this.addWidget("custom", "lora_list", null, () => {});
            // 关键：清掉 computeSize，改走 computeLayoutSize 分支
            container.computeSize = undefined;
            container.computeLayoutSize = () => ({ minHeight: LORA_ROW_HEIGHT, maxHeight: Infinity });
            // 关键：默认 margin=6 会让 ComfyUI 的 getWidgetOnPos 把本容器的命中区左右各内缩 6px，
            // 导致绘制在最右侧的滚动条落在命中区之外 —— 点它等于点节点本体（变成拖拽节点）。
            // 置 0 让容器命中区覆盖整宽，滚动条才能被抓住。
            container.margin = 0;
            // 容器不参与序列化（否则会污染 widgets_values）
            container.serialize = false;
            if (container.options) container.options.serialize = false;
            if (container._state && container._state.options) container._state.options.serialize = false;
            container.draw = (ctx, node, w, posY) => node._drawLoraList(ctx, node, posY);
            container.mouse = (event, pos, node) => node._onLoraListMouse(event, pos);
            this._loraListWidget = container;
            return container;
        };

        // 重排 widget 顺序：所有行 widget -> 容器 -> 其余按钮（Add / 预设）
        nodeType.prototype._orderLoraWidgets = function() {
            if (!Array.isArray(this.widgets)) return;
            const rows = this.loraWidgets || [];
            const container = (this._loraListWidget && this.widgets.includes(this._loraListWidget)) ? this._loraListWidget : null;
            const rest = this.widgets.filter(w => w !== container && !rows.includes(w));
            this.widgets.length = 0;
            this.widgets.push(...rows);
            if (container) this.widgets.push(container);
            this.widgets.push(...rest);
        };

        // 计算列表视口几何：视口高度 = 容器被分配到的 computedHeight（跟随节点高度）
        nodeType.prototype._loraListMetrics = function() {
            const container = this._loraListWidget;
            if (!container || !Array.isArray(this.widgets) || !this.widgets.includes(container)) return null;
            const rows = this.loraWidgets || [];
            const contentH = rows.length * LORA_ROW_HEIGHT;
            const viewH = Math.max(LORA_ROW_HEIGHT, container.computedHeight || LORA_ROW_HEIGHT);
            const maxScroll = Math.max(0, contentH - viewH);
            const viewTop = container.last_y ?? container.y ?? 0;
            const scroll = Math.min(Math.max(0, this._loraScroll || 0), maxScroll);
            return { container, rows, contentH, viewH, maxScroll, viewTop, scroll };
        };

        // 夹紧滚动位置（删行/缩放后调用）
        nodeType.prototype._clampLoraScroll = function() {
            const m = this._loraListMetrics();
            if (!m) return;
            const clamped = Math.min(Math.max(0, this._loraScroll || 0), m.maxScroll);
            if (clamped !== this._loraScroll) {
                this._loraScroll = clamped;
                this.setDirtyCanvas(true, true);
            }
        };

        // 设置滚动位置（Infinity 表示滚到底部）
        nodeType.prototype._setLoraScroll = function(v) {
            const m = this._loraListMetrics();
            const maxScroll = m ? m.maxScroll : 0;
            let next = (v === Infinity) ? maxScroll : (Number.isFinite(v) ? v : 0);
            next = Math.min(Math.max(0, next), maxScroll);
            if (next !== this._loraScroll) {
                this._loraScroll = next;
                this.setDirtyCanvas(true, true);
            }
        };

        // 按节点局部 Y 命中当前行（只命中原生可视行）
        nodeType.prototype._loraRowAt = function(localY) {
            const m = this._loraListMetrics();
            if (!m) return null;
            if (localY < m.viewTop || localY >= m.viewTop + m.viewH) return null;
            const idx = Math.floor((localY - m.viewTop + m.scroll) / LORA_ROW_HEIGHT);
            return (idx >= 0 && idx < m.rows.length) ? m.rows[idx] : null;
        };

        // 容器绘制：按视口裁剪，逐行复用行 widget 的 draw
        nodeType.prototype._drawLoraList = function(ctx, node, posY) {
            const container = this._loraListWidget;
            if (!container) return;
            const m = this._loraListMetrics();
            if (!m) return;
            const nodeW = node.size[0];
            const viewH = m.viewH;
            const scroll = m.scroll;
            this._loraScroll = scroll;

            ctx.save();
            ctx.beginPath();
            ctx.rect(0, posY, nodeW, viewH);
            ctx.clip();

            ctx.fillStyle = "rgba(0,0,0,0.12)";
            ctx.fillRect(0, posY, nodeW, viewH);

            if (m.rows.length === 0) {
                ctx.fillStyle = "#666";
                ctx.font = "11px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("暂无 LoRA，点击下方 ➕ Add Lora 添加", nodeW / 2, posY + viewH / 2);
            }
            for (let i = 0; i < m.rows.length; i++) {
                const row = m.rows[i];
                const rowY = posY + i * LORA_ROW_HEIGHT - scroll;
                // 回写位置：供右键菜单 / 预览定位 / 命中判定使用
                row.y = rowY;
                row.last_y = rowY;
                if (rowY + LORA_ROW_HEIGHT < posY || rowY > posY + viewH) continue; // 完全不可见则跳过
                if (typeof row.draw === "function") {
                    row.draw(ctx, node, nodeW, rowY + 3, LORA_ROW_HEIGHT - 6);
                }
            }

            // 行排序拖拽反馈：被拖行半透明高亮 + 插入位置指示线
            const drag = this._loraDrag;
            if (drag && m.rows.length > 0) {
                const fromRowY = posY + drag.from * LORA_ROW_HEIGHT - scroll;
                ctx.save();
                ctx.fillStyle = "rgba(96,165,250,0.22)";
                ctx.beginPath();
                ctx.roundRect(10, fromRowY + 1, nodeW - 20, LORA_ROW_HEIGHT - 2, 3);
                ctx.fill();
                const gap = Math.max(0, Math.min(m.rows.length, drag.gap ?? drag.from));
                const lineY = posY + gap * LORA_ROW_HEIGHT - scroll;
                ctx.strokeStyle = "#60a5fa";
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(10, lineY);
                ctx.lineTo(nodeW - 14, lineY);
                ctx.stroke();
                ctx.restore();
            }

            ctx.restore();

            // 溢出时绘制滚动条（记录几何供鼠标拖拽）
            this._loraScrollbar = null;
            if (m.maxScroll > 0) {
                // 固定在右侧槽位；行内容到 nodeW-14 为止，这里从 nodeW-9 起，互不重叠
                const trackW = 6;                       // 可见条宽度（比原来 5px 更粗，更好抓）
                const trackX = nodeW - 9;               // 可见条 [nodeW-9, nodeW-3]
                const trackY = posY + 1;
                const trackH = viewH - 2;
                const thumbH = Math.max(24, trackH * (viewH / m.contentH));
                const thumbY = trackY + (trackH - thumbH) * (scroll / m.maxScroll);
                ctx.save();
                ctx.fillStyle = "rgba(255,255,255,0.06)";
                ctx.beginPath();
                ctx.roundRect(trackX, trackY, trackW, trackH, 3);
                ctx.fill();
                ctx.fillStyle = container._sbDragging ? "rgba(96,165,250,0.9)" : "rgba(150,150,150,0.7)";
                ctx.beginPath();
                ctx.roundRect(trackX, thumbY, trackW, thumbH, 3);
                ctx.fill();
                ctx.restore();
                // 命中区比可见条更宽（左右各外扩），大幅降低"抓不住"的概率
                this._loraScrollbar = { x: trackX - 4, w: trackW + 8, trackY, trackH, thumbY, thumbH };
            }
        };

        // 容器鼠标交互：滚动条拖拽 + 行事件路由（拖拽跨行由 node_widget 捕获后持续送到容器）
        nodeType.prototype._onLoraListMouse = function(event, pos) {
            const container = this._loraListWidget;
            if (!container) return false;
            const node = this;
            const localX = pos[0];
            const localY = pos[1];
            const sb = this._loraScrollbar;
            // 事件带 buttons 位掩码（左键=1）。若指针已抬起，任何残留的拖拽状态都是无效的。
            const leftDown = typeof event.buttons === "number" ? (event.buttons & 1) === 1 : true;

            // 自愈：ComfyUI 在窗口外松开 / pointercancel 时可能不会把 pointerup 派发到本容器
            // （processWidgetClick 的 finally 在拿不到 eUp 时会提前 return），导致滚动条拖拽状态残留。
            // 此时若继续把 pointermove 当滚动拖拽，会吞掉权重行的拖拽手势。检测到指针已抬起则清理。
            if (container._sbDragging && event.type !== "pointerdown" && !leftDown) {
                container._sbDragging = false;
                container._sbGrab = null;
            }

            if (event.type === "pointerdown") {
                // 新的按下必然开启一次全新手势：先清掉上一次可能残留的状态
                container._sbDragging = false;
                container._sbGrab = null;
                container._activeRow = null;
                node._loraDrag = null;
                for (const w of (node.loraWidgets || [])) w._pressPending = false;

                // 滚动条区域
                if (sb && localX >= sb.x && localX <= sb.x + sb.w && localY >= sb.trackY && localY <= sb.trackY + sb.trackH) {
                    const onThumb = localY >= sb.thumbY && localY <= sb.thumbY + sb.thumbH;
                    container._sbDragging = true;
                    if (onThumb) {
                        container._sbGrab = localY - sb.thumbY;
                    } else {
                        container._sbGrab = sb.thumbH / 2;
                        node._scrollFromThumbY(localY);
                    }
                    return true;
                }
                const row = node._loraRowAt(localY);
                if (row && typeof row.mouse === "function") {
                    container._activeRow = row;
                    return row.mouse(event, [localX, localY], node) || true;
                }
                return false;
            }

            if (event.type === "pointermove") {
                // 行排序拖拽中：更新插入位置 + 视口边缘自动滚动
                if (node._loraDrag) {
                    if (!leftDown) {
                        // 指针已在窗口外抬起：按最后位置落位
                        node._finishLoraRowDrag(localY);
                        return true;
                    }
                    const m = node._loraListMetrics();
                    if (m) {
                        if (localY < m.viewTop + 16) node._setLoraScroll(m.scroll - 14);
                        else if (localY > m.viewTop + m.viewH - 16) node._setLoraScroll(m.scroll + 14);
                        const cur = node._loraListMetrics() || m;
                        const idxFloat = (localY - cur.viewTop + cur.scroll) / LORA_ROW_HEIGHT;
                        node._loraDrag.gap = Math.max(0, Math.min(cur.rows.length, Math.round(idxFloat)));
                        node.setDirtyCanvas(true, true);
                    }
                    return true;
                }
                // 滚动条拖拽中（仅在左键仍按下时成立，其余情况已被上面的自愈清理）
                if (container._sbDragging) {
                    node._scrollFromThumbY(localY);
                    return true;
                }
                const row = container._activeRow;
                if (row && typeof row.mouse === "function") {
                    return row.mouse(event, [localX, localY], node);
                }
                return false;
            }

            if (event.type === "pointerup") {
                // 行排序拖拽结束：按最终位置落位
                if (node._loraDrag) {
                    node._finishLoraRowDrag(localY);
                    container._activeRow = null;
                    return true;
                }
                // 无论是否命中行、是否滚动拖拽，pointerup 都必须把两类状态统一复位，
                // 否则残留状态会让后续权重拖拽失效。
                const row = container._activeRow;
                let res = false;
                if (row && typeof row.mouse === "function") {
                    res = row.mouse(event, [localX, localY], node);
                }
                container._activeRow = null;
                if (container._sbDragging) {
                    container._sbDragging = false;
                    container._sbGrab = null;
                    res = true;
                }
                if (res) node.setDirtyCanvas(true, true);
                return res;
            }
            return false;
        };

        // 按滚动条滑块位置反算滚动量
        nodeType.prototype._scrollFromThumbY = function(localY) {
            const m = this._loraListMetrics();
            const sb = this._loraScrollbar;
            const container = this._loraListWidget;
            if (!m || !sb || !container || m.maxScroll <= 0) return;
            const trackRange = sb.trackH - sb.thumbH;
            if (trackRange <= 0) return;
            const grab = container._sbGrab ?? sb.thumbH / 2;
            const ratio = (localY - grab - sb.trackY) / trackRange;
            this._setLoraScroll(ratio * m.maxScroll);
        };

        // 打开某行的 LoRA 选择弹窗（名称区点击，未拖动时触发）
        nodeType.prototype._openLoraRowChooser = function(widget, event) {
            const node = this;
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
        };

        // 开始行排序拖拽：记录起始下标与当前插入位置
        nodeType.prototype._beginLoraRowDrag = function(widget, localY) {
            const rows = this.loraWidgets || [];
            const from = rows.indexOf(widget);
            if (from < 0) return false;
            hidePreview();
            const m = this._loraListMetrics();
            let gap = from;
            if (m) {
                gap = Math.round((localY - m.viewTop + m.scroll) / LORA_ROW_HEIGHT);
                gap = Math.max(0, Math.min(rows.length, gap));
            }
            this._loraDrag = { from, gap };
            this.setDirtyCanvas(true, true);
            return true;
        };

        // 把第 fromIdx 行移动到插入位置 gapIdx（gapIdx 语义为“插入到第几行之前”）
        nodeType.prototype._moveLoraRowTo = function(fromIdx, gapIdx) {
            const rows = this.loraWidgets || [];
            if (fromIdx < 0 || fromIdx >= rows.length) return false;
            const [w] = rows.splice(fromIdx, 1);
            let gap = (gapIdx > fromIdx) ? gapIdx - 1 : gapIdx;
            gap = Math.max(0, Math.min(rows.length, gap));
            rows.splice(gap, 0, w);
            this._orderLoraWidgets();
            if (typeof this._clampLoraScroll === "function") this._clampLoraScroll();
            this.setDirtyCanvas(true, true);
            return true;
        };

        // 结束行排序拖拽并落位
        nodeType.prototype._finishLoraRowDrag = function(localY) {
            const drag = this._loraDrag;
            this._loraDrag = null;
            if (!drag) return false;
            const m = this._loraListMetrics();
            let gap = drag.gap;
            if (m && Number.isFinite(localY)) {
                gap = Math.round((localY - m.viewTop + m.scroll) / LORA_ROW_HEIGHT);
                gap = Math.max(0, Math.min(m.rows.length, gap));
            }
            const moved = this._moveLoraRowTo(drag.from, gap);
            this.setDirtyCanvas(true, true);
            return moved;
        };

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
                strengthTwo: null,
                trigger: "",
                triggerWeight: 1.0
            }, () => {});

            // Auto-populate trigger word from database
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
            // 内部滚动模式：行 widget 隐藏（不占高度/不绘制/不参与命中），但仍参与 widgets_values 序列化
            widget.hidden = true;

            widget.draw = (ctx, node, w, posY, h) => {
                // 确保 widget.value 存在
                if (!widget.value) {
                    widget.value = { on: true, lora: null, strength: 1.0, strengthTwo: null, trigger: "", triggerWeight: 1.0 };
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

                const maxNameWidth = width - 70 - (iconDrawn ? 18 : 0);
                let truncatedName = name;
                while (ctx.measureText(truncatedName).width > maxNameWidth && truncatedName.length > 3) {
                    truncatedName = truncatedName.slice(0, -4) + "...";
                }
                ctx.fillText(truncatedName, nameX, midY);

                const strength = widget.value.strength ?? 1.0;
                const strengthStr = strength.toFixed(2);
                ctx.textAlign = "right";
                ctx.fillStyle = isOn ? "#60a5fa" : "#777";
                ctx.fillText(strengthStr, width + x - 4, midY);

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

                if (event.type === "pointermove") {
                    // 名称区按下后移动：超过阈值即转为行排序拖拽
                    if (widget._pressPending) {
                        const leftDown = typeof event.buttons === "number" ? (event.buttons & 1) === 1 : true;
                        if (!leftDown) {
                            widget._pressPending = false;
                            widget._pressEvent = null;
                            return false;
                        }
                        const dx = (event.clientX ?? event.canvasX) - widget._pressX;
                        const dy = (event.clientY ?? event.canvasY) - widget._pressY;
                        if (Math.hypot(dx, dy) > 5) {
                            widget._pressPending = false;
                            widget._pressEvent = null;
                            return node._beginLoraRowDrag(widget, pos[1]);
                        }
                        return true;
                    }
                    // 自愈：若左键已抬起（窗口外松开 / pointercancel 导致 pointerup 未送达本行），
                    // 残留的拖拽状态会让权重出现“幻影拖拽/跳变”，此处清理并放弃本次手势。
                    const leftDown = typeof event.buttons === "number" ? (event.buttons & 1) === 1 : true;
                    if (widget._isDragging && !leftDown) {
                        widget._isDragging = false;
                        widget._hasMoved = false;
                        widget._dragStartX = null;
                        widget._dragStartStrength = null;
                        return false;
                    }
                    if (widget._isDragging && widget._dragStartX != null) {
                        const deltaX = event.canvasX - widget._dragStartX;
                        if (Math.abs(deltaX) > 3) {
                            widget._hasMoved = true;
                        }
                        if (widget._hasMoved) {
                            const newStrength = widget._dragStartStrength + deltaX * 0.01;
                            const val = Math.round(newStrength * 100) / 100;
                            widget.value.strength = val;
                            widget.value.triggerWeight = val;
                            node.setDirtyCanvas(true, true);
                        }
                        return true;
                    }
                    return false;
                }
                
                if (event.type === "pointerup") {
                    // 名称区点击（未拖动）：打开 LoRA 选择弹窗
                    if (widget._pressPending) {
                        const pressEvent = widget._pressEvent || event;
                        widget._pressPending = false;
                        widget._pressEvent = null;
                        node._openLoraRowChooser(widget, pressEvent);
                        return true;
                    }
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

                    // LoRA名称区域：按下先挂起，拖动=排序，抬起=选择弹窗
                    if (localX >= margin + 24 && localX <= node.size[0] - 60) {
                        widget._pressPending = true;
                        widget._pressX = event.clientX ?? event.canvasX;
                        widget._pressY = event.clientY ?? event.canvasY;
                        widget._pressEvent = event;
                        return true;
                    }
                    
                    // 权重区域 - 开始拖拽
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

            this.loraWidgets.push(widget);
            // 排好 widget 顺序（容器在行与按钮之间），新增行滚动到底部
            this._orderLoraWidgets();
            this._setLoraScroll(Infinity);
            this.setDirtyCanvas(true, true);
            
            return widget;
        };

        nodeType.prototype.removeLoraWidget = function(widget) {
            const idx = this.widgets.indexOf(widget);
            if (idx >= 0) {
                this.widgets.splice(idx, 1);
                this.loraWidgets = this.loraWidgets.filter(w => w !== widget);
                // 内部滚动模式：不重算节点高度，仅夹紧滚动位置
                if (typeof this._clampLoraScroll === "function") this._clampLoraScroll();
                this.setDirtyCanvas(true, true);
            }
        };

        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function(info) {
            while (this.widgets?.length) this.widgets.pop();
            this.loraCounter = 0;
            this.loraWidgets = [];

            // 内部滚动模式：重置容器与滚动状态（旧容器对象已随 widgets 清空失效）
            this.__xbhhScrollable = true;
            this._loraScroll = 0;
            this._loraDrag = null;
            this._loraListWidget = null;
            this._ensureLoraListWidget();

            // 提示词权重控制：重建承载 widget（旧对象已随 widgets 清空失效）
            this._triggerWeightControlWidget = null;
            this._ensureTriggerWeightControlWidget();
            
            for (const v of info.widgets_values || []) {
                if (v?.lora !== undefined) {
                    const w = this.addLoraRow(v.lora);
                    w.value = { ...v };
                }
            }
            
            // 添加 LoRA 按钮 (自定义绘制)
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
            
            // 导入/导出按钮合并为一行
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

            // 重新排好 widget 顺序（行 -> 容器 -> 按钮）
            this._orderLoraWidgets();

            // 恢复「提示词权重控制」开关：优先用命名值，缺失则默认开启
            // （忽略位置兜底，避免老工作流被错误置为关闭）
            const savedWeightControl = info.widgets_values_named?.["trigger_weight_control"];
            this._triggerWeightControl = savedWeightControl === undefined ? true : !!savedWeightControl;
            if (this._triggerWeightControlWidget) {
                this._triggerWeightControlWidget.value = this._triggerWeightControl;
            }

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

// 弹出预设多选组合与在线修改弹窗
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

    // 数据库为准：弹窗打开时用数据库最新触发词预填并刷新 widget 缓存，
    // 保证在 LoRA 管理器修改提示词后，这里显示的就是最新值（不再是添加时的旧缓存）。
    // 数据库无值时保留 widget 值（兼容预设导入行携带触发词的情况）。
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
    let modalOverlay = document.getElementById("xbhh-preset-combo-modal");
    if (modalOverlay) modalOverlay.remove();

    modalOverlay = document.createElement("div");
    modalOverlay.id = "xbhh-preset-combo-modal";
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

        // ====================================================================
        // 右键菜单：行内操作 / 空白区批量操作 / 保存为配方
        // ====================================================================
        const STACK_RECIPE_MODAL_ID = "xbhh-stack-recipe-modal";

        // 配方预览图文件名主干：<配方名>_<配方ID>（与 LoRA 管理器保持一致）
        function stackRecipePreviewStem(name, id) {
            const safe = String(name || "")
                .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
                .replace(/\s+/g, " ")
                .trim()
                .replace(/^\.+/, "")
                .slice(0, 60)
                .trim();
            const rid = String(id || "").replace(/[^A-Za-z0-9_-]/g, "");
            return rid ? `${safe || "recipe"}_${rid}` : (safe || "recipe");
        }

        // 行 widget → 配方里的 LoRA 行（字段名与管理器配方一致）
        function stackRowToRecipeLora(w) {
            const v = (w && w.value) || {};
            const name = Array.isArray(v.lora) ? v.lora[0] : v.lora;
            if (!name || name === "None") return null;
            const model = Number.isFinite(Number(v.strength)) ? Number(v.strength) : 1.0;
            const clip = (v.strengthTwo === null || v.strengthTwo === undefined || !Number.isFinite(Number(v.strengthTwo)))
                ? model
                : Number(v.strengthTwo);
            const tw = Number.isFinite(Number(v.triggerWeight)) ? Number(v.triggerWeight) : 1.0;
            return {
                on: v.on !== false,
                name,
                hash: "",
                weight: model,
                weightClip: clip,
                trigger: v.trigger || "",
                triggerWeight: tw
            };
        }

        // 上传配方预览图，返回相对 ComfyUI 根目录的路径
        async function uploadStackRecipePreview(blob, filename, name, id) {
            const fd = new FormData();
            fd.append("image", blob, filename || "image.png");
            fd.append("stem", stackRecipePreviewStem(name, id));
            const res = await api.fetchApi("/xbhh/lora/recipe-preview/upload", { method: "POST", body: fd });
            const data = await res.json();
            if (!data || data.error || !(data.paths || []).length) {
                throw new Error((data && data.error) || "图片上传失败");
            }
            return (data.rel_paths && data.rel_paths[0]) || data.paths[0];
        }

        // 最近一次生成任务输出的图片（新的在前）
        async function fetchRecentOutputImages(limit) {
            const res = await api.fetchApi(`/history?max_items=${Math.max(8, (limit || 9) * 2)}`);
            const hist = await res.json();
            const runs = Object.keys(hist || {})
                .map(k => hist[k])
                .filter(Boolean)
                .sort((a, b) => ((b.prompt && b.prompt[0]) || 0) - ((a.prompt && a.prompt[0]) || 0));
            const out = [];
            for (const run of runs) {
                const imgs = [];
                const outputs = run.outputs || {};
                for (const nid of Object.keys(outputs)) {
                    for (const im of (outputs[nid].images || [])) {
                        if ((im.type || "output") !== "output") continue;
                        imgs.push(im);
                    }
                }
                // 单次执行最多取 4 张，避免批量出图占满列表
                for (const im of imgs.slice(-4)) {
                    out.push({
                        filename: im.filename,
                        subfolder: im.subfolder || "",
                        url: `/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || "")}&type=output`
                    });
                    if (out.length >= (limit || 9)) return out;
                }
            }
            return out;
        }

        // 轻提示（不依赖 ComfyUI 版本）
        function showStackToast(msg) {
            const el = document.createElement("div");
            el.textContent = msg;
            el.style.cssText = "position:fixed; left:50%; bottom:36px; transform:translateX(-50%); background:rgba(30,30,36,0.96); border:1px solid #3a3a4c; color:#ddd; font-size:12px; padding:8px 16px; border-radius:8px; z-index:100001; pointer-events:none; box-shadow:0 6px 20px rgba(0,0,0,0.5);";
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 2400);
        }

        // 把当前 LoRA 堆保存为一个配方（字段参考 LoRA 管理器的新建配方弹窗）
        async function openSaveStackRecipeDialog(node) {
            // 配方只收已启用的 LoRA，关闭的先不写入
            const rows = (node.loraWidgets || [])
                .filter(w => w && w.value && w.value.on !== false)
                .map(stackRowToRecipeLora)
                .filter(Boolean);
            if (!rows.length) {
                showStackToast("没有已启用的 LoRA，无法保存配方");
                return;
            }
            const existed = document.getElementById(STACK_RECIPE_MODAL_ID);
            if (existed) existed.remove();

            const state = {
                id: "r" + Date.now(),
                tags: [],
                image: null,   // { file, filename } 或 { url, filename }
                saving: false
            };
            let objectUrl = null;

            const el = (tag, css, text) => {
                const e = document.createElement(tag);
                if (css) e.style.cssText = css;
                if (text !== undefined) e.textContent = text;
                return e;
            };
            const INPUT_CSS = "width:100%; box-sizing:border-box; background:rgba(255,255,255,0.05); border:1px solid #3a3a4c; border-radius:6px; color:#ddd; font-size:12px; padding:6px 8px; outline:none; font-family:inherit;";
            const LABEL_CSS = "display:block; font-size:11px; color:#8b95a7; margin-bottom:4px;";
            const fmt = (n) => String(Math.round(Number(n) * 1000) / 1000);

            // ===== 容器 =====
            const overlay = el("div", "position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:10000; display:flex; align-items:center; justify-content:center; font-family:system-ui,-apple-system,sans-serif; color:#ddd;");
            overlay.id = STACK_RECIPE_MODAL_ID;
            const dialog = el("div", "background:#1e1e24; border:1px solid #3a3a4c; border-radius:12px; width:min(880px, 94vw); height:min(700px, 90vh); display:flex; flex-direction:column; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,0.8);");

            const header = el("div", "flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid #3a3a4c;");
            const titleEl = el("div", "font-size:14px; font-weight:600; color:#89b4fa;", "保存为配方");
            const closeBtn = el("div", "width:26px; height:26px; line-height:24px; text-align:center; border-radius:6px; cursor:pointer; color:#9aa5b8; font-size:18px; user-select:none;", "×");
            closeBtn.title = "关闭";
            header.appendChild(titleEl);
            header.appendChild(closeBtn);

            const body = el("div", "flex:1 1 auto; display:flex; align-items:stretch; gap:16px; padding:16px; overflow:hidden; min-height:0;");
            const left = el("div", "flex:0 0 236px; display:flex; flex-direction:column; gap:10px; overflow-y:auto; padding-right:12px; border-right:1px solid #3a3a4c;");
            const right = el("div", "flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:10px; overflow-y:auto; padding-right:4px; min-height:0;");

            // ===== 左栏：图片 / 最近生成 / 名称 / 分类 / 标签 / 备注 =====
            const imgField = el("div");
            imgField.appendChild(el("label", LABEL_CSS, "配方图片"));
            const imgBox = el("div", "position:relative; width:100%; aspect-ratio:1/1; min-height:150px; border:2px dashed rgba(255,255,255,0.2); border-radius:8px; box-sizing:border-box; cursor:pointer; overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;");
            imgBox.title = "点击上传配方图片";
            const imgEl = document.createElement("img");
            imgEl.style.cssText = "position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:none; background:#111; border-radius:8px;";
            const phEl = el("div", "display:flex; flex-direction:column; align-items:center; gap:6px; pointer-events:none;");
            phEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30"><path fill="#9aa5b8" d="${IMAGE_ICON_PATH}"/></svg><span style="font-size:12px; color:#888;">点击添加配方图片</span><span style="font-size:10px; color:#555;">支持 JPG / PNG / WEBP</span>`;
            const clearBtn = el("div", "position:absolute; top:5px; right:5px; z-index:2; width:22px; height:22px; line-height:22px; text-align:center; border-radius:50%; background:rgba(0,0,0,0.7); color:#ff7676; font-size:13px; cursor:pointer; user-select:none; display:none;", "✕");
            clearBtn.title = "移除图片";
            imgBox.appendChild(imgEl);
            imgBox.appendChild(phEl);
            imgBox.appendChild(clearBtn);
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = "image/png,image/jpeg,image/jpg,image/webp";
            fileInput.style.display = "none";
            imgField.appendChild(imgBox);
            imgField.appendChild(fileInput);

            // 最近生成图片
            const recentHead = el("div", "display:flex; align-items:center; justify-content:space-between; margin-top:2px;");
            recentHead.appendChild(el("span", "font-size:11px; color:#8b95a7;", "最近生成"));
            const refreshBtn = el("span", "font-size:10px; color:#89b4fa; cursor:pointer; user-select:none;", "刷新");
            recentHead.appendChild(refreshBtn);
            const recentWrap = el("div", "display:grid; grid-template-columns:repeat(3, 1fr); gap:6px;");

            const recentThumbs = [];
            const updateRecentSelection = () => {
                for (const t of recentThumbs) {
                    const sel = !!state.image && !!state.image.url && t.item.url === state.image.url;
                    t.el.style.borderColor = sel ? "#89b4fa" : "transparent";
                    t.el.style.opacity = sel ? "1" : "0.85";
                }
            };

            const setImage = (payload) => {
                if (objectUrl) {
                    try { URL.revokeObjectURL(objectUrl); } catch (e) { /* ignore */ }
                    objectUrl = null;
                }
                state.image = payload || null;
                if (payload && payload.file) {
                    objectUrl = URL.createObjectURL(payload.file);
                    imgEl.src = objectUrl;
                } else if (payload && payload.url) {
                    imgEl.src = payload.url;
                } else {
                    imgEl.removeAttribute("src");
                }
                const has = !!payload;
                imgEl.style.display = has ? "block" : "none";
                phEl.style.display = has ? "none" : "flex";
                clearBtn.style.display = has ? "block" : "none";
                imgBox.style.borderStyle = has ? "solid" : "dashed";
                imgBox.style.borderColor = has ? "#3a3a4c" : "rgba(255,255,255,0.2)";
                updateRecentSelection();
            };

            const loadRecent = async () => {
                recentThumbs.length = 0;
                recentWrap.innerHTML = "";
                recentWrap.appendChild(el("div", "grid-column:1 / -1; font-size:10px; color:#555; padding:4px 0;", "加载中…"));
                try {
                    const items = await fetchRecentOutputImages(9);
                    recentWrap.innerHTML = "";
                    if (!items.length) {
                        recentWrap.appendChild(el("div", "grid-column:1 / -1; font-size:10px; color:#555; padding:4px 0;", "暂无生成图片"));
                        return;
                    }
                    for (const item of items) {
                        const box = el("div", "position:relative; width:100%; aspect-ratio:1/1; border:2px solid transparent; border-radius:6px; overflow:hidden; cursor:pointer; box-sizing:border-box; background:#111;");
                        box.title = item.filename;
                        const im = document.createElement("img");
                        im.loading = "lazy";
                        im.src = item.url;
                        im.style.cssText = "width:100%; height:100%; object-fit:cover; display:block;";
                        box.appendChild(im);
                        box.onclick = () => setImage({ url: item.url, filename: item.filename });
                        recentWrap.appendChild(box);
                        recentThumbs.push({ el: box, item });
                    }
                    updateRecentSelection();
                } catch (e) {
                    recentWrap.innerHTML = "";
                    recentWrap.appendChild(el("div", "grid-column:1 / -1; font-size:10px; color:#f38ba8; padding:4px 0;", "读取最近生成图片失败"));
                }
            };

            imgBox.onclick = () => fileInput.click();
            clearBtn.onclick = (e) => {
                e.stopPropagation();
                setImage(null);
            };
            fileInput.onchange = () => {
                const f = fileInput.files && fileInput.files[0];
                if (f) setImage({ file: f, filename: f.name });
                fileInput.value = "";
            };
            refreshBtn.onclick = () => loadRecent();

            const nameField = el("div");
            nameField.appendChild(el("label", LABEL_CSS, "配方名称"));
            const nameInput = document.createElement("input");
            nameInput.type = "text";
            nameInput.placeholder = "如：赛博少女";
            nameInput.style.cssText = INPUT_CSS;
            nameField.appendChild(nameInput);

            const catField = el("div");
            catField.appendChild(el("label", LABEL_CSS, "分类"));
            const categorySelect = document.createElement("select");
            categorySelect.style.cssText = INPUT_CSS + " background:#262631;";
            const catNone = document.createElement("option");
            catNone.value = "";
            catNone.textContent = "未分类";
            categorySelect.appendChild(catNone);
            catField.appendChild(categorySelect);

            const tagsField = el("div");
            tagsField.appendChild(el("label", LABEL_CSS, "标签"));
            const tagsWrap = el("div", "display:flex; flex-wrap:wrap; gap:5px; align-items:center; background:rgba(255,255,255,0.05); border:1px solid #3a3a4c; border-radius:6px; padding:5px 6px; min-height:30px; box-sizing:border-box;");
            const tagInput = document.createElement("input");
            tagInput.type = "text";
            tagInput.placeholder = "输入后回车添加";
            tagInput.style.cssText = "flex:1 1 60px; min-width:60px; background:transparent; border:none; outline:none; color:#ddd; font-size:12px; padding:2px; font-family:inherit;";
            tagsWrap.appendChild(tagInput);
            tagsField.appendChild(tagsWrap);

            const renderTags = () => {
                tagsWrap.querySelectorAll(".xbhh-sr-tag").forEach(n => n.remove());
                for (const tag of state.tags) {
                    const chip = el("span", "display:inline-flex; align-items:center; gap:4px; background:rgba(137,180,250,0.16); border:1px solid rgba(137,180,250,0.4); color:#89b4fa; font-size:11px; border-radius:10px; padding:2px 8px;");
                    chip.className = "xbhh-sr-tag";
                    chip.appendChild(document.createTextNode(tag));
                    const del = el("span", "cursor:pointer; opacity:0.7; font-size:12px; line-height:1;", "×");
                    del.title = "移除标签";
                    del.onclick = () => {
                        state.tags = state.tags.filter(t => t !== tag);
                        renderTags();
                    };
                    chip.appendChild(del);
                    tagsWrap.insertBefore(chip, tagInput);
                }
            };
            const addTag = () => {
                const val = tagInput.value.trim().replace(/[,，]+$/, "");
                if (val && !state.tags.includes(val)) state.tags.push(val);
                tagInput.value = "";
                renderTags();
            };
            tagInput.onkeydown = (e) => {
                if (e.key === "Enter" || e.key === "," || e.key === "，") {
                    e.preventDefault();
                    addTag();
                } else if (e.key === "Backspace" && !tagInput.value && state.tags.length) {
                    state.tags.pop();
                    renderTags();
                }
            };
            tagInput.onblur = () => { if (tagInput.value.trim()) addTag(); };

            const noteField = el("div");
            noteField.appendChild(el("label", LABEL_CSS, "备注"));
            const noteInput = document.createElement("textarea");
            noteInput.placeholder = "可选的备注";
            noteInput.style.cssText = INPUT_CSS + " min-height:56px; resize:vertical;";
            noteField.appendChild(noteInput);

            left.appendChild(imgField);
            left.appendChild(recentHead);
            left.appendChild(recentWrap);
            left.appendChild(nameField);
            left.appendChild(catField);
            left.appendChild(tagsField);
            left.appendChild(noteField);

            // ===== 右栏：当前堆 LoRA 列表 + 提示词 =====
            const listHead = el("div", "display:flex; align-items:center; gap:8px;");
            listHead.appendChild(el("span", "font-size:11px; color:#8b95a7;", "LoRA 列表"));
            listHead.appendChild(el("span", "font-size:11px; color:#89b4fa;", `（${rows.length}）`));
            const listHint = el("div", "font-size:10px; color:rgba(255,255,255,0.32); line-height:1.5;", "仅包含当前已启用的 LoRA，保存后可在 LoRA 管理器的配方中查看");
            const listWrap = el("div", "flex:1 1 auto; min-height:80px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; padding-right:4px;");

            for (const r of rows) {
                const rowEl = el("div", "display:flex; align-items:center; gap:8px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:6px 8px; box-sizing:border-box;");
                const thumb = el("div", "width:34px; height:34px; flex:0 0 34px; border-radius:6px; overflow:hidden; background:#111;");
                const imgName = loraImages[r.name];
                if (imgName) {
                    const im = document.createElement("img");
                    im.src = `/xbhh/view/${encodeRFC3986URIComponent(imgName)}`;
                    im.style.cssText = "width:100%; height:100%; object-fit:cover; display:block;";
                    thumb.appendChild(im);
                }
                const info = el("div", "flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px;");
                const nm = el("div", "font-size:12px; color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;", stripSafetensorsExt(String(r.name).split(/[\/\\]/).pop()));
                nm.title = r.name;
                let metaText = `模型 ${fmt(r.weight)} · CLIP ${fmt(r.weightClip)}`;
                if (Number(r.triggerWeight) !== 1) metaText += ` · 提示词 ${fmt(r.triggerWeight)}`;
                info.appendChild(nm);
                info.appendChild(el("div", "font-size:10px; color:#8b95a7;", metaText));
                rowEl.appendChild(thumb);
                rowEl.appendChild(info);
                listWrap.appendChild(rowEl);
            }

            const promptHead = el("div", "display:flex; align-items:center; gap:8px; margin-top:2px;");
            promptHead.appendChild(el("span", "font-size:11px; color:#8b95a7;", "提示词"));
            const promptInput = document.createElement("textarea");
            promptInput.placeholder = "可选的提示词，仅作记录";
            promptInput.style.cssText = INPUT_CSS + " min-height:72px; resize:vertical;";

            right.appendChild(listHead);
            right.appendChild(listHint);
            right.appendChild(listWrap);
            right.appendChild(promptHead);
            right.appendChild(promptInput);

            // ===== 底部操作栏 =====
            const footer = el("div", "flex:0 0 auto; display:flex; align-items:center; gap:8px; padding:10px 16px; border-top:1px solid #3a3a4c; background:rgba(0,0,0,0.18);");
            const errEl = el("div", "flex:1 1 auto; min-width:0; color:#f38ba8; font-size:11px;");
            const cancelBtn = el("button", "padding:5px 14px; font-size:12px; border-radius:6px; white-space:nowrap; cursor:pointer; background:rgba(255,255,255,0.06); border:1px solid #3a3a4c; color:#9aa5b8; font-family:inherit;", "取消");
            const saveBtn = el("button", "padding:5px 14px; font-size:12px; border-radius:6px; white-space:nowrap; cursor:pointer; background:rgba(137,180,250,0.2); border:1px solid rgba(137,180,250,0.5); color:#89b4fa; font-family:inherit;", "保存配方");
            footer.appendChild(errEl);
            footer.appendChild(cancelBtn);
            footer.appendChild(saveBtn);

            body.appendChild(left);
            body.appendChild(right);
            dialog.appendChild(header);
            dialog.appendChild(body);
            dialog.appendChild(footer);
            overlay.appendChild(dialog);

            const onKey = (e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    close();
                }
            };

            function close() {
                window.removeEventListener("keydown", onKey, true);
                if (objectUrl) {
                    try { URL.revokeObjectURL(objectUrl); } catch (e) { /* ignore */ }
                    objectUrl = null;
                }
                overlay.remove();
            }

            closeBtn.onclick = close;
            cancelBtn.onclick = close;
            overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
            window.addEventListener("keydown", onKey, true);

            saveBtn.onclick = async () => {
                if (state.saving) return;
                const name = nameInput.value.trim();
                if (!name) {
                    errEl.textContent = "请填写配方名称";
                    nameInput.focus();
                    return;
                }
                // 输入框里没回车的内容也算标签
                if (tagInput.value.trim()) addTag();
                errEl.textContent = "";
                state.saving = true;
                saveBtn.disabled = true;
                saveBtn.style.opacity = "0.6";
                saveBtn.textContent = "保存中…";

                try {
                    let preview = null;
                    if (state.image) {
                        let blob = state.image.file;
                        let filename = state.image.filename;
                        if (!blob) {
                            const r = await api.fetchApi(state.image.url);
                            if (!r.ok) throw new Error("读取生成图片失败");
                            blob = await r.blob();
                        }
                        preview = await uploadStackRecipePreview(blob, filename, name, state.id);
                    }

                    const settingsRes = await api.fetchApi("/xbhh/lora/settings");
                    const settings = await settingsRes.json();
                    const recipes = (settings && Array.isArray(settings.recipes)) ? settings.recipes : [];
                    const recipe = {
                        id: state.id,
                        name,
                        category: categorySelect.value || null,
                        loras: rows.map(r => ({ ...r })),
                        tags: state.tags.slice(),
                        note: noteInput.value.trim(),
                        prompt: promptInput.value.trim(),
                        rating: 0,
                        preview,
                        updated: Date.now()
                    };
                    recipes.unshift(recipe);
                    const res = await api.fetchApi("/xbhh/lora/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ recipes })
                    });
                    const data = await res.json();
                    if (!data || data.error) throw new Error((data && data.error) || "保存失败");

                    close();
                    showStackToast(`已保存配方「${name}」，共 ${rows.length} 个 LoRA`);
                } catch (e) {
                    errEl.textContent = (e && e.message) ? e.message : String(e);
                    state.saving = false;
                    saveBtn.disabled = false;
                    saveBtn.style.opacity = "1";
                    saveBtn.textContent = "保存配方";
                }
            };

            document.body.appendChild(overlay);
            renderTags();
            loadRecent();
            setTimeout(() => nameInput.focus(), 60);

            // 分类选项来自管理器里已有的配方分类
            try {
                const res = await api.fetchApi("/xbhh/lora/settings");
                const settings = await res.json();
                const dirs = (settings && Array.isArray(settings.recipeDirs)) ? settings.recipeDirs : [];
                for (const d of dirs) {
                    if (!d || !d.name) continue;
                    const o = document.createElement("option");
                    o.value = d.name;
                    o.textContent = d.name;
                    categorySelect.appendChild(o);
                }
            } catch (e) { /* 忽略：仅保留「未分类」 */ }
        }

        // ====================================================================
        // 自定义右键菜单：直接拦截画布右键，完全替代 LiteGraph 原生菜单
        // （原生菜单无法通过 getExtraMenuOptions 去掉 Properties / Colors 等项）
        // ====================================================================
        const STACK_MENU_CLASS = "xbhh-stack-ctx-menu";
        let stackMenuEl = null;
        let stackMenuLastOpen = 0;

        function closeStackContextMenu() {
            if (!stackMenuEl) return;
            stackMenuEl.remove();
            stackMenuEl = null;
        }

        function ensureStackMenuStyle() {
            if (document.getElementById("xbhh-stack-ctx-style")) return;
            const style = document.createElement("style");
            style.id = "xbhh-stack-ctx-style";
            style.textContent = `
                .${STACK_MENU_CLASS} { position:fixed; z-index:100002; min-width:188px; max-width:280px; padding:4px; background:#1e1e24; border:1px solid #3a3a4c; border-radius:8px; box-shadow:0 10px 28px rgba(0,0,0,0.65); font-family:system-ui,-apple-system,sans-serif; font-size:12px; color:#ddd; user-select:none; }
                .${STACK_MENU_CLASS} .xbhh-ctx-title { padding:5px 10px 6px; font-size:11px; color:#8b95a7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-bottom:1px solid #3a3a4c; margin-bottom:4px; }
                .${STACK_MENU_CLASS} .xbhh-ctx-item { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:6px 10px; border-radius:5px; cursor:pointer; white-space:nowrap; }
                .${STACK_MENU_CLASS} .xbhh-ctx-item:hover { background:rgba(137,180,250,0.16); color:#89b4fa; }
                .${STACK_MENU_CLASS} .xbhh-ctx-item.danger { color:#f38ba8; }
                .${STACK_MENU_CLASS} .xbhh-ctx-item.danger:hover { background:rgba(243,139,168,0.14); }
                .${STACK_MENU_CLASS} .xbhh-ctx-item.disabled { opacity:0.38; cursor:default; }
                .${STACK_MENU_CLASS} .xbhh-ctx-item.disabled:hover { background:transparent; color:#ddd; }
                .${STACK_MENU_CLASS} .xbhh-ctx-hint { font-size:10px; color:#8b95a7; }
                .${STACK_MENU_CLASS} .xbhh-ctx-sep { height:1px; margin:4px 6px; background:#3a3a4c; }
            `;
            document.head.appendChild(style);
        }

        // items: [{ label, hint?, danger?, disabled?, onClick } | null]
        function showStackContextMenu(clientX, clientY, title, items) {
            closeStackContextMenu();
            ensureStackMenuStyle();

            const box = document.createElement("div");
            box.className = STACK_MENU_CLASS;

            if (title) {
                const head = document.createElement("div");
                head.className = "xbhh-ctx-title";
                head.textContent = title;
                head.title = title;
                box.appendChild(head);
            }

            for (const item of items) {
                if (!item) {
                    const sep = document.createElement("div");
                    sep.className = "xbhh-ctx-sep";
                    box.appendChild(sep);
                    continue;
                }
                const row = document.createElement("div");
                row.className = "xbhh-ctx-item"
                    + (item.danger ? " danger" : "")
                    + (item.disabled ? " disabled" : "");
                const label = document.createElement("span");
                label.textContent = item.label;
                row.appendChild(label);
                if (item.hint) {
                    const hint = document.createElement("span");
                    hint.className = "xbhh-ctx-hint";
                    hint.textContent = item.hint;
                    row.appendChild(hint);
                }
                if (!item.disabled) {
                    row.addEventListener("click", (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        closeStackContextMenu();
                        try {
                            item.onClick && item.onClick();
                        } catch (err) {
                            console.error("[xbhh] 右键菜单执行失败", err);
                        }
                    });
                }
                box.appendChild(row);
            }

            box.style.visibility = "hidden";
            box.style.left = "0px";
            box.style.top = "0px";
            document.body.appendChild(box);
            stackMenuEl = box;

            const pad = 8;
            const left = Math.max(pad, Math.min(clientX, window.innerWidth - box.offsetWidth - pad));
            const top = Math.max(pad, Math.min(clientY, window.innerHeight - box.offsetHeight - pad));
            box.style.left = left + "px";
            box.style.top = top + "px";
            box.style.visibility = "visible";
        }

        // 行右键菜单项
        function stackRowMenuItems(node, w) {
            const loraName = Array.isArray(w.value?.lora) ? w.value.lora[0] : w.value?.lora;
            return [
                {
                    label: "设置触发词",
                    onClick: () => openLoraPresetComboDialog(node, w)
                },
                {
                    label: "设置触发词权重…",
                    onClick: () => {
                        const cur = (w.value.triggerWeight === undefined || w.value.triggerWeight === null) ? 1.0 : w.value.triggerWeight;
                        app.canvas.prompt("触发词权重 (0.0-2.0，1.0 = 跟随模型强度)", cur, v => {
                            const parsed = parseFloat(v);
                            if (!isNaN(parsed)) {
                                w.value.triggerWeight = Math.max(0, Math.min(2.0, parsed));
                                node.setDirtyCanvas(true, true);
                            }
                        });
                    }
                },
                {
                    label: "在管理器中查看",
                    disabled: !loraName,
                    onClick: () => {
                        if (!loraName) return;
                        // 复用同一套打开逻辑：管理器已打开时让原窗口就地跳转，不再多开标签页
                        if (typeof window.__xbhhOpenLoraManager === "function") {
                            window.__xbhhOpenLoraManager(loraName);
                        } else {
                            window.open(`${window.location.origin}/xbhh/lora-manager?lora=${encodeURIComponent(loraName)}`, "xbhh_lora_manager");
                        }
                    }
                },
                null,
                {
                    label: "删除 LoRA",
                    danger: true,
                    onClick: () => node.removeLoraWidget(w)
                }
            ];
        }

        // 空白区右键菜单项
        function stackBlankMenuItems(node) {
            const widgets = [...(node.loraWidgets || [])];
            const offWidgets = widgets.filter(x => x.value?.on === false);
            const onCount = widgets.length - offWidgets.length;
            const allOn = widgets.length > 0 && widgets.every(x => x.value?.on !== false);
            const allOff = widgets.length > 0 && widgets.every(x => x.value?.on === false);
            return {
                widgets,
                items: [
                    {
                        label: "全部启用",
                        disabled: !widgets.length || allOn,
                        onClick: () => {
                            for (const x of widgets) {
                                if (x.value) x.value.on = true;
                            }
                            node.setDirtyCanvas(true, true);
                        }
                    },
                    {
                        label: "全部禁用",
                        disabled: !widgets.length || allOff,
                        onClick: () => {
                            for (const x of widgets) {
                                if (x.value) x.value.on = false;
                            }
                            node.setDirtyCanvas(true, true);
                        }
                    },
                    null,
                    {
                        label: `清除已关闭（${offWidgets.length}）`,
                        disabled: !offWidgets.length,
                        onClick: () => {
                            for (const x of offWidgets) node.removeLoraWidget(x);
                        }
                    },
                    {
                        label: `清空全部（${widgets.length}）`,
                        danger: true,
                        disabled: !widgets.length,
                        onClick: () => {
                            if (confirm(`确定清空全部 ${widgets.length} 个 LoRA 吗？`)) {
                                for (const x of widgets) node.removeLoraWidget(x);
                            }
                        }
                    },
                    null,
                    {
                        label: "保存为配方…",
                        disabled: !onCount,
                        onClick: () => openSaveStackRecipeDialog(node)
                    }
                ]
            };
        }

        // 指针下方的真实命中元素是否属于画布区域（画布本体 / 画布容器内部）
        // 覆盖在画布之上的浮层（如看板娘）不属于该区域，右键应交给它们
        function isEventOnCanvas(event, canvasEl) {
            let root = canvasEl.closest(".graph-canvas-container") || canvasEl.parentElement || canvasEl;
            // 避免退回 body/html 后把整页都当成画布
            if (root === document.body || root === document.documentElement) root = canvasEl;
            const inside = (el) => !!el && el.nodeType === 1 && (el === root || root.contains(el));
            if (inside(event.target)) return true;
            // 兜底：按坐标取最上层元素再判断一次（兼容 shadow DOM / 覆盖层）
            try {
                const el = document.elementFromPoint(event.clientX, event.clientY);
                if (!el) return true;
                return inside(el);
            } catch (e) {
                return true;
            }
        }

        // 穿透型浮层（如看板娘，容器 pointer-events:none）无法用 DOM 命中判断，
        // 由浮层自行注册坐标命中测试；命中时不抢右键
        function isCoveredByOverlay(event) {
            const tests = window.__xbhhOverlayHitTests;
            if (!Array.isArray(tests)) return false;
            for (const test of tests) {
                try {
                    if (typeof test === "function" && test(event.clientX, event.clientY)) return true;
                } catch (e) { /* ignore */ }
            }
            return false;
        }

        // 画布坐标命中本节点（兼容普通画布与新版 Vue 节点）
        function hitStackNode(event) {
            const canvas = app && app.canvas;
            const canvasEl = canvas && canvas.canvas;
            if (!canvas || !canvas.graph || !canvasEl) return null;
            // 输入框 / 可编辑区域保留浏览器原生菜单（右键复制粘贴）
            const target = event.target;
            if (target && typeof target.closest === "function"
                && target.closest("input, textarea, select, [contenteditable='true']")) return null;
            // 被看板娘等更高层浮层盖住时，右键应交给上层元素，而不是画布里的节点
            if (!isEventOnCanvas(event, canvasEl)) return null;
            if (isCoveredByOverlay(event)) return null;
            const rect = canvasEl.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom) return null;
            let pos;
            try {
                pos = canvas.convertEventToCanvasOffset(event);
            } catch (e) {
                return null;
            }
            if (!pos) return null;
            const node = canvas.graph.getNodeOnPos(pos[0], pos[1]);
            if (!node || node.type !== NODE_NAME) return null;
            // 折叠状态整体交还原生
            if (node.flags && node.flags.collapsed) return null;
            // LiteGraph 的标题栏画在 node.pos 上方：局部 y ∈ [-30, 0)，
            // 只有这一段交还原生菜单；节点本体从 y = 0 开始
            if (pos[1] - node.pos[1] < 0) return null;
            return { node, pos };
        }

        function installStackContextMenu() {
            if (window.__xbhhLoraCtxMenuInstalled) return;
            window.__xbhhLoraCtxMenuInstalled = true;

            const onDown = (event) => {
                // 菜单已打开：点击菜单外先关闭
                if (stackMenuEl) {
                    if (stackMenuEl.contains(event.target)) return;
                    closeStackContextMenu();
                }
                if (event.button !== 2) return;
                // 保存配方弹窗打开时不处理，交给弹窗
                if (document.getElementById(STACK_RECIPE_MODAL_ID)) return;

                const hit = hitStackNode(event);
                if (!hit) return;

                // 阻止原生右键菜单 / 画布默认处理
                event.preventDefault();
                event.stopImmediatePropagation();

                // 右键时选中该节点
                try {
                    const canvas = app.canvas;
                    if (typeof canvas.selectNode === "function") canvas.selectNode(hit.node, false);
                    else if (typeof canvas.select === "function") canvas.select(hit.node);
                } catch (e) { /* ignore */ }

                // pointerdown 与 mousedown 会先后触发，只打开一次
                // （阈值取同一手势内的毫秒差，不能用长时间窗，否则快速二次右键会没反应）
                const now = Date.now();
                if (now - stackMenuLastOpen < 60) return;
                stackMenuLastOpen = now;

                const localY = hit.pos[1] - hit.node.pos[1];
                const row = hit.node._loraRowAt ? hit.node._loraRowAt(localY) : null;

                if (row) {
                    const name = Array.isArray(row.value?.lora) ? row.value.lora[0] : row.value?.lora;
                    const title = name
                        ? stripSafetensorsExt(String(name).split(/[\/\\]/).pop())
                        : null;
                    showStackContextMenu(event.clientX, event.clientY, title, stackRowMenuItems(hit.node, row));
                } else {
                    const { widgets, items } = stackBlankMenuItems(hit.node);
                    showStackContextMenu(event.clientX, event.clientY, `${widgets.length} 个 LoRA`, items);
                }
            };

            window.addEventListener("pointerdown", onDown, true);
            window.addEventListener("mousedown", onDown, true);
            window.addEventListener("contextmenu", (event) => {
                if (!hitStackNode(event)) return;
                event.preventDefault();
                event.stopImmediatePropagation();
            }, true);
            window.addEventListener("keydown", (event) => {
                if (event.key === "Escape" && stackMenuEl) {
                    closeStackContextMenu();
                    event.preventDefault();
                    event.stopPropagation();
                }
            }, true);
            window.addEventListener("wheel", closeStackContextMenu, true);
            window.addEventListener("blur", closeStackContextMenu);
            window.addEventListener("resize", closeStackContextMenu);
        }

        installStackContextMenu();

        // 标题栏使用 ComfyUI/LiteGraph 原生右键菜单，这里不再追加自定义项

        const onMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function(event, pos) {
            onMouseMove?.apply(this, arguments);

            // 选择弹窗打开时不再显示行内悬浮预览，避免预览被弹窗遮挡或盖住弹窗
            if (document.querySelector(".xbhh-lora-dialog-plus")) {
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
            // 内部滚动：用容器命中判定当前行
            const hitRow = this._loraRowAt ? this._loraRowAt(localY) : null;
            let found = false;

            if (hitRow) {
                if (this._hoverLoraWidget !== hitRow) {
                    this._hoverLoraWidget = hitRow;
                    if (shiftKeyPressed) this.setDirtyCanvas(true, true);
                }
                if (hitRow.value.lora && loraImages[hitRow.value.lora]) {
                    const screenPos = app.canvas.convertOffsetToCanvas([
                        this.pos[0] + this.size[0],
                        this.pos[1] + hitRow.last_y
                    ]);
                    showPreviewAt(hitRow.value.lora, screenPos[0], screenPos[1]);
                    found = true;
                }
            }

            if (this._hoverLoraWidget && !found && !hitRow) {
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
        
        // 内部滚动：滚轮改为滚动列表
        // 注意：ComfyUI 的 processMouseWheel 不会把事件派发给节点/widget（node.onWheel 是死代码），
        // 因此这里自建 window 捕获监听，命中本节点的列表视口时才拦截。
        if (!window.__xbhhLoraWheelPlus) {
            window.__xbhhLoraWheelPlus = true;
            window.addEventListener("wheel", (event) => {
                // 保存配方弹窗打开时，滚轮交给弹窗自身处理
                if (document.getElementById(STACK_RECIPE_MODAL_ID)) return;
                const canvas = app.canvas;
                if (!canvas || !canvas.graph) return;
                let p;
                try { p = canvas.convertEventToCanvasOffset(event); } catch (e) { return; }
                const node = canvas.graph.getNodeOnPos(p[0], p[1]);
                if (!node || node.type !== NODE_NAME) return;
                if (typeof node._loraListMetrics !== "function") return;
                const m = node._loraListMetrics();
                if (!m || m.maxScroll <= 0) return;
                const localY = p[1] - node.pos[1];
                if (localY < m.viewTop || localY >= m.viewTop + m.viewH) return;
                const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
                node._setLoraScroll(m.scroll + delta * 0.5);
                event.preventDefault();
                event.stopPropagation();
            }, { capture: true, passive: false });
        }

        // 拖拽边框改变节点大小时：夹紧滚动位置并重绘（列表视口跟随节点高度）
        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function() {
            onResize?.apply(this, arguments);
            if (this.__xbhhScrollable && typeof this._clampLoraScroll === "function") {
                this._clampLoraScroll();
                this.setDirtyCanvas(true, true);
            }
        };

        // ====================================================================
        // 提示词权重控制：全局开关（节点标题栏右侧）
        // ====================================================================

        // 惰性创建/复用承载 widget：
        // hidden=true 使其不占高度、不绘制、不参与命中，但 name 仍在，
        // 因此 prompt 构建时仍会以名字为键发送给后端（hidden 不影响发送）。
        nodeType.prototype._ensureTriggerWeightControlWidget = function() {
            if (this._triggerWeightControlWidget && Array.isArray(this.widgets) && this.widgets.includes(this._triggerWeightControlWidget)) {
                return this._triggerWeightControlWidget;
            }
            if (this._triggerWeightControl === undefined) this._triggerWeightControl = true;
            const ctrlW = this.addWidget("custom", "trigger_weight_control", this._triggerWeightControl, () => {});
            ctrlW.computeSize = () => [0, 0];
            ctrlW.serializeValue = () => !!this._triggerWeightControl;
            ctrlW.hidden = true;
            this._triggerWeightControlWidget = ctrlW;
            return ctrlW;
        };

        // 按钮几何：贴在标题栏右侧（标题栏在节点局部坐标 y ∈ [-NODE_TITLE_HEIGHT, 0]）
        nodeType.prototype._getTriggerWeightToggleRect = function() {
            const titleH = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
            const w = 96;
            const h = 18;
            const x = (this.size ? this.size[0] : 300) - w - 8;
            const y = -titleH + (titleH - h) / 2;
            return { x, y, w, h };
        };

        nodeType.prototype._drawTriggerWeightToggle = function(ctx) {
            if (this.flags && this.flags.collapsed) return;
            const r = this._getTriggerWeightToggleRect();
            const on = this._triggerWeightControl !== false;
            const label = on ? "提示词权重 开" : "提示词权重 关";

            ctx.save();
            ctx.beginPath();
            ctx.roundRect(r.x, r.y, r.w, r.h, 9);
            ctx.fillStyle = on ? "rgba(59, 130, 246, 0.9)" : "rgba(80, 80, 80, 0.9)";
            ctx.fill();
            ctx.strokeStyle = on ? "rgba(147, 197, 253, 0.95)" : "rgba(140, 140, 140, 0.8)";
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = "#ffffff";
            ctx.font = "11px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 0.5);
            ctx.restore();
        };

        // 切换开关：同步节点属性、隐藏 widget 值并重绘
        nodeType.prototype._setTriggerWeightControl = function(v) {
            this._triggerWeightControl = !!v;
            if (this._triggerWeightControlWidget) {
                this._triggerWeightControlWidget.value = this._triggerWeightControl;
            }
            this.setDirtyCanvas(true, true);
        };

        // 自绘入口：onDrawForeground 在 drawNode 内被调用，ctx 已平移到节点原点
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function(ctx, canvas) {
            onDrawForeground?.apply(this, arguments);
            if (this.__xbhhScrollable) this._drawTriggerWeightToggle(ctx);
        };

        // 命中判定：命中则切换并返回真值消费事件（阻止节点拖拽）
        const onMouseDownPlus = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function(event, pos, canvas) {
            if (this.__xbhhScrollable && pos && !(this.flags && this.flags.collapsed)) {
                const r = this._getTriggerWeightToggleRect();
                if (pos[0] >= r.x && pos[0] <= r.x + r.w && pos[1] >= r.y && pos[1] <= r.y + r.h) {
                    this._setTriggerWeightControl(this._triggerWeightControl === false);
                    return true;
                }
            }
            return onMouseDownPlus?.apply(this, arguments);
        };
        
        // 背景样式：遵循 ComfyUI 原生节点背景样式
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
            if (this.flags.collapsed) return;
            onDrawBackground?.apply(this, arguments);
        };
    }
});
