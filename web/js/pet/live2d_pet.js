import { app } from "/scripts/app.js";

/**
 * XBHH Live2D Pet Extension
 * 实现一个常驻桌面的 Live2D 小人
 */

export class Live2DPet {
  constructor() {
    this.pixiApp = null;
    this.model = null;
    this.container = null;
    this.canvas = null;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.tipsTimer = null;
    this.idleTimer = null;
    this.config = {
      visible: true,
      x: 50,
      y: 50,
      scale: 0.15,
      sensitivity: 1.0,
      modelPath: "", // 默认为空，由初始化逻辑决定
      enabled: true,
      minimized: false, // 是否处于最小化状态
      canvasWidth: 300,
      canvasHeight: 400,
      lockPosition: true, // 新增：默认开启位移锁定（左键穿透）
    };

    this.isResizing = false;
    this.resizerSize = { w: 0, h: 0 };
    this.resizerStart = { x: 0, y: 0 };

    this.motions = {};
    this.motionKeybinds = {};
    this.activeExpressions = new Set();
    this.loadMotionKeybinds();

    this.loadConfig();
    this.init();
  }

  loadConfig() {
    const saved = localStorage.getItem("xbhh_live2d_config");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // 确保新属性有默认值
        if (parsed.lockPosition === undefined) parsed.lockPosition = true;
        this.config = { ...this.config, ...parsed };
      } catch (e) {
        console.error("[XBHH] Failed to load Live2D config", e);
      }
    }
  }

  saveConfig() {
    localStorage.setItem("xbhh_live2d_config", JSON.stringify(this.config));
  }

  async init() {
    // 获取扩展路径
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split("/");
    const extensionsIdx = pathSegments.indexOf("extensions");
    this.extName =
      extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : "xbhh-lora";
    this.extBaseUrl = `/extensions/${this.extName}`;

    // 如果模型路径为空，则设置一个默认值
    if (!this.config.modelPath) {
      this.config.modelPath = `${this.extBaseUrl}/live2d/v4/zyby/真夜白音.model3.json`;
      this.saveConfig();
    }

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

    // 页面不可见时自动暂停渲染，减少后台 CPU 占用
    this._onVisibilityChange = () => {
      if (!this.pixiApp || !this.pixiApp.ticker) return;
      if (document.hidden) {
        this.pixiApp.ticker.stop();
        console.log("[XBHH] Page hidden, pausing Live2D rendering.");
      } else if (this.config.visible && !this.config.minimized) {
        this.pixiApp.ticker.start();
        console.log("[XBHH] Page visible, resuming Live2D rendering.");
      }
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  destroy() {
    console.log("[XBHH] Destroying V5 instance...");
    if (this._onSwitchModel) {
      window.removeEventListener("xbhh-live2d-switch", this._onSwitchModel);
    }
    if (this._onWindowContextMenu) {
      window.removeEventListener("contextmenu", this._onWindowContextMenu);
    }
    if (this.pixiApp) {
      this.pixiApp.destroy(true, {
        children: true,
        texture: true,
        baseTexture: true,
      });
      this.pixiApp = null;
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
      this.showMessage("模型已切换！", 3000, 9); // 确保切换模型后有提示
    } else if (version === "v2") {
      // 切换到 V2
      await this.switchToV2(modelPath);
      this.showMessage("已切换到 V2 模型！", 3000, 9); // 确保切换模型后有提示
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

    // 3. 加载 V2
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split("/");
    const extensionsIdx = pathSegments.indexOf("extensions");
    const extName =
      extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : "xbhh-lora";

    const { Live2DV2Pet } = await import(
      `${this.extBaseUrl}/js/pet/live2d_v2_pet.js?v=${Date.now()}`
    );
    window.xbhhLive2DPet = new Live2DV2Pet();
  }

  async loadLibraries() {
    // 动态获取插件名
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split("/");
    const extensionsIdx = pathSegments.indexOf("extensions");
    const extName =
      extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : "xbhh-lora";

    const baseUrl = `${this.extBaseUrl}/lib/live2d`;
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
            pointer-events: ${this.config.lockPosition ? "none" : "auto"};
            cursor: move;
            user-select: none;
            display: ${this.config.visible ? "block" : "none"};
            transition: border-radius 0.3s;
        `;

    this.canvas = document.createElement("canvas");
    this.canvas.id = "live2d"; // 统一 ID，便于 waifu-tips.json 的选择器
    this.canvas.style.cssText =
      "position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: block; z-index: 10000;";

    // 创建对话框
    this.tips = document.createElement("div");
    this.tips.id = "xbhh-waifu-tips";
    this.tips.style.cssText = `
        opacity: 0;
        position: absolute;
        top: -100px;
        left: 50%;
        transform: translateX(-50%);
        width: 250px;
        min-height: 70px;
        background: rgba(30, 30, 30, 0.85);
        border: 1px solid #444;
        border-radius: 12px;
        padding: 10px 15px;
        color: #fff;
        font-size: 14px;
        line-height: 1.4;
        text-align: center;
        pointer-events: none;
        transition: opacity 0.3s;
        z-index: 10005;
        box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        backdrop-filter: blur(5px);
    `;

    // 创建球体（最小化后的图标）
    this.sphere = document.createElement("div");
    this.sphere.id = "xbhh-live2d-sphere";
    this.sphere.style.cssText = `
        display: none;
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: linear-gradient(135deg, #fa0 0%, #d48800 100%);
        box-shadow: 0 4px 15px rgba(0,0,0,0.4), inset 0 2px 5px rgba(255,255,255,0.2);
        border: 2px solid #fff;
        cursor: pointer;
        text-align: center;
        line-height: 46px;
        font-size: 24px;
        z-index: 10001;
        pointer-events: auto;
    `;
    this.sphere.innerHTML = "🐱";

    // 创建缩放权柄
    this.resizer = document.createElement("div");
    this.resizer.id = "xbhh-live2d-resizer";
    this.resizer.style.cssText = `
        position: absolute;
        right: 0;
        bottom: 0;
        width: 12px;
        height: 12px;
        cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 50%, #555 50%);
        border-bottom-right-radius: 8px;
        z-index: 10002;
        pointer-events: auto;
    `;

    this.container.appendChild(this.canvas);
    this.container.appendChild(this.tips);
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
      // 暂停渲染循环，释放 CPU
      if (this.pixiApp && this.pixiApp.ticker) {
        this.pixiApp.ticker.stop();
      }
      this.container.style.width = "50px";
      this.container.style.height = "50px";
      this.container.style.borderRadius = "50%";
      this.container.style.pointerEvents = "auto"; // 最小化时必须可点击
      this.canvas.style.display = "none";
      this.sphere.style.display = "block";
      this.resizer.style.display = "none";
      this.tips.style.opacity = "0";
      this.tips.style.display = "none";
    } else {
      // 恢复渲染循环
      if (this.pixiApp && this.pixiApp.ticker) {
        this.pixiApp.ticker.start();
      }
      this.container.style.width = this.config.canvasWidth + "px";
      this.container.style.height = this.config.canvasHeight + "px";
      this.container.style.borderRadius = "8px";
      const pe = this.config.lockPosition ? "none" : "auto";
      this.container.style.pointerEvents = pe;
      this.canvas.style.pointerEvents = pe;
      this.canvas.style.display = "block";
      this.sphere.style.display = "none";
      this.resizer.style.display = "block";
      this.tips.style.display = "block";
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

    // 帧率限制：从配置读取，默认 30fps
    const targetFPS = this.config.targetFPS || 30;
    this.pixiApp.ticker.maxFPS = targetFPS;
  }

  async loadModel() {
    try {
      // 清理旧模型
      if (this.model) {
        this.pixiApp.stage.removeChild(this.model);
        this.model.destroy({
          children: true,
          texture: true,
          baseTexture: true,
        });
        this.model = null;
      }

      const modelUrl = `${this.config.modelPath}?v=${Date.now()}`;
      console.log("[XBHH] Loading Live2D model from:", modelUrl);

      this.model = await PIXI.live2d.Live2DModel.from(modelUrl);
      this.pixiApp.stage.addChild(this.model);

      // 调整模型到中心
      this.model.anchor.set(0.5, 0.5);
      this.model.scale.set(this.config.scale);
      this.updateModelPosition();

      // 开启交互支持 (即使穿透，追踪仍通过外部监听实现)
      this.model.interactive = true;

      console.log("[XBHH] Live2D model loaded successfully");

      // 初始化提示语系统
      this.initTips();

      // 提取表情列表并预加载表情参数数据
      this.expressions = [];
      this.expressionData = []; // 缓存每个表情的参数定义
      this.activeExpressions = new Set();
      const settings = this.model.internalModel.settings;
      if (settings && (settings.expressions || settings.Expressions)) {
        const rawExprs = settings.expressions || settings.Expressions;
        this.expressions = rawExprs.map(
          (exp) => exp.name || exp.Name || "Unknown",
        );
        // 异步加载所有表情文件的参数定义
        this._loadExpressionData(rawExprs);
      }

      // 提取动画列表
      this.motions = {};
      if (settings && settings.motions) {
        this.motions = settings.motions;
        console.log(`[XBHH] Found ${Object.keys(this.motions).length} motion groups`);
      }

      this.bindMotionKeyListener();

      // 绑定点击交互 (Hit Test) - 注意：穿透模式下此监听将失效，这是符合预期的
      this.model.on("pointerdown", (e) => {
        const hitAreas = this.model.hitTest(e.data.global.x, e.data.global.y);
        if (hitAreas.includes("Body") || hitAreas.includes("body")) {
          if (this.tipsData) {
            const texts = this.tipsData.message.tapBody || ["哎呀！"];
            this.showMessage(
              texts[Math.floor(Math.random() * texts.length)],
              4000,
              8,
            );
          }
        } else if (hitAreas.includes("Head") || hitAreas.includes("head")) {
          if (this.tipsData) {
            const texts = this.tipsData.message.hoverBody || ["别摸我头！"];
            this.showMessage(
              texts[Math.floor(Math.random() * texts.length)],
              4000,
              8,
            );
          }
        }
      });
    } catch (e) {
      console.error("[XBHH] Failed to load Live2D model.", e);
      if (e.message && e.message.includes("Network error")) {
        console.warn(
          "[XBHH] Path might be incorrect or server not serving the live2d folder. Check if 'live2d' is inside the root directory.",
        );
      }
      // 模型加载失败时自动销毁并清理容器，避免保留空白外框
      this.destroy();
    }
  }

  updateModelPosition() {
    if (this.model) {
      this.model.x = this.config.canvasWidth / 2;
      this.model.y = this.config.canvasHeight / 2;
    }
  }

  bindEvents() {
    // 1. 全局右键监听，用于实现穿透模式下的菜单唤出
    this._onWindowContextMenu = (e) => {
      if (!this.config.visible || this.config.minimized) return;
      
      const rect = this.container.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
          e.preventDefault();
          e.stopPropagation();
          this.showContextMenu(e.clientX, e.clientY);
      }
    };
    window.addEventListener("contextmenu", this._onWindowContextMenu, true);

    // 2. 拖拽逻辑 (仅在 lockPosition 为 false 时响应容器上的事件)
    this.container.addEventListener("mousedown", (e) => {
      if (this.config.lockPosition) return; // 穿透模式下不响应容器拖拽
      if (e.button !== 0) return; // 仅左键拖拽
      
      this.isDragging = true;
      this.dragOffset.x = e.clientX - this.container.offsetLeft;
      this.dragOffset.y = e.clientY - this.container.offsetTop;
      this.container.style.cursor = "grabbing";
      this.container.style.opacity = "0.8"; // 拖拽时轻微透明
      // 拖拽期间临时提升帧率到 60fps，防止低帧率下模型闪烁
      if (this.pixiApp && this.pixiApp.ticker) {
        this.pixiApp.ticker.maxFPS = 60;
      }
      e.stopPropagation();
    });

    this.container.addEventListener("dblclick", (e) => {
      if (this.config.lockPosition) return;
      // 触发双击对话
      if (this.tipsData && this.tipsData.message.click) {
        const texts = this.tipsData.message.click;
        this.showMessage(
          texts[Math.floor(Math.random() * texts.length)],
          3000,
          7,
        );
      }
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
        x = Math.max(
          0,
          Math.min(window.innerWidth - this.config.canvasWidth, x),
        );
        y = Math.max(
          0,
          Math.min(window.innerHeight - this.config.canvasHeight, y),
        );

        this.container.style.left = x + "px";
        this.container.style.top = y + "px";
        this.config.x = x;
        this.config.y = y;

        // 触发拖拽对话 (频率限制)
        const now = Date.now();
        if (!this._lastDragTipTime || now - this._lastDragTipTime > 5000) {
          if (this.tipsData && this.tipsData.message.drag) {
            const texts = this.tipsData.message.drag;
            this.showMessage(
              texts[Math.floor(Math.random() * texts.length)],
              2000,
              6,
            );
            this._lastDragTipTime = now;
          }
        }
      }

      // 2. 头部追踪逻辑（节流 100ms，减少 CPU 占用）
      if (!this._lastTrackTime || Date.now() - this._lastTrackTime > 100) {
        this._lastTrackTime = Date.now();
        try {
          this.updateHeadTracking(e);
        } catch (err) {
          // 仅打印一次以避免淹没控制台
          if (!this._trackingErrorLog) {
            console.error("[XBHH] Head tracking error:", err);
            this._trackingErrorLog = true;
          }
        }
      }
    });

    window.addEventListener("mouseup", () => {
      if (this.isDragging || this.isResizing) {
        this.isDragging = false;
        this.isResizing = false;
        this.container.style.cursor = "move";
        this.container.style.opacity = "1.0";
        // 恢复原始帧率
        if (this.pixiApp && this.pixiApp.ticker) {
          this.pixiApp.ticker.maxFPS = this.config.targetFPS || 30;
        }
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
      // 缩放期间临时提升帧率到 60fps，防止低帧率下模型闪烁
      if (this.pixiApp && this.pixiApp.ticker) {
        this.pixiApp.ticker.maxFPS = 60;
      }
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
    if (
      !this.model ||
      !this.model.internalModel ||
      !this.model.internalModel.coreModel
    )
      return;

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
            .xbhh-live2d-menu-item:hover > .xbhh-live2d-submenu,
            .xbhh-live2d-menu-item.active > .xbhh-live2d-submenu {
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
    fetch("/xbhh/live2d_models")
      .then((r) => r.json())
      .then((data) => {
        if (data.v2 && data.v2.length > 0) {
          const v2Header = document.createElement("div");
          v2Header.style.cssText =
            "padding: 5px 15px; color: #888; font-size: 10px; border-bottom: 1px solid #333;";
          v2Header.innerText = "SDK 2.0 (V2)";
          modelSubmenu.appendChild(v2Header);
          data.v2.forEach((m) => {
            modelSubmenu.appendChild(
              createItem("· " + m.name, () => {
                window.dispatchEvent(
                  new CustomEvent("xbhh-live2d-switch", {
                    detail: { version: "v2", modelPath: m.path },
                  }),
                );
              }),
            );
          });
        }
        if (data.v5 && data.v5.length > 0) {
          const v5Header = document.createElement("div");
          v5Header.style.cssText =
            "padding: 5px 15px; color: #888; font-size: 10px; border-bottom: 1px solid #333; margin-top: 5px;";
          v5Header.innerText = "SDK 4.0/5.0 (V5)";
          modelSubmenu.appendChild(v5Header);
          data.v5.forEach((m) => {
            modelSubmenu.appendChild(
              createItem("· " + m.name, () => {
                window.dispatchEvent(
                  new CustomEvent("xbhh-live2d-switch", {
                    detail: { version: "v5", modelPath: m.path },
                  }),
                );
              }),
            );
          });
        }
      });

    // 1. 表情二级菜单
    const expItem = createItem("🎭 表情", null, true);
    const expSubmenu = document.createElement("div");
    expSubmenu.className = "xbhh-live2d-submenu";
    expSubmenu.style.maxHeight = "500px";
    expSubmenu.style.overflowY = "auto";
    expSubmenu.style.minWidth = "180px";

    if (this.expressions && this.expressions.length > 0) {
      // 全部取消按钮
      const clearAllItem = document.createElement("div");
      clearAllItem.className = "xbhh-live2d-menu-item";
      clearAllItem.innerHTML = `<span style="color:#ef5350;">🗑️ 清除所有表情</span>`;
      clearAllItem.onclick = (e) => {
        e.stopPropagation();
        this.clearAllExpressions();
        if (menu.parentNode) document.body.removeChild(menu);
      };
      if (this.activeExpressions.size > 0) {
        expSubmenu.appendChild(clearAllItem);
        const sep = document.createElement("div");
        sep.style.cssText = "border-top: 1px solid #444; margin: 4px 0;";
        expSubmenu.appendChild(sep);
      }

      this.expressions.forEach((name, index) => {
        const isActive = this.activeExpressions.has(index);
        const label = isActive ? `✓ ${name}` : `   ${name}`;
        const item = document.createElement("div");
        item.className = "xbhh-live2d-menu-item";
        item.innerHTML = `<span>${label}</span>`;
        if (isActive) {
          item.style.color = "#66bb6a";
          item.style.background = "rgba(102, 187, 106, 0.1)";
        }
        item.onclick = (e) => {
          e.stopPropagation();
          this.toggleExpression(index, name);
          if (menu.parentNode) document.body.removeChild(menu);
        };
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

    // 1.5 动画菜单
    const motionItem = createItem("🎬 动画", null, true);
    const motionSubmenu = document.createElement("div");
    motionSubmenu.className = "xbhh-live2d-submenu";
    motionSubmenu.style.maxHeight = "400px";
    motionSubmenu.style.overflowY = "auto";
    motionSubmenu.style.minWidth = "180px";
    const motionGroups = Object.keys(this.motions || {}).filter(g => g.toLowerCase() !== "idle");
    if (motionGroups.length > 0) {
      motionGroups.forEach((group) => {
        const keybind = Object.entries(this.motionKeybinds).find(([k, v]) => v === group);
        const keyLabel = keybind ? ` [${keybind[0]}]` : "";

        const itemDiv = document.createElement("div");
        itemDiv.className = "xbhh-live2d-menu-item";
        itemDiv.style.display = "flex";
        itemDiv.style.justifyContent = "space-between";
        itemDiv.style.alignItems = "center";
        itemDiv.style.gap = "8px";

        const nameSpan = document.createElement("span");
        nameSpan.style.flex = "1";
        nameSpan.style.cursor = "pointer";
        nameSpan.textContent = group + keyLabel;
        nameSpan.onclick = (e) => {
          e.stopPropagation();
          this.playMotion(group);
          if (menu.parentNode) document.body.removeChild(menu);
        };

        const keyBtn = document.createElement("span");
        keyBtn.textContent = "⌨";
        keyBtn.title = "绑定快捷键";
        keyBtn.style.cssText = "cursor:pointer; font-size:14px; opacity:0.6; padding:2px 4px; border-radius:3px; transition: all 0.2s;";
        keyBtn.onmouseenter = () => { keyBtn.style.opacity = "1"; keyBtn.style.background = "rgba(255,255,255,0.1)"; };
        keyBtn.onmouseleave = () => { keyBtn.style.opacity = "0.6"; keyBtn.style.background = "none"; };
        keyBtn.onclick = (e) => {
          e.stopPropagation();
          nameSpan.textContent = group + " ⏳ 请按组合键...";
          nameSpan.style.color = "#4fc3f7";
          const onKey = (ev) => {
            if (["Control", "Shift", "Alt", "Meta"].includes(ev.key)) return;
            ev.preventDefault();
            ev.stopPropagation();
            const combo = this._buildKeyCombo(ev);
            for (const [k, v] of Object.entries(this.motionKeybinds)) {
              if (k === combo || v === group) delete this.motionKeybinds[k];
            }
            this.motionKeybinds[combo] = group;
            this.saveMotionKeybinds();
            nameSpan.textContent = group + ` [${combo}]`;
            nameSpan.style.color = "#66bb6a";
            this.showMessage(`快捷键 [${combo}] 已绑定到动画 "${group}"`, 3000, 10);
            setTimeout(() => { nameSpan.style.color = ""; }, 1500);
            window.removeEventListener("keydown", onKey, true);
          };
          window.addEventListener("keydown", onKey, true);
        };

        itemDiv.appendChild(nameSpan);
        itemDiv.appendChild(keyBtn);
        motionSubmenu.appendChild(itemDiv);
      });

      if (Object.keys(this.motionKeybinds).length > 0) {
        const sep = document.createElement("div");
        sep.style.cssText = "border-top: 1px solid #444; margin: 4px 0;";
        motionSubmenu.appendChild(sep);
        const clearItem = createItem("🗑️ 清除所有快捷键", () => {
          this.motionKeybinds = {};
          this.saveMotionKeybinds();
          this.showMessage("已清除所有动画快捷键", 2000, 10);
        });
        clearItem.style.color = "#ef5350";
        motionSubmenu.appendChild(clearItem);
      }

      // 恢复初始化选项
      const resetSep = document.createElement("div");
      resetSep.style.cssText = "border-top: 1px solid #444; margin: 4px 0;";
      motionSubmenu.appendChild(resetSep);
      const resetItem = createItem("🔄 恢复初始化", () => {
        this.resetMotion();
      });
      resetItem.style.color = "#4fc3f7";
      motionSubmenu.appendChild(resetItem);
    } else {
      const ph = createItem("（未检测到动画）", null);
      ph.style.color = "#888";
      motionSubmenu.appendChild(ph);
    }
    motionItem.appendChild(motionSubmenu);
    menu.appendChild(motionItem);

    // 2. 灵敏度
    const sensItem = createItem("📏 灵敏度", null, true);
    const sensSubmenu = document.createElement("div");
    sensSubmenu.className = "xbhh-live2d-submenu";
    sensSubmenu.appendChild(
      createItem("增加 (+0.1)", () => {
        this.config.sensitivity += 0.1;
        this.saveConfig();
      }),
    );
    sensSubmenu.appendChild(
      createItem("减少 (-0.1)", () => {
        this.config.sensitivity = Math.max(0.1, this.config.sensitivity - 0.1);
        this.saveConfig();
      }),
    );
    sensItem.appendChild(sensSubmenu);
    menu.appendChild(sensItem);

    // 3. 倍率调节 (滑块 + 输入框并排联动)
    const scaleItem = createItem("🔍 倍率调节", null, true);
    const scaleSubmenu = document.createElement("div");
    scaleSubmenu.className = "xbhh-live2d-submenu";
    scaleSubmenu.style.cssText += "padding: 12px; min-width: 200px;";

    const scaleLayout = document.createElement("div");
    scaleLayout.style.cssText =
      "display: flex; align-items: center; gap: 10px;";

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
    numInput.style.cssText =
      "width: 55px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 3px 5px; font-size: 12px; outline: none;";

    const applyScale = (val) => {
      val = parseFloat(val);
      if (isNaN(val) || val <= 0) return;
      this.config.scale = val;
      if (this.model) this.model.scale.set(val);
      numInput.value = val; // 只更新数值框，不更新滑块自身（避免平滑度问题）
      this.saveConfig();
    };

    slider.oninput = (e) => {
      applyScale(e.target.value);
      e.stopPropagation(); // 阻止事件冒泡到菜单甚至 ComfyUI 全局
    };

    // 关键修复：防止拖动滑块时干扰其他交互，并确保菜单不关闭
    const stopEvents = (e) => {
      e.stopPropagation();
      if (e.type === "mousedown" || e.type === "pointerdown") {
        scaleItem.classList.add("active");

        const endDrag = () => {
          scaleItem.classList.remove("active");
          window.removeEventListener("pointerup", endDrag);
          window.removeEventListener("mouseup", endDrag);
        };
        window.addEventListener("pointerup", endDrag);
        window.addEventListener("mouseup", endDrag);
      }
    };

    slider.onmousedown = stopEvents;
    slider.onmousemove = stopEvents;
    slider.onpointerdown = stopEvents;
    slider.onpointermove = stopEvents;

    numInput.onchange = (e) => applyScale(e.target.value);
    numInput.onmousedown = (e) => e.stopPropagation();
    numInput.onpointerdown = (e) => e.stopPropagation();

    scaleLayout.appendChild(slider);
    scaleLayout.appendChild(numInput);
    scaleSubmenu.appendChild(scaleLayout);
    scaleItem.appendChild(scaleSubmenu);
    menu.appendChild(scaleItem);

    // 4. 锁定/解锁模式 (控制穿透)
    const lockText = this.config.lockPosition ? "🔓 开启互动 (关闭穿透)" : "🔒 锁定位置 (开启穿透)";
    const lockBtn = createItem(lockText, () => {
        this.config.lockPosition = !this.config.lockPosition;
        const pe = this.config.lockPosition ? "none" : "auto";
        this.container.style.pointerEvents = pe;
        this.canvas.style.pointerEvents = pe;
        this.saveConfig();
        this.showMessage(this.config.lockPosition ? "已开启穿透模式" : "已开启互动模式", 2000, 10);
    });
    menu.appendChild(lockBtn);

    // 5. 最小化/还原
    const minBtn = createItem(
      this.config.minimized ? "📺 还原模型" : "🎈 最小化",
      () => this.toggleMinimize(),
    );
    menu.appendChild(minBtn);

    // 6. 隐藏
    menu.appendChild(createItem("🙈 隐藏小人", () => this.hide()));

    // 6.5 帧率调节
    const fpsItem = createItem("🎬 渲染帧率", null, true);
    const fpsSubmenu = document.createElement("div");
    fpsSubmenu.className = "xbhh-live2d-submenu";
    const currentFPS = this.config.targetFPS || 30;
    const fpsOptions = [10, 15, 24, 30, 60];
    fpsOptions.forEach(fps => {
      const label = fps === currentFPS ? `✓ ${fps} FPS` : `  ${fps} FPS`;
      fpsSubmenu.appendChild(createItem(label, () => {
        this.config.targetFPS = fps;
        if (this.pixiApp && this.pixiApp.ticker) {
          this.pixiApp.ticker.maxFPS = fps;
        }
        this.saveConfig();
        this.showMessage(`帧率已设为 ${fps} FPS`, 2000, 10);
      }));
    });
    fpsItem.appendChild(fpsSubmenu);
    menu.appendChild(fpsItem);

    // 7. 喂食商店 (新增养成系统)
    menu.appendChild(createItem("🥪 喂食商店", () => this.showFoodStore()));

    // 8. 快捷菜单 (新增需求)
    const quickItem = createItem("⚡ 快捷菜单", null, true);
    const quickSubmenu = document.createElement("div");
    quickSubmenu.className = "xbhh-live2d-submenu";

    const placeholder = createItem("（暂无快捷功能）", null);
    placeholder.style.color = "#888";
    placeholder.style.fontStyle = "italic";
    quickSubmenu.appendChild(placeholder);

    quickItem.appendChild(quickSubmenu);
    menu.appendChild(quickItem);

    // 9. 清理缓存
    menu.appendChild(
      createItem("🔧 清理本地缓存", () => {
        localStorage.removeItem("xbhh_live2d_config");
        localStorage.removeItem("xbhh_live2d_version");
        localStorage.removeItem("Comfy.MenuPosition.Docked");
        location.reload();
      }),
    );

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

  async showFoodStore() {
    // 移除旧商店
    const oldStore = document.getElementById("xbhh-food-store");
    if (oldStore) oldStore.remove();

    // 获取金币和食物
    const [walletResp, foodsResp] = await Promise.all([
        fetch("/xbhh/wallet/stats"),
        fetch("/xbhh/pet/foods")
    ]);
    const wallet = await walletResp.json();
    const foods = await foodsResp.json();

    const store = document.createElement("div");
    store.id = "xbhh-food-store";
    store.style.cssText = `
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 550px;
        max-height: 80vh;
        background: rgba(20, 20, 20, 0.95);
        backdrop-filter: blur(25px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 24px;
        padding: 30px;
        z-index: 20000;
        color: white;
        box-shadow: 0 30px 60px rgba(0,0,0,0.9);
        display: flex;
        flex-direction: column;
        gap: 20px;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    `;

    const header = document.createElement("div");
    header.style.cssText = "display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid rgba(255,255,255,0.05); padding-bottom: 20px; flex-shrink: 0;";
    header.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 36px; height: 36px; background: linear-gradient(135deg, #fa0, #d48800); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px;">🥪</div>
            <div style="font-size: 22px; font-weight: 600; letter-spacing: 0.5px;">宠物商店</div>
        </div>
        <div style="background: rgba(255, 215, 0, 0.15); color: #ffd700; padding: 6px 18px; border-radius: 12px; font-size: 16px; font-weight: 600; border: 1px solid rgba(255,215,0,0.3); box-shadow: 0 0 15px rgba(255,215,0,0.1);">
            <span style="font-size: 14px; opacity: 0.8; margin-right: 4px;">余额</span>💰 ${wallet.balance}
        </div>
    `;
    store.appendChild(header);

    const grid = document.createElement("div");
    grid.style.cssText = `
        display: flex; 
        flex-direction: column; 
        gap: 30px; 
        overflow-y: auto; 
        overflow-x: hidden;
        padding-right: 12px; 
        margin: 5px 0;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.2) transparent;
    `;
    
    // 自定义滚动条样式
    const styleId = "xbhh-store-scroll-style";
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            #xbhh-food-store ::-webkit-scrollbar { width: 6px; }
            #xbhh-food-store ::-webkit-scrollbar-track { background: transparent; }
            #xbhh-food-store ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 10px; }
            #xbhh-food-store ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
        `;
        document.head.appendChild(style);
    }
    
    // 按等级分组
    const tiers = ["传奇", "史诗", "稀有", "普通"];
    const grouped = tiers.reduce((acc, tier) => {
        acc[tier] = foods.filter(f => (f.tier || "普通") === tier);
        return acc;
    }, {});

    tiers.forEach(tier => {
        const tierFoods = grouped[tier];
        if (!tierFoods || tierFoods.length === 0) return;

        const section = document.createElement("div");
        section.innerHTML = `<div style="font-size: 14px; color: #aaa; margin-bottom: 15px; padding-left: 5px; display: flex; align-items: center; gap: 10px; font-weight: 500;">
            <span style="width: 4px; height: 16px; background: ${this.getTierColor(tier)}; border-radius: 2px; box-shadow: 0 0 8px ${this.getTierColor(tier)}88;"></span>
            ${tier}等级
        </div>`;
        
        const tierGrid = document.createElement("div");
        tierGrid.style.cssText = "display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px;";

        tierFoods.forEach(food => {
            const item = document.createElement("div");
            item.style.cssText = `
                background: rgba(255, 255, 255, 0.04);
                border-radius: 16px;
                padding: 15px 10px;
                text-align: center;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                border: 1px solid rgba(255,255,255,0.06);
                position: relative;
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                height: 165px;
                box-sizing: border-box;
            `;
            
            const tierColor = this.getTierColor(tier);

            item.innerHTML = `
                <div style="width: 100%; aspect-ratio: 1/1; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.15); border-radius: 12px; overflow: hidden; box-sizing: border-box; flex-shrink: 0;">
                    <img src="${food.url}" style="width: 100%; height: 100%; object-fit: cover; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.3)); transition: transform 0.5s;">
                </div>
                <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 4px; min-height: 40px;">
                    <div style="font-size: 13px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 4px; font-weight: 500;">${food.name}</div>
                    <div style="font-size: 15px; color: ${tierColor}; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 3px;">
                        ${food.price} <span style="font-size: 10px; opacity: 0.8;">CUI</span>
                    </div>
                </div>
            `;

            item.onmouseenter = () => {
                item.style.background = "rgba(255, 255, 255, 0.08)";
                item.style.borderColor = tierColor;
                item.style.transform = "translateY(-6px) scale(1.02)";
                item.style.boxShadow = `0 10px 20px ${tierColor}15`;
            };
            item.onmouseleave = () => {
                item.style.background = "rgba(255, 255, 255, 0.04)";
                item.style.borderColor = "rgba(255,255,255,0.06)";
                item.style.transform = "translateY(0) scale(1)";
                item.style.boxShadow = "none";
            };

            item.onclick = async () => {
                await this.feedPet(food);
            };

            tierGrid.appendChild(item);
        });

        section.appendChild(tierGrid);
        grid.appendChild(section);
    });

    store.appendChild(grid);

    const closeBtn = document.createElement("div");
    closeBtn.innerText = "完成离开";
    closeBtn.style.cssText = "background: #444; color: white; text-align: center; padding: 12px; border-radius: 12px; cursor: pointer; font-size: 14px; transition: background 0.2s;";
    closeBtn.onmouseenter = () => closeBtn.style.background = "#555";
    closeBtn.onmouseleave = () => closeBtn.style.background = "#444";
    closeBtn.onclick = () => store.remove();
    store.appendChild(closeBtn);

    document.body.appendChild(store);

    // 点击外部关闭
    setTimeout(() => {
        const handleClickOutside = (e) => {
            if (!store.contains(e.target)) {
                store.remove();
                document.removeEventListener("mousedown", handleClickOutside);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
    }, 10);
  }

  getTierColor(tier) {
    switch(tier) {
        case "传奇": return "#ff4d4f";
        case "史诗": return "#722ed1";
        case "稀有": return "#1890ff";
        default: return "#888";
    }
  }

  async feedPet(food) {
    try {
        const resp = await fetch("/xbhh/pet/feed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                food_id: food.id,
                food_name: food.name,
                price: food.price
            })
        });

        const result = await resp.json();
        if (result.success) {
            // 喂食成功： Live2D 反馈
            this.showMessage(`😋 好吃！谢谢主人投喂的 ${food.name} ~`, 4000, 10);
            
            // 触发模型表情 (如果存在)
            if (this.model) {
                // 尝试播放一个开心的表情（通常 index 0 或 名字含 Happy 的）
                try {
                    const settings = this.model.internalModel.settings;
                    const exprs = settings.expressions || settings.Expressions || [];
                    let happyIdx = exprs.findIndex(e => (e.name || e.Name || "").toLowerCase().includes("happy"));
                    if (happyIdx === -1) happyIdx = 0; // 默认第一个
                    this.setExpression(happyIdx);
                    
                    // 3秒后恢复默认或第一个表情
                    setTimeout(() => this.setExpression(0), 3000);
                } catch (err) {}
            }
            
            // 更新商店余额显示
            const balanceDiv = document.querySelector("#xbhh-food-store div[style*='color: #ffd700']");
            if (balanceDiv) balanceDiv.innerHTML = `💰 ${result.balance} CUI`;
            
        } else {
            this.showMessage(`⚠️ ${result.message}`, 3000, 10);
        }
    } catch (e) {
        console.error("[XBHH] Feed Error:", e);
        this.showMessage("⚠️ 喂食失败，服务器无响应", 3000, 10);
    }
  }

  // 异步加载所有表情文件的参数数据
  async _loadExpressionData(rawExprs) {
    const modelPath = this.config.modelPath;
    const basePath = modelPath.substring(0, modelPath.lastIndexOf("/") + 1);
    
    this.expressionData = new Array(rawExprs.length).fill(null);
    
    const promises = rawExprs.map(async (exp, index) => {
      const file = exp.file || exp.File;
      if (!file) return;
      try {
        const url = basePath + file;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          this.expressionData[index] = data.Parameters || [];
          console.log(`[XBHH] Loaded expression data: ${this.expressions[index]} (${(data.Parameters || []).length} params)`);
        }
      } catch (e) {
        console.warn(`[XBHH] Failed to load expression file for ${this.expressions[index]}:`, e);
      }
    });
    
    await Promise.all(promises);
    console.log(`[XBHH] All expression data loaded: ${this.expressionData.filter(d => d).length}/${rawExprs.length}`);
  }

  toggleExpression(index, name) {
    if (!this.model) return;
    try {
      if (this.activeExpressions.has(index)) {
        this.activeExpressions.delete(index);
        this.showMessage(`已取消表情: ${name}`, 2000, 8);
        console.log(`[XBHH] Expression removed: ${name} (${index})`);
      } else {
        this.activeExpressions.add(index);
        this.showMessage(`已应用表情: ${name}`, 2000, 8);
        console.log(`[XBHH] Expression applied: ${name} (${index})`);
      }
      this._applyMergedExpressions();
      console.log(`[XBHH] Active expressions:`, [...this.activeExpressions]);
    } catch (e) {
      console.warn("[XBHH] Expression error", e);
    }
  }

  clearAllExpressions() {
    if (!this.model) return;
    try {
      this.activeExpressions.clear();
      this._stopExpressionUpdater();
      // 使用与动画重置相同的完整参数恢复逻辑
      this._resetAllParametersToDefault();
      this.showMessage("已清除所有表情", 2000, 8);
      console.log("[XBHH] All expressions cleared");
    } catch (e) {
      console.warn("[XBHH] Clear expressions error", e);
    }
  }

  // 彻底恢复所有模型参数到默认值（与动画重置使用相同逻辑）
  _resetAllParametersToDefault() {
    if (!this.model) return;
    const im = this.model.internalModel;
    const core = im.coreModel;
    if (!core) return;

    // 禁止库的表情管理器干扰
    const expMgr = im.motionManager?.expressionManager;
    if (expMgr) {
      if (typeof expMgr.resetExpression === "function") expMgr.resetExpression();
      if ("currentExpression" in expMgr) expMgr.currentExpression = null;
      if ("_currentExpression" in expMgr) expMgr._currentExpression = null;
    }

    // 重置所有参数到默认值
    if (core && typeof core.getParameterCount === "function") {
      const count = core.getParameterCount();
      for (let i = 0; i < count; i++) {
        const defVal = core.getParameterDefaultValue(i);
        core.setParameterValueByIndex(i, defVal);
      }
      console.log(`[XBHH] Reset ${count} parameters to default`);
    } else if (core && core._model) {
      const model = core._model;
      const defaults = model._parameterDefaultValues || model.parameters?.defaultValues;
      const values = model._parameterValues || model.parameters?.values;
      if (defaults && values) {
        for (let i = 0; i < defaults.length; i++) {
          values[i] = defaults[i];
        }
        console.log(`[XBHH] Reset ${defaults.length} parameters via direct array`);
      }
    } else if (core && typeof core.setParamFloat === "function") {
      core.saveParam();
      core.loadParam();
      console.log("[XBHH] Reset via SDK 2.0 saveParam/loadParam");
    }

    // 播放 Idle 动画作为兜底，确保模型恢复自然状态
    const idleGroup = Object.keys(this.motions || {}).find(g => g.toLowerCase() === "idle");
    if (idleGroup) {
      setTimeout(() => {
        if (this.model) {
          this.model.motion(idleGroup, 0, 3);
          console.log("[XBHH] Playing idle motion after expression reset");
        }
      }, 100);
    }
  }

  // 核心：合并所有激活表情的参数并直接写入模型
  _applyMergedExpressions() {
    if (!this.model) return;
    const core = this.model.internalModel.coreModel;
    if (!core) return;

    // 如果没有激活的表情，执行完整的参数恢复
    if (this.activeExpressions.size === 0) {
      this._stopExpressionUpdater();
      this._resetAllParametersToDefault();
      return;
    }

    // 彻底禁用库的表情管理器（防止它每帧覆盖我们的参数）
    this._disableLibraryExpressionManager();

    // 构建完整参数表（包含所有表情参数的默认值 + 激活表情的叠加值）
    const fullParamMap = new Map();

    // 步骤1：收集所有表情涉及的参数，先全部设为默认值
    if (this.expressionData && typeof core.getParameterCount === "function") {
      const defaultValues = new Map();
      const count = core.getParameterCount();
      for (let i = 0; i < count; i++) {
        if (typeof core.getParameterId === "function") {
          defaultValues.set(core.getParameterId(i), core.getParameterDefaultValue(i));
        }
      }
      for (const params of this.expressionData) {
        if (!params) continue;
        for (const p of params) {
          if (defaultValues.has(p.Id)) {
            fullParamMap.set(p.Id, defaultValues.get(p.Id));
          }
        }
      }
    }

    // 步骤2：计算激活表情的合并参数，覆盖默认值
    const activeParams = new Map();
    for (const idx of this.activeExpressions) {
      const params = this.expressionData?.[idx];
      if (!params) continue;
      for (const p of params) {
        const blend = (p.Blend || "Add").toLowerCase();
        if (blend === "add") {
          const prev = activeParams.get(p.Id) || 0;
          activeParams.set(p.Id, prev + p.Value);
        } else if (blend === "multiply") {
          const prev = activeParams.get(p.Id) || 1;
          activeParams.set(p.Id, prev * p.Value);
        } else {
          activeParams.set(p.Id, p.Value);
        }
      }
    }
    for (const [id, value] of activeParams) {
      fullParamMap.set(id, value);
    }

    // 先立即应用一次
    this._writeParamsToCore(core, fullParamMap);
    console.log(`[XBHH] Applied ${activeParams.size} active expression params (${fullParamMap.size} total managed)`);

    // 缓存参数表，供 ticker 持续使用
    this._cachedExpressionParams = fullParamMap;

    // 启动持续应用（使用 PIXI ticker 确保在库的 update 之后执行）
    this._startExpressionUpdater();
  }

  // 彻底禁用库自带的表情管理器
  _disableLibraryExpressionManager() {
    const expMgr = this.model?.internalModel?.motionManager?.expressionManager;
    if (!expMgr) return;

    // 清空当前表情
    if (typeof expMgr.resetExpression === "function") expMgr.resetExpression();
    if ("currentExpression" in expMgr) expMgr.currentExpression = null;
    if ("_currentExpression" in expMgr) expMgr._currentExpression = null;

    // 关键：monkey-patch 库的 update 方法，阻止它每帧重新应用表情
    if (!expMgr._xbhhOriginalUpdate) {
      expMgr._xbhhOriginalUpdate = expMgr.update;
      expMgr.update = function(model, now) {
        // 当我们有自定义表情激活时，跳过库的表情更新
        return false;
      };
      console.log("[XBHH] Disabled library expression manager update");
    }
  }

  // 恢复库的表情管理器
  _enableLibraryExpressionManager() {
    const expMgr = this.model?.internalModel?.motionManager?.expressionManager;
    if (!expMgr || !expMgr._xbhhOriginalUpdate) return;
    expMgr.update = expMgr._xbhhOriginalUpdate;
    delete expMgr._xbhhOriginalUpdate;
    console.log("[XBHH] Re-enabled library expression manager update");
  }

  // 将参数表写入模型核心
  _writeParamsToCore(core, paramMap) {
    if (typeof core.setParameterValueById === "function") {
      for (const [id, value] of paramMap) {
        try { core.setParameterValueById(id, value); } catch (_) {}
      }
    } else if (typeof core.setParamFloat === "function") {
      for (const [id, value] of paramMap) {
        try { core.setParamFloat(id, value); } catch (_) {}
      }
    }
  }

  // 停止表情持续更新器
  _stopExpressionUpdater() {
    if (this._expressionTickerFn && this.pixiApp) {
      this.pixiApp.ticker.remove(this._expressionTickerFn);
      this._expressionTickerFn = null;
    }
    // 兼容旧的 RAF 方式
    if (this._expressionUpdateId) {
      cancelAnimationFrame(this._expressionUpdateId);
      this._expressionUpdateId = null;
    }
    this._cachedExpressionParams = null;
    // 恢复库的表情管理器
    this._enableLibraryExpressionManager();
  }

  // 持续应用表情参数（使用 PIXI ticker，在模型 update 之后执行）
  _startExpressionUpdater() {
    // 先清理旧的 ticker 回调（但不清空缓存和不恢复库表情管理器）
    if (this._expressionTickerFn && this.pixiApp) {
      this.pixiApp.ticker.remove(this._expressionTickerFn);
      this._expressionTickerFn = null;
    }
    if (this._expressionUpdateId) {
      cancelAnimationFrame(this._expressionUpdateId);
      this._expressionUpdateId = null;
    }

    if (this.activeExpressions.size === 0) return;
    if (!this.pixiApp || !this.model) return;

    const core = this.model.internalModel.coreModel;
    if (!core) return;

    if (!this._cachedExpressionParams) return;
    const paramMap = this._cachedExpressionParams;

    // 禁用库的表情管理器
    this._disableLibraryExpressionManager();

    // 使用 PIXI ticker 注册回调，这确保在同一帧中库更新后再覆盖参数
    this._expressionTickerFn = () => {
      if (this.activeExpressions.size === 0 || !this.model) {
        this._stopExpressionUpdater();
        return;
      }
      this._writeParamsToCore(core, paramMap);
    };
    this.pixiApp.ticker.add(this._expressionTickerFn, null, PIXI.UPDATE_PRIORITY.LOW);
    console.log("[XBHH] Expression updater started via PIXI ticker");
  }

  setExpression(index) {
    if (!this.model) return;
    try {
      this.model.expression(index);
    } catch (e) {
      console.warn("[XBHH] Expression error", e);
    }
  }

  playMotion(group, index = 0, priority = 3) {
    if (!this.model) return;
    this.model.motion(group, index, priority);
    console.log(`[XBHH] Playing motion: ${group}`);
  }

  resetMotion() {
    if (!this.model) return;
    try {
      // 同时清理自定义表情状态
      this.activeExpressions.clear();
      this._stopExpressionUpdater();

      const im = this.model.internalModel;
      const core = im.coreModel;

      console.log("[XBHH] resetMotion - internalModel:", im);
      console.log("[XBHH] resetMotion - coreModel:", core);
      console.log("[XBHH] resetMotion - motionManager:", im.motionManager);

      // === 第一步：停止所有动画 ===
      if (im.motionManager) {
        // 尝试各种可能的停止方法
        if (typeof im.motionManager.stopAllMotions === "function") {
          im.motionManager.stopAllMotions();
          console.log("[XBHH] stopAllMotions() called");
        }
        // 清空所有动画状态
        if (im.motionManager._currentAudio) {
          im.motionManager._currentAudio.pause();
          im.motionManager._currentAudio = undefined;
        }
        // 强制清理动画队列
        ["_motionQueueEntries", "motionQueueEntries", "_motions"].forEach(prop => {
          if (im.motionManager[prop] && Array.isArray(im.motionManager[prop])) {
            im.motionManager[prop].length = 0;
          }
        });
        // 清空当前动画
        if ("currentMotion" in im.motionManager) {
          im.motionManager.currentMotion = null;
        }
      }

      // === 第二步：重置表情 ===
      const expMgr = im.motionManager?.expressionManager;
      if (expMgr) {
        if (typeof expMgr.resetExpression === "function") {
          expMgr.resetExpression();
        } else if (typeof expMgr.setExpression === "function") {
          expMgr.setExpression(null);
        }
        if ("currentExpression" in expMgr) {
          expMgr.currentExpression = null;
        }
      }

      // === 第三步：重置模型参数到默认值 ===
      let paramReset = false;

      // 方法A：使用 Cubism4 getParameterCount API (最可靠)
      if (core && typeof core.getParameterCount === "function") {
        const count = core.getParameterCount();
        for (let i = 0; i < count; i++) {
          const defVal = core.getParameterDefaultValue(i);
          core.setParameterValueByIndex(i, defVal);
        }
        paramReset = true;
        console.log(`[XBHH] Reset ${count} parameters via Cubism4 API`);
      }
      // 方法B：直接操作内部数组 (Cubism4 _model 对象)
      else if (core && core._model) {
        const model = core._model;
        const defaults = model._parameterDefaultValues || model.parameters?.defaultValues;
        const values = model._parameterValues || model.parameters?.values;
        if (defaults && values) {
          for (let i = 0; i < defaults.length; i++) {
            values[i] = defaults[i];
          }
          paramReset = true;
          console.log(`[XBHH] Reset ${defaults.length} parameters via direct array`);
        }
      }
      // 方法C：SDK 2.0 兼容
      else if (core && typeof core.setParamFloat === "function") {
        core.saveParam();
        core.loadParam();
        paramReset = true;
        console.log("[XBHH] Reset via SDK 2.0 saveParam/loadParam");
      }

      if (!paramReset) {
        console.warn("[XBHH] Could not reset parameters, core structure:", Object.keys(core || {}));
      }

      // === 第四步：播放 Idle 动画作为兜底 ===
      const idleGroup = Object.keys(this.motions || {}).find(g => g.toLowerCase() === "idle");
      if (idleGroup) {
        setTimeout(() => {
          this.model.motion(idleGroup, 0, 3);
          console.log("[XBHH] Fallback: playing idle motion");
        }, 100);
      }

      this.showMessage("已恢复初始状态", 2000, 10);
      console.log("[XBHH] Motion & parameters reset to initial state");
    } catch (e) {
      console.warn("[XBHH] Reset motion error:", e);
      // 最终兜底：尝试播放 idle
      try {
        const idleGroup = Object.keys(this.motions || {}).find(g => g.toLowerCase() === "idle");
        if (idleGroup) this.model.motion(idleGroup, 0, 3);
      } catch (_) {}
      this.showMessage("恢复初始化失败", 2000, 10);
    }
  }

  loadMotionKeybinds() {
    try {
      const saved = localStorage.getItem("xbhh_motion_keybinds");
      if (saved) this.motionKeybinds = JSON.parse(saved);
    } catch (e) { this.motionKeybinds = {}; }
  }

  saveMotionKeybinds() {
    localStorage.setItem("xbhh_motion_keybinds", JSON.stringify(this.motionKeybinds));
  }

  _buildKeyCombo(e) {
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    return parts.join("+");
  }

  bindMotionKeyListener() {
    if (this._motionKeyHandler) {
      window.removeEventListener("keydown", this._motionKeyHandler, true);
    }
    this._motionKeyHandler = (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const combo = this._buildKeyCombo(e);
      const group = this.motionKeybinds[combo];
      if (group && this.motions[group]) {
        e.preventDefault();
        this.playMotion(group);
        this.showMessage(`🎬 播放动画: ${group}`, 2000, 8);
      }
    };
    window.addEventListener("keydown", this._motionKeyHandler, true);
  }

  hide() {
    this.config.visible = false;
    this.saveConfig();

    // 持久化隐藏状态（loader 重启时会清除此标记）
    localStorage.setItem("xbhh_live2d_hidden", "true");

    console.log("[XBHH] Live2D hiding: destroying instance to release CPU...");

    // 停止 PIXI 渲染循环
    if (this.pixiApp && this.pixiApp.ticker) {
      this.pixiApp.ticker.stop();
    }

    // 销毁 Live2D 模型
    if (this.model && this.pixiApp) {
      try {
        this.pixiApp.stage.removeChild(this.model);
        this.model.destroy({ children: true, texture: true, baseTexture: true });
      } catch (e) {
        console.warn("[XBHH] Error destroying model:", e);
      }
      this.model = null;
    }

    // 销毁 PIXI 应用
    if (this.pixiApp) {
      try {
        this.pixiApp.destroy(true, { children: true, texture: true, baseTexture: true });
      } catch (e) {
        console.warn("[XBHH] Error destroying PIXI app:", e);
      }
      this.pixiApp = null;
    }

    // 清理定时器
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.tipsTimer) { clearTimeout(this.tipsTimer); this.tipsTimer = null; }

    // 清理事件监听器
    if (this._onSwitchModel) {
      window.removeEventListener("xbhh-live2d-switch", this._onSwitchModel);
    }
    if (this._onWindowContextMenu) {
      window.removeEventListener("contextmenu", this._onWindowContextMenu);
    }
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
    }

    // 移除 DOM
    if (this.container) { this.container.remove(); this.container = null; }
    this.canvas = null;

    console.log("[XBHH] Live2D instance destroyed. Will re-enable on next restart.");
  }



  show() {
    this.config.visible = true;
    this.container.style.display = "block";
    this.saveConfig();
  }

  // 对话系统实现
  async initTips() {
    try {
      // 动态获取插件名
      const url_tips = new URL(import.meta.url);
      const pathSegments_tips = url_tips.pathname.split("/");
      const extensionsIdx_tips = pathSegments_tips.indexOf("extensions");
      const extName_tips =
        extensionsIdx_tips !== -1
          ? pathSegments_tips[extensionsIdx_tips + 1]
          : "xbhh-lora";

      const resp = await fetch(
        `/extensions/${extName_tips}/js/pet/waifu-tips.json?v=` + Date.now(),
      );
      this.tipsData = await resp.json();
      this.showWelcomeMessage();
      this.startIdleTimer();
      this.bindGlobalInteractions();
    } catch (e) {
      console.error("[XBHH] Failed to load waifu-tips.json", e);
    }
  }

  showWelcomeMessage() {
    if (!this.tipsData) return;
    const hour = new Date().getHours();
    let text = "你好！";
    for (const item of this.tipsData.time) {
      const range = item.hour.split("-");
      if (hour >= parseInt(range[0]) && hour <= parseInt(range[1])) {
        text = Array.isArray(item.text) ? item.text[0] : item.text;
        break;
      }
    }
    this.showMessage(text, 5000, 10);
  }

  showMessage(text, timeout = 3000, priority = 0) {
    if (!text || this.currentPriority > priority || this.config.minimized)
      return;
    if (this.tipsTimer) clearTimeout(this.tipsTimer);

    this.currentPriority = priority;
    this.tips.innerHTML = text;
    this.tips.style.opacity = "1";

    this.tipsTimer = setTimeout(() => {
      this.tips.style.opacity = "0";
      this.currentPriority = -1;
    }, timeout);
  }

  startIdleTimer() {
    const resetTimer = () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.tipsData && this.tipsData.message.default) {
          const texts = this.tipsData.message.default;
          const text = texts[Math.floor(Math.random() * texts.length)];
          this.showMessage(text, 5000, 5);
        }
        resetTimer();
      }, 30000);
    };
    resetTimer();
  }

  bindGlobalInteractions() {
    window.addEventListener("copy", () => {
      if (this.tipsData) this.showMessage(this.tipsData.message.copy, 5000, 9);
    });
    window.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.tipsData) {
        this.showMessage(this.tipsData.message.visibilitychange, 5000, 9);
      }
    });
  }
}

// 移除自执行逻辑，由 loader 统一调度实例化
// (function() { ... })();
