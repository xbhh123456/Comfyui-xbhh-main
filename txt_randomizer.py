import os
import random

class PromptRandomizer:
    def __init__(self):
        pass
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file_path": ("STRING", {"default": ""}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "step": 1}),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    FUNCTION = "extract_prompt"
    CATEGORY = "XBHH"
    
    def extract_prompt(self, file_path, seed):
        # 确保每次生成都重新读取文件（关键！）
        if not file_path or not os.path.exists(file_path):
            return ("",)
        
        try:
            with open(file_path, 'r', encoding='utf-8') as file:
                lines = [line.strip() for line in file if line.strip()]
            
            if not lines:
                return ("",)
            
            selected_line = random.choice(lines)
            return (selected_line,)
        except Exception as e:
            print(f"Error: {str(e)}")
            return ("",)

# 注册节点
NODE_CLASS_MAPPINGS = {
    "PromptRandomizer": PromptRandomizer
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptRandomizer": "xbhh txt随机抽取"
}