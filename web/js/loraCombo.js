import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_NAME = "XBHHMultiLoraLoader";
const IMAGE_SIZE = 300;

// LoRA 堆内部滚动：单行高度（与旧版 22 + 4 行距一致，视觉不变）与默认可见行数
const LORA_ROW_HEIGHT = 26;
const LORA_LIST_DEFAULT_ROWS = 6;

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

// Shift 键状态跟踪：Shift+点击 LoRA 行 = 快捷删除（批量删除场景；Alt 与官方快捷键冲突故用 Shift）
let shiftKeyPressed = false;
window.addEventListener("keydown", e => { if (e.key === "Shift") shiftKeyPressed = true; }, true);
window.addEventListener("keyup", e => { if (e.key === "Shift") shiftKeyPressed = false; }, true);
window.addEventListener("blur", () => { shiftKeyPressed = false; });
let loraTrie = new Trie();

// ============================================================================
// 工具函数
// ============================================================================
function encodeRFC3986URIComponent(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
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

// ============================================================================
// 图片预览
// ============================================================================
const imageHost = $el("img", {
    className: "xbhh-preview-image",
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
document.body.appendChild(imageHost);

function showPreviewAt(loraName, x, y) {
    if (!loraName || !loraImages[loraName]) {
        hidePreview();
        return;
    }
    
    imageHost.src = `/xbhh/view/${encodeRFC3986URIComponent(loraImages[loraName])}?${+new Date()}`;
    imageHost.style.display = "block";
    
    // 计算位置
    let left = x + 10;
    let top = y - IMAGE_SIZE / 2;
    
    const bw = window.innerWidth;
    const bh = window.innerHeight;
    
    if (left + IMAGE_SIZE > bw) left = x - IMAGE_SIZE - 10;
    if (top + IMAGE_SIZE > bh) top = bh - IMAGE_SIZE - 10;
    if (top < 10) top = 10;
    
    imageHost.style.left = `${left}px`;
    imageHost.style.top = `${top}px`;
}

function hidePreview() {
    imageHost.style.display = "none";
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
    if (!loraName || !loraImages[loraName]) {
        hidePreview();
        return;
    }

    imageHost.src = `/xbhh/view/${encodeRFC3986URIComponent(loraImages[loraName])}?${+new Date()}`;
    imageHost.style.display = "block";

    const bw = window.innerWidth;
    const bh = window.innerHeight;

    // 优先放在矩形右侧，右侧空间不足则放到左侧
    let left = rect.right + gap;
    if (left + IMAGE_SIZE > bw - 10) left = rect.left - IMAGE_SIZE - gap;
    if (left < 10) left = 10;

    let top = rect.top + (rect.height - IMAGE_SIZE) / 2;
    if (top + IMAGE_SIZE > bh - 10) top = bh - IMAGE_SIZE - 10;
    if (top < 10) top = 10;

    imageHost.style.left = `${left}px`;
    imageHost.style.top = `${top}px`;
}

// ============================================================================
// 自定义LoRA选择对话框 (带搜索功能)
// ============================================================================
function showLoraChooserDialog(event, callback, options = {}) {
    const singleSelect = !!options.singleSelect;
    // 关闭已存在的对话框
    const existing = document.querySelector(".xbhh-lora-dialog");
    if (existing) existing.remove();
    
    const splitBy = /[\/\\]/;

    // 创建对话框
    const dialog = $el("div.xbhh-lora-dialog", {
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

    // 存储所有项目和文件夹的引用
    const allItems = [];
    const allFolders = [];

    // 创建LoRA项目
    function createLoraItem(loraName, indent = 0) {
        const fileName = loraName.split(splitBy).pop();
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
            textContent: hasImg ? `🖼️ ${fileName}` : fileName
        });
        
        item.appendChild(checkbox);
        item.appendChild(textSpan);
        
        allItems.push({ element: item, loraName, fileName: fileName.toLowerCase() });
        return item;
    }

    // 创建文件夹
    function createFolder(name, content, indent = 0) {
        const ITEMS = Symbol.for("items");
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
        
        // 添加子文件夹
        for (const [subName, subContent] of content.entries()) {
            if (typeof subName === "symbol") continue;
            children.appendChild(createFolder(subName, subContent, indent + 1));
        }
        
        // 添加LoRA
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

    // 构建文件夹树
    function buildTree() {
        const folderMap = new Map();
        const rootItems = [];
        const ITEMS = Symbol.for("items");

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

            if (!currentLevel.has(ITEMS)) {
                currentLevel.set(ITEMS, []);
            }
            currentLevel.get(ITEMS).push(loraName);
        }

        // 添加 None 选项
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

        // 添加文件夹
        for (const [name, content] of folderMap.entries()) {
            contentContainer.appendChild(createFolder(name, content));
        }
        
        // 添加根级LoRA
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

    // 搜索过滤功能
    searchInput.oninput = () => {
        const query = searchInput.value.toLowerCase().trim();
        
        if (!query) {
            // 清空搜索：恢复默认状态（条目为 flex 布局，不能重置为空，否则勾选框与文字会换行）
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
        
        // 有搜索词：过滤并展平显示
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
                element.style.paddingLeft = "12px"; // 展平显示
            }
        });
        requestAnimationFrame(reposition);
    };

    // 自动聚焦搜索框
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
                background: "#3b82f6",
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
// 节点扩展
// ============================================================================
app.registerExtension({
    name: "xbhh.MultiLoraLoader",

    async init() {
        await loadLoraData();

        const orig = app.refreshComboInNodes;
        app.refreshComboInNodes = async function() {
            const r = await Promise.all([orig.apply(this, arguments), loadLoraData().catch(() => {})]);
            return r[0];
        };
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
            this._loraListWidget = null;
            this._ensureLoraListWidget();

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
            // 容器不参与序列化（否则会污染 widgets_values）
            container.serialize = false;
            if (container.options) container.options.serialize = false;
            if (container._state && container._state.options) container._state.options.serialize = false;
            container.draw = (ctx, node, w, posY) => node._drawLoraList(ctx, node, posY);
            container.mouse = (event, pos, node) => node._onLoraListMouse(event, pos);
            this._loraListWidget = container;
            return container;
        };

        // 重排 widget 顺序：所有行 widget -> 容器 -> 其余按钮（Add）
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

            ctx.restore();

            // 溢出时绘制滚动条（记录几何供鼠标拖拽）
            this._loraScrollbar = null;
            if (m.maxScroll > 0) {
                const trackX = nodeW - 7;
                const trackY = posY + 1;
                const trackH = viewH - 2;
                const thumbH = Math.max(24, trackH * (viewH / m.contentH));
                const thumbY = trackY + (trackH - thumbH) * (scroll / m.maxScroll);
                ctx.save();
                ctx.fillStyle = "rgba(255,255,255,0.06)";
                ctx.beginPath();
                ctx.roundRect(trackX, trackY, 5, trackH, 2);
                ctx.fill();
                ctx.fillStyle = container._sbDragging ? "rgba(96,165,250,0.9)" : "rgba(150,150,150,0.7)";
                ctx.beginPath();
                ctx.roundRect(trackX, thumbY, 5, thumbH, 2);
                ctx.fill();
                ctx.restore();
                this._loraScrollbar = { x: trackX - 2, w: 9, trackY, trackH, thumbY, thumbH };
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

            // 滚动条拖拽中
            if (container._sbDragging) {
                if (event.type === "pointermove") {
                    node._scrollFromThumbY(localY);
                    return true;
                }
                if (event.type === "pointerup") {
                    container._sbDragging = false;
                    node.setDirtyCanvas(true, true);
                    return true;
                }
            }

            if (event.type === "pointerdown") {
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

            if (event.type === "pointermove" || event.type === "pointerup") {
                const row = container._activeRow;
                let res = false;
                if (row && typeof row.mouse === "function") {
                    res = row.mouse(event, [localX, localY], node);
                }
                if (event.type === "pointerup") container._activeRow = null;
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

                // 开关 + LoRA名称 + 权重
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
                const name = widget.value.lora?.split(/[\/\\]/).pop() || "None";
                const nameX = toggleX + toggleSize + 6;
                ctx.fillStyle = isOn ? "#ddd" : "#777";
                ctx.font = "11px Arial";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                
                const displayName = loraImages[widget.value.lora] ? `🖼️ ${name}` : name;
                const maxNameWidth = width - 70;
                let truncatedName = displayName;
                while (ctx.measureText(truncatedName).width > maxNameWidth && truncatedName.length > 3) {
                    truncatedName = truncatedName.slice(0, -4) + "...";
                }
                ctx.fillText(truncatedName, nameX, midY);

                const strength = widget.value.strength ?? 1.0;
                const strengthStr = strength.toFixed(2);
                ctx.textAlign = "right";
                ctx.fillStyle = "#999";
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

                // 权重区域拖拽处理
                if (event.type === "pointermove") {
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
                    if (widget._isDragging) {
                        const hasMoved = widget._hasMoved;
                        // 清理状态
                        widget._isDragging = false;
                        widget._hasMoved = false;
                        widget._dragStartX = null;
                        widget._dragStartStrength = null;
                        
                        // 没有拖拽移动则弹出输入框
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
            this._loraListWidget = null;
            this._ensureLoraListWidget();
            
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
            
            configure?.apply(this, arguments);

            // 重新排好 widget 顺序（行 -> 容器 -> 按钮）
            this._orderLoraWidgets();

            // 工作流加载后后台刷新列表并清理失效行（文件已被移动/删除的 LoRA）
            refreshLoraList();
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

    // 若 widget 内存中的触发词为空，且数据库中有有效触发词，自动从数据库同步
    let currentTrigger = widget.value.trigger;
    if (!currentTrigger && dbActiveTrigger) {
        currentTrigger = dbActiveTrigger;
        widget.value.trigger = dbActiveTrigger;
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
    titleEl.innerText = `📦 预设组合与编辑: ${loraName.split('/').pop()}`;

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

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(_, options) {
            getExtraMenuOptions?.apply(this, arguments);

            const mouse = app.canvas.graph_mouse;
            const localY = mouse[1] - this.pos[1];

            // 内部滚动：用容器命中判定当前行
            const w = this._loraRowAt ? this._loraRowAt(localY) : null;
            let onRow = false;
            if (w) {
                onRow = true;
                options.unshift(
                    { content: "🗑️ 删除", callback: () => this.removeLoraWidget(w) },
                    {
                        content: "✏️ 设置触发词",
                        callback: () => openLoraPresetComboDialog(this, w)
                    },
                    {
                        content: "⚖️ 设置触发词权重",
                        callback: () => {
                            app.canvas.prompt("触发词权重 (0.0-2.0)", w.value.triggerWeight || 1.0, v => {
                                const parsed = parseFloat(v);
                                if (!isNaN(parsed)) {
                                    w.value.triggerWeight = Math.max(0, Math.min(2.0, parsed));
                                    this.setDirtyCanvas(true, true);
                                }
                            });
                        }
                    },
                    null
                );
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
            if (document.querySelector(".xbhh-lora-dialog")) {
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
        if (!window.__xbhhLoraWheel) {
            window.__xbhhLoraWheel = true;
            window.addEventListener("wheel", (event) => {
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
    }
});
