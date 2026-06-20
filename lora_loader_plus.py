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
                "lora_preset": ("STRING", {"forceInput": True}),
            }),
            "hidden": {},
        }
    
    def load_loras(self, model=None, clip=None, lora_preset=None, **kwargs):
        """循环加载所有启用的LoRA"""
        
        # 收集预设文本用于导出
        preset_lines = []
        # 收集触发词
        trigger_words = []
        
        # 0. 预先收集现有的手动配置 LoRA
        existing_lora_names = set()
        for key, value in kwargs.items():
            if key.upper().startswith('LORA_') and isinstance(value, dict):
                lora_name = value.get('lora')
                if lora_name and lora_name != 'None':
                    existing_lora_names.add(lora_name)

        # 1. 先处理来自外部输入的 lora_preset
        if lora_preset and isinstance(lora_preset, str):
            lines = lora_preset.strip().split('\n')
            for line in lines:
                parts = line.split('|')
                if len(parts) >= 2:
                    is_on = parts[0] == "1"
                    lora_name = parts[1]
                    
                    if lora_name in existing_lora_names:
                        # 已经存在的手动输入优先，合并启用状态
                        for k, v in kwargs.items():
                            if k.upper().startswith('LORA_') and isinstance(v, dict) and v.get('lora') == lora_name:
                                v['on'] = is_on
                                break
                    else:
                        strength_model = float(parts[2]) if len(parts) > 2 else 1.0
                        strength_clip = float(parts[3]) if len(parts) > 3 else strength_model
                        trigger = parts[4] if len(parts) > 4 else ""
                        trigger_weight = float(parts[5]) if len(parts) > 5 else 1.0
                        
                        # 不存在则作为预设项追加
                        tag = f"PRESET_{lora_name}"
                        kwargs[tag] = {
                            "on": is_on,
                            "lora": lora_name,
                            "strength": strength_model,
                            "strengthTwo": strength_clip,
                            "trigger": trigger,
                            "triggerWeight": trigger_weight
                        }

        # 2. 处理所有输入（包括预设和手动挂件）
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
                
                if not is_on:
                    continue
                
                # 生成预设行 (格式: enabled|lora_name|strength_model|strength_clip|trigger|trigger_weight)
                enabled_str = "1"
                preset_lines.append(f"{enabled_str}|{lora_name}|{strength_model}|{strength_clip if strength_clip else strength_model}|{trigger}|{trigger_weight}")
                
                # 收集启用的触发词
                if is_on and trigger:
                    formatted_trigger = f"({trigger}:{trigger_weight:.2f})"
                    trigger_words.append(formatted_trigger)
                
                if clip is None:
                    strength_clip = 0
                
                if strength_model == 0 and strength_clip == 0:
                    continue
                
                lora_file = get_lora_by_filename(lora_name)
                if lora_file is None:
                    print(f"[XBHH] Warning: LoRA not found: {lora_name}")
                    continue
                
                # Increment LFU use statistics in SQLite
                try:
                    import threading
                    from . import lora_database
                    threading.Thread(target=lambda: lora_database.increment_lora_use(lora_file), daemon=True).start()
                except Exception:
                    pass
                
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
