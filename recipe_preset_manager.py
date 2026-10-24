"""XBHH 预设管理（配方）节点。

定位：把「LoRA 数据管理器」里维护好的配方（预设）"无线"发送到画布上的
Lora 堆 Plus 节点，全程不需要拉任何连线。

职责边界：
- 配方的新建 / 修改 / 删除全部在 LoRA 数据管理器里完成，本节点不参与；
- 本节点只负责"调用"配方：前端 DOM 面板（web/js/recipePresetManager.js）
  读取配方、选择目标 Lora 堆 Plus 并写入，无需连线；
- 额外提供两个 STRING 输出口：分别输出当前选中配方的「预设文本」与「提示词」，
  可选地手动连给其它节点（如 Lora 堆 Plus 的 lora_preset）作为备用方案。
"""


class XBHHRecipePresetManager:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 前端 DOM 面板会把「当前选中配方」的预设文本写进这个 widget
                # （面板中该 widget 被隐藏显示），执行时原样从输出口吐出，
                # 供需要走连线的场景连接到 Lora 堆 Plus 的 lora_preset。
                "preset_text": ("STRING", {"default": "", "multiline": False}),
                # 同上，但承载「当前选中配方」的提示词，供连线的场景使用。
                "prompt_text": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("preset_text", "prompt")
    FUNCTION = "emit_preset"
    CATEGORY = "XBHH"
    DESCRIPTION = (
        "预设管理（配方）：从 LoRA 管理器调用配方，无线发送到 Lora 堆 Plus 节点；"
        "同时输出所选配方的预设文本与提示词。"
    )

    def emit_preset(self, preset_text="", prompt_text="", **kwargs):
        # **kwargs 容忍前端面板可能序列化出来的额外字段
        return (
            preset_text if isinstance(preset_text, str) else "",
            prompt_text if isinstance(prompt_text, str) else "",
        )


NODE_CLASS_MAPPINGS = {
    "XBHHRecipePresetManager": XBHHRecipePresetManager,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHRecipePresetManager": "XBHH 预设管理（配方）",
}
