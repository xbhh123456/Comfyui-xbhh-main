import torch

# 预设分辨率列表
RESOLUTION_PRESETS = {
    "512x512 (1:1)": (512, 512),
    "768x768 (1:1)": (768, 768),
    "1024x1024 (1:1)": (1024, 1024),
    "512x768 (2:3)": (512, 768),
    "768x512 (3:2)": (768, 512),
    "512x896 (9:16)": (512, 896),
    "896x512 (16:9)": (896, 512),
    "768x1024 (3:4)": (768, 1024),
    "1024x768 (4:3)": (1024, 768),
    "832x1216 (SD1.5)": (832, 1216),
    "1216x832 (SD1.5)": (1216, 832),
    "896x1152 (SDXL)": (896, 1152),
    "1152x896 (SDXL)": (1152, 896),
    "768x1344 (2:3)": (768, 1344),
    "1344x768 (3:2)": (1344, 768),
    "自定义": (0, 0),  # 特殊标记，使用自定义宽高
}

class XBHHEmptyLatent:
    """
    XBHH 空 Latent 节点
    支持预设分辨率选择和自定义分辨率
    """
    
    def __init__(self):
        pass
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "resolution": (list(RESOLUTION_PRESETS.keys()), {"default": "1024x1024 (1:1)"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64, "step": 1}),
            },
            "optional": {
                "custom_width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "custom_height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }
    
    RETURN_TYPES = ("LATENT", "INT", "INT")
    RETURN_NAMES = ("latent", "width", "height")
    FUNCTION = "generate"
    CATEGORY = "XBHH"
    
    def generate(self, resolution, batch_size, custom_width=1024, custom_height=1024, unique_id=None):
        # 获取分辨率
        if resolution == "自定义":
            width = custom_width
            height = custom_height
        else:
            width, height = RESOLUTION_PRESETS.get(resolution, (1024, 1024))
        
        # 确保是8的倍数
        width = (width // 8) * 8
        height = (height // 8) * 8
        
        # 生成空 latent
        latent = torch.zeros([batch_size, 4, height // 8, width // 8])
        
        return ({"samples": latent}, width, height)

# 注册节点
NODE_CLASS_MAPPINGS = {
    "XBHHEmptyLatent": XBHHEmptyLatent
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHEmptyLatent": "xbhh 空Latent 📐"
}
