import { app } from "../../../scripts/app.js";
import { $el } from "../../../scripts/ui.js";

const NODE_NAME = "XBHHDynamicText";

// ============================================================================
// 可用变量定义
// ============================================================================
const AVAILABLE_VARIABLES = {
    "date": { syntax: "%date%", desc: "日期 (YYYY-MM-DD)", example: "2026-01-12" },
    "date:FORMAT": { syntax: "%date:MM-dd%", desc: "自定义日期格式", example: "01-12" },
    "time": { syntax: "%time%", desc: "时间 (HH:MM:SS)", example: "14:30:45" },
    "time:FORMAT": { syntax: "%time:HH-mm%", desc: "自定义时间格式", example: "14-30" },
    "datetime": { syntax: "%datetime%", desc: "日期时间组合", example: "2026-01-12_14-30-45" },
    "random:MIN-MAX": { syntax: "%random:1-100%", desc: "指定范围随机数", example: "42" },
    "uuid": { syntax: "%uuid%", desc: "8位唯一标识符", example: "f7b8c9d2" },
    "uuid:LENGTH": { syntax: "%uuid:16%", desc: "指定长度标识符", example: "f7b8c9d2e3a4b5c6" },
    "counter": { syntax: "%counter%", desc: "自增计数器", example: "1, 2, 3..." },
    "counter:WIDTH": { syntax: "%counter:3%", desc: "指定宽度(补零)", example: "001, 002..." },
    "year": { syntax: "%year%", desc: "当前年份", example: "2026" },
    "month": { syntax: "%month%", desc: "当前月份", example: "01" },
    "day": { syntax: "%day%", desc: "当前日期", example: "12" },
    "hour": { syntax: "%hour%", desc: "当前小时", example: "14" },
    "weekday": { syntax: "%weekday%", desc: "星期几(中文)", example: "周日" },
    "weekday:en": { syntax: "%weekday:en%", desc: "星期几(英文)", example: "Sunday" },
    "choice:OPTIONS": { syntax: "%choice:A|B|C%", desc: "随机选择", example: "B" },
};

// ============================================================================
// 帮助面板
// ============================================================================
let helpPanel = null;

function createHelpPanel() {
    if (helpPanel) {
        helpPanel.remove();
    }
    
    helpPanel = $el("div.xbhh-dynamic-text-help", {
        style: {
            position: "fixed",
            right: "20px",
            top: "100px",
            width: "420px",
            maxHeight: "500px",
            background: "linear-gradient(135deg, #1a1f2e 0%, #0f1318 100%)",
            border: "2px solid #4a6fa5",
            borderRadius: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
            zIndex: "9999",
            display: "none",
            flexDirection: "column",
            fontFamily: "'Segoe UI', Arial, sans-serif",
            overflow: "hidden"
        }
    });
    
    // 标题栏
    const header = $el("div", {
        style: {
            padding: "14px 18px",
            background: "linear-gradient(90deg, #2d3a5a 0%, #1a2438 100%)",
            borderBottom: "1px solid #3a4a6a",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
        }
    });
    
    const title = $el("span", {
        style: {
            color: "#7ab8ff",
            fontWeight: "bold",
            fontSize: "15px"
        },
        textContent: "⚡ 动态变量参考"
    });
    
    const closeBtn = $el("button", {
        style: {
            background: "none",
            border: "none",
            color: "#888",
            fontSize: "20px",
            cursor: "pointer",
            padding: "0 5px",
            transition: "color 0.2s"
        },
        textContent: "✕",
        onclick: () => {
            helpPanel.style.display = "none";
        }
    });
    closeBtn.onmouseenter = () => { closeBtn.style.color = "#ff6b6b"; };
    closeBtn.onmouseleave = () => { closeBtn.style.color = "#888"; };
    
    header.appendChild(title);
    header.appendChild(closeBtn);
    helpPanel.appendChild(header);
    
    // 内容区域
    const content = $el("div", {
        style: {
            padding: "12px",
            overflowY: "auto",
            maxHeight: "420px",
            flex: "1"
        }
    });
    
    // 创建变量表格
    for (const [key, info] of Object.entries(AVAILABLE_VARIABLES)) {
        const row = $el("div", {
            style: {
                display: "flex",
                padding: "10px 12px",
                marginBottom: "6px",
                background: "rgba(42, 58, 90, 0.4)",
                borderRadius: "8px",
                border: "1px solid #2a3a5a",
                transition: "all 0.2s",
                cursor: "pointer"
            }
        });
        
        row.onmouseenter = () => {
            row.style.background = "rgba(58, 78, 110, 0.5)";
            row.style.borderColor = "#4a6fa5";
        };
        row.onmouseleave = () => {
            row.style.background = "rgba(42, 58, 90, 0.4)";
            row.style.borderColor = "#2a3a5a";
        };
        
        // 点击复制
        row.onclick = () => {
            navigator.clipboard.writeText(info.syntax);
            showToast(`已复制: ${info.syntax}`);
        };
        
        // 语法列
        const syntaxCol = $el("div", {
            style: {
                flex: "0 0 140px",
                marginRight: "12px"
            }
        });
        
        const syntaxCode = $el("code", {
            style: {
                background: "#1a2438",
                color: "#7ab8ff",
                padding: "4px 8px",
                borderRadius: "4px",
                fontSize: "12px",
                fontFamily: "Consolas, monospace"
            },
            textContent: info.syntax
        });
        syntaxCol.appendChild(syntaxCode);
        
        // 描述列
        const descCol = $el("div", {
            style: {
                flex: "1",
                color: "#aaa",
                fontSize: "12px",
                lineHeight: "1.5"
            }
        });
        
        const descText = $el("div", {
            textContent: info.desc
        });
        
        const exampleText = $el("div", {
            style: {
                color: "#6a8a6a",
                fontSize: "11px",
                marginTop: "2px"
            },
            textContent: `→ ${info.example}`
        });
        
        descCol.appendChild(descText);
        descCol.appendChild(exampleText);
        
        row.appendChild(syntaxCol);
        row.appendChild(descCol);
        content.appendChild(row);
    }
    
    helpPanel.appendChild(content);
    
    // 底部提示
    const footer = $el("div", {
        style: {
            padding: "10px 15px",
            borderTop: "1px solid #2a3a5a",
            background: "rgba(26, 36, 56, 0.8)",
            color: "#666",
            fontSize: "11px",
            textAlign: "center"
        },
        textContent: "💡 点击变量可复制到剪贴板"
    });
    helpPanel.appendChild(footer);
    
    document.body.appendChild(helpPanel);
    return helpPanel;
}

// Toast 提示
function showToast(message) {
    const toast = $el("div", {
        style: {
            position: "fixed",
            bottom: "80px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(42, 58, 90, 0.95)",
            color: "#7ab8ff",
            padding: "10px 20px",
            borderRadius: "8px",
            border: "1px solid #4a6fa5",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            zIndex: "10000",
            fontSize: "13px",
            fontWeight: "500",
            animation: "fadeInUp 0.3s ease"
        },
        textContent: message
    });
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s";
        setTimeout(() => toast.remove(), 300);
    }, 1500);
}

// 添加动画样式
const style = document.createElement("style");
style.textContent = `
    @keyframes fadeInUp {
        from {
            opacity: 0;
            transform: translateX(-50%) translateY(10px);
        }
        to {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }
    }
`;
document.head.appendChild(style);

// ============================================================================
// 预览处理器 (前端模拟)
// ============================================================================
function processPreview(text) {
    const now = new Date();
    
    // 格式化函数
    const pad = (n) => n.toString().padStart(2, '0');
    
    const formatDate = (format) => {
        let result = format || 'YYYY-MM-DD';
        result = result.replace(/YYYY|yyyy/g, now.getFullYear());
        result = result.replace(/YY|yy/g, String(now.getFullYear()).slice(-2));
        result = result.replace(/MM/g, pad(now.getMonth() + 1));
        result = result.replace(/DD|dd/g, pad(now.getDate()));
        result = result.replace(/HH/g, pad(now.getHours()));
        result = result.replace(/mm/g, pad(now.getMinutes()));
        result = result.replace(/SS|ss/g, pad(now.getSeconds()));
        return result;
    };
    
    // 替换变量
    return text
        .replace(/%date(?::([^%]*))?%/gi, (_, fmt) => formatDate(fmt || 'YYYY-MM-DD'))
        .replace(/%time(?::([^%]*))?%/gi, (_, fmt) => formatDate(fmt || 'HH:mm:SS'))
        .replace(/%datetime%/gi, formatDate('YYYY-MM-DD_HH-mm-SS'))
        .replace(/%random:(\d+)-(\d+)%/gi, (_, min, max) => {
            return String(Math.floor(Math.random() * (parseInt(max) - parseInt(min) + 1)) + parseInt(min));
        })
        .replace(/%random%/gi, String(Math.floor(Math.random() * 101)))
        .replace(/%uuid(?::(\d+))?%/gi, (_, len) => {
            const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = Math.random() * 16 | 0;
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
            return (len ? uuid.replace(/-/g, '').slice(0, parseInt(len)) : uuid.slice(0, 8));
        })
        .replace(/%counter(?::(\d+))?%/gi, (_, width) => {
            const count = '1';
            return width ? count.padStart(parseInt(width), '0') : count;
        })
        .replace(/%year%/gi, String(now.getFullYear()))
        .replace(/%month%/gi, pad(now.getMonth() + 1))
        .replace(/%day%/gi, pad(now.getDate()))
        .replace(/%hour%/gi, pad(now.getHours()))
        .replace(/%minute%/gi, pad(now.getMinutes()))
        .replace(/%second%/gi, pad(now.getSeconds()))
        .replace(/%weekday(?::([^%]*))?%/gi, (_, arg) => {
            const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            const enWeekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const shortWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const day = now.getDay();
            if (arg === 'en') return enWeekdays[day];
            if (arg === 'short') return shortWeekdays[day];
            return weekdays[day];
        })
        .replace(/%choice:([^%]+)%/gi, (_, options) => {
            const opts = options.split('|');
            return opts[Math.floor(Math.random() * opts.length)];
        });
}

// ============================================================================
// 节点扩展
// ============================================================================
app.registerExtension({
    name: "xbhh.DynamicText",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            onNodeCreated?.apply(this, arguments);
            
            this.serialize_widgets = true;
            
            // 设置节点默认尺寸
            this.size[0] = Math.max(this.size[0] || 0, 380);
            this.size[1] = Math.max(this.size[1] || 0, 200);
            
            // 添加帮助按钮
            this.addWidget("button", "📖 变量参考", null, () => {
                if (!helpPanel) {
                    createHelpPanel();
                }
                helpPanel.style.display = helpPanel.style.display === "none" ? "flex" : "none";
            });
            
            // 添加预览按钮
            this.addWidget("button", "👁️ 预览结果", null, () => {
                const textWidget = this.widgets?.find(w => w.name === "text");
                if (textWidget?.value) {
                    const preview = processPreview(textWidget.value);
                    showPreviewDialog(textWidget.value, preview);
                }
            });
        };

        // 自定义绘制
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
            if (this.flags.collapsed) return;
            onDrawBackground?.apply(this, arguments);
            
            // 渐变背景
            const gradient = ctx.createLinearGradient(0, 0, 0, this.size[1]);
            gradient.addColorStop(0, "#1a2438");
            gradient.addColorStop(1, "#0f1318");
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.roundRect(0, 0, this.size[0], this.size[1], 6);
            ctx.fill();
            
            // 边框
            ctx.strokeStyle = "#3a5a8a";
            ctx.lineWidth = 2;
            ctx.stroke();
        };
    }
});

// 预览对话框
function showPreviewDialog(original, preview) {
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
            width: "500px",
            maxHeight: "80vh",
            background: "linear-gradient(135deg, #1a2438 0%, #0f1318 100%)",
            border: "2px solid #4a6fa5",
            borderRadius: "12px",
            boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
            overflow: "hidden"
        }
    });
    
    // 标题
    const header = $el("div", {
        style: {
            padding: "14px 18px",
            background: "linear-gradient(90deg, #2d3a5a 0%, #1a2438 100%)",
            borderBottom: "1px solid #3a4a6a",
            color: "#7ab8ff",
            fontWeight: "bold",
            fontSize: "15px"
        },
        textContent: "👁️ 预览结果"
    });
    dialog.appendChild(header);
    
    // 内容
    const content = $el("div", {
        style: {
            padding: "16px"
        }
    });
    
    // 原始文本
    const originalLabel = $el("div", {
        style: { color: "#888", fontSize: "12px", marginBottom: "6px" },
        textContent: "原始文本："
    });
    const originalText = $el("div", {
        style: {
            background: "#0f1318",
            padding: "12px",
            borderRadius: "6px",
            color: "#aaa",
            fontSize: "13px",
            fontFamily: "Consolas, monospace",
            marginBottom: "16px",
            wordBreak: "break-all"
        },
        textContent: original
    });
    
    // 处理结果
    const previewLabel = $el("div", {
        style: { color: "#7ab8ff", fontSize: "12px", marginBottom: "6px" },
        textContent: "处理结果："
    });
    const previewText = $el("div", {
        style: {
            background: "rgba(42, 90, 58, 0.3)",
            padding: "12px",
            borderRadius: "6px",
            color: "#8fdc9a",
            fontSize: "14px",
            fontFamily: "Consolas, monospace",
            border: "1px solid #3a5a4a",
            wordBreak: "break-all"
        },
        textContent: preview
    });
    
    content.appendChild(originalLabel);
    content.appendChild(originalText);
    content.appendChild(previewLabel);
    content.appendChild(previewText);
    dialog.appendChild(content);
    
    // 关闭按钮
    const footer = $el("div", {
        style: {
            padding: "12px 16px",
            borderTop: "1px solid #2a3a5a",
            textAlign: "center"
        }
    });
    
    const closeBtn = $el("button", {
        style: {
            background: "linear-gradient(135deg, #3a5a8a 0%, #2a4a6a 100%)",
            border: "none",
            padding: "8px 24px",
            borderRadius: "6px",
            color: "#fff",
            cursor: "pointer",
            fontSize: "13px"
        },
        textContent: "关闭",
        onclick: () => overlay.remove()
    });
    footer.appendChild(closeBtn);
    dialog.appendChild(footer);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}
