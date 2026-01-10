import os
import glob
import folder_paths
from nodes import LoraLoader
from server import PromptServer
from aiohttp import web


# ============================================================================
# API 路由
# ============================================================================
@PromptServer.instance.routes.get("/xbhh/images/loras")
async def get_lora_images(request):
    """获取所有LoRA对应的预览图列表"""
    names = folder_paths.get_filename_list("loras")
    
    images = {}
    for item_name in names:
        file_path = folder_paths.get_full_path("loras", item_name)
        
        if file_path is None:
            continue
        
        file_path_no_ext = os.path.splitext(file_path)[0]
        file_name = os.path.splitext(item_name)[0]
        
        # 查找对应的预览图
        for ext in ["png", "jpg", "jpeg", "preview.png", "preview.jpeg"]:
            image_path = file_path_no_ext + "." + ext
            if os.path.isfile(image_path):
                images[item_name] = f"loras/{file_name}.{ext}"
                break
    
    return web.json_response(images)


@PromptServer.instance.routes.get("/xbhh/view/{name:.*}")
async def view_lora_image(request):
    """查看LoRA预览图"""
    name = request.match_info["name"]
    
    if "/" in name:
        pos = name.index("/")
        type_name = name[0:pos]
        file_name = name[pos+1:]
    else:
        return web.Response(status=400)
    
    image_path = folder_paths.get_full_path(type_name, file_name)
    if not image_path or not os.path.isfile(image_path):
        return web.Response(status=404)
    
    filename = os.path.basename(image_path)
    return web.FileResponse(image_path, headers={
        "Content-Disposition": f'filename="{filename}"'
    })


@PromptServer.instance.routes.get("/xbhh/loras")
async def get_loras(request):
    """获取LoRA列表"""
    loras = folder_paths.get_filename_list("loras")
    return web.json_response(loras)


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
# 多LoRA 加载器节点
# ============================================================================
class XBHHMultiLoraLoader:
    """
    XBHH 多LoRA加载器节点
    
    功能:
    - 点击 Add Lora 添加多个LoRA
    - 文件夹树形显示
    - 悬浮显示LoRA预览图
    """
    
    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
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
        
        for key, value in kwargs.items():
            key_upper = key.upper()
            
            # 检查是否是LoRA输入
            if key_upper.startswith('LORA_') and isinstance(value, dict):
                if 'on' not in value or 'lora' not in value or 'strength' not in value:
                    continue
                
                if not value.get('on', False):
                    continue
                
                lora_name = value.get('lora')
                if not lora_name or lora_name == 'None':
                    continue
                
                strength_model = value.get('strength', 1.0)
                strength_clip = value.get('strengthTwo', strength_model)
                
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
        
        return (model, clip)
