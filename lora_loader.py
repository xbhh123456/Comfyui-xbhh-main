import os
import glob
import hashlib
import asyncio
import threading
import folder_paths
from nodes import LoraLoader
from server import PromptServer
from aiohttp import web

def _get_thumb_cache_dir():
    """缩略图磁盘缓存目录。

    放在 ComfyUI 的 user/xbhh 持久化目录下（与 settings.json、数据库同处），
    而不是 temp：ComfyUI 启动时会清理 temp 里超过约一天的文件，导致缩略图
    被反复删除，每次冷启动首屏都要把所有预览图重新用 PIL 生成一遍——这正是
    刷新/滚动时图片加载慢的原因之一。
    """
    try:
        from . import lora_database
        base_dir = lora_database.get_xbhh_user_dir()
    except Exception:
        base_dir = folder_paths.get_temp_directory()
    cache_dir = os.path.join(base_dir, "thumbs")
    os.makedirs(cache_dir, exist_ok=True)
    return cache_dir


THUMB_CACHE_DIR = _get_thumb_cache_dir()


# ============================================================================
# API 路由
# ============================================================================
@PromptServer.instance.routes.get("/xbhh/images/loras")
async def get_lora_images(request):
    """获取所有LoRA对应的预览图列表（后台线程执行，避免大量 stat 阻塞事件循环）"""
    images = await asyncio.to_thread(_get_lora_images_sync)
    return web.json_response(images)


def _get_lora_images_sync():
    # 复用智能缓存的列表（与 /xbhh/loras 数据源一致，新添加的文件立刻有预览图映射）
    names = get_loras_smart()

    images = {}
    for item_name in names:
        file_path = folder_paths.get_full_path("loras", item_name)

        if file_path is None:
            continue

        file_path_no_ext = os.path.splitext(file_path)[0]
        file_name = os.path.splitext(item_name)[0]

        # 查找对应的预览图
        for ext in ["png", "jpg", "jpeg", "webp", "preview.png", "preview.jpeg", "preview.webp"]:
            image_path = file_path_no_ext + "." + ext
            if os.path.isfile(image_path):
                images[item_name] = f"loras/{file_name}.{ext}"
                break

    return images


@PromptServer.instance.routes.get("/xbhh/view/{name:.*}")
async def view_lora_image(request):
    """查看LoRA预览图，支持 ?thumb=<width> 返回缩略图（磁盘缓存）"""
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
    headers = {
        "Content-Disposition": f'filename="{filename}"',
        # 协商缓存：预览图可能被同名覆盖（如重新上传），immutable 强缓存会让浏览器
        # 长期不回源验证，主列表一直显示旧图。no-cache + FileResponse 自带的
        # Last-Modified/ETag：文件未变返回 304，变了返回 200 新图。
        "Cache-Control": "no-cache",
    }

    # 缩略图分支
    thumb_param = request.query.get("thumb")
    if thumb_param:
        try:
            width = int(thumb_param)
        except (TypeError, ValueError):
            width = 0
        if 16 <= width <= 2048:
            # PIL 是同步操作，放线程池避免阻塞 ComfyUI 事件循环（首次批量生成时尤其重要）
            import asyncio
            loop = asyncio.get_event_loop()
            thumb_path = await loop.run_in_executor(
                None, _get_or_create_thumbnail, image_path, width
            )
            if thumb_path:
                # 卡片缩略图的 URL 带 ?v=<mtime> 版本号：文件一被同名覆盖，mtime 变化
                # → URL 变化 → 天然失效。因此这里可以放心用一年期强缓存：刷新页面时
                # 浏览器直接读本地缓存，不再对上百科缩略图逐一回源校验（这曾是刷新的卡顿主因）。
                # 没有版本号时仍退回 no-cache 协商缓存，避免同名覆盖后显示旧图。
                thumb_headers = dict(headers)
                if request.query.get("v"):
                    thumb_headers["Cache-Control"] = "public, max-age=31536000, immutable"
                return web.FileResponse(thumb_path, headers=thumb_headers)
        # 缩略图生成失败则回退原图

    return web.FileResponse(image_path, headers=headers)


def _get_or_create_thumbnail(image_path, width):
    """生成并缓存缩略图（webp），返回缓存文件路径；失败返回 None"""
    try:
        mtime = int(os.path.getmtime(image_path))
        key = hashlib.md5(f"{image_path}|{mtime}|{width}".encode()).hexdigest()[:24]
        cache_path = os.path.join(THUMB_CACHE_DIR, key + ".webp")
        if os.path.isfile(cache_path):
            return cache_path

        from PIL import Image
        with Image.open(image_path) as img:
            if img.mode not in ("RGB", "RGBA", "L"):
                img = img.convert("RGBA")
            if img.width > width:
                ratio = width / img.width
                img = img.resize((width, max(1, int(img.height * ratio))), Image.LANCZOS)
            img.save(cache_path, "WEBP", quality=85)
        return cache_path
    except Exception:
        return None


@PromptServer.instance.routes.get("/xbhh/loras")
async def get_loras(request):
    """获取LoRA列表（智能缓存，后台线程执行，不阻塞事件循环）"""
    loras = await asyncio.to_thread(get_loras_smart)
    return web.json_response(loras)


# ============================================================================
# LoRA 列表智能缓存：目录 mtime 快照
# ============================================================================
_lora_list_lock = threading.Lock()
_lora_list_cache = {"list": None, "dir_mtimes": {}}


def _snapshot_lora_dirs():
    """收集 loras 目录树中所有目录的 mtime。

    目录 mtime 只在其条目列表变化时更新：文件增/删/改名/移动都会改变
    所在目录的 mtime，新建子目录会改变父目录 mtime——因此只需比对
    目录 mtime 即可捕获所有影响文件列表的变化。
    """
    snapshot = {}
    for root in folder_paths.get_folder_paths("loras"):
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, _files in os.walk(root):
            try:
                snapshot[dirpath] = os.path.getmtime(dirpath)
            except OSError:
                pass
    return snapshot


def get_loras_smart():
    """带缓存的 LoRA 列表。

    - 目录树无变化：只做几十次 stat（HDD 上也是毫秒级，元数据在系统缓存中），直接返回缓存
    - 有变化：清 ComfyUI 缓存做一次全量重扫（仅此时产生真实 I/O 开销）
    """
    with _lora_list_lock:
        cached = _lora_list_cache
        if cached["list"] is not None:
            try:
                unchanged = all(
                    os.path.isdir(d) and os.path.getmtime(d) == m
                    for d, m in cached["dir_mtimes"].items()
                )
                if unchanged:
                    return cached["list"]
            except OSError:
                pass  # stat 失败（目录被删等）视为有变化
        # 目录树有变化：清缓存全量重扫
        try:
            folder_paths.filename_list_cache.pop("loras", None)
        except Exception:
            pass
        loras = list(folder_paths.get_filename_list("loras"))
        cached["list"] = loras
        cached["dir_mtimes"] = _snapshot_lora_dirs()
        return loras


def invalidate_lora_list_cache():
    """外部改动 loras 目录（重命名/移动文件）后调用。
    Windows 目录 mtime 更新有延迟，mtime 快照比对会短暂误判"无变化"返回旧列表，
    必须主动置空让下次 get_loras_smart 全量重扫。"""
    with _lora_list_lock:
        _lora_list_cache["list"] = None


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
        
        return (model, clip)
