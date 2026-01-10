import { app } from "../../../scripts/app.js";
import { $el } from "../../../scripts/ui.js";

const NODE_NAME = "XBHHNoteNode";

// ============================================================================
// 全局搜索结果弹窗
// ============================================================================
let searchResultPanel = null;

function createSearchResultPanel() {
    if (searchResultPanel) {
        searchResultPanel.remove();
    }
    
    searchResultPanel = $el("div.xbhh-note-search-panel", {
        style: {
            position: "fixed",
            right: "20px",
            top: "100px",
            width: "350px",
            maxHeight: "400px",
            background: "linear-gradient(135deg, #1a2a1f 0%, #0f1a12 100%)",
            border: "2px solid #5a8a6a",
            borderRadius: "10px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            zIndex: "9999",
            display: "none",
            flexDirection: "column",
            fontFamily: "Arial, sans-serif",
            overflow: "hidden"
        }
    });
    
    // 标题栏
    const header = $el("div", {
        style: {
            padding: "12px 15px",
            background: "linear-gradient(90deg, #2d4a3d 0%, #1a2a1f 100%)",
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
            fontSize: "14px"
        },
        textContent: "🔍 搜索结果"
    });
    
    const closeBtn = $el("button", {
        style: {
            background: "none",
            border: "none",
            color: "#888",
            fontSize: "18px",
            cursor: "pointer",
            padding: "0 5px"
        },
        textContent: "✕",
        onclick: () => {
            searchResultPanel.style.display = "none";
        }
    });
    closeBtn.onmouseenter = () => { closeBtn.style.color = "#ff6b6b"; };
    closeBtn.onmouseleave = () => { closeBtn.style.color = "#888"; };
    
    header.appendChild(title);
    header.appendChild(closeBtn);
    searchResultPanel.appendChild(header);
    
    // 结果容器
    const content = $el("div.xbhh-search-content", {
        style: {
            padding: "10px",
            overflowY: "auto",
            maxHeight: "340px",
            flex: "1"
        }
    });
    searchResultPanel.appendChild(content);
    
    document.body.appendChild(searchResultPanel);
    return searchResultPanel;
}

function showSearchResults(results, query) {
    if (!searchResultPanel) {
        createSearchResultPanel();
    }
    
    const content = searchResultPanel.querySelector(".xbhh-search-content");
    content.innerHTML = "";
    
    if (!results || results.length === 0) {
        content.innerHTML = `
            <div style="color: #ff6b6b; text-align: center; padding: 30px 20px;">
                <div style="font-size: 40px; margin-bottom: 10px;">😔</div>
                <div style="font-size: 14px;">未找到 "<span style="color: #ffd700;">${query}</span>" 的匹配内容</div>
            </div>
        `;
    } else {
        // 统计信息
        const stats = $el("div", {
            style: {
                color: "#7ac98a",
                fontSize: "12px",
                marginBottom: "10px",
                paddingBottom: "8px",
                borderBottom: "1px dashed #3a5a4a"
            },
            innerHTML: `找到 <span style="color: #8fdc9a; font-weight: bold;">${results.length}</span> 处匹配`
        });
        content.appendChild(stats);
        
        // 结果列表
        for (const result of results) {
            const item = $el("div", {
                style: {
                    padding: "10px 12px",
                    marginBottom: "8px",
                    background: "rgba(42, 74, 58, 0.5)",
                    borderRadius: "6px",
                    border: "1px solid #3a5a4a",
                    transition: "all 0.2s ease"
                }
            });
            
            item.onmouseenter = () => {
                item.style.background = "rgba(58, 90, 74, 0.7)";
                item.style.borderColor = "#5a8a6a";
            };
            item.onmouseleave = () => {
                item.style.background = "rgba(42, 74, 58, 0.5)";
                item.style.borderColor = "#3a5a4a";
            };
            
            // 行号标签
            const lineLabel = $el("span", {
                style: {
                    display: "inline-block",
                    background: "#2d5a3d",
                    color: "#8fdc9a",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    fontSize: "11px",
                    fontWeight: "bold",
                    marginRight: "10px"
                },
                textContent: `第 ${result.lineNum} 行`
            });
            
            // 内容文本（高亮关键词）
            let text = result.lineText;
            const lowerText = text.toLowerCase();
            const lowerQuery = query.toLowerCase();
            const matchIndex = lowerText.indexOf(lowerQuery);
            
            let highlightedText = "";
            if (matchIndex !== -1) {
                const before = text.substring(0, matchIndex);
                const match = text.substring(matchIndex, matchIndex + query.length);
                const after = text.substring(matchIndex + query.length);
                highlightedText = `${escapeHtml(before)}<span style="background: #ffd700; color: #000; padding: 1px 3px; border-radius: 2px; font-weight: bold;">${escapeHtml(match)}</span>${escapeHtml(after)}`;
            } else {
                highlightedText = escapeHtml(text);
            }
            
            const textEl = $el("div", {
                style: {
                    color: "#ccc",
                    fontSize: "12px",
                    marginTop: "6px",
                    lineHeight: "1.5",
                    wordBreak: "break-word"
                }
            });
            textEl.innerHTML = highlightedText;
            
            item.appendChild(lineLabel);
            item.appendChild(textEl);
            content.appendChild(item);
        }
    }
    
    searchResultPanel.style.display = "flex";
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================================
// 节点扩展
// ============================================================================
app.registerExtension({
    name: "xbhh.NoteNode",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            onNodeCreated?.apply(this, arguments);
            
            this.serialize_widgets = true;
            
            // 设置节点默认尺寸
            this.size[0] = Math.max(this.size[0] || 0, 350);
            this.size[1] = Math.max(this.size[1] || 0, 280);
            
            // 添加搜索按钮
            this.addWidget("button", "🔍 搜索", null, () => {
                this._performSearch();
            });
        };
        
        // 执行搜索
        nodeType.prototype._performSearch = function() {
            const searchWidget = this.widgets?.find(w => w.name === "search");
            const noteWidget = this.widgets?.find(w => w.name === "note");
            
            const query = searchWidget?.value?.trim();
            if (!query || !noteWidget?.value) {
                showSearchResults([], query || "");
                return;
            }
            
            const lines = noteWidget.value.split('\n');
            const results = [];
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.toLowerCase().includes(query.toLowerCase())) {
                    results.push({
                        lineNum: i + 1,
                        lineText: line
                    });
                }
            }
            
            showSearchResults(results, query);
        };

        // 背景样式
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
            onDrawBackground?.apply(this, arguments);
            
            // 添加渐变背景
            const gradient = ctx.createLinearGradient(0, 0, 0, this.size[1]);
            gradient.addColorStop(0, "#1a2a1f");
            gradient.addColorStop(1, "#0f1a12");
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.roundRect(0, 0, this.size[0], this.size[1], 5);
            ctx.fill();
            
            // 添加边框
            ctx.strokeStyle = "#3d6b4a";
            ctx.lineWidth = 2;
            ctx.stroke();
        };
    }
});
