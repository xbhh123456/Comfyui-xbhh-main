import json
import os
from pathlib import Path

# ====== 重点：动态获取可用键（在节点加载时读取文件） ======
try:
    # 尝试读取默认的preset.json（在ComfyUI工作目录）
    default_preset = "preset.json"
    if os.path.exists(default_preset):
        with open(default_preset, 'r', encoding='utf-8') as f:
            data = json.load(f)
            available_keys = list(data.keys())
    else:
        available_keys = []
except:
    available_keys = []

class PresetSelector:
    CATEGORY = "XBHH"
    RETURN_TYPES = ("STRING", "STRING")  # 两个输出：1. 选择的值 2. 实时显示的值
    FUNCTION = "select_preset"
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset_file": ("STRING", {
                    "default": "preset.json",
                    "tooltip": "JSON文件路径（默认在ComfyUI工作目录）"
                }),
                "keys": ("STRING", {
                    "default": "prompt",
                    "options": available_keys,  # 关键！动态生成下拉选项
                    "tooltip": f"可选键: {', '.join(available_keys) or '（无可用键）'}"
                })
            }
        }

    def select_preset(self, preset_file, keys):
        # 1. 确认文件路径
        full_path = os.path.join(os.getcwd(), preset_file)
        if not os.path.exists(full_path):
            return ("⚠️ 文件不存在", "❌ 文件不存在")
        
        # 2. 读取JSON
        try:
            with open(full_path, 'r', encoding='utf-8') as f:
                preset_data = json.load(f)
        except Exception as e:
            return (f"❌ 读取失败: {str(e)}", f"❌ 读取失败: {str(e)}")
        
        # 3. 处理选择的键
        if keys in preset_data:
            value = str(preset_data[keys])
            return (f"{keys}: {value}", f"当前值: {value}")
        else:
            return ("⚠️ 键不存在", f"⚠️ 键 '{keys}' 不存在")

# ====== 注册节点（和你之前的PromptRandomizer完全一致） ======
NODE_CLASS_MAPPINGS = {
    "PresetSelector": PresetSelector
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PresetSelector": "xbhh JSON预设选择器"
}