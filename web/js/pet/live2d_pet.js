import { app } from "/scripts/app.js";

/**
 * XBHH Live2D Pet Extension
 * 实现一个常驻桌面的 Live2D 小人
 */

class Live2DPet {
    constructor() {
        this.app = null;
        this.model = null;
        this.container = null;
        this.canvas = null;
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this.config = {
            visible: true,
            x: window.innerWidth - 300,
            y: window.innerHeight - 400,
            scale: 0.1,
            sensitivity: 1.0,
            modelPath: "/extensions/xbhh-lora/live2d/zyby/真夜白音.model3.json"
        };
        
        this.loadConfig();
        this.init();
    }

    loadConfig() {
        const saved = localStorage.getItem("xbhh_live2d_config");
        if (saved) {
            try {
                this.config = { ...this.config, ...JSON.parse(saved) };
            } catch (e) {
                console.error("[XBHH] Failed to load Live2D config", e);
            }
        }
    }

    saveConfig() {
        localStorage.setItem("xbhh_live2d_config", JSON.stringify(this.config));
    }

    async init() {
        // 创建容器
        this.createContainer();
        
        // 动态加载库
        await this.loadLibraries();
        
        // 初始化 PIXI
        await this.initPIXI();
        
        // 加载模型
        await this.loadModel();
        
        // 绑定事件
        this.bindEvents();
    }

    async loadLibraries() {
        // 定义正确的加载顺序：PIXI 必须最先加载
        // 我们已将库文件重命名为 .jslib，以防止 ComfyUI 自动将其作为扩展加载
        const baseUrl = "/extensions/xbhh-lora/lib/live2d";
        
        const scripts = [
            `${baseUrl}/pixi.min.jslib`,
            `${baseUrl}/live2dcubismcore.min.jslib`,
            `${baseUrl}/pixi-live2d-display.min.jslib`
        ];

        for (const src of scripts) {
            if (!document.querySelector(`script[src="${src}"]`)) {
                console.log(`[XBHH] Loading script: ${src}`);
                await new Promise((resolve, reject) => {
                    const script = document.createElement("script");
                    script.src = src;
                    script.onload = () => {
                        console.log(`[XBHH] Script loaded: ${src}`);
                        // 特殊处理：PIXI 加载后导出到全局，供后续库使用
                        if (src.includes("pixi.min.js")) {
                            window.PIXI = PIXI;
                        }
                        resolve();
                    };
                    script.onerror = (e) => {
                        console.error(`[XBHH] Failed to load script: ${src}`, e);
                        reject(new Error(`Failed to load ${src}`));
                    };
                    document.head.appendChild(script);
                });
            }
        }
    }

    createContainer() {
        this.container = document.createElement("div");
        this.container.id = "xbhh-live2d-container";
        this.container.style.cssText = `
            position: fixed;
            left: ${this.config.x}px;
            top: ${this.config.y}px;
            width: 300px;
            height: 400px;
            z-index: 9999;
            pointer-events: auto;
            cursor: move;
            user-select: none;
            display: ${this.config.visible ? "block" : "none"};
        `;
        
        this.canvas = document.createElement("canvas");
        this.canvas.style.width = "100%";
        this.canvas.style.height = "100%";
        this.container.appendChild(this.canvas);
        document.body.appendChild(this.container);
    }

    async initPIXI() {
        if (!window.PIXI) {
             throw new Error("PIXI is not defined. Library loading sequence might be broken.");
        }
        this.pixiApp = new PIXI.Application({
            view: this.canvas,
            autoStart: true,
            width: 300,
            height: 400,
            backgroundAlpha: 0,
            antialias: true
        });
    }

    async loadModel() {
        try {
            // ComfyUI 的静态资源通常可以通过 /extensions/<folder_name>/ 访问
            // 我们需要确保路径与实际文件夹名（xbhh-lora）匹配
            const modelPath = "/extensions/xbhh-lora/live2d/zyby/真夜白音.model3.json";
            console.log("[XBHH] Loading Live2D model from:", modelPath);
            
            this.model = await PIXI.live2d.Live2DModel.from(modelPath);
            this.pixiApp.stage.addChild(this.model);
            
            // 调整模型
            this.model.anchor.set(0.5, 0.5);
            this.model.scale.set(this.config.scale);
            this.model.x = 150;
            this.model.y = 250;
            
            // 播放待机动作
            try { this.model.motion('Idle'); } catch (e) {}
            
            console.log("[XBHH] Live2D model loaded successfully");
        } catch (e) {
            console.error("[XBHH] Failed to load Live2D model.", e);
            // 增加网络调试提示
            if (e.message && e.message.includes("Network error")) {
                console.warn("[XBHH] Path might be incorrect or server not serving the live2d folder. Check if 'live2d' is inside the root directory.");
            }
        }
    }

    bindEvents() {
        // 拖拽逻辑
        this.container.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return; // 仅左键拖拽
            this.isDragging = true;
            this.dragOffset.x = e.clientX - this.container.offsetLeft;
            this.dragOffset.y = e.clientY - this.container.offsetTop;
            this.container.style.cursor = "grabbing";
        });

        window.addEventListener("mousemove", (e) => {
            // 头部追踪
            this.updateHeadTracking(e);
            
            // 拖拽
            if (this.isDragging) {
                let x = e.clientX - this.dragOffset.x;
                let y = e.clientY - this.dragOffset.y;
                
                // 边界检查
                x = Math.max(0, Math.min(window.innerWidth - 300, x));
                y = Math.max(0, Math.min(window.innerHeight - 400, y));
                
                this.container.style.left = x + "px";
                this.container.style.top = y + "px";
                this.config.x = x;
                this.config.y = y;
            }
        });

        window.addEventListener("mouseup", () => {
            if (this.isDragging) {
                this.isDragging = false;
                this.container.style.cursor = "move";
                this.saveConfig();
            }
        });

        // 右键菜单
        this.container.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.showContextMenu(e.clientX, e.clientY);
        });
    }

    updateHeadTracking(e) {
        if (!this.model) return;
        
        const rect = this.container.getBoundingClientRect();
        // 如果外鼠标在容器外，也要转头，但需要计算相对容器中心的位置
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        const x = (e.clientX - centerX) / (window.innerWidth / 2);
        const y = (e.clientY - centerY) / (window.innerHeight / 2);

        const core = this.model.internalModel.coreModel;
        
        const angleXIndex = core.getParameterIndex('ParamAngleX');
        const angleYIndex = core.getParameterIndex('ParamAngleY');
        const eyeBallXIndex = core.getParameterIndex('ParamEyeBallX');
        const eyeBallYIndex = core.getParameterIndex('ParamEyeBallY');

        if (angleXIndex !== -1) core.setParameterValueByIndex(angleXIndex, x * 30 * this.config.sensitivity);
        if (angleYIndex !== -1) core.setParameterValueByIndex(angleYIndex, -y * 30 * this.config.sensitivity);
        if (eyeBallXIndex !== -1) core.setParameterValueByIndex(eyeBallXIndex, x);
        if (eyeBallYIndex !== -1) core.setParameterValueByIndex(eyeBallYIndex, y);
        
        this.model.internalModel.motionManager.update(0);
    }

    showContextMenu(x, y) {
        // 简单的右键菜单
        const menu = document.createElement("div");
        menu.style.cssText = `
            position: fixed;
            left: ${x}px;
            top: ${y}px;
            background: #222;
            border: 1px solid #444;
            border-radius: 4px;
            padding: 5px 0;
            z-index: 1001;
            box-shadow: 0 2px 10px rgba(0,0,0,0.5);
            color: white;
            font-family: sans-serif;
            font-size: 14px;
        `;

        const items = [
            { text: "🎀 丸子头", action: () => this.setExpression(0) },
            { text: "⭐ 星星眼", action: () => this.setExpression(1) },
            { text: "❤️ 心心眼", action: () => this.setExpression(2) },
            { text: "🔄 重置表情", action: () => this.setExpression(-1) },
            { text: "📏 灵敏度 +", action: () => { this.config.sensitivity += 0.1; this.saveConfig(); } },
            { text: "📏 灵敏度 -", action: () => { this.config.sensitivity = Math.max(0.1, this.config.sensitivity - 0.1); this.saveConfig(); } },
            { text: "🙈 隐藏小人", action: () => this.hide() },
        ];

        items.forEach(item => {
            const div = document.createElement("div");
            div.innerText = item.text;
            div.style.padding = "8px 20px";
            div.style.cursor = "pointer";
            div.onmouseover = () => div.style.background = "#444";
            div.onmouseout = () => div.style.background = "transparent";
            div.onclick = () => {
                item.action();
                document.body.removeChild(menu);
            };
            menu.appendChild(div);
        });

        document.body.appendChild(menu);
        
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                if (menu.parentNode) document.body.removeChild(menu);
                window.removeEventListener("mousedown", closeMenu);
            }
        };
        window.addEventListener("mousedown", closeMenu);
    }

    setExpression(index) {
        if (!this.model) return;
        try {
            if (index === -1) {
                // 重置逻辑视具体模型而定，通常是清除所有表情
                this.model.internalModel.eyeBlink = true; // 恢复眨眼
            } else {
                this.model.expression(index);
            }
        } catch (e) {
            console.warn("[XBHH] Expression error", e);
        }
    }

    hide() {
        this.config.visible = false;
        this.container.style.display = "none";
        this.saveConfig();
        
        // 添加一个找回按钮或提示
        console.log("[XBHH] Live2D hidden. Use localStorage.setItem('xbhh_live2d_config', '{\"visible\":true}') to show again.");
    }

    show() {
        this.config.visible = true;
        this.container.style.display = "block";
        this.saveConfig();
    }
}

// 注册插件
app.registerExtension({
    name: "xbhh.live2d_pet",
    async setup() {
        setTimeout(() => {
            window.xbhhLive2DPet = new Live2DPet();
        }, 1000); // 延迟一点点确保 ComfyUI 已经加载好
    }
});
