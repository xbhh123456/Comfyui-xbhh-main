import os
import random
import folder_paths

# 获取当前文件所在目录
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
XBHH_PLUGIN_FOLDER = os.path.join(CURRENT_DIR, "xbhh")

def get_user_txt_folder():
    """获取并确保创建 user/xbhh/txt/ 存放自定义 txt 文件的文件夹"""
    try:
        if hasattr(folder_paths, "get_user_directory"):
            base_dir = folder_paths.get_user_directory()
        else:
            base_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "user")
    except Exception:
        base_dir = os.path.dirname(os.path.abspath(__file__))
    
    user_txt_dir = os.path.join(base_dir, "xbhh", "txt")
    os.makedirs(user_txt_dir, exist_ok=True)
    return user_txt_dir

def get_txt_files_dict():
    """获取所有可用的 txt 文件路径映射 {文件名: 完整路径}，优先使用 user 目录"""
    files_map = {}
    
    # 1. 扫描插件自带目录
    if os.path.exists(XBHH_PLUGIN_FOLDER):
        for f in os.listdir(XBHH_PLUGIN_FOLDER):
            if f.endswith('.txt'):
                files_map[f] = os.path.join(XBHH_PLUGIN_FOLDER, f)
                
    # 2. 扫描 ComfyUI user 目录（优先于插件自带目录）
    user_txt_dir = get_user_txt_folder()
    if os.path.exists(user_txt_dir):
        for f in os.listdir(user_txt_dir):
            if f.endswith('.txt'):
                files_map[f] = os.path.join(user_txt_dir, f)
                
    return files_map

def get_txt_files():
    """获取可用 txt 文件名称列表"""
    files_map = get_txt_files_dict()
    txt_files = list(files_map.keys())
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
        
        files_map = get_txt_files_dict()
        file_path = files_map.get(txt_file)
        
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
    "XBHHTxtSelector": XBHHTxtSelector
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHTxtSelector": "xbhh txt选择器"
}
