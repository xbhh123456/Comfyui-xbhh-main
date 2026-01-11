import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_NAME = "XBHHMultiLoraLoaderPlus";
const IMAGE_SIZE = 300;

// ============================================================================
// 数据存储
// ============================================================================
let loraImages = {};
let loraList = [];

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
            if (w.value?.lora) {
                const enabled = w.value.on ? "1" : "0";
                const lora = w.value.lora;
                const strength = w.value.strength ?? 1.0;
                const strengthTwo = w.value.strengthTwo ?? strength;
                lines.push(`${enabled}|${lora}|${strength}|${strengthTwo}`);
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
                
                // 清空现有 LoRA
                while (node.loraWidgets?.length > 0) {
                    node.removeLoraWidget(node.loraWidgets[0]);
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
                        
                        const w = node.addLoraRow(loraName);
                        w.value.on = enabled;
                        w.value.strength = strength;
                        w.value.strengthTwo = strengthTwo;
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
                textOverflow: "ellipsis"
            },
            textContent: hasImg ? `🖼️ ${fileName}` : fileName,
            onmouseenter: (e) => {
                item.style.background = "#444";
                if (hasImg) {
                    const rect = item.getBoundingClientRect();
                    showPreviewAt(loraName, rect.right, rect.top + rect.height / 2);
                }
            },
            onmouseleave: () => {
                item.style.background = "";
                hidePreview();
            },
            onclick: () => {
                hidePreview();
                dialog.remove();
                callback(loraName);
            }
        });
        
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
            return;
        }
        
        allFolders.forEach(({ header, children }) => {
            header.style.display = "none";
            children.style.display = "block";
        });
        
        allItems.forEach(({ element, loraName, fileName }) => {
            const matches = fileName.includes(query) || loraName.toLowerCase().includes(query);
            element.style.display = matches ? "" : "none";
            if (matches) {
                element.style.paddingLeft = "12px";
            }
        });
    };

    setTimeout(() => searchInput.focus(), 50);

    document.body.appendChild(dialog);

    const rect = dialog.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        dialog.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
        dialog.style.top = `${window.innerHeight - rect.height - 10}px`;
    }

    const closeHandler = (e) => {
        if (!dialog.contains(e.target)) {
            hidePreview();
            dialog.remove();
            document.removeEventListener("mousedown", closeHandler);
        }
    };
    setTimeout(() => {
        document.addEventListener("mousedown", closeHandler);
    }, 100);

    const escHandler = (e) => {
        if (e.key === "Escape") {
            hidePreview();
            dialog.remove();
            document.removeEventListener("keydown", escHandler);
        }
    };
    document.addEventListener("keydown", escHandler);
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
            
            // 添加 LoRA 按钮
            this.addWidget("button", "➕ Add Lora", null, () => {
                showLoraChooserDialog(window.event, value => {
                    if (value && value !== "None") {
                        this.addLoraRow(value);
                    }
                });
            });
            
            // 导出按钮
            this.addWidget("button", "📤 导出预设", null, () => {
                showPresetDialog(this, "export");
            });
            
            // 导入按钮
            this.addWidget("button", "📥 导入预设", null, () => {
                showPresetDialog(this, "import");
            });
            
            this.size[0] = Math.max(this.size[0] || 0, 320);
        };

        nodeType.prototype.addLoraRow = function(loraName) {
            this.loraCounter++;
            const widgetName = `lora_${this.loraCounter}`;
            
            const widget = this.addWidget("custom", widgetName, {
                on: true,
                lora: loraName,
                strength: 1.0,
                strengthTwo: null
            }, () => {});

            widget.computeSize = () => [this.size[0] - 20, 22];
            widget.serializeValue = () => widget.value;

            widget.draw = (ctx, node, w, posY, h) => {
                const x = 10;
                const y = posY;
                const width = node.size[0] - 20;
                const height = 20;
                const midY = y + height / 2;

                ctx.fillStyle = widget.value.on ? "rgba(45, 90, 61, 0.9)" : "rgba(40, 40, 40, 0.9)";
                ctx.beginPath();
                ctx.roundRect(x, y, width, height, 3);
                ctx.fill();
                
                ctx.strokeStyle = widget.value.on ? "#5a8a6a" : "#333";
                ctx.lineWidth = 1;
                ctx.stroke();

                const toggleX = x + 4;
                const toggleSize = 12;
                ctx.fillStyle = widget.value.on ? "#6a6" : "#555";
                ctx.beginPath();
                ctx.roundRect(toggleX, midY - toggleSize/2, toggleSize, toggleSize, 2);
                ctx.fill();
                
                if (widget.value.on) {
                    ctx.fillStyle = "#fff";
                    ctx.font = "bold 9px Arial";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText("✓", toggleX + toggleSize/2, midY);
                }

                const name = widget.value.lora?.split(/[\/\\]/).pop() || "None";
                const nameX = toggleX + toggleSize + 6;
                ctx.fillStyle = widget.value.on ? "#ddd" : "#777";
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
                
                if (event.type === "pointermove") {
                    if (widget._isDragging && widget._dragStartX != null) {
                        const deltaX = event.canvasX - widget._dragStartX;
                        if (Math.abs(deltaX) > 3) {
                            widget._hasMoved = true;
                        }
                        if (widget._hasMoved) {
                            const newStrength = widget._dragStartStrength + deltaX * 0.01;
                            widget.value.strength = Math.round(newStrength * 100) / 100;
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
                                    node.setDirtyCanvas(true, true);
                                }
                            }, event);
                        }
                        return true;
                    }
                    return false;
                }
                
                if (event.type === "pointerdown") {
                    if (localX >= margin && localX <= margin + 20) {
                        widget.value.on = !widget.value.on;
                        node.setDirtyCanvas(true, true);
                        return true;
                    }
                    
                    if (localX >= margin + 24 && localX <= node.size[0] - 60) {
                        showLoraChooserDialog(event, value => {
                            if (value) {
                                widget.value.lora = value;
                                node.setDirtyCanvas(true, true);
                            }
                        });
                        return true;
                    }
                    
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
            const btnNames = ["➕ Add Lora", "📤 导出预设", "📥 导入预设"];
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
            
            this.addWidget("button", "➕ Add Lora", null, () => {
                showLoraChooserDialog(window.event, value => {
                    if (value && value !== "None") this.addLoraRow(value);
                });
            });
            
            this.addWidget("button", "📤 导出预设", null, () => {
                showPresetDialog(this, "export");
            });
            
            this.addWidget("button", "📥 导入预设", null, () => {
                showPresetDialog(this, "import");
            });
            
            configure?.apply(this, arguments);
        };

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
        
        // 背景样式
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
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
