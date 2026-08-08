import os
import json
import struct
import asyncio
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
        "SELECT hash, user_trigger, auto_trigger, trained_words, use_count, profiles FROM lora_global WHERE name = ?", 
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
        db_info = {
            "hash": db_row["hash"],
            "user_trigger": db_row["user_trigger"] or "",
            "auto_trigger": db_row["auto_trigger"] or "",
            "trained_words": db_row["trained_words"] or "",
            "active_trigger": db_row["user_trigger"] or db_row["auto_trigger"] or db_row["trained_words"] or "",
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
    """测试 Civitai API Key 连通性 (优先针对 civitai.red 全能站点测试)"""
    try:
        data = await request.json()
        api_key = data.get("civitai_api_key", "").strip()
    except Exception:
        api_key = ""

    if not api_key:
        settings = lora_database.get_settings()
        api_key = settings.get("civitai_api_key", "").strip()

    domains = ["civitai.red", "civitai.com"]
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    }
    if api_key:
        headers['Authorization'] = f'Bearer {api_key}'

    def _do_test():
        results = []
        for domain in domains:
            url = f"https://{domain}/api/v1/models?limit=1"
            if api_key:
                url += f"&token={api_key}"
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=10) as response:
                    results.append((domain, response.getcode(), None))
            except urllib.error.HTTPError as e:
                results.append((domain, e.code, e.reason))
            except Exception as e:
                results.append((domain, 0, str(e)))
        return results

    results = await asyncio.to_thread(_do_test)
    
    success_domains = [d for d, code, _ in results if code == 200]
    if success_domains:
        msg = f"✅ Civitai ({' & '.join(success_domains)}) 连接正常！"
        if api_key:
            msg += " (API 密钥验证成功)"
        else:
            msg += " (当前使用匿名访问)"
        return web.json_response({"success": True, "message": msg})
    else:
        err_details = [f"{d}: HTTP {code} ({err})" for d, code, err in results]
        return web.json_response({"success": False, "message": "❌ 连接失败: " + " | ".join(err_details)})



