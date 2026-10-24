XBHH 测试 / AI 自动绘画 工作流目录
======================================

把 ComfyUI 工作流 JSON 文件放到本目录，即可在 Live2D 小人的右键菜单
「🎨 测试运行工作流 → 已保存工作流」中看到并一键运行。

后续 AI 自动绘画也会复用这套机制（AI 构造工作流 → 提交）。

────────────────────────────────────────
所需格式：API 格式 (prompt 格式)
────────────────────────────────────────

必须是 ComfyUI 的「API 格式」(即 POST /prompt 接受的格式)，
形如：

    {
      "3": {
        "class_type": "KSampler",
        "inputs": {
          "seed": 0,
          "cfg": 7.0,
          ...
        }
      },
      ...
    }

⚠️ 不要使用「Save」保存的 UI 格式 (含 nodes / links 数组的那个)，
   那种格式 /prompt 不接受。

如何导出 API 格式：
  ComfyUI 画布右上角「保存」按钮旁 → 选「Save (API Format)」
  或菜单：Workflow → Export → Save (API Format)
  得到的 .json 直接放进本目录即可。

────────────────────────────────────────
运行机制
────────────────────────────────────────
- 前端从 GET /xbhh/pet/workflows/{name} 读取 JSON
- 然后走 ComfyUI 原生 POST /prompt 提交队列
- 执行进度通过 ComfyUI 前端 api 的 websocket 事件回传到小人气泡
  (🖌️开始 → 🎨正在绘画 → ✅完成 / ❌失败)

注意：工作流里引用的 checkpoint / lora / 模型必须在本机已安装，
否则 ComfyUI 校验会失败并在气泡里提示错误。
