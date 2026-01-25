import { app } from "/scripts/app.js";

/**
 * XBHH Live2D Pet SDK 2.0 (Pio) Adapter
 * 采用标准化移植方案：从 test/1 (live2d-widget) 完整平移逻辑，并适配 ComfyUI 环境。
 */
export class Live2DV2Pet {
  constructor() {
    this.libPath = "/extensions/xbhh-lora/lib/live2d/";
    this.petPath = "/extensions/xbhh-lora/js/pet/";
    this.modelBasePath = "/extensions/xbhh-lora/live2d/";
    
    this.config = {
      visible: true,
      minimized: false,
      canvasWidth: 300,
      canvasHeight: 400,
    };

    this.loadConfig();
    this.init();
    
    // 使用命名函数以便移除监听器
    this._onSwitchModel = this.onSwitchModel.bind(this);
    window.addEventListener("xbhh-live2d-switch", this._onSwitchModel);
  }

  destroy() {
    console.log("[XBHH] Destroying V2 instance...");
    if (this._onSwitchModel) {
        window.removeEventListener("xbhh-live2d-switch", this._onSwitchModel);
    }
    const waifu = document.getElementById("waifu");
    if (waifu) waifu.remove();
    const toggle = document.getElementById("waifu-toggle");
    if (toggle) toggle.remove();
    // 同时也清理 V2 的样式
    const style = document.getElementById("waifu-css");
    if (style) style.remove();
  }

  onSwitchModel(e) {
    const { version, modelPath } = e.detail;
    if (version === "v2") {
        // V2 内部切换模型
        // 注意：window.xbhhModelInstance 是在 waifu-tips.js 加载后定义的
        if (window.xbhhModelInstance) {
            // 找到匹配的 modelId
            const models = window.xbhhModelInstance.models;
            const id = models.findIndex(m => m.paths.includes(modelPath));
            if (id !== -1) {
                window.xbhhModelInstance.modelId = id;
                window.xbhhModelInstance.modelTexturesId = 0;
                window.xbhhModelInstance.loadModel();
            }
        }
    } else {
        // 切换到 V5
        this.switchToV5(modelPath);
    }
  }

  bindGlobalEvents() {
      // 已移至 constructor
  }

  async switchToV5(modelPath) {
      console.log("[XBHH] Switching to V5...", modelPath);
      // 1. 清理
      this.destroy();

      // 2. 持久化配置以便下次加载
      localStorage.setItem("xbhh_live2d_config", JSON.stringify({
          ...JSON.parse(localStorage.getItem("xbhh_live2d_config") || "{}"),
          modelPath: modelPath,
          enabled: true
      }));
      // 更新 loader 配置
      const loaderConfig = { enabled: true, version: "v5" };
      // 注意：这里无法直接修改 config_live2d.json，但可以通过 localStorage 覆盖 loader 逻辑
      // 我们改一下 live2d_loader.js 让其优先读取 localStorage
      localStorage.setItem("xbhh_live2d_version", "v5");

      // 3. 加载 V5
      const { Live2DPet } = await import("./live2d_pet.js?v=" + Date.now());
      window.xbhhLive2DPet = new Live2DPet();
  }

  loadConfig() {
    const saved = localStorage.getItem("xbhh_live2d_v2_config");
    if (saved) {
      try {
        this.config = { ...this.config, ...JSON.parse(saved) };
      } catch (e) {
        console.error("[XBHH] Failed to load V2 config", e);
      }
    }
  }

  saveConfig() {
    localStorage.setItem("xbhh_live2d_v2_config", JSON.stringify(this.config));
  }

  /**
   * 标准外部资源加载器 (适配 ComfyUI 相对路径)
   */
  loadExternalResource(url, type) {
    return new Promise((resolve, reject) => {
        let tag;
        const ver = Date.now();
        const finalUrl = url.includes('?') ? `${url}&v=${ver}` : `${url}?v=${ver}`;

        if (type === 'css') {
            tag = document.createElement('link');
            tag.rel = 'stylesheet';
            tag.href = finalUrl;
        } else if (type === 'js') {
            tag = document.createElement('script');
            // 原版是 module，但在 ComfyUI 某些库冲突下，核心驱动习惯作为全局脚本加载
            // 这里我们保持 module 还是全局脚本？
            // 根据 debug.html 成功经验，live2d.min.js 是全局脚本，waifu-tips.js 是 module
            if (url.includes('waifu-tips.js')) {
                tag.type = 'module';
            }
            tag.src = finalUrl;
        }

        if (tag) {
            tag.onload = () => resolve(url);
            tag.onerror = () => reject(new Error(`Failed to load: ${url}`));
            document.head.appendChild(tag);
        }
    });
  }

  async init() {
    console.log("[XBHH] Initializing V2 Widget (Standardized)...");
    
    try {
        // 1. 加载样式与核心驱动 (全局脚本)
        await Promise.all([
            this.loadExternalResource(this.libPath + 'waifu.css', 'css'),
            this.loadExternalResource(this.libPath + 'live2d.min.js', 'js')
        ]);

        // 2. 导入逻辑组件 (Module)
        // 注意：我们直接加载之前拷贝到 lib 下的 waifu-tips.js
        await import(this.libPath + 'waifu-tips.js');

        if (typeof window.initWidget === 'function') {
            // 增加安全性检查：校验 localStorage 中的模型索引是否越界，并强制重置显示状态
            const checkAndFixConfig = async () => {
                // 1. 强制重置显示隐藏状态，确保 ComfyUI 刷新后小人总能出现
                localStorage.removeItem("waifu-display");
                
                try {
                    const resp = await fetch('/xbhh/live2d_models');
                    const data = await resp.json();
                    
                    // 2. 校验 V2 模型 Id
                    let modelId = parseInt(localStorage.getItem("modelId"), 10);
                    if (!isNaN(modelId)) {
                        if (!data.v2 || data.v2.length === 0 || modelId >= data.v2.length) {
                             console.warn("[XBHH] modelId out of bounds, resetting to 0");
                             localStorage.setItem("modelId", "0");
                             modelId = 0;
                        }
                        
                        // 3. 校验贴图/衣服 Id
                        let texturesId = parseInt(localStorage.getItem("modelTexturesId"), 10);
                        if (!isNaN(texturesId) && data.v2[modelId] && texturesId >= data.v2[modelId].clothes.length) {
                            console.warn("[XBHH] modelTexturesId out of bounds, resetting to 0");
                            localStorage.setItem("modelTexturesId", "0");
                        }
                    }
                } catch (e) {
                    console.error("[XBHH] Failed to check and fix config:", e);
                }
            };
            await checkAndFixConfig();

            window.initWidget({
                waifuPath: '/xbhh/waifu-tips.json?v=' + Date.now(),
                cubism2Path: this.libPath + 'live2d.min.js',
                tools: ['hitokoto', 'switch-model', 'switch-texture', 'photo', 'quit'],
                logLevel: 'warn',
                drag: true
            });
            console.log("[XBHH] V2 Widget Initialized successfully.");
            
            // 劫持实例以供外部调用
            // 我们需要找到 c 类的实例。initCheck 返回了它。
            // 但 waifu-tips.js 里的 initWidget 没暴露。
            // 幸好我们可以在 waifu-tips.js 结尾看到 export { a as l }; 
            // 实际上我们可以通过调试发现，实例被绑定在了某些地方，或者我们直接修改 waifu-tips.js 暴露它。
            // 简单起见，我先尝试在 initWidget 之后绑定右键菜单。
            setTimeout(() => this.initContextMenu(), 1000);
        } else {
            console.error("[XBHH] initWidget not found after import!");
        }
    } catch (e) {
        console.error("[XBHH] V2 Initialization failed:", e);
    }
  }

  async initContextMenu() {
      const waifu = document.getElementById("waifu");
      if (!waifu) return;

      waifu.addEventListener("contextmenu", async (e) => {
          e.preventDefault();
          this.showModelMenu(e.clientX, e.clientY);
      });
  }

  async showModelMenu(x, y) {
      // 移除旧菜单
      const oldMenu = document.getElementById("xbhh-live2d-v2-menu");
      if (oldMenu) oldMenu.remove();

      const menu = document.createElement("div");
      menu.id = "xbhh-live2d-v2-menu";
      menu.style.cssText = `
          position: fixed;
          left: ${x}px;
          top: ${y}px;
          background: rgba(30, 30, 30, 0.9);
          border: 1px solid #444;
          border-radius: 8px;
          padding: 10px 0;
          z-index: 10001;
          color: white;
          font-size: 14px;
          min-width: 150px;
          box-shadow: 0 4px 15px rgba(0,0,0,0.5);
          backdrop-filter: blur(5px);
      `;

      const resp = await fetch("/xbhh/live2d_models");
      const data = await resp.json();

      const createSection = (title) => {
          const header = document.createElement("div");
          header.style.cssText = "padding: 5px 15px; color: #888; font-size: 11px; text-transform: uppercase; border-bottom: 1px solid #333; margin-bottom: 5px;";
          header.innerText = title;
          menu.appendChild(header);
      };

      const createItem = (text, callback) => {
          const item = document.createElement("div");
          item.style.cssText = "padding: 8px 20px; cursor: pointer; transition: background 0.2s;";
          item.innerText = text;
          item.onmouseover = () => { item.style.background = "#444"; };
          item.onmouseout = () => { item.style.background = "transparent"; };
          item.onclick = () => {
              callback();
              menu.remove();
          };
          menu.appendChild(item);
      };

      if (data.v2 && data.v2.length > 0) {
          createSection("Live2D V2 Models");
          data.v2.forEach(m => {
              createItem(m.name, () => {
                  // 这里我们需要 V2 的实例来切换。
                  // 如果没有暴露，我们就用 xbhh-live2d-switch 事件
                  window.dispatchEvent(new CustomEvent("xbhh-live2d-switch", {
                      detail: { version: "v2", modelPath: m.path }
                  }));
              });
          });
      }

      if (data.v5 && data.v5.length > 0) {
          createSection("Live2D V5 Models");
          data.v5.forEach(m => {
              createItem(m.name, () => {
                  window.dispatchEvent(new CustomEvent("xbhh-live2d-switch", {
                      detail: { version: "v5", modelPath: m.path }
                  }));
              });
          });
      }

      document.body.appendChild(menu);

      const closeMenu = (e) => {
          if (!menu.contains(e.target)) {
              menu.remove();
              document.removeEventListener("mousedown", closeMenu);
          }
      };
      setTimeout(() => document.addEventListener("mousedown", closeMenu), 10);
  }
}
