class XBHHLayeredNote:
    """
    分层注释节点 - 可以添加多个可折叠的注释块。
    每个块包含标题和内容，支持展开/折叠。
    """
    
    def __init__(self):
        pass
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }
    
    RETURN_TYPES = ()
    FUNCTION = "execute"
    CATEGORY = "XBHH"
    OUTPUT_NODE = True
    
    def execute(self, unique_id=None):
        # 节点不做任何处理，仅用于显示
        return {}

# 注册节点
NODE_CLASS_MAPPINGS = {
    "XBHHLayeredNote": XBHHLayeredNote
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHLayeredNote": "xbhh 分层注释 📑"
}
