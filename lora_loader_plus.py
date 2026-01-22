import os
import glob
import folder_paths
from nodes import LoraLoader
from server import PromptServer
from aiohttp import web


# ============================================================================
# 灵活输入类型 - 支持动态LoRA输入 (参考rgthree)
# ============================================================================
class AnyType(str):
    """特殊类型，在比较时始终相等"""
    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    """允许任意额外输入的类型"""
    def __init__(self, type, data=None):
        self.type = type
        self.data = data
        if data:
            for k, v in data.items():
                self[k] = v
    
    def __getitem__(self, key):
        if self.data and key in self.data:
            return self.data[key]
        return (self.type,)
    
    def __contains__(self, key):
        return True


any_type = AnyType("*")


# ============================================================================
# 辅助函数
# ============================================================================
def get_lora_by_filename(filename):
    """通过文件名获取LoRA"""
    lora_paths = folder_paths.get_filename_list("loras")
    
    if filename in lora_paths:
        return filename
    
    # 不带扩展名匹配
    lora_paths_no_ext = [os.path.splitext(x)[0] for x in lora_paths]
    file_no_ext = os.path.splitext(filename)[0]
    
    if file_no_ext in lora_paths_no_ext:
        return lora_paths[lora_paths_no_ext.index(file_no_ext)]
    
    # 模糊匹配
    for i, lora_path in enumerate(lora_paths):
        if filename in lora_path:
            return lora_paths[i]
    
    return None


# ============================================================================
# 多LoRA 加载器 Plus 节点
# ============================================================================
class XBHHMultiLoraLoaderPlus:
    """
    XBHH 多LoRA加载器 Plus 版本
    
    功能:
    - 点击 Add Lora 添加多个LoRA
    - 文件夹树形显示
    - 悬浮显示LoRA预览图
    - 导出/导入 LoRA 预设文本
    """
    
    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "preset_text", "triggers")
    FUNCTION = "load_loras"
    CATEGORY = "XBHH/loaders"
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": FlexibleOptionalInputType(type=any_type, data={
                "model": ("MODEL",),
                "clip": ("CLIP",),
            }),
            "hidden": {},
        }
    
    def load_loras(self, model=None, clip=None, **kwargs):
        """循环加载所有启用的LoRA"""
        
        # 收集预设文本用于导出
        preset_lines = []
        # 收集触发词
        trigger_words = []
        
        for key, value in kwargs.items():
            key_upper = key.upper()
            
            # 检查是否是LoRA输入
            if key_upper.startswith('LORA_') and isinstance(value, dict):
                if 'on' not in value or 'lora' not in value or 'strength' not in value:
                    continue
                
                lora_name = value.get('lora')
                if not lora_name or lora_name == 'None':
                    continue
                
                is_on = value.get('on', False)
                strength_model = value.get('strength', 1.0)
                strength_clip = value.get('strengthTwo', strength_model)
                trigger = value.get('trigger', '')
                trigger_weight = value.get('triggerWeight', 1.0)
                
                # 生成预设行 (格式: enabled|lora_name|strength_model|strength_clip|trigger|trigger_weight)
                enabled_str = "1" if is_on else "0"
                preset_lines.append(f"{enabled_str}|{lora_name}|{strength_model}|{strength_clip if strength_clip else strength_model}|{trigger}|{trigger_weight}")
                
                # 收集启用的触发词
                if is_on and trigger:
                    formatted_trigger = f"({trigger}:{trigger_weight:.2f})"
                    trigger_words.append(formatted_trigger)
                
                if not is_on:
                    continue
                
                if clip is None:
                    strength_clip = 0
                
                if strength_model == 0 and strength_clip == 0:
                    continue
                
                lora_file = get_lora_by_filename(lora_name)
                if lora_file is None:
                    print(f"[XBHH] Warning: LoRA not found: {lora_name}")
                    continue
                
                if model is not None:
                    try:
                        model, clip = LoraLoader().load_lora(
                            model, clip, lora_file, strength_model, strength_clip
                        )
                    except Exception as e:
                        print(f"[XBHH] Error loading LoRA {lora_name}: {e}")
        
        # 生成预设文本
        preset_text = "\n".join(preset_lines)
        # 生成触发词文本
        triggers_text = ", ".join(trigger_words)
        
        return (model, clip, preset_text, triggers_text)


# 注册节点
NODE_CLASS_MAPPINGS = {
    "XBHHMultiLoraLoaderPlus": XBHHMultiLoraLoaderPlus
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHMultiLoraLoaderPlus": "XBHH Multi Lora Loader Plus 🎨⭐"
}
