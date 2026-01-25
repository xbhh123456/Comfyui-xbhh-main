import { app } from "/scripts/app.js";

/**
 * XBHH Live2D Pet Extension
 * 实现一个常驻桌面的 Live2D 小人
 */

export class Live2DPet {
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
      modelPath: "/extensions/xbhh-lora/live2d/zyby/真夜白音.model3.json",
      minimized: false, // 是否处于最小化状态
      canvasWidth: 300,
      canvasHeight: 400,
    };

    this.isResizing = false;
    this.resizerSize = { w: 0, h: 0 };
    this.resizerStart = { x: 0, y: 0 };

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
    
    this._onSwitchModel = this.onSwitchModel.bind(this);
    window.addEventListener("xbhh-live2d-switch", this._onSwitchModel);
  }

  destroy() {
    console.log("[XBHH] Destroying V5 instance...");
    if (this._onSwitchModel) {
        window.removeEventListener("xbhh-live2d-switch", this._onSwitchModel);
    }
    if (this.app) {
        this.app.destroy(true, { children: true, texture: true, baseTexture: true });
    }
    if (this.container) this.container.remove();
  }

  async onSwitchModel(e) {
    const { version, modelPath } = e.detail;
    if (version === "v5") {
        // V5 内部切换模型
        this.config.modelPath = modelPath;
        this.saveConfig();
        await this.loadModel();
    } else if (version === "v2") {
        // 切换到 V2
        await this.switchToV2(modelPath);
    }
  }

  bindGlobalEvents() {
      // 已移至 constructor
  }

  async switchToV2(modelPath) {
      console.log("[XBHH] Switching to V2...", modelPath);
      // 1. 清理
      this.destroy();

      // 2. 持久化配置
      localStorage.setItem("xbhh_live2d_version", "v2");
      // 注意：V2 的模型是由 waifu-tips.json 里的 models 数组定义的，
      // 我们可能需要修改 waifu-tips.json 的默认加载项，
      // 但 V2 启动时会读取 localStorage.getItem("modelId")。
      // 为简化，直接交给 V2 的 init 逻辑。

      // 3. 加载 V2
      const { Live2DV2Pet } = await import("./live2d_v2_pet.js?v=" + Date.now());
      window.xbhhLive2DPet = new Live2DV2Pet();
  }

  async loadLibraries() {
    // 定义正确的加载顺序：PIXI 必须最先加载
    const baseUrl = "/extensions/xbhh-lora/lib/live2d";
    const version = Date.now(); // 强刷缓存

    const scripts = [
      `${baseUrl}/pixi.min.jslib`,
      `${baseUrl}/live2dcubismcore.min.jslib`,
      `${baseUrl}/pixi-live2d-display.min.jslib`,
    ];

    for (const srcBase of scripts) {
      const srcUrl = `${srcBase}?v=${version}`;
      // 防止重复加载
      if (!document.querySelector(`script[src^="${srcBase}"]`)) {
        console.log(`[XBHH] Loading script: ${srcUrl}`);
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = srcUrl;
          script.onload = () => {
            console.log(`[XBHH] Script loaded: ${srcBase}`);
            if (srcBase.includes("pixi.min.js")) {
              window.PIXI = PIXI;
            }
            resolve();
          };
          script.onerror = (e) => {
            console.error(`[XBHH] Failed to load script: ${srcBase}`, e);
            reject(new Error(`Failed to load ${srcBase}`));
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
            width: ${this.config.canvasWidth}px;
            height: ${this.config.canvasHeight}px;
            z-index: 9999;
            pointer-events: auto;
            cursor: move;
            user-select: none;
            display: ${this.config.visible ? "block" : "none"};
            transition: border-radius 0.3s;
        `;

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "width: 100%; height: 100%; display: block;";
    
    // 创建缩放手柄 (右下角)
    this.resizer = document.createElement("div");
    this.resizer.id = "xbhh-live2d-resizer";
    this.resizer.style.cssText = `
        position: absolute;
        right: 0;
        bottom: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        z-index: 10002;
        background: linear-gradient(135deg, transparent 50%, rgba(122, 184, 255, 0.6) 50%);
        border-bottom-right-radius: 6px;
    `;
    
    // 创建最小化后的球体元素
    this.sphere = document.createElement("div");
    this.sphere.id = "xbhh-live2d-sphere";
    this.sphere.style.cssText = `
        display: none;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: linear-gradient(135deg, #4a6fa5 0%, #1a2438 100%);
        box-shadow: 0 4px 15px rgba(0,0,0,0.4), inset 0 2px 5px rgba(255,255,255,0.2);
        border: 2px solid #7ab8ff;
        cursor: move;
        box-sizing: border-box;
    `;
    
    this.container.appendChild(this.canvas);
    this.container.appendChild(this.sphere);
    this.container.appendChild(this.resizer);
    document.body.appendChild(this.container);

    // 根据初始状态设置
    if (this.config.minimized) {
        this.applyMinimizedState(true);
    }
  }

  applyMinimizedState(min) {
    if (min) {
        this.container.style.width = "50px";
        this.container.style.height = "50px";
        this.container.style.borderRadius = "50%";
        this.canvas.style.display = "none";
        this.sphere.style.display = "block";
        this.resizer.style.display = "none";
    } else {
        this.container.style.width = this.config.canvasWidth + "px";
        this.container.style.height = this.config.canvasHeight + "px";
        this.container.style.borderRadius = "8px";
        this.canvas.style.display = "block";
        this.sphere.style.display = "none";
        this.resizer.style.display = "block";
    }
  }

  toggleMinimize() {
    this.config.minimized = !this.config.minimized;
    this.applyMinimizedState(this.config.minimized);
    this.saveConfig();
  }

  async initPIXI() {
    if (!window.PIXI) {
      throw new Error(
        "PIXI is not defined. Library loading sequence might be broken.",
      );
    }
    this.pixiApp = new PIXI.Application({
      view: this.canvas,
      autoStart: true,
      width: this.config.canvasWidth,
      height: this.config.canvasHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
    });
  }

  async loadModel() {
    try {
      const modelPath =
        "/extensions/xbhh-lora/live2d/v4/zyby/真夜白音.model3.json";
      const modelUrl = `${modelPath}?v=${Date.now()}`;
      console.log("[XBHH] Loading Live2D model from:", modelUrl);

      this.model = await PIXI.live2d.Live2DModel.from(modelUrl);
      this.pixiApp.stage.addChild(this.model);

      // 调整模型到中心
      this.model.anchor.set(0.5, 0.5);
      this.model.scale.set(this.config.scale);
      this.updateModelPosition();

      console.log("[XBHH] Live2D model loaded successfully");

      // 提取表情列表
      this.expressions = [];
      const settings = this.model.internalModel.settings;
      if (settings && (settings.expressions || settings.Expressions)) {
        const rawExprs = settings.expressions || settings.Expressions;
        this.expressions = rawExprs.map(exp => exp.name || exp.Name || "Unknown");
      }
    } catch (e) {
      console.error("[XBHH] Failed to load Live2D model.", e);
      if (e.message && e.message.includes("Network error")) {
        console.warn(
          "[XBHH] Path might be incorrect or server not serving the live2d folder. Check if 'live2d' is inside the root directory.",
        );
      }
    }
  }

  updateModelPosition() {
    if (this.model) {
      this.model.x = this.config.canvasWidth / 2;
      this.model.y = this.config.canvasHeight / 2;
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
      this.container.style.opacity = "0.8"; // 拖拽时轻微透明
      e.stopPropagation();
    });

    window.addEventListener("mousemove", (e) => {
      // 1. 缩放逻辑
      if (this.isResizing) {
        const deltaX = e.clientX - this.resizerStart.x;
        const deltaY = e.clientY - this.resizerStart.y;
        
        let newW = Math.max(100, this.resizerSize.w + deltaX);
        let newH = Math.max(100, this.resizerSize.h + deltaY);
        
        this.config.canvasWidth = newW;
        this.config.canvasHeight = newH;
        
        this.container.style.width = newW + "px";
        this.container.style.height = newH + "px";
        
        // 同步 PIXI 渲染区域
        if (this.pixiApp) {
            this.pixiApp.renderer.resize(newW, newH);
        }
        this.updateModelPosition();
        return; // 缩放时不触发拖拽
      }

      // 2. 拖拽逻辑优先
      if (this.isDragging) {
        let x = e.clientX - this.dragOffset.x;
        let y = e.clientY - this.dragOffset.y;

        // 边界检查
        x = Math.max(0, Math.min(window.innerWidth - this.config.canvasWidth, x));
        y = Math.max(0, Math.min(window.innerHeight - this.config.canvasHeight, y));

        this.container.style.left = x + "px";
        this.container.style.top = y + "px";
        this.config.x = x;
        this.config.y = y;
      }

      // 2. 头部追踪逻辑（包裹在 try-catch 中以防万一）
      try {
        this.updateHeadTracking(e);
      } catch (err) {
        // 仅打印一次以避免淹没控制台
        if (!this._trackingErrorLog) {
          console.error("[XBHH] Head tracking error:", err);
          this._trackingErrorLog = true;
        }
      }
    });

    window.addEventListener("mouseup", () => {
      if (this.isDragging || this.isResizing) {
        this.isDragging = false;
        this.isResizing = false;
        this.container.style.cursor = "move";
        this.container.style.opacity = "1.0";
        this.saveConfig();
      }
    });

    // 缩放手柄事件
    this.resizer.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        this.isResizing = true;
        this.resizerStart.x = e.clientX;
        this.resizerStart.y = e.clientY;
        this.resizerSize.w = this.config.canvasWidth;
        this.resizerSize.h = this.config.canvasHeight;
        e.stopPropagation();
        e.preventDefault();
    });

    // 双击球体还原
    if (this.sphere) {
        this.sphere.addEventListener("dblclick", () => this.toggleMinimize());
    }

    // 右键菜单
    this.container.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showContextMenu(e.clientX, e.clientY);
    });
  }

  updateHeadTracking(e) {
    if (!this.model || !this.model.internalModel || !this.model.internalModel.coreModel) return;
    
    // 如果模型进入不可见状态（如移出屏幕触发 PIXI 优化），跳过参数更新
    if (this.model.worldAlpha <= 0 || !this.model.renderable) return;

    const rect = this.container.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // 计算归一化位置 (-1 到 1)，增加安全边界
    let x = (e.clientX - centerX) / (window.innerWidth / 2);
    let y = (e.clientY - centerY) / (window.innerHeight / 2);
    
    if (isNaN(x) || isNaN(y)) return;

    const pose = {
      ParamAngleX: x * 30 * this.config.sensitivity,
      ParamAngleY: -y * 30 * this.config.sensitivity,
      ParamEyeBallX: x,
      ParamEyeBallY: y,
    };

    const core = this.model.internalModel.coreModel;
    for (const [id, value] of Object.entries(pose)) {
      try {
        if (core.setParameterValueById) {
          core.setParameterValueById(id, value);
        } else if (core.setParamFloat) {
          core.setParamFloat(id, value);
        }
      } catch (err) {}
    }
  }

  showContextMenu(x, y) {
    const menu = document.createElement("div");
    menu.className = "xbhh-live2d-menu";
    menu.style.cssText = `
            position: fixed;
            left: ${x}px;
            top: ${y}px;
            background: rgba(30, 30, 30, 0.9);
            backdrop-filter: blur(5px);
            border: 1px solid #444;
            border-radius: 6px;
            padding: 5px 0;
            z-index: 10001;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            color: white;
            font-family: "Microsoft YaHei", sans-serif;
            font-size: 13px;
            min-width: 120px;
        `;

    // 基础样式注入
    const styleId = "xbhh-live2d-menu-style";
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            .xbhh-live2d-menu-item {
                padding: 8px 15px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background 0.2s;
                position: relative;
            }
            .xbhh-live2d-menu-item:hover {
                background: #444;
            }
            .xbhh-live2d-submenu {
                display: none;
                position: absolute;
                left: 100%;
                top: 0;
                background: rgba(30, 30, 30, 0.95);
                border: 1px solid #444;
                border-radius: 6px;
                padding: 5px 0;
                min-width: 100px;
                box-shadow: 4px 4px 15px rgba(0,0,0,0.5);
            }
            .xbhh-live2d-menu-item:hover > .xbhh-live2d-submenu {
                display: block;
            }
        `;
        document.head.appendChild(style);
    }

    const createItem = (text, action, hasSubmenu = false) => {
        const div = document.createElement("div");
        div.className = "xbhh-live2d-menu-item";
        div.innerHTML = `<span>${text}</span>${hasSubmenu ? '<span style="font-size:10px;margin-left:10px;">▶</span>' : ""}`;
        if (!hasSubmenu && action) {
            div.onclick = (e) => {
                e.stopPropagation();
                if (action) action();
                if (menu.parentNode) document.body.removeChild(menu);
            };
        }
        return div;
    };

    // 0. 模型二级菜单 (动态获取)
    const modelItem = createItem("👤 模型切换", null, true);
    const modelSubmenu = document.createElement("div");
    modelSubmenu.className = "xbhh-live2d-submenu";
    modelItem.appendChild(modelSubmenu);
    menu.appendChild(modelItem);

    // 延迟加载模型列表
    fetch("/xbhh/live2d_models").then(r => r.json()).then(data => {
        if (data.v2 && data.v2.length > 0) {
            const v2Header = document.createElement("div");
            v2Header.style.cssText = "padding: 5px 15px; color: #888; font-size: 10px; border-bottom: 1px solid #333;";
            v2Header.innerText = "SDK 2.0 (V2)";
            modelSubmenu.appendChild(v2Header);
            data.v2.forEach(m => {
                modelSubmenu.appendChild(createItem("· " + m.name, () => {
                   window.dispatchEvent(new CustomEvent("xbhh-live2d-switch", { detail: { version: "v2", modelPath: m.path } }));
                }));
            });
        }
        if (data.v5 && data.v5.length > 0) {
            const v5Header = document.createElement("div");
            v5Header.style.cssText = "padding: 5px 15px; color: #888; font-size: 10px; border-bottom: 1px solid #333; margin-top: 5px;";
            v5Header.innerText = "SDK 4.0/5.0 (V5)";
            modelSubmenu.appendChild(v5Header);
            data.v5.forEach(m => {
                modelSubmenu.appendChild(createItem("· " + m.name, () => {
                   window.dispatchEvent(new CustomEvent("xbhh-live2d-switch", { detail: { version: "v5", modelPath: m.path } }));
                }));
            });
        }
    });

    // 1. 表情二级菜单
    const expItem = createItem("🎭 表情", null, true);
    const expSubmenu = document.createElement("div");
    expSubmenu.className = "xbhh-live2d-submenu";
    
    if (this.expressions && this.expressions.length > 0) {
        this.expressions.forEach((name, index) => {
            const item = createItem(name, () => this.setExpression(index));
            expSubmenu.appendChild(item);
        });
    } else {
        const placeholder = createItem("（未检测到表情）", null);
        placeholder.style.color = "#888";
        placeholder.style.fontStyle = "italic";
        expSubmenu.appendChild(placeholder);
    }
    expItem.appendChild(expSubmenu);
    menu.appendChild(expItem);

    // 2. 灵敏度
    const sensItem = createItem("📏 灵敏度", null, true);
    const sensSubmenu = document.createElement("div");
    sensSubmenu.className = "xbhh-live2d-submenu";
    sensSubmenu.appendChild(createItem("增加 (+0.1)", () => { this.config.sensitivity += 0.1; this.saveConfig(); }));
    sensSubmenu.appendChild(createItem("减少 (-0.1)", () => { this.config.sensitivity = Math.max(0.1, this.config.sensitivity - 0.1); this.saveConfig(); }));
    sensItem.appendChild(sensSubmenu);
    menu.appendChild(sensItem);

    // 3. 倍率调节 (滑块 + 输入框并排联动)
    const scaleItem = createItem("🔍 倍率调节", null, true);
    const scaleSubmenu = document.createElement("div");
    scaleSubmenu.className = "xbhh-live2d-submenu";
    scaleSubmenu.style.cssText += "padding: 12px; min-width: 200px;";

    const scaleLayout = document.createElement("div");
    scaleLayout.style.cssText = "display: flex; align-items: center; gap: 10px;";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.01";
    slider.max = "0.5";
    slider.step = "0.01";
    slider.value = this.config.scale;
    slider.style.flex = "1";
    slider.style.cursor = "pointer";

    const numInput = document.createElement("input");
    numInput.type = "number";
    numInput.min = "0.01";
    numInput.max = "1.0";
    numInput.step = "0.01";
    numInput.value = this.config.scale;
    numInput.style.cssText = "width: 55px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 3px 5px; font-size: 12px; outline: none;";

    const applyScale = (val) => {
        val = parseFloat(val);
        if (isNaN(val) || val <= 0) return;
        this.config.scale = val;
        if (this.model) this.model.scale.set(val);
        slider.value = val;
        numInput.value = val;
        this.saveConfig();
    };

    slider.oninput = (e) => applyScale(e.target.value);
    numInput.onchange = (e) => applyScale(e.target.value);

    scaleLayout.appendChild(slider);
    scaleLayout.appendChild(numInput);
    scaleSubmenu.appendChild(scaleLayout);
    scaleItem.appendChild(scaleSubmenu);
    menu.appendChild(scaleItem);

    // 4. 最小化/还原
    const minBtn = createItem(this.config.minimized ? "📺 还原模型" : "🎈 最小化", () => this.toggleMinimize());
    menu.appendChild(minBtn);

    // 5. 隐藏
    menu.appendChild(createItem("🙈 隐藏小人", () => this.hide()));

    document.body.appendChild(menu);

    // 优化：点击面板外部或菜单外部立即关闭
    const closeMenu = (e) => {
      // 检查点击目标是否在菜单及其子项内
      if (!menu.contains(e.target)) {
        if (menu.parentNode) document.body.removeChild(menu);
        document.removeEventListener("pointerdown", closeMenu, true);
      }
    };
    
    // 使用 pointerdown 并配合 capture 确保在其他交互前拦截
    document.addEventListener("pointerdown", closeMenu, true);
  }

  setExpression(index) {
    if (!this.model) return;
    try {
      this.model.expression(index);
    } catch (e) {
      console.warn("[XBHH] Expression error", e);
    }
  }

  hide() {
    this.config.visible = false;
    this.container.style.display = "none";
    this.saveConfig();

    // 添加一个找回按钮或提示
    console.log(
      "[XBHH] Live2D hidden. Use localStorage.setItem('xbhh_live2d_config', '{\"visible\":true}') to show again.",
    );
  }

  show() {
    this.config.visible = true;
    this.container.style.display = "block";
    this.saveConfig();
  }
}


// 移除自执行逻辑，由 loader 统一调度实例化
// (function() { ... })();

