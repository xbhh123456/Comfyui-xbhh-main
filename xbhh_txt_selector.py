import os
import random

# 获取当前文件所在目录
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
XBHH_FOLDER = os.path.join(CURRENT_DIR, "xbhh")

def get_txt_files():
    """获取xbhh文件夹下的所有txt文件"""
    if not os.path.exists(XBHH_FOLDER):
        os.makedirs(XBHH_FOLDER)
    
    txt_files = [f for f in os.listdir(XBHH_FOLDER) if f.endswith('.txt')]
    
    if not txt_files:
        return ["无txt文件"]
    
    return txt_files

class XBHHTxtSelector:
    def __init__(self):
        pass
    
    @classmethod
    def INPUT_TYPES(cls):
        txt_files = get_txt_files()
        return {
            "required": {
                "txt_file": (txt_files, {"default": txt_files[0] if txt_files else "无txt文件"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "step": 1}),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    FUNCTION = "extract_prompt"
    CATEGORY = "XBHH"
    
    @classmethod
    def IS_CHANGED(cls, txt_file, seed):
        # 确保每次seed改变时重新执行
        return seed
    
    def extract_prompt(self, txt_file, seed):
        if txt_file == "无txt文件":
            return ("",)
        
        file_path = os.path.join(XBHH_FOLDER, txt_file)
        
        if not os.path.exists(file_path):
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
    "XBHHTxtSelector": XBHHTxtSelector
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHTxtSelector": "xbhh txt选择器"
}
