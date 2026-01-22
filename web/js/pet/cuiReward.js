import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

console.log('[XBHH] cuiReward.js 加载');

// CUI 钱包状态缓存
let cuiWalletState = {
    balance: 0,
    totalEarned: 0,
    lastEarned: 0,
    lastUpdateTime: null
};

// 注册扩展
app.registerExtension({
    name: "xbhh.pet.cui",
    
    async setup() {
        console.log("[XBHH Pet] CUI 系统已加载");
    },
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // 只处理我们的保存图片节点
        if (nodeData.name !== "XBHHSaveImageWithCUI") {
            return;
        }
        
        // 保存原始的 onExecuted 方法
        const originalOnExecuted = nodeType.prototype.onExecuted;
        
        nodeType.prototype.onExecuted = function(message) {
            // 调用原始方法
            if (originalOnExecuted) {
                originalOnExecuted.apply(this, arguments);
            }
            
            // 处理 CUI 信息
            if (message && message.cui_info && message.cui_info.length > 0) {
                const cuiInfo = message.cui_info[0];
                
                // 更新缓存状态
                cuiWalletState = {
                    balance: cuiInfo.balance,
                    totalEarned: cuiInfo.total_earned,
                    lastEarned: cuiInfo.earned,
                    lastUpdateTime: new Date()
                };
                
                // 在节点上显示信息
                this.cuiEarned = cuiInfo.earned;
                this.cuiBalance = cuiInfo.balance;
                this.cuiMessage = cuiInfo.message;
                
                // 标记需要重绘
                this.setDirtyCanvas(true);
                
                // 显示通知
                showCUINotification(cuiInfo);
            }
        };
        
        // 自定义绘制来显示CUI信息
        const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
        
        nodeType.prototype.onDrawForeground = function(ctx) {
            if (originalOnDrawForeground) {
                originalOnDrawForeground.apply(this, arguments);
            }
            
            // 绘制CUI信息
            if (this.cuiBalance !== undefined) {
                const x = this.size[0] - 10;
                const y = 20;
                
                // 绘制背景
                ctx.save();
                
                // CUI余额显示
                const balanceText = `💰 ${this.cuiBalance} CUI`;
                ctx.font = "12px Arial";
                const textWidth = ctx.measureText(balanceText).width;
                
                // 背景框
                ctx.fillStyle = "rgba(255, 193, 7, 0.2)";
                ctx.strokeStyle = "rgba(255, 193, 7, 0.6)";
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.roundRect(x - textWidth - 16, y - 14, textWidth + 12, 20, 4);
                ctx.fill();
                ctx.stroke();
                
                // 文字
                ctx.fillStyle = "#FFD700";
                ctx.textAlign = "right";
                ctx.fillText(balanceText, x - 10, y);
                
                // 如果刚获得奖励，显示动画效果
                if (this.cuiEarned && this._cuiAnimationTime) {
                    const elapsed = Date.now() - this._cuiAnimationTime;
                    if (elapsed < 2000) {
                        const alpha = 1 - (elapsed / 2000);
                        const offsetY = -20 * (elapsed / 2000);
                        
                        ctx.fillStyle = `rgba(76, 175, 80, ${alpha})`;
                        ctx.font = "bold 14px Arial";
                        ctx.fillText(`+${this.cuiEarned} CUI`, x - 10, y + offsetY - 20);
                    } else {
                        this._cuiAnimationTime = null;
                    }
                }
                
                ctx.restore();
            }
        };
        
        // 重写 onExecuted 以触发动画
        const wrappedOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function(message) {
            if (wrappedOnExecuted) {
                wrappedOnExecuted.apply(this, arguments);
            }
            
            // 触发动画
            if (message && message.cui_info && message.cui_info.length > 0) {
                this._cuiAnimationTime = Date.now();
                
                // 持续重绘动画
                const animateFrame = () => {
                    if (this._cuiAnimationTime && Date.now() - this._cuiAnimationTime < 2000) {
                        this.setDirtyCanvas(true);
                        requestAnimationFrame(animateFrame);
                    }
                };
                requestAnimationFrame(animateFrame);
            }
        };
    }
});

/**
 * 显示CUI奖励通知
 */
function showCUINotification(cuiInfo) {
    // 使用ComfyUI的通知API（如果可用）
    if (app.ui && app.ui.dialog) {
        // 简单的控制台日志通知
        console.log(`[CUI] ${cuiInfo.message}`);
    }
    
    // 创建自定义浮动通知
    createFloatingNotification(cuiInfo);
}

/**
 * 创建浮动通知
 */
function createFloatingNotification(cuiInfo) {
    const notification = document.createElement('div');
    notification.className = 'xbhh-cui-notification';
    notification.innerHTML = `
        <div class="cui-icon">💰</div>
        <div class="cui-content">
            <div class="cui-title">获得 CUI 奖励!</div>
            <div class="cui-amount">+${cuiInfo.earned} CUI</div>
            <div class="cui-balance">余额: ${cuiInfo.balance} CUI</div>
        </div>
    `;
    
    // 添加样式
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border: 2px solid #ffd700;
        border-radius: 12px;
        padding: 16px 20px;
        display: flex;
        align-items: center;
        gap: 12px;
        box-shadow: 0 8px 32px rgba(255, 215, 0, 0.3);
        z-index: 10000;
        animation: cuiSlideIn 0.5s ease-out, cuiFadeOut 0.5s ease-in 2.5s forwards;
        font-family: 'Segoe UI', sans-serif;
    `;
    
    // 添加动画样式
    if (!document.getElementById('xbhh-cui-styles')) {
        const style = document.createElement('style');
        style.id = 'xbhh-cui-styles';
        style.textContent = `
            @keyframes cuiSlideIn {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
            @keyframes cuiFadeOut {
                from {
                    opacity: 1;
                }
                to {
                    opacity: 0;
                    transform: translateY(-20px);
                }
            }
            .xbhh-cui-notification .cui-icon {
                font-size: 32px;
            }
            .xbhh-cui-notification .cui-title {
                font-size: 14px;
                color: #888;
                margin-bottom: 4px;
            }
            .xbhh-cui-notification .cui-amount {
                font-size: 24px;
                font-weight: bold;
                color: #4caf50;
            }
            .xbhh-cui-notification .cui-balance {
                font-size: 12px;
                color: #ffd700;
            }
        `;
        document.head.appendChild(style);
    }
    
    document.body.appendChild(notification);
    
    // 3秒后移除
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 3000);
}

// 导出钱包状态供其他模块使用
window.xbhhCUIState = cuiWalletState;
