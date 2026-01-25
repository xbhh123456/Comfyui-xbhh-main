import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/**
 * XBHH Live2D Loader
 * 跨版本引导加载器：负责读取配置并隔离加载 SDK 2.0 / SDK 4.0 环境
 */

async function loadLive2DConfig() {
    try {
        // 直接尝试从根目录通过 api 读取配置文件
        // 在 ComfyUI 扩展开发中，通常静态文件映射在 /extensions/xbhh-lora/
        // 但为了方便用户操作开关，我们假定配置在后端映射可见路径
        const response = await fetch("/extensions/xbhh-lora/js/pet/config_live2d.json?v=" + Date.now());
        if (!response.ok) {
            console.error("[XBHH] Config not found at /extensions/xbhh-lora/js/pet/config_live2d.json");
            return { enabled: true, version: "v4" };
        }
        return await response.json();
    } catch (e) {
        console.warn("[XBHH] Failed to load config_live2d.json, defaulting to v4", e);
        return { enabled: true, version: "v4" };
    }
}

app.registerExtension({
    name: "xbhh.live2d_loader",
    async setup() {
        const config = await loadLive2DConfig();
        // 优先从 localStorage 读取版本，支持运行时切换
        const savedVersion = localStorage.getItem("xbhh_live2d_version");
        if (savedVersion) config.version = savedVersion;
        
        if (config.enabled === false) {
            console.log("[XBHH] Live2D is disabled via config.");
            // 确保清理旧容器
            document.getElementById("xbhh-live2d-container")?.remove();
            document.getElementById("xbhh-live2d-v2-container")?.remove();
            return;
        }

        console.log(`[XBHH] Initializing Live2D Loader (Version: ${config.version})`);
        const verSuffix = "?v=" + Date.now();

        // 根据配置动态实例化，确保单一实例
        try {
            if (config.version === "v2") {
                const { Live2DV2Pet } = await import("./live2d_v2_pet.js" + verSuffix);
                if (!document.getElementById("xbhh-live2d-v2-container")) {
                    window.xbhhLive2DPet = new Live2DV2Pet();
                }
            } else {
                const { Live2DPet } = await import("./live2d_pet.js" + verSuffix);
                if (!document.getElementById("xbhh-live2d-container")) {
                    window.xbhhLive2DPet = new Live2DPet();
                }
            }
        } catch (e) {
            console.error("[XBHH] Failed to initialize pet instance", e);
        }
    }
});
