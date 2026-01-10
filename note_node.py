class XBHHNoteNode:
    """
    一个用于存储和搜索注释的节点。
    无输入输出，仅作为笔记存储使用。
    """
    
    def __init__(self):
        pass
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "search": ("STRING", {"default": "", "multiline": False}),
                "note": ("STRING", {"default": "", "multiline": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }
    
    RETURN_TYPES = ()
    FUNCTION = "execute"
    CATEGORY = "XBHH"
    OUTPUT_NODE = True
    
    def execute(self, search, note, unique_id=None):
        # 节点不做任何处理，仅用于显示
        return {}

# 注册节点
NODE_CLASS_MAPPINGS = {
    "XBHHNoteNode": XBHHNoteNode
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHNoteNode": "xbhh 注释节点 📝"
}
