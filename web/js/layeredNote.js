import { app } from "../../../scripts/app.js";
import { $el } from "../../../scripts/ui.js";

const NODE_NAME = "XBHHLayeredNote";

// ============================================================================
// 文本编辑对话框
// ============================================================================
function showEditDialog(title, value, isMultiline, callback) {
    const overlay = $el("div", {
        style: {
            position: "fixed",
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
            background: "rgba(0,0,0,0.6)",
            zIndex: "9998",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
        },
        onclick: (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        }
    });
    
    const dialog = $el("div", {
        style: {
            width: "450px",
            background: "linear-gradient(135deg, #1a2a1f 0%, #0f1a12 100%)",
            border: "2px solid #5a8a6a",
            borderRadius: "12px",
            boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
            overflow: "hidden"
        }
    });
    
    // 标题
    const header = $el("div", {
        style: {
            padding: "14px 18px",
            background: "linear-gradient(90deg, #2d5a3d 0%, #1a2a1f 100%)",
            borderBottom: "1px solid #3a5a4a",
            color: "#8fdc9a",
            fontWeight: "bold",
            fontSize: "14px"
        },
        textContent: title
    });
    dialog.appendChild(header);
    
    // 内容
    const content = $el("div", {
        style: {
            padding: "16px"
        }
    });
    
    const input = isMultiline 
        ? $el("textarea", {
            style: {
                width: "100%",
                height: "200px",
                background: "#1a1a1a",
                border: "1px solid #3a5a4a",
                borderRadius: "6px",
                color: "#ddd",
                fontSize: "13px",
                fontFamily: "Consolas, monospace",
                padding: "10px",
                resize: "vertical",
                boxSizing: "border-box"
            },
            value: value || ""
        })
        : $el("input", {
            type: "text",
            style: {
                width: "100%",
                padding: "10px",
                background: "#1a1a1a",
                border: "1px solid #3a5a4a",
                borderRadius: "6px",
                color: "#ddd",
                fontSize: "14px",
                boxSizing: "border-box"
            },
            value: value || ""
        });
    
    content.appendChild(input);
    dialog.appendChild(content);
    
    // 按钮
    const footer = $el("div", {
        style: {
            padding: "12px 16px",
            borderTop: "1px solid #2a3a2a",
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px"
        }
    });
    
    const cancelBtn = $el("button", {
        style: {
            padding: "8px 20px",
            background: "#444",
            border: "none",
            borderRadius: "6px",
            color: "#ccc",
            cursor: "pointer"
        },
        textContent: "取消",
        onclick: () => overlay.remove()
    });
    
    const confirmBtn = $el("button", {
        style: {
            padding: "8px 20px",
            background: "#2d5a3d",
            border: "none",
            borderRadius: "6px",
            color: "#fff",
            cursor: "pointer"
        },
        textContent: "确定",
        onclick: () => {
            callback(input.value);
            overlay.remove();
        }
    });
    
    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    dialog.appendChild(footer);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    setTimeout(() => input.focus(), 50);
}

// ============================================================================
// 节点扩展
// ============================================================================
app.registerExtension({
    name: "xbhh.LayeredNote",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            onNodeCreated?.apply(this, arguments);
            
            this.noteCounter = 0;
            this.noteWidgets = [];
            this.serialize_widgets = true;
            
            // 设置默认尺寸
            this.size[0] = Math.max(this.size[0] || 0, 350);
            this.size[1] = Math.max(this.size[1] || 0, 150);
            
            // 添加注释块按钮
            this._createAddButton();
        };
        
        // 创建添加按钮
        nodeType.prototype._createAddButton = function() {
            const addBtn = this.addWidget("custom", "➕ 添加注释块", null, () => {});
            addBtn.computeSize = () => [this.size[0] - 20, 28];
            addBtn.draw = (ctx, node, w, posY, h) => {
                const x = 10;
                const y = posY;
                const width = node.size[0] - 20;
                const height = 26;
                
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
                ctx.fillText("➕ 添加注释块", x + width / 2, y + height / 2);
            };
            addBtn.mouse = (event, pos, node) => {
                if (event.type === "pointerdown") {
                    node.addNoteBlock();
                    return true;
                }
                return false;
            };
        };
        
        // 添加注释块
        nodeType.prototype.addNoteBlock = function(title = "新注释", content = "", collapsed = false) {
            this.noteCounter++;
            const widgetName = `note_${this.noteCounter}`;
            
            const widget = this.addWidget("custom", widgetName, {
                title: title,
                content: content,
                collapsed: collapsed
            }, () => {});
            
            widget.computeSize = () => {
                if (widget.value.collapsed) {
                    return [this.size[0] - 20, 32];
                } else {
                    // 根据内容计算高度
                    const lines = (widget.value.content || "").split("\n").length;
                    const contentHeight = Math.max(60, Math.min(200, lines * 18 + 40));
                    return [this.size[0] - 20, 32 + contentHeight];
                }
            };
            
            widget.serializeValue = () => widget.value;
            
            widget.draw = (ctx, node, w, posY, h) => {
                if (!widget.value) {
                    widget.value = { title: "新注释", content: "", collapsed: false };
                }
                
                const x = 10;
                const y = posY;
                const width = node.size[0] - 20;
                const isCollapsed = widget.value.collapsed;
                
                // 标题栏
                const headerHeight = 28;
                const gradient = ctx.createLinearGradient(x, y, x, y + headerHeight);
                gradient.addColorStop(0, "#3a5a4a");
                gradient.addColorStop(1, "#2a4a3a");
                
                ctx.fillStyle = gradient;
                ctx.beginPath();
                if (isCollapsed) {
                    ctx.roundRect(x, y, width, headerHeight, 6);
                } else {
                    ctx.roundRect(x, y, width, headerHeight, [6, 6, 0, 0]);
                }
                ctx.fill();
                
                ctx.strokeStyle = "#5a8a6a";
                ctx.lineWidth = 1;
                ctx.stroke();
                
                // 折叠图标
                ctx.fillStyle = "#8fdc9a";
                ctx.font = "12px Arial";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(isCollapsed ? "▶" : "▼", x + 8, y + headerHeight / 2);
                
                // 标题
                ctx.fillStyle = "#ddd";
                ctx.font = "bold 12px Arial";
                const titleText = widget.value.title || "未命名";
                const maxTitleWidth = width - 80;
                let displayTitle = titleText;
                while (ctx.measureText(displayTitle).width > maxTitleWidth && displayTitle.length > 3) {
                    displayTitle = displayTitle.slice(0, -4) + "...";
                }
                ctx.fillText(displayTitle, x + 24, y + headerHeight / 2);
                
                // 删除按钮
                ctx.fillStyle = "#666";
                ctx.font = "14px Arial";
                ctx.textAlign = "right";
                ctx.fillText("✕", x + width - 10, y + headerHeight / 2);
                
                // 编辑图标
                ctx.fillStyle = "#888";
                ctx.font = "11px Arial";
                ctx.fillText("✏️", x + width - 35, y + headerHeight / 2);
                
                // 内容区域
                if (!isCollapsed) {
                    const contentY = y + headerHeight;
                    const contentHeight = widget.computeSize()[1] - headerHeight;
                    
                    ctx.fillStyle = "rgba(26, 42, 31, 0.9)";
                    ctx.beginPath();
                    ctx.roundRect(x, contentY, width, contentHeight, [0, 0, 6, 6]);
                    ctx.fill();
                    
                    ctx.strokeStyle = "#3a5a4a";
                    ctx.lineWidth = 1;
                    ctx.stroke();
                    
                    // 绘制内容文本
                    ctx.fillStyle = "#aaa";
                    ctx.font = "12px Consolas, monospace";
                    ctx.textAlign = "left";
                    ctx.textBaseline = "top";
                    
                    const padding = 10;
                    const textX = x + padding;
                    const textY = contentY + padding;
                    const maxWidth = width - padding * 2;
                    const lineHeight = 16;
                    
                    const content = widget.value.content || "(点击编辑内容)";
                    const lines = content.split("\n");
                    
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(x, contentY, width, contentHeight);
                    ctx.clip();
                    
                    for (let i = 0; i < lines.length && i < 10; i++) {
                        let line = lines[i];
                        // 简单截断
                        while (ctx.measureText(line).width > maxWidth && line.length > 3) {
                            line = line.slice(0, -4) + "...";
                        }
                        ctx.fillText(line, textX, textY + i * lineHeight);
                    }
                    
                    if (lines.length > 10) {
                        ctx.fillStyle = "#666";
                        ctx.fillText(`... 还有 ${lines.length - 10} 行`, textX, textY + 10 * lineHeight);
                    }
                    
                    ctx.restore();
                }
                
                widget.last_y = y;
            };
            
            widget.mouse = (event, pos, node) => {
                const localX = pos[0];
                const localY = pos[1];
                const width = node.size[0] - 20;
                const headerHeight = 28;
                
                if (!widget.last_y) return false;
                
                const relY = localY - widget.last_y;
                
                if (event.type === "pointerdown") {
                    // 点击标题栏区域
                    if (relY >= 0 && relY <= headerHeight) {
                        // 删除按钮
                        if (localX >= width - 20 && localX <= width + 10) {
                            node.removeNoteWidget(widget);
                            return true;
                        }
                        
                        // 编辑标题按钮
                        if (localX >= width - 50 && localX < width - 20) {
                            showEditDialog("编辑标题", widget.value.title, false, (newTitle) => {
                                widget.value.title = newTitle || "未命名";
                                node.setDirtyCanvas(true, true);
                            });
                            return true;
                        }
                        
                        // 折叠/展开
                        if (localX >= 10 && localX < width - 50) {
                            widget.value.collapsed = !widget.value.collapsed;
                            node.setSize(node.computeSize());
                            node.setDirtyCanvas(true, true);
                            return true;
                        }
                    }
                    
                    // 点击内容区域编辑
                    if (!widget.value.collapsed && relY > headerHeight) {
                        showEditDialog("编辑内容", widget.value.content, true, (newContent) => {
                            widget.value.content = newContent;
                            node.setSize(node.computeSize());
                            node.setDirtyCanvas(true, true);
                        });
                        return true;
                    }
                }
                
                return false;
            };
            
            // 将添加按钮移到最后
            const addBtnIdx = this.widgets.findIndex(w => w.name === "➕ 添加注释块");
            if (addBtnIdx >= 0 && addBtnIdx < this.widgets.length - 1) {
                const addBtn = this.widgets.splice(addBtnIdx, 1)[0];
                this.widgets.push(addBtn);
            }
            
            this.noteWidgets.push(widget);
            this.setSize(this.computeSize());
            this.setDirtyCanvas(true, true);
            
            return widget;
        };
        
        // 删除注释块
        nodeType.prototype.removeNoteWidget = function(widget) {
            const idx = this.widgets.indexOf(widget);
            if (idx >= 0) {
                this.widgets.splice(idx, 1);
                this.noteWidgets = this.noteWidgets.filter(w => w !== widget);
                this.setSize(this.computeSize());
                this.setDirtyCanvas(true, true);
            }
        };
        
        // 配置加载
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function(info) {
            // 清空现有widgets
            while (this.widgets?.length) this.widgets.pop();
            this.noteCounter = 0;
            this.noteWidgets = [];
            
            // 恢复注释块
            for (const v of info.widgets_values || []) {
                if (v?.title !== undefined) {
                    this.addNoteBlock(v.title, v.content, v.collapsed);
                }
            }
            
            // 添加按钮
            this._createAddButton();
            
            configure?.apply(this, arguments);
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
