import { app } from "/scripts/app.js";

/**
 * XBHH Live2D Pet SDK 2.0 (Pio) Adapter
 * 采用标准化移植方案：从 test/1 (live2d-widget) 完整平移逻辑，并适配 ComfyUI 环境。
 */
export class Live2DV2Pet {
  constructor() {
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split('/');
    const extensionsIdx = pathSegments.indexOf('extensions');
    this.extName = extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : 'xbhh-lora';

    this.libPath = `/extensions/${this.extName}/lib/live2d/`;
    this.petPath = `/extensions/${this.extName}/js/pet/`;
    this.modelBasePath = `/extensions/${this.extName}/live2d/`;
    
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
    const fixStyle = document.getElementById("xbhh-v2-fix-style");
    if (fixStyle) fixStyle.remove();
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
      const { Live2DPet } = await import(`/extensions/${this.extName}/js/pet/live2d_pet.js?v=${Date.now()}`);
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
        const finalUrl = url.includes('?') ? url : `${url}?v=${Date.now()}`;

        if (type === 'css') {
            tag = document.createElement('link');
            tag.rel = 'stylesheet';
            tag.href = finalUrl;
            tag.id = "waifu-css";
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
                // 1. 强制清理显示限制，确保每次刷新都尝试显示
                localStorage.removeItem("waifu-display");
                localStorage.removeItem("Comfy.MenuPosition.Docked");
                // 确保样式强制可见
                const style = document.createElement("style");
                style.id = "xbhh-v2-fix-style";
                style.innerHTML = "#waifu { display: block !important; }";
                document.head.appendChild(style);
                
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

            // 劫持 Cubism2 渲染循环，降帧率到 15fps
            this.throttleRenderLoop();

            // 页面不可见时暂停渲染
            this._onVisibilityChange = () => {
                if (document.hidden) {
                    this.pauseRenderLoop();
                    console.log("[XBHH] V2 render paused (page hidden)");
                } else if (!this.config.minimized) {
                    this.throttleRenderLoop();
                    console.log("[XBHH] V2 render resumed (page visible)");
                }
            };
            document.addEventListener("visibilitychange", this._onVisibilityChange);

            setTimeout(() => {
                this.initSphere();
                this.initContextMenu();
                this.initInteractiveTips();
            }, 1000);
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
          border-radius: 6px;
          padding: 5px 0;
          z-index: 10001;
          color: white;
          font-family: "Microsoft YaHei", sans-serif;
          font-size: 13px;
          min-width: 120px;
          box-shadow: 0 4px 15px rgba(0,0,0,0.5);
          backdrop-filter: blur(5px);
      `;

      // 注入二级菜单样式（与V5统一）
      const styleId = "xbhh-live2d-v2-menu-style";
      if (!document.getElementById(styleId)) {
          const style = document.createElement("style");
          style.id = styleId;
          style.textContent = `
              .xbhh-v2-menu-item {
                  padding: 8px 15px;
                  cursor: pointer;
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  transition: background 0.2s;
                  position: relative;
              }
              .xbhh-v2-menu-item:hover {
                  background: #444;
              }
              .xbhh-v2-submenu {
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
              .xbhh-v2-menu-item:hover > .xbhh-v2-submenu,
              .xbhh-v2-menu-item.active > .xbhh-v2-submenu {
                  display: block;
              }
          `;
          document.head.appendChild(style);
      }

      const createItem = (text, action, hasSubmenu = false) => {
          const div = document.createElement("div");
          div.className = "xbhh-v2-menu-item";
          div.innerHTML = `<span>${text}</span>${hasSubmenu ? '<span style="font-size:10px;margin-left:10px;">▶</span>' : ''}`;
          if (!hasSubmenu && action) {
              div.onclick = (e) => {
                  e.stopPropagation();
                  if (action) action();
                  menu.remove();
              };
          }
          return div;
      };

      // 1. 模型切换 — 二级子菜单
      const modelItem = createItem("👤 模型切换", null, true);
      const modelSubmenu = document.createElement("div");
      modelSubmenu.className = "xbhh-v2-submenu";
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
                      window.dispatchEvent(new CustomEvent("xbhh-live2d-switch", {
                          detail: { version: "v2", modelPath: m.path }
                      }));
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
                      window.dispatchEvent(new CustomEvent("xbhh-live2d-switch", {
                          detail: { version: "v5", modelPath: m.path }
                      }));
                  }));
              });
          }
      });

      // 2. 渲染帧率 — 二级子菜单
      const fpsItem = createItem("🎬 渲染帧率", null, true);
      const fpsSubmenu = document.createElement("div");
      fpsSubmenu.className = "xbhh-v2-submenu";
      const currentFPS = this.config.targetFPS || 30;
      [10, 15, 24, 30, 60].forEach(fps => {
          const label = fps === currentFPS ? `✓ ${fps} FPS` : `  ${fps} FPS`;
          fpsSubmenu.appendChild(createItem(label, () => {
              this.config.targetFPS = fps;
              this.saveConfig();
              this.pauseRenderLoop();
              this._throttledDrawId = null;
              this.throttleRenderLoop();
          }));
      });
      fpsItem.appendChild(fpsSubmenu);
      menu.appendChild(fpsItem);

      // 3. 工具项 — 一级菜单直接操作
      menu.appendChild(createItem("🔧 清理本地缓存", () => {
          localStorage.removeItem("waifu-display");
          localStorage.removeItem("modelId");
          localStorage.removeItem("modelTexturesId");
          localStorage.removeItem("waifu-pos");
          localStorage.removeItem("Comfy.MenuPosition.Docked");
          location.reload();
      }));
      menu.appendChild(createItem("🎈 最小化小人", () => this.minimize()));
      menu.appendChild(createItem("🙈 隐藏小人", () => this.hide()));

      document.body.appendChild(menu);

      // 点击菜单外部关闭
      const closeMenu = (e) => {
          if (!menu.contains(e.target)) {
              menu.remove();
              document.removeEventListener("pointerdown", closeMenu, true);
          }
      };
      setTimeout(() => document.addEventListener("pointerdown", closeMenu, true), 10);
  }

  initSphere() {
      const waifu = document.getElementById("waifu");
      if (!waifu) return;

      this.sphere = document.createElement("div");
      this.sphere.id = "xbhh-live2d-v2-sphere";
      this.sphere.style.cssText = `
          display: none;
          position: absolute;
          bottom: 20px;
          left: 20px;
          width: 50px;
          height: 50px;
          border-radius: 50%;
          background: linear-gradient(135deg, #fa0 0%, #d48800 100%);
          box-shadow: 0 4px 15px rgba(0,0,0,0.4), inset 0 2px 5px rgba(255,255,255,0.2);
          border: 2px solid #fff;
          cursor: pointer;
          z-index: 10001;
          text-align: center;
          line-height: 46px;
          font-size: 24px;
          user-select: none;
      `;
      this.sphere.innerHTML = "🐱";
      waifu.parentNode.appendChild(this.sphere);

      // 实现拖拽功能
      let isDragging = false;
      let startX, startY;
      let initialLeft, initialTop;

      this.sphere.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          isDragging = true;
          startX = e.clientX;
          startY = e.clientY;
          initialLeft = this.sphere.offsetLeft;
          initialTop = this.sphere.offsetTop;
          this.sphere.style.transition = "none";
          e.stopPropagation();
      });

      window.addEventListener("mousemove", (e) => {
          if (!isDragging) return;
          const deltaX = e.clientX - startX;
          const deltaY = e.clientY - startY;

          let left = initialLeft + deltaX;
          let top = initialTop + deltaY;

          // 边界检查
          const rect = this.sphere.getBoundingClientRect();
          if (left < 0) left = 0;
          if (top < 0) top = 0;
          if (left > window.innerWidth - rect.width) left = window.innerWidth - rect.width;
          if (top > window.innerHeight - rect.height) top = window.innerHeight - rect.height;

          this.sphere.style.left = left + "px";
          this.sphere.style.top = top + "px";
      });

      window.addEventListener("mouseup", (e) => {
          if (isDragging) {
              isDragging = false;
              // 检查位移，如果位移很小则视为点击，触发恢复
              const deltaX = Math.abs(e.clientX - startX);
              const deltaY = Math.abs(e.clientY - startY);
              if (deltaX < 5 && deltaY < 5) {
                  this.restore();
              }
          }
      });
  }

  initInteractiveTips() {
      const waifu = document.getElementById("waifu");
      const canvas = document.getElementById("live2d");
      if (!waifu || !canvas) return;

      this._lastDragTipTime = 0;

      // 1. 双击对话
      // 将单次点击改为双击触发，避免误触
      canvas.addEventListener("dblclick", () => {
          if (this.config.minimized) return;
          window.dispatchEvent(new CustomEvent("live2d:click"));
      });

      // 2. 拖拽对话 (在 Live2DV2Pet 的拖拽逻辑中实现)
      // 实际上 V2 的拖拽是在 mousedown 事件里定义的。我们需要重构一下那部分的监听。
      // 但为了简单，我们可以直接在 window 的 mousemove 里检测是否正在拖拽 waifu。
      // 查阅下方的 mousedown 逻辑。
  }

  minimize() {
      const waifu = document.getElementById("waifu");
      const canvas = document.getElementById("waifu-canvas");
      const tools = document.getElementById("waifu-tool");
      const tips = document.getElementById("waifu-tips");
      if (waifu && this.sphere) {
          // 暂停渲染循环，释放 CPU
          this.pauseRenderLoop();
          console.log("[XBHH] V2 render paused (minimized)");

          waifu.style.pointerEvents = "none";
          if (canvas) canvas.style.display = "none";
          if (tools) tools.style.display = "none";
          if (tips) {
              tips.style.opacity = "0";
              tips.style.display = "none";
          }
          this.sphere.style.display = "block";
          this.config.minimized = true;
          this.saveConfig();
      }
  }

  restore() {
      const waifu = document.getElementById("waifu");
      const canvas = document.getElementById("waifu-canvas");
      const tools = document.getElementById("waifu-tool");
      const tips = document.getElementById("waifu-tips");
      if (waifu && this.sphere) {
          waifu.style.pointerEvents = "auto";
          if (canvas) canvas.style.display = "block";
          if (tools) tools.style.display = "flex";
          if (tips) tips.style.display = "block";
          this.sphere.style.display = "none";
          this.config.minimized = false;
          this.saveConfig();

          // 恢复渲染循环
          this.throttleRenderLoop();
          console.log("[XBHH] V2 render resumed (restored)");
      }
  }

  hide() {
      // 持久化隐藏状态（loader 重启时会清除此标记）
      localStorage.setItem("xbhh_live2d_hidden", "true");

      console.log("[XBHH] Live2D V2 hiding: destroying instance to release CPU...");

      // 停止节流渲染循环
      this.pauseRenderLoop();

      // 清理 visibilitychange 监听
      if (this._onVisibilityChange) {
          document.removeEventListener("visibilitychange", this._onVisibilityChange);
      }

      // 销毁 Cubism2/5 模型实例（停止 WebGL 渲染循环）
      if (window.xbhhModelInstance) {
          try {
              if (window.xbhhModelInstance.cubism2model) {
                  window.xbhhModelInstance.cubism2model.destroy();
              }
              if (window.xbhhModelInstance.cubism5model) {
                  window.xbhhModelInstance.cubism5model.release();
              }
          } catch (e) {
              console.warn("[XBHH] Error destroying model instance:", e);
          }
          window.xbhhModelInstance = null;
      }

      // 移除 DOM 元素
      const waifu = document.getElementById("waifu");
      if (waifu) waifu.remove();
      const toggle = document.getElementById("waifu-toggle");
      if (toggle) toggle.remove();
      if (this.sphere) { this.sphere.remove(); this.sphere = null; }

      // 清理样式
      const style = document.getElementById("waifu-css");
      if (style) style.remove();
      const fixStyle = document.getElementById("xbhh-v2-fix-style");
      if (fixStyle) fixStyle.remove();

      // 清理事件监听器
      if (this._onSwitchModel) {
          window.removeEventListener("xbhh-live2d-switch", this._onSwitchModel);
      }

      console.log("[XBHH] Live2D V2 instance destroyed. Will re-enable on next restart.");
  }


  /**
   * 劫持 Cubism2 的 requestAnimationFrame 渲染循环，限制到 15fps
   */
  throttleRenderLoop() {
      // 如果已有节流循环在运行，不要重复创建
      if (this._throttledDrawId) return;

      const checkAndThrottle = () => {
          if (window.xbhhModelInstance && window.xbhhModelInstance.cubism2model) {
              const cubism2 = window.xbhhModelInstance.cubism2model;
              // 停止原始 60fps 循环
              if (cubism2._drawFrameId) {
                  window.cancelAnimationFrame(cubism2._drawFrameId);
                  cubism2._drawFrameId = null;
              }
              cubism2.isDrawStart = false;

              // 用节流循环替代（从 config 读取帧率，默认 30fps）
              const targetFPS = this.config.targetFPS || 30;
              const frameInterval = 1000 / targetFPS;
              let lastFrameTime = 0;

              const throttledDraw = (timestamp) => {
                  this._throttledDrawId = window.requestAnimationFrame(throttledDraw);
                  const elapsed = timestamp - lastFrameTime;
                  if (elapsed >= frameInterval) {
                      lastFrameTime = timestamp - (elapsed % frameInterval);
                      try {
                          cubism2.draw();
                      } catch(e) {
                          // 忽略渲染错误
                      }
                  }
              };
              this._throttledDrawId = window.requestAnimationFrame(throttledDraw);
              console.log(`[XBHH] Cubism2 render loop throttled to ${targetFPS}fps`);
          } else {
              // 引擎尚未就绪，稍后重试
              setTimeout(checkAndThrottle, 500);
          }
      };
      // 给 initWidget 一些初始化时间
      setTimeout(checkAndThrottle, 2000);
  }

  /**
   * 暂停渲染循环
   */
  pauseRenderLoop() {
      if (this._throttledDrawId) {
          window.cancelAnimationFrame(this._throttledDrawId);
          this._throttledDrawId = null;
      }
      // 也确保原始循环被停止
      if (window.xbhhModelInstance && window.xbhhModelInstance.cubism2model) {
          const cubism2 = window.xbhhModelInstance.cubism2model;
          if (cubism2._drawFrameId) {
              window.cancelAnimationFrame(cubism2._drawFrameId);
              cubism2._drawFrameId = null;
          }
          cubism2.isDrawStart = false;
      }
  }

}
