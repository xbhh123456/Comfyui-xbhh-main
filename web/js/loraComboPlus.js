import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_NAME = "XBHHMultiLoraLoaderPlus";
const IMAGE_SIZE = 300;

// ============================================================================
// 前缀树 (Trie Tree) 模糊搜索引擎
// ============================================================================
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
        word = word.toLowerCase().trim();
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
        prefix = prefix.toLowerCase().trim();
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

// ============================================================================
// 工具函数
// ============================================================================
function encodeRFC3986URIComponent(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function loadLoraData() {
    try {
        const [images, loras] = await Promise.all([
            api.fetchApi("/xbhh/images/loras").then(r => r.json()),
            api.fetchApi("/xbhh/loras").then(r => r.json())
        ]);
        loraImages = images;
        loraList = loras;

        // 构建 Trie Tree
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
    } catch (error) {
        console.error("XBHH: Error loading lora data", error);
    }
}

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
                zIndex: "99999",
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
            background: "linear-gradient(135deg, #1a2a1f 0%, #0f1a12 100%)",
            border: "2px solid #5a8a6a",
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
            background: "linear-gradient(90deg, #2d5a3d 0%, #1a2a1f 100%)",
            borderBottom: "1px solid #3a5a4a",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
        }
    });
    
    const title = $el("span", {
        style: {
            color: "#8fdc9a",
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
            border: "1px solid #3a5a4a",
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
                const strength = w.value.strength ?? 1.0;
                const strengthTwo = w.value.strengthTwo ?? strength;
                const trigger = w.value.trigger || "";
                const triggerWeight = w.value.triggerWeight ?? 1.0;
                lines.push(`${enabled}|${lora}|${strength}|${strengthTwo}|${trigger}|${triggerWeight}`);
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
                background: "#2d5a3d",
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
                background: "#2d5a3d",
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
                
                // 解析并导入 (不需要全覆盖清空)
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
function showLoraChooserDialog(event, callback) {
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
            zIndex: "9999",
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
                item.style.background = selectedItems.has(loraName) ? "#3a7a5a" : "#444";
                if (hasImg) {
                    const rect = item.getBoundingClientRect();
                    showPreviewAt(loraName, rect.right, rect.top + rect.height / 2);
                }
            },
            onmouseleave: () => {
                item.style.background = selectedItems.has(loraName) ? "#2d5a3d" : "";
                hidePreview();
            },
            onclick: () => {
                hidePreview();
                if (selectedItems.has(loraName)) {
                    selectedItems.delete(loraName);
                    checkbox.checked = false;
                    item.style.background = "";
                } else {
                    selectedItems.add(loraName);
                    checkbox.checked = true;
                    item.style.background = "#2d5a3d";
                }
                if (typeof updateConfirmBtn === "function") updateConfirmBtn();
            }
        });
        
        const checkbox = $el("input", {
            type: "checkbox",
            style: { marginRight: "8px", pointerEvents: "none" }
        });
        
        const textSpan = $el("span", {
            textContent: hasImg ? `🖼️ ${fileName}` : fileName
        });
        
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

    searchInput.oninput = () => {
        const query = searchInput.value.toLowerCase().trim();
        
        if (!query) {
            allItems.forEach(({ element }) => {
                element.style.display = "";
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
            const matches = trieMatches.includes(loraName) || fileName.includes(query) || loraName.toLowerCase().includes(query);
            element.style.display = matches ? "" : "none";
            if (matches) {
                element.style.paddingLeft = "12px";
            }
        });
        requestAnimationFrame(reposition);
    };

    setTimeout(() => searchInput.focus(), 50);

    document.body.appendChild(dialog);

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
    name: "xbhh.MultiLoraLoaderPlus",

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
            
            // 添加 LoRA 按钮 (自定义绘制)
            const addLoraBtn = this.addWidget("custom", "➕ Add Lora", null, () => {});
            addLoraBtn.computeSize = () => [this.size[0] - 20, 26];
            addLoraBtn.draw = (ctx, node, w, posY, h) => {
                const x = 10;
                const y = posY;
                const width = node.size[0] - 20;
                const height = 24;
                
                // 绘制圆角背景
                ctx.fillStyle = "#2d5a3d";
                ctx.beginPath();
                ctx.roundRect(x, y, width, height, 6);
                ctx.fill();
                
                ctx.strokeStyle = "#5a8a6a";
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
                ctx.fillStyle = "#3a5a4a";
                ctx.beginPath();
                ctx.roundRect(x, y, btnWidth, height, 6);
                ctx.fill();
                ctx.strokeStyle = "#5a8a6a";
                ctx.lineWidth = 1;
                ctx.stroke();
                
                ctx.fillStyle = "#ccc";
                ctx.font = "11px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("📤 导出预设", x + btnWidth / 2, y + height / 2);
                
                // 导入按钮
                const importX = x + btnWidth + gap;
                ctx.fillStyle = "#3a5a4a";
                ctx.beginPath();
                ctx.roundRect(importX, y, btnWidth, height, 6);
                ctx.fill();
                ctx.strokeStyle = "#5a8a6a";
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
        };

        nodeType.prototype.addLoraRow = function(loraName) {
            if (Array.isArray(loraName)) loraName = loraName[0];
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
                api.fetchApi(`/xbhh/lora/trigger?name=${encodeURIComponent(loraName)}`)
                    .then(r => r.json())
                    .then(data => {
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
                    widget.value = { on: true, lora: null, strength: 1.0, strengthTwo: null, trigger: "", triggerWeight: 1.0 };
                }
                
                const x = 10;
                const y = posY;
                const width = node.size[0] - 20;
                const height = 20;
                const midY = y + height / 2;

                const isOn = widget.value.on ?? true;
                ctx.fillStyle = isOn ? "rgba(45, 90, 61, 0.9)" : "rgba(40, 40, 40, 0.9)";
                ctx.beginPath();
                ctx.roundRect(x, y, width, height, 3);
                ctx.fill();
                
                ctx.strokeStyle = isOn ? "#5a8a6a" : "#333";
                ctx.lineWidth = 1;
                ctx.stroke();

                const toggleX = x + 4;
                const toggleSize = 12;
                ctx.fillStyle = isOn ? "#6a6" : "#555";
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
                ctx.fillStyle = "#8fdc9a";
                ctx.fillText(strengthStr, width + x - 4, midY);
            };

            widget.mouse = (event, pos, node) => {
                const localX = pos[0];
                const margin = 10;
                
                if (event.type === "wheel" || event.type === "mousewheel") {
                    const delta = event.deltaY ? -Math.sign(event.deltaY) * 0.05 : (event.wheelDelta ? Math.sign(event.wheelDelta) * 0.05 : 0);
                    if (delta !== 0) {
                        let newStrength = (widget.value.strength ?? 1.0) + delta;
                        newStrength = Math.round(newStrength * 100) / 100;
                        widget.value.strength = newStrength;
                        widget.value.triggerWeight = newStrength;
                        node.setDirtyCanvas(true, true);
                    }
                    return true;
                }
                
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
                        widget._isDragging = false;
                        widget._hasMoved = false;
                        widget._dragStartX = null;
                        widget._dragStartStrength = null;
                        
                        if (!hasMoved) {
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
                    // 开关区域
                    if (localX >= margin && localX <= margin + 20) {
                        widget.value.on = !widget.value.on;
                        node.setDirtyCanvas(true, true);
                        return true;
                    }
                    
                    // LoRA名称区域
                    if (localX >= margin + 24 && localX <= node.size[0] - 60) {
                        showLoraChooserDialog(event, values => {
                            if (values && values.length > 0) {
                                widget.value.lora = values[0];
                                if (values[0] && values[0] !== "None") {
                                    api.fetchApi(`/xbhh/lora/trigger?name=${encodeURIComponent(values[0])}`)
                                        .then(r => r.json())
                                        .then(data => {
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
                        });
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

            // 将按钮移到最后
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
                this.setDirtyCanvas(true, true);
            }
        };

        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function(info) {
            while (this.widgets?.length) this.widgets.pop();
            this.loraCounter = 0;
            this.loraWidgets = [];
            
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
                
                ctx.fillStyle = "#2d5a3d";
                ctx.beginPath();
                ctx.roundRect(x, y, width, height, 6);
                ctx.fill();
                
                ctx.strokeStyle = "#5a8a6a";
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
                
                ctx.fillStyle = "#3a5a4a";
                ctx.beginPath();
                ctx.roundRect(x, y, btnWidth, height, 6);
                ctx.fill();
                ctx.strokeStyle = "#5a8a6a";
                ctx.lineWidth = 1;
                ctx.stroke();
                
                ctx.fillStyle = "#ccc";
                ctx.font = "11px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("📤 导出预设", x + btnWidth / 2, y + height / 2);
                
                const importX = x + btnWidth + gap;
                ctx.fillStyle = "#3a5a4a";
                ctx.beginPath();
                ctx.roundRect(importX, y, btnWidth, height, 6);
                ctx.fill();
                ctx.strokeStyle = "#5a8a6a";
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
    previewBox.style.cssText = "width:100%; height:48px; background:rgba(0,0,0,0.5); border:1px solid #3a5a4a; border-radius:6px; color:#7ef; font-size:11px; padding:6px; box-sizing:border-box; margin-bottom:15px;";

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
            
            for (const w of this.loraWidgets || []) {
                if (w.last_y && localY >= w.last_y && localY < w.last_y + 24) {
                    options.unshift(
                        { content: "🗑️ 删除", callback: () => this.removeLoraWidget(w) },
                        { content: w.value.on ? "⚫ 禁用" : "🟢 启用", callback: () => { w.value.on = !w.value.on; this.setDirtyCanvas(true, true); } },
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
                    break;
                }
            }
        };

        const onMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function(event, pos) {
            onMouseMove?.apply(this, arguments);
            
            const localY = pos[1];
            let found = false;
            
            for (const w of this.loraWidgets || []) {
                if (w.last_y && localY >= w.last_y && localY < w.last_y + 24) {
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
            
            if (!found) hidePreview();
        };

        const onMouseLeave = nodeType.prototype.onMouseLeave;
        nodeType.prototype.onMouseLeave = function() {
            hidePreview();
            onMouseLeave?.apply(this, arguments);
        };
        
        const onWheel = nodeType.prototype.onWheel;
        nodeType.prototype.onWheel = function(event, pos) {
            const res = onWheel?.apply(this, arguments);
            const localY = pos[1];
            for (const w of this.loraWidgets || []) {
                if (w.last_y && localY >= w.last_y && localY < w.last_y + 24) {
                    const delta = event.deltaY ? -Math.sign(event.deltaY) * 0.05 : (event.wheelDelta ? Math.sign(event.wheelDelta) * 0.05 : 0);
                    if (delta !== 0) {
                        let newStrength = (w.value.strength ?? 1.0) + delta;
                        newStrength = Math.round(newStrength * 100) / 100;
                        w.value.strength = newStrength;
                        w.value.triggerWeight = newStrength;
                        this.setDirtyCanvas(true, true);
                    }
                    return true;
                }
            }
            return res;
        };
        
        // 背景样式
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
            if (this.flags.collapsed) return;
            onDrawBackground?.apply(this, arguments);
            
            const gradient = ctx.createLinearGradient(0, 0, 0, this.size[1]);
            gradient.addColorStop(0, "#1a2a1f");
            gradient.addColorStop(1, "#0f1a12");
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.roundRect(0, 0, this.size[0], this.size[1], 5);
            ctx.fill();
            
            ctx.strokeStyle = "#3d6b4a";
            ctx.lineWidth = 2;
            ctx.stroke();
        };
    }
});
