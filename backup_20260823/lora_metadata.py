import os
import json
import struct
import asyncio
import urllib.request
import urllib.error
import folder_paths
from server import PromptServer
from aiohttp import web
from . import lora_database

# Civitai 批量拉取：连续失败超过此次数则中止，避免长时间阻塞
MAX_CONSECUTIVE_CIVITAI_FAILURES = 5
CIVITAI_REQUEST_INTERVAL_SEC = 0.35

# Start the background file scanner
lora_database.run_background_scanner()

# ============================================================================
# Safetensors 元数据读取
# ============================================================================
def read_safetensors_metadata(file_path):
    return lora_database.read_safetensors_metadata(file_path)


def parse_training_params(metadata):
    """
    解析 sd-scripts 格式的训练参数（ss_* 开头的字段）。
    返回结构化的训练参数字典。
    """
    if not metadata:
        return {}
    
    params = {}
    
    # 基础信息
    params['base_model'] = metadata.get('ss_sd_model_name', '')
    params['model_hash'] = metadata.get('ss_sd_model_hash', '')
    params['vae_name'] = metadata.get('ss_vae_name', '')
    params['vae_hash'] = metadata.get('ss_vae_hash', '')
    
    # LoRA 类型和结构
    params['network_module'] = metadata.get('ss_network_module', '')
    params['network_dim'] = metadata.get('ss_network_dim', '')
    params['network_alpha'] = metadata.get('ss_network_alpha', '')
    params['network_args'] = metadata.get('ss_network_args', '')
    
    # 训练参数
    params['learning_rate'] = metadata.get('ss_learning_rate', '')
    params['unet_lr'] = metadata.get('ss_unet_lr', '')
    params['text_encoder_lr'] = metadata.get('ss_text_encoder_lr', '')
    params['lr_scheduler'] = metadata.get('ss_lr_scheduler', '')
    params['lr_warmup_steps'] = metadata.get('ss_lr_warmup_steps', '')
    
    # 训练规模
    params['epoch'] = metadata.get('ss_epoch', '')
    params['num_epochs'] = metadata.get('ss_num_epochs', '')
    params['steps'] = metadata.get('ss_steps', '')
    params['max_train_steps'] = metadata.get('ss_max_train_steps', '')
    params['num_train_images'] = metadata.get('ss_num_train_images', '')
    params['num_reg_images'] = metadata.get('ss_num_reg_images', '')
    
    # 分辨率和 Batch
    params['resolution'] = metadata.get('ss_resolution', '')
    params['batch_size'] = metadata.get('ss_total_batch_size', '')
    params['gradient_accumulation_steps'] = metadata.get('ss_gradient_accumulation_steps', '')
    
    # 优化器
    params['optimizer'] = metadata.get('ss_optimizer', '')
    
    # 其他
    params['noise_offset'] = metadata.get('ss_noise_offset', '')
    params['clip_skip'] = metadata.get('ss_clip_skip', '')
    params['seed'] = metadata.get('ss_seed', '')
    params['mixed_precision'] = metadata.get('ss_mixed_precision', '')
    params['training_comment'] = metadata.get('ss_training_comment', '')
    params['output_name'] = metadata.get('ss_output_name', '')
    
    # 清理空值
    params = {k: v for k, v in params.items() if v}
    
    return params


def parse_tag_frequency(metadata):
    return lora_database.parse_tag_frequency(metadata)


def get_lora_file_info(file_path):
    """获取 LoRA 文件的基本信息（大小、修改时间等）"""
    try:
        stat = os.stat(file_path)
        return {
            'size': stat.st_size,
            'modified': stat.st_mtime,
        }
    except OSError:
        return {}


# ============================================================================
# API 路由
# ============================================================================

@PromptServer.instance.routes.get("/xbhh/lora/metadata/{name:.*}")
async def get_lora_metadata(request):
    """获取指定 LoRA 的完整元数据（含数据库触发词和使用频次）"""
    name = request.match_info["name"]
    
    file_path = folder_paths.get_full_path("loras", name)
    if not file_path or not os.path.isfile(file_path):
        return web.json_response({"error": "LoRA not found"}, status=404)
    
    # 确保文件被扫描进数据库（惰性扫描）
    lora_database.scan_single_file(name, file_path)
    
    metadata = read_safetensors_metadata(file_path)
    training_params = parse_training_params(metadata)
    tag_frequency = parse_tag_frequency(metadata)
    file_info = get_lora_file_info(file_path)
    
    # 从数据库读取额外字段
    conn = lora_database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT hash, user_trigger, auto_trigger, trained_words, use_count, profiles, category FROM lora_global WHERE name = ?", 
        (name,)
    )
    db_row = cursor.fetchone()
    conn.close()

    db_info = {}
    if db_row:
        profiles_list = []
        if db_row["profiles"]:
            try:
                profiles_list = json.loads(db_row["profiles"])
            except Exception:
                pass
        # 分类：优先用户标注，其次从路径推断（见 lora_database.infer_category_from_path）
        category = db_row["category"]
        if not category:
            category = lora_database.infer_category_from_path(name)
        db_info = {
            "hash": db_row["hash"],
            "user_trigger": db_row["user_trigger"] or "",
            "auto_trigger": db_row["auto_trigger"] or "",
            "trained_words": db_row["trained_words"] or "",
            "active_trigger": db_row["user_trigger"] or db_row["auto_trigger"] or db_row["trained_words"] or "",
            "use_count": db_row["use_count"] or 0,
            "profiles": profiles_list,
            "category": category or ""
        }
    else:
        db_info = {
            "hash": "",
            "user_trigger": "",
            "auto_trigger": "",
            "trained_words": "",
            "active_trigger": "",
            "use_count": 0,
            "profiles": [],
            "category": lora_database.infer_category_from_path(name)
        }
    
    return web.json_response({
        "name": name,
        "file_info": file_info,
        "training_params": training_params,
        "tag_frequency": tag_frequency,
        "raw_metadata": metadata,
        "db_info": db_info
    })


@PromptServer.instance.routes.get("/xbhh/lora/metadata-batch")
async def get_lora_metadata_batch(request):
    """
    批量获取 LoRA 元数据摘要（列表视图用，合并数据库缓存以极速响应）。
    """
    folder = request.query.get("folder", "")
    lora_list = folder_paths.get_filename_list("loras")
    
    # 批量获取数据库信息，避免循环查询
    conn = lora_database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT hash, name, user_trigger, auto_trigger, trained_words, use_count, profiles FROM lora_global")
    db_rows = cursor.fetchall()
    conn.close()
    
    db_map = {row["name"]: row for row in db_rows}
    
    result = []
    for lora_name in lora_list:
        if folder:
            lora_dir = os.path.dirname(lora_name).replace("\\", "/")
            if lora_dir != folder.replace("\\", "/"):
                continue
        
        file_path = folder_paths.get_full_path("loras", lora_name)
        if not file_path or not os.path.isfile(file_path):
            continue
            
        file_info = get_lora_file_info(file_path)
        
        # 检查是否有预览图
        file_path_no_ext = os.path.splitext(file_path)[0]
        preview_image = None
        for ext in ["png", "jpg", "jpeg", "preview.png", "preview.jpeg"]:
            img_path = file_path_no_ext + "." + ext
            if os.path.isfile(img_path):
                lora_name_no_ext = os.path.splitext(lora_name)[0]
                preview_image = f"loras/{lora_name_no_ext}.{ext}"
                break
        
        db_row = db_map.get(lora_name)
        db_info = {}
        if db_row:
            profiles_list = []
            if db_row["profiles"]:
                try:
                    profiles_list = json.loads(db_row["profiles"])
                except Exception:
                    pass
            db_info = {
                "hash": db_row["hash"],
                "user_trigger": db_row["user_trigger"],
                "auto_trigger": db_row["auto_trigger"] or "",
                "trained_words": db_row["trained_words"] or "",
                "active_trigger": db_row["user_trigger"] if db_row["user_trigger"] is not None else (db_row["auto_trigger"] or db_row["trained_words"] or ""),
                "use_count": db_row["use_count"] or 0,
                "profiles": profiles_list
            }
        else:
            db_info = {
                "hash": "",
                "user_trigger": "",
                "auto_trigger": "",
                "trained_words": "",
                "active_trigger": "",
                "use_count": 0,
                "profiles": []
            }
        
        # 为了加载速度，批量列表不读取完整 Safetensors，仅拉取文件基本属性和 DB 数据
        # 如果数据库没有该项的 training_params，则读取它
        training_params = {}
        if db_row:
            # 尝试从 DB 存储的 metadata 解析 training_params
            try:
                if db_row["hash"]:
                    conn2 = lora_database.get_db_connection()
                    cursor2 = conn2.cursor()
                    cursor2.execute("SELECT metadata FROM lora_global WHERE hash = ?", (db_row["hash"],))
                    meta_row = cursor2.fetchone()
                    conn2.close()
                    if meta_row and meta_row["metadata"]:
                        meta = json.loads(meta_row["metadata"])
                        training_params = parse_training_params(meta)
            except Exception:
                pass
                
        if not training_params:
            # 兜底：直接读文件
            metadata = read_safetensors_metadata(file_path)
            training_params = parse_training_params(metadata)
            
        result.append({
            "name": lora_name,
            "file_info": file_info,
            "training_params": training_params,
            "preview_image": preview_image,
            "db_info": db_info
        })
    
    return web.json_response(result)


@PromptServer.instance.routes.get("/xbhh/lora/folders")
async def get_lora_folders(request):
    """获取 LoRA 文件夹树结构"""
    lora_list = folder_paths.get_filename_list("loras")
    
    folders = set()
    folders.add("")  # 根目录
    
    for lora_name in lora_list:
        parts = lora_name.replace("\\", "/").split("/")
        for i in range(1, len(parts)):
            folders.add("/".join(parts[:i]))
    
    folder_infos = {}
    lora_base_paths = folder_paths.get_folder_paths("loras")
    
    for folder in sorted(folders):
        info = {"path": folder, "name": folder.split("/")[-1] if folder else "全部"}
        
        for base_path in lora_base_paths:
            folder_full_path = os.path.join(base_path, folder) if folder else base_path
            for desc_file in ["readme.txt", "description.txt", "README.txt", "README.md"]:
                desc_path = os.path.join(folder_full_path, desc_file)
                if os.path.isfile(desc_path):
                    try:
                        with open(desc_path, 'r', encoding='utf-8') as f:
                            info['description'] = f.read(2000)
                    except Exception:
                        pass
                    break
        
        folder_infos[folder] = info
    
    return web.json_response(folder_infos)


@PromptServer.instance.routes.get("/xbhh/lora-manager")
async def serve_lora_manager(request):
    """提供 LoRA 数据管理器的独立 HTML 页面"""
    html_path = os.path.join(os.path.dirname(__file__), "web", "lora_manager.html")
    if os.path.isfile(html_path):
        return web.FileResponse(html_path)
    return web.Response(text="LoRA Manager page not found", status=404)


@PromptServer.instance.routes.get("/xbhh/lora-manager-demo")
async def serve_lora_manager_demo(request):
    """提供 xbhh LoRA 数据管理器的独立演示 Demo 页面"""
    html_path = os.path.join(os.path.dirname(__file__), "web", "lora_manager_demo.html")
    if os.path.isfile(html_path):
        return web.FileResponse(html_path)
    return web.Response(text="LoRA Manager Demo page not found", status=404)


# ============================================================================
# 全局设置 API
# ============================================================================

@PromptServer.instance.routes.get("/xbhh/lora/settings")
async def get_settings_api(request):
    """获取全站 LoRA 设置 (包含 disable_auto_trigger 等)"""
    settings = lora_database.get_settings()
    return web.json_response(settings)


@PromptServer.instance.routes.post("/xbhh/lora/settings")
async def update_settings_api(request):
    """更新全站 LoRA 设置"""
    try:
        data = await request.json()
        current = lora_database.get_settings()
        current.update(data)
        success = lora_database.save_settings(current)
        return web.json_response({"success": success, "settings": current})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)


@PromptServer.instance.routes.get("/xbhh/lora/profiles")
async def get_profiles_api(request):
    """获取指定 LoRA 的预设 Profile 列表"""
    name = request.query.get("name", "")
    if not name:
        return web.json_response({"error": "Missing parameter 'name'"}, status=400)
    profiles = lora_database.get_lora_profiles(name)
    return web.json_response({"name": name, "profiles": profiles})


@PromptServer.instance.routes.post("/xbhh/lora/profiles/update")
async def update_profiles_api(request):
    """更新指定 LoRA 的预设 Profile 列表"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = data.get("name", "")
    profiles = data.get("profiles", [])
    if not name:
        return web.json_response({"error": "Missing parameter 'name'"}, status=400)

    success = lora_database.update_lora_profiles(name, profiles)
    return web.json_response({"success": success, "name": name, "profiles": profiles})


@PromptServer.instance.routes.post("/xbhh/lora/category/update")
async def update_category_api(request):
    """更新指定 LoRA 的分类标签（如 画风/人物/场景）；空字符串表示清除自定义、回退路径推断"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = data.get("name", "")
    category = data.get("category", "")
    if not name:
        return web.json_response({"error": "Missing parameter 'name'"}, status=400)

    success = lora_database.update_lora_category(name, category)
    final = lora_database.get_lora_category(name)
    return web.json_response({"success": success, "name": name, "category": final})


@PromptServer.instance.routes.get("/xbhh/lora/categories")
async def get_categories_api(request):
    """返回预置分类列表 + 用户已自定义的分类（供前端下拉选择）"""
    conn = lora_database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT DISTINCT category FROM lora_global WHERE category IS NOT NULL AND category != ''")
    used = [row["category"] for row in cursor.fetchall() if row["category"]]
    conn.close()
    merged = list(dict.fromkeys(lora_database.DEFAULT_LORA_CATEGORIES + used))
    return web.json_response({"categories": merged, "default": lora_database.DEFAULT_LORA_CATEGORIES})


# ============================================================================
# 新增 API 路由 - 触发词、Civitai 交互与 LFU 计数
# ============================================================================

@PromptServer.instance.routes.get("/xbhh/lora/trigger")
async def get_trigger(request):
    """根据 LoRA name 获取当前有效触发词"""
    name = request.query.get("name", "")
    if not name:
        return web.json_response({"error": "Missing parameter 'name'"}, status=400)
        
    settings = lora_database.get_settings()
    disable_auto = request.query.get("disable_auto", "").lower() == "true" or settings.get("disable_auto_trigger", False)

    conn = lora_database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT hash, user_trigger, auto_trigger, trained_words FROM lora_global WHERE name = ?", 
        (name,)
    )
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        # 尝试使用 file_path 查找或兜底生成
        file_path = folder_paths.get_full_path("loras", name)
        if file_path and os.path.isfile(file_path):
            lora_database.scan_single_file(name, file_path)
            conn = lora_database.get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT hash, user_trigger, auto_trigger, trained_words FROM lora_global WHERE name = ?", (name,))
            row = cursor.fetchone()
            conn.close()
            
    if row:
        if disable_auto:
            active = row["user_trigger"] if row["user_trigger"] is not None else ""
        else:
            active = row["user_trigger"] if row["user_trigger"] is not None else (row["auto_trigger"] or row["trained_words"] or "")
        return web.json_response({
            "name": name,
            "hash": row["hash"],
            "user_trigger": row["user_trigger"],
            "auto_trigger": row["auto_trigger"] or "",
            "trained_words": row["trained_words"] or "",
            "active_trigger": active,
            "disable_auto_trigger": disable_auto
        })
        
    return web.json_response({"name": name, "active_trigger": "", "disable_auto_trigger": disable_auto})


@PromptServer.instance.routes.post("/xbhh/lora/trigger/update")
async def update_trigger(request):
    """更新 LoRA 手动触发词"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
        
    name = data.get("name", "")
    lora_hash = data.get("hash", "")
    trigger = data.get("trigger")
    
    if not name and not lora_hash:
        return web.json_response({"error": "Missing name or hash"}, status=400)
        
    conn = lora_database.get_db_connection()
    cursor = conn.cursor()
    
    if lora_hash:
        cursor.execute("UPDATE lora_global SET user_trigger = ? WHERE hash = ?", (trigger, lora_hash))
    else:
        cursor.execute("UPDATE lora_global SET user_trigger = ? WHERE name = ?", (trigger, name))
        
    conn.commit()
    conn.close()
    
    lora_database.sync_lfu_cache()
    
    return web.json_response({"success": True})


@PromptServer.instance.routes.post("/xbhh/lora/trigger/batch-update")
async def batch_update_triggers(request):
    """批量触发词操作：
    - action='auto': 将训练标签最高频词 (auto_trigger) 复制到 user_trigger
    - action='reset': 清空 user_trigger，使之回退到 auto_trigger
    - action='civitai': 批量获取并应用 Civitai 的 trained_words 到 user_trigger
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
        
    names = data.get("names", [])
    action = data.get("action", "auto")
    
    if not names:
        return web.json_response({"error": "Missing names"}, status=400)

    # Initialize stats to avoid conflict with boolean success
    stats = {
        "processed": 0,
        "success_count": 0,
        "failed": 0,
        "skipped": 0,
        "aborted": False,
        "abort_reason": "",
    }
    consecutive_failures = 0
        
    for name in names:
        conn = lora_database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT hash, auto_trigger, trained_words FROM lora_global WHERE name = ?", (name,))
        row = cursor.fetchone()
        conn.close()

        if not row:
            stats["skipped"] += 1
            continue
            
        lora_hash = row["hash"]
        
        if action == "auto":
            conn = lora_database.get_db_connection()
            cursor = conn.cursor()
            cursor.execute("UPDATE lora_global SET user_trigger = ? WHERE hash = ?", (row["auto_trigger"], lora_hash))
            conn.commit()
            conn.close()
            stats["success_count"] += 1
            stats["processed"] += 1
        elif action == "reset":
            conn = lora_database.get_db_connection()
            cursor = conn.cursor()
            cursor.execute("UPDATE lora_global SET user_trigger = NULL WHERE hash = ?", (lora_hash,))
            conn.commit()
            conn.close()
            stats["success_count"] += 1
            stats["processed"] += 1
        elif action == "clear_auto":
            conn = lora_database.get_db_connection()
            cursor = conn.cursor()
            cursor.execute("UPDATE lora_global SET user_trigger = '', auto_trigger = '' WHERE hash = ?", (lora_hash,))
            conn.commit()
            conn.close()
            stats["success_count"] += 1
            stats["processed"] += 1
        elif action == "civitai":
            if consecutive_failures >= MAX_CONSECUTIVE_CIVITAI_FAILURES:
                stats["aborted"] = True
                stats["abort_reason"] = (
                    f"连续失败 {MAX_CONSECUTIVE_CIVITAI_FAILURES} 次，已自动停止"
                )
                break

            # 在线程池中执行网络请求，避免阻塞 ComfyUI 事件循环
            civitai_words = await asyncio.to_thread(
                lora_database.fetch_civitai_trigger_words, lora_hash
            )
            stats["processed"] += 1

            if civitai_words:
                conn = lora_database.get_db_connection()
                cursor = conn.cursor()
                cursor.execute(
                    "UPDATE lora_global SET trained_words = ?, user_trigger = ? WHERE hash = ?",
                    (civitai_words, civitai_words, lora_hash),
                )
                conn.commit()
                conn.close()
                
                consecutive_failures = 0
                stats["success_count"] += 1
            else:
                consecutive_failures += 1
                stats["failed"] += 1

            await asyncio.sleep(CIVITAI_REQUEST_INTERVAL_SEC)
            
    lora_database.sync_lfu_cache()
    
    # Map success_count back to success for frontend compatibility, but ensure top-level success is boolean
    response_data = {"success": True}
    response_data.update(stats)
    response_data["success_count"] = stats["success_count"] 
    # Actually, the frontend expects `res.success` to be used in condition: `if (res && res.success)`
    # Since frontend expects `res.success` to be boolean or truthy, and we want to pass the count as well:
    # Wait, the frontend checks `if (res.success > 0)` in some places but `if (res && res.success)` in others.
    # Let's return success_count and leave success as boolean True.
    response_data["success_count"] = stats["success_count"]
    
    return web.json_response(response_data)


@PromptServer.instance.routes.post("/xbhh/lora/fetch-civitai")
async def fetch_civitai_info(request):
    """拉取 Civitai 模型推荐触发词并入库"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
        
    name = data.get("name", "")
    lora_hash = data.get("hash", "")
    
    if not lora_hash and name:
        # 查找 hash
        conn = lora_database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT hash FROM lora_global WHERE name = ?", (name,))
        row = cursor.fetchone()
        conn.close()
        if row:
            lora_hash = row["hash"]
            
    if not lora_hash:
        return web.json_response({"error": "LoRA hash not found in database"}, status=400)
        
    # 在线程池中执行网络请求，避免阻塞 ComfyUI 事件循环
    words = await asyncio.to_thread(lora_database.fetch_civitai_trigger_words, lora_hash)
    
    if words:
        conn = lora_database.get_db_connection()
        cursor = conn.cursor()
        # 更新 Civitai 触发词，并自动将它设为当前的自定义触发词以备用
        cursor.execute(
            "UPDATE lora_global SET trained_words = ?, user_trigger = ? WHERE hash = ?", 
            (words, words, lora_hash)
        )
        conn.commit()
        conn.close()
        lora_database.sync_lfu_cache()
        
    return web.json_response({
        "success": True, 
        "trained_words": words, 
        "active_trigger": words
    })


@PromptServer.instance.routes.post("/xbhh/lora/recalculate-auto-triggers")
async def recalculate_auto_triggers_api(request):
    """按训练标签最高频次重新计算所有 LoRA 的 auto_trigger。"""
    await asyncio.to_thread(lora_database.recalculate_auto_triggers)
    lora_database.sync_lfu_cache()
    return web.json_response({"success": True})


@PromptServer.instance.routes.post("/xbhh/lora/use")
async def use_lora(request):
    """LoRA 加载时递增 LFU 计数"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
        
    name = data.get("name", "")
    
    if not name:
        return web.json_response({"error": "Missing name"}, status=400)
        
    conn = lora_database.get_db_connection()
    cursor = conn.cursor()
    
    # 增加 use_count 统计并更新 last_used 时间
    cursor.execute("""
        UPDATE lora_global 
        SET use_count = use_count + 1, last_used = CURRENT_TIMESTAMP 
        WHERE name = ?
    """, (name,))
    
    conn.commit()
    conn.close()
    
    # 同步 LFU Cache
    lora_database.sync_lfu_cache()
    
    return web.json_response({"success": True})


@PromptServer.instance.routes.post("/xbhh/lora/test-civitai")
async def test_civitai_api(request):
    """
    测试 Civitai API Key。
    策略（重要，2026-08-19 重构）：
    - 弃用 /users/me 端点验证：civitai.com 官方域名在国内被墙（超时），
      civitai.red 镜像的 /users/me 对任何 token 都返回 401（镜像不支持该端点），
      因此 /users/me 在国内网络下根本无法用于验证 token——无论 key 是否正确都会失败。
    - 改用「真实拉取触发词」验证：直接调用 /model-versions/by-hash/{hash}，
      这正是 fetch_civitai_trigger_words 的真实工作方式，验证最贴近实际用途。
    - token 发送方式与拉取函数完全一致：Authorization: Bearer {key} 头 + ?token={key} 参数。
    - 优先用用户库里第一个 LoRA 的 hash 实测（更具代表性；若为限制级模型还能真正校验 token），
      拉不到时兜底用已知公开模型 hash。
    """
    try:
        try:
            data = await request.json()
            api_key = data.get("civitai_api_key", "").strip()
        except Exception:
            api_key = ""

        if not api_key:
            settings = lora_database.get_settings()
            api_key = settings.get("civitai_api_key", "").strip()

        if not api_key:
            return web.json_response({
                "success": False,
                "message": "⚠️ 未填写 API Key，请先粘贴你的 Civitai Personal Access Token"
            })

        # ── token 清洗 ──
        original_key = api_key
        if len(api_key) >= 2 and (
            (api_key[0] == '"' and api_key[-1] == '"') or
            (api_key[0] == "'" and api_key[-1] == "'")
        ):
            api_key = api_key[1:-1]
        if api_key.lower().startswith("bearer "):
            api_key = api_key[7:]
        api_key = "".join(api_key.split())

        cleaned = (original_key != api_key)

        if not api_key:
            return web.json_response({
                "success": False,
                "message": "❌ 清洗后 token 为空，请检查输入"
            })

        base_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }

        # 已知公开模型的 SHA256（Superhero Diffusion V1，触发词 comicmay），作为兜底测试目标
        KNOWN_HASH = "CAC0A972CFA40CFE44E3C00D3A488DCBE34668BF291DD6245D70266247643A7C"

        # 优先取用户库里第一个 hash 实测（更具代表性；若为限制级模型还能真正校验 token 真伪）
        try:
            conn = lora_database.get_db_connection()
            cursor = conn.cursor()
            cursor.execute(
                "SELECT hash FROM lora_global WHERE hash IS NOT NULL AND hash != '' LIMIT 1"
            )
            _row = cursor.fetchone()
            conn.close()
            user_hash = _row["hash"] if _row else None
        except Exception:
            user_hash = None

        # 测试目标 hash 列表：用户自己的 LoRA 优先，兜底公开模型
        test_hashes = [h for h in [user_hash, KNOWN_HASH] if h]

        def _do_test():
            """
            用真实 by-hash 拉取验证 token + 网络通道（与 fetch_civitai_trigger_words 同源同方式）。
            仅用 civitai.red 镜像（civitai.com 在国内被墙，尝试它只会徒增 12s 超时）。
            依次尝试 test_hashes，取第一个能拉到的结果。
            返回 dict: domain, code, trained_words, model_name, error
            """
            hdrs = dict(base_headers)
            if api_key:
                hdrs['Authorization'] = f'Bearer {api_key}'

            domain = "civitai.red"
            for model_hash in test_hashes:
                url = f"https://{domain}/api/v1/model-versions/by-hash/{model_hash}"
                if api_key:
                    url += f"?token={api_key}"
                try:
                    req = urllib.request.Request(url, headers=hdrs)
                    with urllib.request.urlopen(req, timeout=12) as response:
                        body = response.read().decode('utf-8', errors='replace')
                        data = json.loads(body)
                        words = data.get('trainedWords', []) or []
                        model_obj = data.get('model') or {}
                        return {
                            "domain": domain,
                            "code": response.getcode(),
                            "trained_words": words,
                            "model_name": model_obj.get('name', ''),
                            "error": "",
                        }
                except urllib.error.HTTPError as e:
                    if e.code == 401:
                        # token 无效或已过期：直接判定失败
                        return {
                            "domain": domain, "code": 401, "trained_words": [],
                            "model_name": "",
                            "error": f"{domain} 返回 401 Unauthorized（token 无效或已过期）",
                        }
                    # 404 等：该 hash 在镜像没找到，换下一个 hash 继续
                    continue
                except Exception as e:
                    # 网络异常（超时/DNS）：换 hash 也救不了，直接返回网络错误
                    return {
                        "domain": domain, "code": 0, "trained_words": [],
                        "model_name": "",
                        "error": f"{domain} {type(e).__name__}: {e}",
                    }
            # 所有 hash 都没拉到（多为 404）
            return {
                "domain": domain, "code": 404, "trained_words": [],
                "model_name": "",
                "error": f"{domain} 未找到测试模型（均返回 404）",
            }

        result = await asyncio.to_thread(_do_test)

        lines = []
        if cleaned:
            lines.append(f"ℹ️ 已自动清洗 token（原长度 {len(original_key)} → {len(api_key)}）")
        lines.append(f"Token 长度: {len(api_key)} 字符，前 6 位: {api_key[:6]}…")
        lines.append("")

        # 情况1: 拉取成功且拿到触发词 → token 生效，拉取通道正常
        if result["code"] == 200 and result["trained_words"]:
            words_preview = ", ".join(result["trained_words"][:5])
            src = f"模型「{result['model_name']}」" if result["model_name"] else "样例模型"
            lines.append("✅ 测试通过！token 已生效，触发词拉取通道正常")
            lines.append(f"   实测通过 {result['domain']} 拉取 {src} 成功")
            lines.append(f"   样例触发词: {words_preview}")
            lines.append("")
            lines.append("说明：已用真实 by-hash 接口实测（与实际拉取 LoRA 触发词的方式完全一致），")
            lines.append("     可放心保存使用。若你的 LoRA 为限制级内容，token 在拉取时会自动校验。")
            return web.json_response({
                "success": True,
                "message": "\n".join(lines),
                "verified": True
            })

        # 情况2: 200 但无触发词（罕见）→ 通道正常，token 视为可用
        if result["code"] == 200 and not result["trained_words"]:
            lines.append(f"⚠️ 网络通道正常（{result['domain']} 返回 200），但该样例模型无触发词")
            lines.append("   token 视为可用，可保存后实际拉取你的 LoRA 测试")
            return web.json_response({
                "success": True,
                "message": "\n".join(lines),
                "verified": False
            })

        # 情况3: 401 → token 无效或已过期
        if result["code"] == 401:
            lines.append(f"❌ token 无效或已过期（{result['error']}）")
            lines.append("")
            lines.append("可能原因：")
            lines.append("  1. token 已过期或被撤销（即使刚生成，也可能账号异常）")
            lines.append("  2. 复制时缺字符（请用 Civitai 网站的复制按钮，不要手动拖选）")
            lines.append("  3. 账号被风控（登录 civitai.com 网站看是否正常浏览）")
            return web.json_response({
                "success": False,
                "message": "\n".join(lines)
            })

        # 情况4: 网络不可达 / 测试模型均 404
        lines.append(f"❌ 无法连接 Civitai（{result['error']}）")
        lines.append("网络问题，请检查网络连接或代理设置（civitai.red 不可达）")
        return web.json_response({
            "success": False,
            "message": "\n".join(lines)
        })
    except Exception as e:
        import traceback
        print(f"[XBHH] test-civitai 内部错误: {e}\n{traceback.format_exc()}")
        return web.json_response({
            "success": False,
            "message": f"❌ 后端处理出错: {type(e).__name__}: {e}"
        })

@PromptServer.instance.routes.get("/xbhh/lora/preview-path")
async def get_lora_preview_path(request):
    """查询指定 LoRA 当前预览图路径（相对路径，可直接拼 /xbhh/view/ 使用）"""
    name = request.query.get("name", "")
    if not name:
        return web.json_response({"error": "Missing parameter 'name'"}, status=400)
    file_path = folder_paths.get_full_path("loras", name)
    if not file_path or not os.path.isfile(file_path):
        return web.json_response({"preview_image": None})
    file_path_no_ext = os.path.splitext(file_path)[0]
    lora_name_no_ext = os.path.splitext(name)[0]
    for ext in ["png", "jpg", "jpeg", "preview.png", "preview.jpeg"]:
        img_path = file_path_no_ext + "." + ext
        if os.path.isfile(img_path):
            return web.json_response({"preview_image": f"loras/{lora_name_no_ext}.{ext}"})
    return web.json_response({"preview_image": None})


@PromptServer.instance.routes.post("/xbhh/lora/upload-image")
async def upload_lora_image(request):
    """上传或替换 LoRA 预览图，保存为与 LoRA 同目录同名的 .png 文件"""
    try:
        reader = await request.multipart()
        lora_name = None
        image_data = None
        content_type = "image/png"

        async for part in reader:
            if part.name == "name":
                lora_name = (await part.read()).decode("utf-8").strip()
            elif part.name == "image":
                content_type = part.headers.get("Content-Type", "image/png")
                image_data = await part.read()

        if not lora_name or image_data is None:
            return web.json_response({"error": "Missing 'name' or 'image' field"}, status=400)

        file_path = folder_paths.get_full_path("loras", lora_name)
        if not file_path or not os.path.isfile(file_path):
            return web.json_response({"error": "LoRA file not found"}, status=404)

        file_path_no_ext = os.path.splitext(file_path)[0]
        lora_name_no_ext = os.path.splitext(lora_name)[0]

        # 删除旧的预览图（所有可能的扩展名）
        for ext in ["png", "jpg", "jpeg", "preview.png", "preview.jpeg"]:
            old_path = file_path_no_ext + "." + ext
            if os.path.isfile(old_path):
                try:
                    os.remove(old_path)
                except Exception:
                    pass

        # 保存新图片为 .png
        save_path = file_path_no_ext + ".png"
        with open(save_path, "wb") as f:
            f.write(image_data)

        preview_image = f"loras/{lora_name_no_ext}.png"
        return web.json_response({
            "success": True,
            "preview_image": preview_image
        })

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/xbhh/lora/delete-image")
async def delete_lora_image(request):
    """删除 LoRA 预览图（与 LoRA 同目录同名的所有图片变体）"""
    try:
        data = await request.json()
        lora_name = (data.get("name") or "").strip()
        if not lora_name:
            return web.json_response({"error": "Missing parameter 'name'"}, status=400)

        file_path = folder_paths.get_full_path("loras", lora_name)
        if not file_path or not os.path.isfile(file_path):
            return web.json_response({"error": "LoRA file not found"}, status=404)

        file_path_no_ext = os.path.splitext(file_path)[0]

        deleted = False
        for ext in ["png", "jpg", "jpeg", "preview.png", "preview.jpeg"]:
            img_path = file_path_no_ext + "." + ext
            if os.path.isfile(img_path):
                try:
                    os.remove(img_path)
                    deleted = True
                except Exception:
                    pass

        if not deleted:
            return web.json_response({"error": "未找到预览图"}, status=404)

        return web.json_response({"success": True})

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.get("/xbhh/lora/logo")
async def get_lora_logo(request):
    """返回扩展 data 目录下的 logo.jpg，用于网页 favicon 和顶栏品牌图标"""
    # 优先 jpg，其次兼容未来可能换成 png
    ext_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(ext_dir, "data", "logo.jpg"),
        os.path.join(ext_dir, "data", "logo.png"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            mime = "image/jpeg" if path.endswith(".jpg") else "image/png"
            try:
                return web.FileResponse(path, headers={"Content-Type": mime, "Cache-Control": "no-cache"})
            except Exception:
                pass
    # 找不到文件时返回 1x1 透明 PNG 占位，避免 <img> 报错
    transparent_1x1 = bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
        "0000000D49444154789C636000000000050001A5F64540000000049454E44AE426082"
    )
    return web.Response(body=transparent_1x1, content_type="image/png")

