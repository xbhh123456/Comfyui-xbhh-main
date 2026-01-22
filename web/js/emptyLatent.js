import { app } from "../../../scripts/app.js";

const NODE_NAME = "XBHHEmptyLatent";

// ============================================================================
// 节点扩展 - 动态显示/隐藏自定义宽高输入
// ============================================================================
app.registerExtension({
    name: "xbhh.EmptyLatent",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            onNodeCreated?.apply(this, arguments);
            
            // 初始化时更新widget可见性
            setTimeout(() => {
                this._updateCustomInputsVisibility();
            }, 100);
        };
        
        // 更新自定义输入的可见性
        nodeType.prototype._updateCustomInputsVisibility = function() {
            const resolutionWidget = this.widgets?.find(w => w.name === "resolution");
            const customWidthWidget = this.widgets?.find(w => w.name === "custom_width");
            const customHeightWidget = this.widgets?.find(w => w.name === "custom_height");
            
            if (!resolutionWidget) return;
            
            const isCustom = resolutionWidget.value === "自定义";
            
            // 显示或隐藏自定义宽高输入
            if (customWidthWidget) {
                customWidthWidget.hidden = !isCustom;
            }
            if (customHeightWidget) {
                customHeightWidget.hidden = !isCustom;
            }
            
            // 重新计算节点尺寸
            this.setSize(this.computeSize());
            this.setDirtyCanvas(true, true);
        };

        // 监听配置加载
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function(info) {
            configure?.apply(this, arguments);
            
            setTimeout(() => {
                this._updateCustomInputsVisibility();
            }, 100);
        };
        
        // 监听widget值变化
        const onPropertyChanged = nodeType.prototype.onPropertyChanged;
        nodeType.prototype.onPropertyChanged = function(name, value) {
            onPropertyChanged?.apply(this, arguments);
            
            if (name === "resolution") {
                this._updateCustomInputsVisibility();
            }
        };

        // 背景样式
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
            if (this.flags.collapsed) return;
            onDrawBackground?.apply(this, arguments);
            
            // 添加渐变背景
            const gradient = ctx.createLinearGradient(0, 0, 0, this.size[1]);
            gradient.addColorStop(0, "#1a1a2e");
            gradient.addColorStop(1, "#16213e");
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.roundRect(0, 0, this.size[0], this.size[1], 5);
            ctx.fill();
            
            // 添加边框
            ctx.strokeStyle = "#4a69bd";
            ctx.lineWidth = 2;
            ctx.stroke();
        };
    },
    
    // 注册widget回调
    async nodeCreated(node) {
        if (node.comfyClass !== NODE_NAME) return;
        
        const resolutionWidget = node.widgets?.find(w => w.name === "resolution");
        if (resolutionWidget) {
            const originalCallback = resolutionWidget.callback;
            resolutionWidget.callback = function(value) {
                originalCallback?.call(this, value);
                node._updateCustomInputsVisibility();
            };
        }
    }
});
