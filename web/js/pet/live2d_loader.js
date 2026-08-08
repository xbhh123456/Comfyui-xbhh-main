import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/**
 * XBHH Live2D Loader
 * 跨版本引导加载器：负责读取配置并隔离加载 SDK 2.0 / SDK 4.0 环境
 */

const SETTING_ID = "XBHH.Live2D.Enable";

async function loadLive2DConfig() {
    // 动态获取插件名
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split('/');
    const extensionsIdx = pathSegments.indexOf('extensions');
    const extName = extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : 'xbhh-lora';

    try {
        const response = await fetch(`/extensions/${extName}/js/pet/config_live2d.json?v=${Date.now()}`);
        if (!response.ok) {
            console.warn(`[XBHH] Config not found at /extensions/${extName}/js/pet/config_live2d.json, using defaults.`);
            return { enabled: true, version: "v4" };
        }
        return await response.json();
    } catch (e) {
        console.warn("[XBHH] Failed to load config_live2d.json, defaulting to v4", e);
        return { enabled: true, version: "v4" };
    }
}

let isInitializing = false;

function cleanContainers() {
    if (window.xbhhLive2DPet) {
        try {
            window.xbhhLive2DPet.destroy?.();
            window.xbhhLive2DPet.hide?.();
        } catch (e) {}
        window.xbhhLive2DPet = null;
    }
    document.querySelectorAll("#xbhh-live2d-container, #xbhh-live2d-v2-container, #waifu, #waifu-toggle").forEach(el => el.remove());
}

async function checkAvailableModels() {
    try {
        const resp = await fetch(`/xbhh/live2d_models?v=${Date.now()}`);
        if (!resp.ok) return { v2: [], v5: [] };
        const data = await resp.json();
        return {
            v2: Array.isArray(data?.v2) ? data.v2 : [],
            v5: Array.isArray(data?.v5) ? data.v5 : []
        };
    } catch (e) {
        console.warn("[XBHH] Failed to fetch Live2D models:", e);
        return { v2: [], v5: [] };
    }
}

async function startLive2DPet() {
    if (isInitializing) {
        console.warn("[XBHH] Live2D initialization in progress, skipping redundant trigger.");
        return;
    }
    isInitializing = true;

    try {
        // 启动前强制清理旧容器和实例，保证单例
        cleanContainers();

        const config = await loadLive2DConfig();
        // 优先从 localStorage 读取版本，支持运行时切换
        const savedVersion = localStorage.getItem("xbhh_live2d_version");
        if (savedVersion) config.version = savedVersion;
        
        if (config.enabled === false) {
            console.log("[XBHH] Live2D is disabled via config_live2d.json.");
            return;
        }

        // 检查是否被 ComfyUI 官方设置禁用
        const settingEnabled = app.ui.settings.getSettingValue(SETTING_ID, true);
        if (settingEnabled === false) {
            console.log("[XBHH] Live2D is disabled via ComfyUI Settings.");
            return;
        }

        // 检查服务器上是否有可用的 Live2D 模型
        const modelsData = await checkAvailableModels();
        const hasV2 = modelsData.v2.length > 0;
        const hasV5 = modelsData.v5.length > 0;

        if (!hasV2 && !hasV5) {
            console.log("[XBHH] 没有检测到可用的 Live2D 模型，自动关闭并清理看板娘外框。");
            return;
        }

        // 如果当前配置的版本无模型，但另一个版本有模型，自动切到有模型的版本
        if (config.version === "v2" && !hasV2 && hasV5) {
            console.log("[XBHH] V2 无可用模型，自动智能切换到 V5/V4 版本");
            config.version = "v4";
        } else if ((config.version === "v4" || config.version === "v5") && !hasV5 && hasV2) {
            console.log("[XBHH] V4/V5 无可用模型，自动智能切换到 V2 版本");
            config.version = "v2";
        }

        // 检查是否被用户隐藏（隐藏=关闭，重启时清除隐藏标记，正常启动）
        const wasHidden = localStorage.getItem("xbhh_live2d_hidden");
        if (wasHidden === "true") {
            localStorage.removeItem("xbhh_live2d_hidden");
            console.log("[XBHH] Live2D was hidden last session, re-enabling on restart.");
        }

        console.log(`[XBHH] Initializing Live2D Loader (Version: ${config.version})`);
        const verSuffix = "?v=" + Date.now();

        // 根据配置动态实例化，确保单一实例
        if (config.version === "v2") {
            const { Live2DV2Pet } = await import("./live2d_v2_pet.js" + verSuffix);
            window.xbhhLive2DPet = new Live2DV2Pet();
        } else {
            const { Live2DPet } = await import("./live2d_pet.js" + verSuffix);
            window.xbhhLive2DPet = new Live2DPet();
        }
    } catch (e) {
        console.error("[XBHH] Failed to initialize pet instance", e);
        cleanContainers();
    } finally {
        isInitializing = false;
    }
}

app.registerExtension({
    name: "xbhh.live2d_loader",
    async init() {
        // 在 ComfyUI 官方设置菜单中注册 Live2D 开关
        app.ui.settings.addSetting({
            id: SETTING_ID,
            name: "XBHH Live2D 看板娘开关",
            type: "boolean",
            defaultValue: true,
            tooltip: "开启/关闭 Live2D 桌面看板娘。关闭时卸载模型并释放 CPU/GPU 资源。",
            onChange(value) {
                if (value === false) {
                    cleanContainers();
                } else if (value === true) {
                    startLive2DPet();
                }
            }
        });
    },
    async setup() {
        await startLive2DPet();
    }
});
