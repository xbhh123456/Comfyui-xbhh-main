import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_NAME = "XBHHMultiLoraLoader";
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
const imageHost = $el("img", {
    className: "xbhh-preview-image",
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

// ============================================================================
// 自定义LoRA选择对话框 (带搜索功能)
// ============================================================================
function showLoraChooserDialog(event, callback) {
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

    // 搜索过滤功能
    searchInput.oninput = () => {
        const query = searchInput.value.toLowerCase().trim();
        
        if (!query) {
            // 清空搜索：恢复默认状态
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
        
        // 有搜索词：过滤并展平显示
        allFolders.forEach(({ header, children }) => {
            header.style.display = "none";
            children.style.display = "block";
        });
        
        allItems.forEach(({ element, loraName, fileName }) => {
            const matches = fileName.includes(query) || loraName.toLowerCase().includes(query);
            element.style.display = matches ? "" : "none";
            if (matches) {
                element.style.paddingLeft = "12px"; // 展平显示
            }
        });
    };

    // 自动聚焦搜索框
    setTimeout(() => searchInput.focus(), 50);

    document.body.appendChild(dialog);

    // 调整位置确保不超出屏幕
    const rect = dialog.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        dialog.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
        dialog.style.top = `${window.innerHeight - rect.height - 10}px`;
    }

    // 点击外部关闭
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

    // ESC键关闭
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
            
            this.addWidget("button", "➕ Add Lora", null, () => {
                showLoraChooserDialog(window.event, value => {
                    if (value && value !== "None") {
                        this.addLoraRow(value);
                    }
                });
            });
            
            this.size[0] = Math.max(this.size[0] || 0, 300);
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

                ctx.fillStyle = widget.value.on ? "rgba(50, 70, 50, 0.9)" : "rgba(40, 40, 40, 0.9)";
                ctx.beginPath();
                ctx.roundRect(x, y, width, height, 3);
                ctx.fill();
                
                ctx.strokeStyle = widget.value.on ? "#585" : "#333";
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

                const strengthStr = widget.value.strength.toFixed(2);
                ctx.textAlign = "right";
                ctx.fillStyle = "#999";
                ctx.fillText(strengthStr, width + x - 4, midY);
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
                        // 清理状态
                        widget._isDragging = false;
                        widget._hasMoved = false;
                        widget._dragStartX = null;
                        widget._dragStartStrength = null;
                        
                        // 没有拖拽移动则弹出输入框
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
                    // 开关区域
                    if (localX >= margin && localX <= margin + 20) {
                        widget.value.on = !widget.value.on;
                        node.setDirtyCanvas(true, true);
                        return true;
                    }
                    
                    // LoRA名称区域
                    if (localX >= margin + 24 && localX <= node.size[0] - 60) {
                        showLoraChooserDialog(event, value => {
                            if (value) {
                                widget.value.lora = value;
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

            const btnIdx = this.widgets.findIndex(w => w.name === "➕ Add Lora");
            if (btnIdx >= 0) {
                const [btn] = this.widgets.splice(btnIdx, 1);
                this.widgets.push(btn);
            }
            
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
    }
});
