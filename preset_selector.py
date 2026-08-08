import json
import os
import folder_paths

def resolve_preset_file(preset_file="preset.json"):
    """依次在 user/xbhh 目录、ComfyUI 工作目录查找预设文件"""
    if not preset_file:
        preset_file = "preset.json"
        
    if os.path.isabs(preset_file) and os.path.exists(preset_file):
        return preset_file
        
    # 1. 优先检查 ComfyUI user 目录: ComfyUI/user/xbhh/<preset_file>
    try:
        if hasattr(folder_paths, "get_user_directory"):
            user_dir = folder_paths.get_user_directory()
        else:
            user_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "user")
        user_preset = os.path.join(user_dir, "xbhh", preset_file)
        if os.path.exists(user_preset):
            return user_preset
    except Exception:
        pass
        
    # 2. 检查工作目录 cwd
    cwd_preset = os.path.join(os.getcwd(), preset_file)
    if os.path.exists(cwd_preset):
        return cwd_preset
        
    # 3. 检查插件自身目录
    plugin_preset = os.path.join(os.path.dirname(os.path.abspath(__file__)), preset_file)
    if os.path.exists(plugin_preset):
        return plugin_preset
        
    return cwd_preset

# ====== 重点：动态获取可用键（在节点加载时读取文件） ======
available_keys = []
try:
    target_preset_path = resolve_preset_file("preset.json")
    if os.path.exists(target_preset_path):
        with open(target_preset_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            available_keys = list(data.keys())
except Exception:
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
                    "tooltip": "JSON文件路径（优先从 ComfyUI user/xbhh/ 目录读取）"
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
        full_path = resolve_preset_file(preset_file)
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