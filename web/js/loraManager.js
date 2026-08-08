import { app } from "../../../scripts/app.js";

// ============================================================================
// 侧边栏按钮 — 点击打开 LoRA 数据管理器新标签页
// ============================================================================
app.registerExtension({
    name: "xbhh.LoraManager",

    async init() {
        // 注册侧边栏标签页
        if (app.extensionManager?.registerSidebarTab) {
            app.extensionManager.registerSidebarTab({
                id: "xbhh-lora-manager",
                icon: "pi pi-database",
                title: "LoRA 数据",
                tooltip: "打开 LoRA 数据管理器",
                type: "custom",
                render: (el) => {
                    el.innerHTML = "";
                    const container = document.createElement("div");
                    container.style.cssText = "padding:20px; display:flex; flex-direction:column; align-items:center; gap:16px; height:100%;";

                    // 图标
                    const icon = document.createElement("div");
                    icon.style.cssText = "font-size:48px; margin-top:40px;";
                    icon.textContent = "📊";
                    container.appendChild(icon);

                    // 标题
                    const title = document.createElement("h3");
                    title.style.cssText = "color:#ddd; margin:0; font-size:16px;";
                    title.textContent = "LoRA 数据管理器";
                    container.appendChild(title);

                    // 描述
                    const desc = document.createElement("p");
                    desc.style.cssText = "color:#888; font-size:12px; text-align:center; line-height:1.6; margin:0;";
                    desc.textContent = "浏览 LoRA 文件、查看训练参数、标签频率等元数据信息";
                    container.appendChild(desc);

                    // 打开按钮
                    const btn = document.createElement("button");
                    btn.style.cssText = `
                        padding: 10px 24px;
                        background: linear-gradient(135deg, #2d5a3d, #1a8a4a);
                        border: none;
                        border-radius: 8px;
                        color: #fff;
                        font-size: 14px;
                        font-weight: bold;
                        cursor: pointer;
                        transition: all 0.2s;
                        box-shadow: 0 2px 8px rgba(26, 138, 74, 0.3);
                    `;
                    btn.textContent = "🚀 打开管理器";
                    btn.onmouseenter = () => {
                        btn.style.transform = "scale(1.05)";
                        btn.style.boxShadow = "0 4px 16px rgba(26, 138, 74, 0.5)";
                    };
                    btn.onmouseleave = () => {
                        btn.style.transform = "scale(1)";
                        btn.style.boxShadow = "0 2px 8px rgba(26, 138, 74, 0.3)";
                    };
                    btn.onclick = () => {
                        const baseUrl = window.location.origin;
                        window.open(`${baseUrl}/xbhh/lora-manager`, "_blank");
                    };
                    container.appendChild(btn);

                    el.appendChild(container);
                }
            });
        }

        // 注册 ComfyUI 官方设置选项
        if (app.ui?.settings) {
            app.ui.settings.addSetting({
                id: "XBHH.CivitaiAPIKey",
                name: "XBHH LoRA: Civitai API Key",
                type: "text",
                defaultValue: "",
                tooltip: "用于在 Civitai 拉取受限/R18/高频限制模型的推荐触发词 (Personal Access Token)",
                async onChange(newVal) {
                    if (newVal !== undefined) {
                        const val = String(newVal).trim();
                        localStorage.setItem("xbhh_civitai_api_key", val);
                        document.cookie = `xbhh_civitai_api_key=${encodeURIComponent(val)}; path=/; max-age=31536000`;
                        try {
                            await fetch("/xbhh/lora/settings", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ civitai_api_key: val })
                            });
                        } catch (e) {
                            console.error("[XBHH] Error saving Civitai API key:", e);
                        }
                    }
                }
            });
        }
    }
});
