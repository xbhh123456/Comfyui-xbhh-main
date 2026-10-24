import os
import json
import shutil
import struct
import uuid
import ctypes
import asyncio
import hashlib
import datetime
import subprocess
import urllib.request
import urllib.error
import folder_paths
from server import PromptServer
from aiohttp import web
from . import lora_database

# Civitai 批量拉取：连续失败超过此次数则中止，避免长时间阻塞
MAX_CONSECUTIVE_CIVITAI_FAILURES = 5
# 并发拉取线程数（实测单请求 ~0.4s，串行+0.35s间隔=0.75s/个太慢；并发4约 10个/s）
CIVITAI_CONCURRENCY = 4

# Start the background file scanner
lora_database.run_background_scanner()
# 启动每日自动导出清单调度（仅在设置里开启 backup_auto_enabled 时才真正导出）
lora_database.start_backup_scheduler()

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
# LoRA 目录索引：一次 scandir 遍历取代「每条 LoRA 9 次 stat/isfile」
# ============================================================================

# 与同名 LoRA 并列存放的预览图候选后缀（按优先级）
_PREVIEW_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".webp",
    ".preview.png", ".preview.jpeg", ".preview.webp",
)

# hash -> 解析后的 training_params。metadata 只在重新扫描文件时变化，
# 且 hash 由文件内容决定，因此按 hash 缓存不会失效。
_PARAMS_CACHE = {}
_PARAMS_CACHE_LIMIT = 4000


def _scan_lora_tree():
    """遍历所有 LoRA 根目录并建立索引（同步，供子线程调用）。

    返回 (rel_files, dir_names)：
      rel_files: {"子目录/文件名"(小写): (size, mtime)}
      dir_names: {("子目录"(小写), "文件名"(小写)): (实际文件名, size, mtime)}
    """
    rel_files = {}
    dir_names = {}

    def walk(abs_dir, rel_dir):
        try:
            with os.scandir(abs_dir) as it:
                entries = list(it)
        except OSError:
            return
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    walk(entry.path, f"{rel_dir}/{entry.name}" if rel_dir else entry.name)
                    continue
                if not entry.is_file():
                    continue
                stat = entry.stat()
            except OSError:
                continue
            key = f"{rel_dir}/{entry.name}" if rel_dir else entry.name
            rel_files[key.lower()] = (stat.st_size, stat.st_mtime)
            dir_names[(rel_dir.lower(), entry.name.lower())] = (entry.name, stat.st_size, stat.st_mtime)

    for base in folder_paths.get_folder_paths("loras"):
        if os.path.isdir(base):
            walk(base, "")
    return rel_files, dir_names


def _find_preview(dir_names, rel_dir, filename):
    """在目录索引里找同名预览图，返回 (相对路径, mtime)；没有则 (None, None)。"""
    stem = os.path.splitext(filename)[0]
    key_dir = rel_dir.lower()
    for suffix in _PREVIEW_SUFFIXES:
        hit = dir_names.get((key_dir, (stem + suffix).lower()))
        if hit:
            actual, _size, mtime = hit
            rel_preview = f"{rel_dir}/{actual}" if rel_dir else actual
            return f"loras/{rel_preview}", int(mtime)
    return None, None


def _get_training_params(db_row):
    """从 DB 的 metadata 列解析训练参数，按 hash 做进程内缓存。"""
    file_hash = db_row["hash"]
    if file_hash in _PARAMS_CACHE:
        return _PARAMS_CACHE[file_hash]
    params = {}
    raw = db_row["metadata"]
    if raw:
        try:
            params = parse_training_params(json.loads(raw))
        except Exception:
            params = {}
    if len(_PARAMS_CACHE) >= _PARAMS_CACHE_LIMIT:
        _PARAMS_CACHE.clear()
    _PARAMS_CACHE[file_hash] = params
    return params


# ============================================================================
# API 路由
# ============================================================================

@PromptServer.instance.routes.get("/xbhh/lora/metadata/{name:.*}")
async def get_lora_metadata(request):
    """获取指定 LoRA 的完整元数据（含数据库触发词和使用频次）"""
    name = request.match_info["name"]
    # 首次点击可能触发整文件哈希（scan_single_file），放到子线程避免卡住事件循环
    payload = await asyncio.to_thread(_build_single_payload, name)
    if payload is None:
        return web.json_response({"error": "LoRA not found"}, status=404)
    return web.json_response(payload)


def _build_single_payload(name):
    file_path = folder_paths.get_full_path("loras", name)
    if not file_path:
        # 回退：数据库记录的路径（重命名后 folder_paths 缓存可能尚未失效）
        try:
            conn_fb = lora_database.get_db_connection()
            cursor_fb = conn_fb.cursor()
            cursor_fb.execute("SELECT file_path FROM lora_global WHERE name = ?", (name,))
            row_fb = cursor_fb.fetchone()
            conn_fb.close()
            if row_fb and row_fb["file_path"] and os.path.isfile(row_fb["file_path"]):
                file_path = row_fb["file_path"]
        except Exception:
            pass
    if not file_path or not os.path.isfile(file_path):
        return None
    
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
        "SELECT hash, user_trigger, auto_trigger, trained_words, use_count, profiles, category, base_model_override, rating FROM lora_global WHERE name = ?",
        (name,)
    )
    db_row = cursor.fetchone()
    conn.close()

    db_info = {}
    if db_row:
        # 底模覆盖优先于文件元数据
        if db_row["base_model_override"]:
            training_params['base_model'] = db_row["base_model_override"]
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
            # user_trigger 保留 NULL 语义（null=未自定义，''=显式清空），避免新模型被误标"已设置自定义触发词"
            "user_trigger": db_row["user_trigger"],
            "auto_trigger": db_row["auto_trigger"] or "",
            "trained_words": db_row["trained_words"] or "",
            "active_trigger": db_row["user_trigger"] if db_row["user_trigger"] is not None else (db_row["auto_trigger"] or db_row["trained_words"] or ""),
            "use_count": db_row["use_count"] or 0,
            "profiles": profiles_list,
            "category": category or "",
            "rating": db_row["rating"] or 0
        }
    else:
        db_info = {
            "hash": "",
            "user_trigger": None,
            "auto_trigger": "",
            "trained_words": "",
            "active_trigger": "",
            "use_count": 0,
            "profiles": [],
            "category": lora_database.infer_category_from_path(name),
            "rating": 0
        }
    
    return {
        "name": name,
        "file_info": file_info,
        "training_params": training_params,
        "tag_frequency": tag_frequency,
        "raw_metadata": metadata,
        "db_info": db_info
    }


@PromptServer.instance.routes.get("/xbhh/lora/metadata-batch")
async def get_lora_metadata_batch(request):
    """
    批量获取 LoRA 元数据摘要（列表视图用，合并数据库缓存以极速响应）。
    """
    folder = request.query.get("folder", "")
    # 目录扫描 + SQLite 都是同步阻塞操作，放到子线程，避免卡住事件循环
    result = await asyncio.to_thread(_build_batch_payload, folder)

    body = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    etag = '"' + hashlib.md5(body.encode("utf-8")).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    # 数据没变直接 304，浏览器复用上次的响应体
    if request.headers.get("If-None-Match") == etag:
        return web.Response(status=304, headers=headers)
    return web.Response(
        body=body.encode("utf-8"),
        content_type="application/json",
        charset="utf-8",
        headers=headers,
    )


def _build_batch_payload(folder):
    """列表数据构建（同步，跑在子线程）：单次目录索引 + 单条 SQL + 参数缓存。"""
    lora_list = folder_paths.get_filename_list("loras")
    rel_files, dir_names = _scan_lora_tree()

    # 一次性取全表（含 metadata），避免每条 LoRA 各开一次连接
    conn = lora_database.get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT hash, name, user_trigger, auto_trigger, trained_words, use_count, profiles, rating, metadata FROM lora_global"
        )
        db_rows = cursor.fetchall()
    finally:
        conn.close()

    db_map = {row["name"]: row for row in db_rows}

    folder_norm = folder.replace("\\", "/").strip("/")
    result = []
    for lora_name in lora_list:
        rel_name = lora_name.replace("\\", "/")
        rel_dir, _, filename = rel_name.rpartition("/")
        if folder_norm and rel_dir != folder_norm:
            continue

        hit = rel_files.get(rel_name.lower())
        if hit:
            size, mtime = hit
        else:
            # 索引里没有（软链接等特殊情况）时退回单文件 stat
            file_path = folder_paths.get_full_path("loras", lora_name)
            if not file_path:
                continue
            try:
                stat = os.stat(file_path)
            except OSError:
                continue
            size, mtime = stat.st_size, stat.st_mtime

        # 预览图从同一份目录索引里取，不再对 7 个候选各做一次 isfile
        preview_image, preview_mtime = _find_preview(dir_names, rel_dir, filename)

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
                "profiles": profiles_list,
                "rating": db_row["rating"] or 0
            }
        else:
            db_info = {
                "hash": "",
                # 新模型无 db 记录：user_trigger 返回 null 表示未自定义（与列表接口有记录时语义一致）
                "user_trigger": None,
                "auto_trigger": "",
                "trained_words": "",
                "active_trigger": "",
                "use_count": 0,
                "profiles": [],
                "rating": 0
            }
        
        # training_params 直接取自上面那条 SQL 的 metadata 列，并按 hash 缓存解析结果，
        # 不再为每条 LoRA 重开连接、重复解析大 JSON
        training_params = {}
        if db_row and db_row["hash"]:
            training_params = _get_training_params(db_row)
        else:
            # 库里还没有这条记录（尚未扫描）：兜底读一次文件头
            file_path = folder_paths.get_full_path("loras", lora_name)
            if file_path:
                training_params = parse_training_params(read_safetensors_metadata(file_path))
            
        result.append({
            "name": lora_name,
            "file_info": {"size": size, "modified": mtime},
            "training_params": training_params,
            "preview_image": preview_image,
            "preview_mtime": preview_mtime,
            "db_info": db_info
        })
    
    return result


@PromptServer.instance.routes.get("/xbhh/lora/folders")
async def get_lora_folders(request):
    """获取 LoRA 文件夹树结构"""
    return web.json_response(await asyncio.to_thread(_build_folders_payload))


def _build_folders_payload():
    """文件夹树构建（同步，跑在子线程）：目录索引一次，代替每文件夹 4 次 isfile。"""
    lora_list = folder_paths.get_filename_list("loras")
    _, dir_names = _scan_lora_tree()

    folders = set()
    folders.add("")  # 根目录

    for lora_name in lora_list:
        parts = lora_name.replace("\\", "/").split("/")
        for i in range(1, len(parts)):
            folders.add("/".join(parts[:i]))

    folder_infos = {}
    lora_base_paths = folder_paths.get_folder_paths("loras")
    # 索引里 key 全小写，等价于大小写的 README.txt / README.md
    desc_candidates = ("readme.txt", "description.txt", "readme.md")

    for folder in sorted(folders):
        info = {"path": folder, "name": folder.split("/")[-1] if folder else "全部"}

        for desc_file in desc_candidates:
            hit = dir_names.get((folder.lower(), desc_file))
            if not hit:
                continue
            actual_name = hit[0]
            for base_path in lora_base_paths:
                desc_path = os.path.join(base_path, *folder.split("/"), actual_name) if folder else os.path.join(base_path, actual_name)
                if os.path.isfile(desc_path):
                    try:
                        with open(desc_path, 'r', encoding='utf-8') as f:
                            info['description'] = f.read(2000)
                    except Exception:
                        pass
                    break
            if 'description' in info:
                break

        folder_infos[folder] = info

    return folder_infos


@PromptServer.instance.routes.get("/xbhh/lora-manager")
async def serve_lora_manager(request):
    """提供 LoRA 数据管理器的独立 HTML 页面"""
    html_path = os.path.join(os.path.dirname(__file__), "web", "lora_manager.html")
    if os.path.isfile(html_path):
        return web.FileResponse(html_path)
    return web.Response(text="LoRA Manager page not found", status=404)


# ============================================================================
# 看板娘聊天自定义字体：把 .ttf/.otf/.woff/.woff2 丢进 web/assets/fonts/ 即可
# ============================================================================
FONTS_DIR = os.path.join(os.path.dirname(__file__), "web", "assets", "fonts")
FONT_EXTS = (".ttf", ".otf", ".woff", ".woff2")


@PromptServer.instance.routes.get("/xbhh/fonts/list")
async def chat_fonts_list(request):
    """列出可用的自定义字体文件（实时读取目录，新增字体无需重启）"""
    files = []
    if os.path.isdir(FONTS_DIR):
        for f in sorted(os.listdir(FONTS_DIR)):
            if f.lower().endswith(FONT_EXTS):
                files.append(f)
    return web.json_response({"fonts": files})


@PromptServer.instance.routes.get("/xbhh/fonts/{name}")
async def chat_font_file(request):
    """提供字体文件"""
    name = os.path.basename(request.match_info.get("name", ""))
    path = os.path.join(FONTS_DIR, name)
    if name.lower().endswith(FONT_EXTS) and os.path.isfile(path):
        return web.FileResponse(path, headers={"Cache-Control": "public, max-age=86400"})
    return web.Response(text="font not found", status=404)


@PromptServer.instance.routes.get("/xbhh/lora-manager-demo")
async def serve_lora_manager_demo(request):
    """提供 xbhh LoRA 数据管理器的独立演示 Demo 页面"""
    html_path = os.path.join(os.path.dirname(__file__), "web", "lora_manager_demo.html")
    if os.path.isfile(html_path):
        return web.FileResponse(html_path)
    return web.Response(text="LoRA Manager Demo page not found", status=404)


# ============================================================================
# DeepSeek 小鲸鱼余额挂件（移植自 MeteorNOX/DeepSeek-Balance-Whale-Widget, MIT）
# ============================================================================
WHALE_ASSET_DIR = os.path.join(os.path.dirname(__file__), "web", "assets", "whale")
WHALE_JS_PATH = os.path.join(os.path.dirname(__file__), "web", "js", "whale_widget.js")
WHALE_USAGE_FILE = os.path.join(os.path.dirname(__file__), "data", "whale_usage.json")
WHALE_BALANCE_URL = "https://api.deepseek.com/user/balance"
# 高峰时段：工作日 9:00-12:00 和 14:00-18:00（北京时间）；2026-08-23 起周末全天谷价
_WHALE_PEAK_HOURS = [(9, 12), (14, 18)]
_WHALE_WEEKEND_VALLEY_FROM = datetime.datetime(2026, 8, 23, 0, 0, 0,
                                               tzinfo=datetime.timezone(datetime.timedelta(hours=8)))


def _whale_is_peak_now():
    """当前是否处于 DeepSeek 高峰时段（北京时间）"""
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    if now >= _WHALE_WEEKEND_VALLEY_FROM and now.weekday() >= 5:
        return False
    hour = now.hour
    return any(start <= hour < end for start, end in _WHALE_PEAK_HOURS)


def _whale_today_key():
    return datetime.datetime.now().strftime("%Y-%m-%d")


def _whale_read_ledger():
    try:
        with open(WHALE_USAGE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("date"), str):
            return data
    except Exception:
        pass
    return {"date": _whale_today_key(), "lastBalance": None, "lastCurrency": "", "todayUsage": 0, "history": {}}


def _whale_write_ledger(ledger):
    try:
        os.makedirs(os.path.dirname(WHALE_USAGE_FILE), exist_ok=True)
        with open(WHALE_USAGE_FILE, "w", encoding="utf-8") as f:
            json.dump(ledger, f, ensure_ascii=False)
    except Exception:
        pass


def _whale_record_usage(balance, currency):
    """余额差值记账：跨天归零归档；币种切换只重置基准不记差值"""
    today = _whale_today_key()
    ledger = _whale_read_ledger()
    cur = str(currency or "")
    currency_changed = bool(ledger.get("lastCurrency")) and bool(cur) and ledger["lastCurrency"] != cur
    if ledger.get("date") != today:
        if ledger.get("date") and isinstance(ledger.get("todayUsage"), (int, float)):
            history = ledger.setdefault("history", {})
            history[ledger["date"]] = ledger["todayUsage"]
        ledger = {"date": today, "lastBalance": balance, "lastCurrency": cur, "todayUsage": 0, "history": ledger.get("history", {})}
    elif currency_changed:
        ledger["lastBalance"] = balance
        ledger["lastCurrency"] = cur
    else:
        prev = ledger.get("lastBalance")
        if isinstance(prev, (int, float)) and isinstance(balance, (int, float)) and balance < prev:
            ledger["todayUsage"] = (ledger.get("todayUsage") or 0) + (prev - balance)
        ledger["lastBalance"] = balance
        ledger["lastCurrency"] = cur
    keys = sorted((ledger.get("history") or {}).keys())
    while len(keys) > 30:
        del ledger["history"][keys.pop(0)]
    _whale_write_ledger(ledger)
    return ledger


def _whale_fetch_balance_blocking(api_key):
    """同步拉取 DeepSeek 余额接口（在线程池中执行）"""
    last_err = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(
                WHALE_BALANCE_URL,
                headers={"Authorization": "Bearer " + api_key},
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            infos = data.get("balance_infos") or []

            def num(x):
                try:
                    return float(x.get("total_balance"))
                except Exception:
                    return float("nan")

            info = next((x for x in infos if x.get("currency") == "CNY" and num(x) > 0), None) \
                or next((x for x in infos if num(x) > 0), None) \
                or next((x for x in infos if x.get("currency") == "CNY"), None) \
                or (infos[0] if infos else None)
            if not info or info.get("total_balance") is None:
                return {"ok": False, "code": "SHAPE", "error": "余额接口返回结构异常"}
            return {
                "ok": True,
                "totalBalance": float(info["total_balance"]),
                "currency": str(info.get("currency") or "CNY"),
                "updatedAt": datetime.datetime.now().isoformat(),
            }
        except urllib.error.HTTPError as e:
            last_err = "HTTP " + str(e.code)
            if e.code < 500:
                break
        except Exception as e:
            last_err = str(e)
        if attempt == 0:
            import time
            time.sleep(0.5)
    transient = not (last_err or "").startswith("HTTP 4")
    return {
        "ok": False,
        "code": "HTTP",
        "transient": transient,
        "error": "余额接口请求失败: " + (last_err or "unknown")[:200],
    }


async def _whale_get_balance_payload(api_key):
    payload = await asyncio.to_thread(_whale_fetch_balance_blocking, api_key)
    if not payload.get("ok"):
        return payload
    ledger = _whale_record_usage(payload["totalBalance"], payload["currency"])
    payload["isPeak"] = _whale_is_peak_now()
    payload["todayUsage"] = ledger.get("todayUsage", 0)
    payload["usageMode"] = "ledger"
    return payload


@PromptServer.instance.routes.get("/xbhh/whale/balance.json")
async def whale_balance(request):
    """挂件余额数据：代理 DeepSeek 余额接口 + 余额差值记账
    Key 来源优先级：?key= 查询参数（看板娘设置的 API Key，前端传入）> 服务端设置"""
    api_key = (request.query.get("key") or "").strip()
    if not api_key:
        settings = lora_database.get_settings()
        api_key = (settings.get("deepseek_api_key") or "").strip()
    if not api_key:
        return web.json_response({"ok": False, "code": "NO_KEY", "error": "未配置 API Key（看板娘设置侧边栏 → AI API Key，或 LoRA 管理器 → ⚙️ 设置）"})
    try:
        payload = await _whale_get_balance_payload(api_key)
    except Exception as e:
        payload = {"ok": False, "code": "ERROR", "error": "余额服务异常: " + str(e)[:200]}
    return web.json_response(payload)


@PromptServer.instance.routes.post("/xbhh/whale/balance.json")
async def whale_balance_test(request):
    """测试指定 DeepSeek API Key（设置弹窗「测试」按钮用）"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid JSON"}, status=400)
    api_key = (data.get("key") or "").strip()
    if not api_key:
        return web.json_response({"ok": False, "code": "NO_KEY", "error": "请先填入 DeepSeek API Key"})
    try:
        payload = await asyncio.to_thread(_whale_fetch_balance_blocking, api_key)
    except Exception as e:
        payload = {"ok": False, "code": "ERROR", "error": str(e)[:200]}
    return web.json_response(payload)


@PromptServer.instance.routes.get("/xbhh/whale/widget.js")
async def whale_widget_js(request):
    """挂件脚本"""
    if os.path.isfile(WHALE_JS_PATH):
        return web.FileResponse(WHALE_JS_PATH, headers={"Cache-Control": "no-store"})
    return web.Response(text="whale widget js not found", status=404)


@PromptServer.instance.routes.get("/xbhh/whale/image.png")
async def whale_image(request):
    """鲸鱼本体立绘"""
    path = os.path.join(WHALE_ASSET_DIR, "DSniang1.png")
    if os.path.isfile(path):
        return web.FileResponse(path, headers={"Cache-Control": "no-store"})
    return web.Response(text="whale image not found", status=404)


@PromptServer.instance.routes.get("/xbhh/whale/rua.gif")
async def whale_gif(request):
    """随机台词 gif"""
    path = os.path.join(WHALE_ASSET_DIR, "rua.gif")
    if os.path.isfile(path):
        return web.FileResponse(path, headers={"Cache-Control": "no-store"})
    return web.Response(text="whale gif not found", status=404)


@PromptServer.instance.routes.get("/xbhh/whale/sound/{kind}")
async def whale_sound(request):
    """按压/松手音效：?set=duck 小黄鸭 / fx1 音效1"""
    kind = request.match_info.get("kind", "")
    sound_set = request.query.get("set", "duck")
    names = {
        "press.mp3": {"duck": "Ya1.mp3", "fx1": "D1.mp3"},
        "release.mp3": {"duck": "Ya2.mp3", "fx1": "D2.mp3"},
    }.get(kind, {}).get("fx1" if sound_set == "fx1" else "duck")
    if not names:
        return web.Response(text="sound not found", status=404)
    path = os.path.join(WHALE_ASSET_DIR, names)
    if os.path.isfile(path):
        return web.FileResponse(path, headers={"Cache-Control": "no-store"})
    return web.Response(text="sound file not found", status=404)


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


@PromptServer.instance.routes.post("/xbhh/lora/rating/update")
async def update_rating_api(request):
    """更新指定 LoRA 的星级评分（0-5，0 表示未评分）"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = data.get("name", "")
    if not name:
        return web.json_response({"error": "Missing parameter 'name'"}, status=400)
    if "rating" not in data:
        return web.json_response({"error": "Missing parameter 'rating'"}, status=400)

    try:
        rating = int(data.get("rating"))
    except (TypeError, ValueError):
        return web.json_response({"error": "Invalid rating"}, status=400)
    rating = max(0, min(5, rating))

    success = lora_database.set_lora_rating(name, rating)
    return web.json_response({"success": success, "name": name, "rating": rating})


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


async def _batch_fetch_civitai_concurrent(names, stats):
    """Civitai 批量拉取：网络请求并发（信号量限流），DB 读写在主协程串行执行。

    相比旧的串行 + 0.35s 间隔实现（~0.75s/个），并发拉取可将几百个 LoRA 的
    获取时间缩短一个数量级。保留"连续失败 N 次中止"保护：先拉前几个探针，
    全部失败（网络断开/Key 失效）时快速中止，避免几百个请求全部等超时。
    """
    # 1) 串行读 DB 收集 hash（无网络开销，很快）
    entries = []
    for name in names:
        conn = lora_database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT hash FROM lora_global WHERE name = ?", (name,))
        row = cursor.fetchone()
        conn.close()
        if row and row["hash"]:
            entries.append((name, row["hash"]))
        else:
            stats["skipped"] += 1

    if not entries:
        lora_database.sync_lfu_cache()
        return web.json_response({**{"success": True}, **stats})

    sem = asyncio.Semaphore(CIVITAI_CONCURRENCY)

    async def fetch_one(lora_hash):
        async with sem:
            return await asyncio.to_thread(
                lora_database.fetch_civitai_trigger_words, lora_hash
            )

    # 2) 探针：先拉前 N 个（N=连续失败阈值），全部失败则快速中止
    probe_entries = entries[:MAX_CONSECUTIVE_CIVITAI_FAILURES]
    probe_results = await asyncio.gather(*(fetch_one(h) for _, h in probe_entries))
    if not any(probe_results):
        stats["aborted"] = True
        stats["abort_reason"] = (
            f"前 {len(probe_entries)} 个全部失败，疑似网络不通或 Key 失效，已自动停止"
        )
        stats["processed"] = len(probe_entries)
        stats["failed"] = len(probe_entries)
        lora_database.sync_lfu_cache()
        return web.json_response({**{"success": True}, **stats})

    # 3) 并发拉取剩余全部
    rest = entries[MAX_CONSECUTIVE_CIVITAI_FAILURES:]
    if rest:
        rest_results = await asyncio.gather(*(fetch_one(h) for _, h in rest))
        all_entries = probe_entries + rest
        all_results = list(probe_results) + list(rest_results)
    else:
        all_entries = probe_entries
        all_results = list(probe_results)

    # 4) 串行写 DB（SQLite 单写者，避免并发写锁冲突）
    for (name, lora_hash), civitai_words in zip(all_entries, all_results):
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
            stats["success_count"] += 1
        else:
            stats["failed"] += 1

    lora_database.sync_lfu_cache()
    return web.json_response({**{"success": True}, **stats})


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

    # Civitai 批量走专门的并发实现（网络并发拉取 + DB 串行写），其余 action 走下方串行循环
    if action == "civitai":
        return await _batch_fetch_civitai_concurrent(names, stats)

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
    """按训练标签最高频次重新计算 LoRA 的 auto_trigger。

    body 可带 hashes 数组：只重算指定项（选中/单个场景，毫秒级）；
    不带则重算全部（全库扫描，较慢）。
    """
    hashes = None
    try:
        data = await request.json()
        if isinstance(data, dict) and isinstance(data.get("hashes"), list):
            hashes = [h for h in data["hashes"] if h] or None
    except Exception:
        pass

    triggers = await asyncio.to_thread(lora_database.recalculate_auto_triggers, hashes)
    await asyncio.to_thread(lora_database.sync_lfu_cache)
    return web.json_response({"success": True, "triggers": triggers})


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
            两步验证（2026-09-10 重构）：
            ① GET /api/v1/me —— 官方鉴权端点（civitai.red 镜像实测支持）：
               无 token / 假 token 一律 401 {"error":"Unauthorized"}，真 token 返回 200+用户信息。
               这是唯一能判定 token 真伪的端点——by-hash 拉公开模型匿名也放行，验不了 token。
               （注意：正确路径是 /api/v1/me；此前试过的 /users/me 是错误路径，镜像不支持）
            ② by-hash 实拉 —— 与 fetch_civitai_trigger_words 同源同方式，验证真实拉取通道。
            返回 dict: domain, code, trained_words, model_name, error, username
            """
            hdrs = dict(base_headers)
            if api_key:
                hdrs['Authorization'] = f'Bearer {api_key}'

            domain = "civitai.red"

            # ── ① token 真伪校验（/api/v1/me）──
            me_url = f"https://{domain}/api/v1/me"
            if api_key:
                me_url += f"?token={api_key}"
            username = ""
            try:
                req = urllib.request.Request(me_url, headers=hdrs)
                with urllib.request.urlopen(req, timeout=12) as response:
                    me_data = json.loads(response.read().decode('utf-8', errors='replace'))
                    username = me_data.get('username', '')
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    return {
                        "domain": domain, "code": 401, "trained_words": [],
                        "model_name": "", "username": "",
                        "error": f"{domain} /api/v1/me 返回 401（API Key 无效或已过期）",
                    }
                return {
                    "domain": domain, "code": e.code, "trained_words": [],
                    "model_name": "", "username": "",
                    "error": f"{domain} /api/v1/me 返回 {e.code}",
                }
            except Exception as e:
                return {
                    "domain": domain, "code": 0, "trained_words": [],
                    "model_name": "", "username": "",
                    "error": f"{domain} {type(e).__name__}: {e}",
                }

            # ── ② by-hash 实拉验证通道（与实际拉取触发词方式一致）──
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
                            "username": username,
                            "error": "",
                        }
                except urllib.error.HTTPError as e:
                    if e.code == 401:
                        return {
                            "domain": domain, "code": 401, "trained_words": [],
                            "model_name": "", "username": username,
                            "error": f"{domain} 返回 401 Unauthorized（token 无效或已过期）",
                        }
                    # 404 等：该 hash 在镜像没找到，换下一个 hash 继续
                    continue
                except Exception as e:
                    # 网络异常（超时/DNS）：换 hash 也救不了，直接返回网络错误
                    return {
                        "domain": domain, "code": 0, "trained_words": [],
                        "model_name": "", "username": username,
                        "error": f"{domain} {type(e).__name__}: {e}",
                    }
            # 所有 hash 都没拉到（多为 404）
            return {
                "domain": domain, "code": 404, "trained_words": [],
                "model_name": "", "username": username,
                "error": f"{domain} 未找到测试模型（均返回 404）",
            }

        result = await asyncio.to_thread(_do_test)

        lines = []
        if cleaned:
            lines.append(f"ℹ️ 已自动清洗 token（原长度 {len(original_key)} → {len(api_key)}）")
        lines.append(f"Token 长度: {len(api_key)} 字符，前 6 位: {api_key[:6]}…")
        lines.append("")

        user_tag = f"（用户: {result.get('username', '')}）" if result.get('username') else ""

        # 情况1: 拉取成功且拿到触发词 → token 生效，拉取通道正常
        if result["code"] == 200 and result["trained_words"]:
            words_preview = ", ".join(result["trained_words"][:5])
            src = f"模型「{result['model_name']}」" if result["model_name"] else "样例模型"
            lines.append(f"✅ 测试通过！API Key 有效{user_tag}，触发词拉取通道正常")
            lines.append(f"   /api/v1/me 鉴权通过 + 实测通过 {result['domain']} 拉取 {src} 成功")
            lines.append(f"   样例触发词: {words_preview}")
            lines.append("")
            lines.append("说明：已用真实 by-hash 接口实测（与实际拉取 LoRA 触发词的方式完全一致），")
            lines.append("     可放心保存使用。若你的 LoRA 为限制级内容，token 在拉取时会自动校验。")
            return web.json_response({
                "success": True,
                "message": "\n".join(lines),
                "verified": True
            })

        # 情况2: me 200 + by-hash 200 但无触发词（罕见）→ token 有效，通道正常
        if result["code"] == 200 and not result["trained_words"]:
            lines.append(f"⚠️ API Key 有效{user_tag}（/api/v1/me 校验通过），但样例模型无触发词")
            lines.append("   可保存后实际拉取你的 LoRA 测试")
            return web.json_response({
                "success": True,
                "message": "\n".join(lines),
                "verified": False
            })

        # 情况3: 401 → token 无效或已过期
        if result["code"] == 401:
            lines.append(f"❌ API Key 校验未通过（{result['error']}）")
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
    for ext in ["png", "jpg", "jpeg", "webp", "preview.png", "preview.jpeg", "preview.webp"]:
        img_path = file_path_no_ext + "." + ext
        if os.path.isfile(img_path):
            return web.json_response({
                "preview_image": f"loras/{lora_name_no_ext}.{ext}",
                "preview_mtime": int(os.path.getmtime(img_path))
            })
    return web.json_response({"preview_image": None, "preview_mtime": None})


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
        for ext in ["png", "jpg", "jpeg", "webp", "preview.png", "preview.jpeg", "preview.webp"]:
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
        for ext in ["png", "jpg", "jpeg", "webp", "preview.png", "preview.jpeg", "preview.webp"]:
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


# ============================================================================
# 参考图（Reference Images）API
# ============================================================================

# 支持的图片扩展名
_REF_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

# 配方预览图子目录名：放在用户第一个 LoRA 目录下，随 LoRA 一起搬迁/备份
_RECIPE_PREVIEW_SUBDIR = "xbhh_recipe_previews"

# 旧版配方预览图目录（历史遗留）：首次访问时自动迁移到 LoRA 目录下的新位置
_LEGACY_RECIPE_PREVIEW_DIR = os.path.join(folder_paths.base_path, "output", _RECIPE_PREVIEW_SUBDIR)

# 迁移只尝试一次，避免每次请求都扫描目录
_recipe_preview_migrated = False


def _to_rel_or_abs(path):
    """把绝对路径尽量转成相对 ComfyUI 根目录的路径（统一正斜杠）。
    跨盘（Windows）等原因无法取相对路径时，返回原绝对路径。
    """
    if not path:
        return ""
    try:
        return os.path.relpath(path, folder_paths.base_path).replace("\\", "/")
    except Exception:
        return os.path.normpath(path).replace("\\", "/")


def _join_rel(base_rel, name):
    """拼接相对目录与文件名（统一正斜杠）。"""
    if not base_rel:
        return name
    return base_rel.rstrip("/") + "/" + name


def _migrate_legacy_recipe_previews(target_dir):
    """一次性把旧目录 output/xbhh_recipe_previews 里的图片搬到新目录。"""
    global _recipe_preview_migrated
    if _recipe_preview_migrated:
        return
    _recipe_preview_migrated = True
    if not target_dir:
        return
    if os.path.normpath(target_dir) == os.path.normpath(_LEGACY_RECIPE_PREVIEW_DIR):
        return
    if not os.path.isdir(_LEGACY_RECIPE_PREVIEW_DIR):
        return
    try:
        names = os.listdir(_LEGACY_RECIPE_PREVIEW_DIR)
    except OSError:
        return
    for name in names:
        src = os.path.join(_LEGACY_RECIPE_PREVIEW_DIR, name)
        if not os.path.isfile(src):
            continue
        if os.path.splitext(name)[1].lower() not in _REF_IMG_EXTS:
            continue
        dst = os.path.join(target_dir, name)
        if os.path.exists(dst):
            continue
        try:
            shutil.move(src, dst)
        except Exception:
            continue


def _get_recipe_preview_dir(create=True):
    """配方预览图的存放目录：<第一个 LoRA 目录>/xbhh_recipe_previews。
    拿不到 LoRA 目录（或创建失败）时退化为旧目录。
    返回 (绝对目录, 相对 ComfyUI 根目录的目录)。
    """
    base = None
    try:
        paths = folder_paths.get_folder_paths("loras") or []
        if paths:
            base = paths[0]
    except Exception:
        base = None

    target = os.path.join(base, _RECIPE_PREVIEW_SUBDIR) if base else _LEGACY_RECIPE_PREVIEW_DIR

    if create:
        try:
            os.makedirs(target, exist_ok=True)
        except Exception:
            target = _LEGACY_RECIPE_PREVIEW_DIR
            try:
                os.makedirs(target, exist_ok=True)
            except Exception:
                pass

    _migrate_legacy_recipe_previews(target)
    return target, _to_rel_or_abs(target)


def _delete_recipe_preview_file(raw_path, keep=None):
    """删除配方预览图文件：仅限配方预览目录内的图片，防误删。
    keep 为本次新写入的文件绝对路径，与新文件相同时跳过。
    """
    if not raw_path:
        return
    path = _resolve_ref_path(raw_path)
    if not path or not os.path.isfile(path):
        return
    dir_path, _rel_dir = _get_recipe_preview_dir(create=False)
    if not dir_path:
        return
    if os.path.normcase(os.path.dirname(os.path.abspath(path))) != os.path.normcase(os.path.abspath(dir_path)):
        return
    if keep and os.path.normcase(os.path.abspath(path)) == os.path.normcase(os.path.abspath(keep)):
        return
    if os.path.splitext(path)[1].lower() not in _REF_IMG_EXTS:
        return
    try:
        os.remove(path)
    except OSError:
        pass


@PromptServer.instance.routes.get("/xbhh/lora/recipe-preview-dir")
async def get_recipe_preview_dir(request):
    """返回配方预览图的存放目录：
    dir=绝对路径，rel_dir=相对 ComfyUI 根目录的路径（正斜杠），legacy_dir=旧版目录（供前端迁移历史路径）。
    """
    dir_path, rel_dir = _get_recipe_preview_dir()
    return web.json_response({
        "dir": dir_path,
        "rel_dir": rel_dir,
        "legacy_dir": _LEGACY_RECIPE_PREVIEW_DIR,
    })


def _dir_contains_ref_image(dir_path, _depth=0, _seen=None):
    """递归判断目录内是否至少存在一张参考图（含更深层子目录）。
    用 realpath 去重防软链成环，超过深度上限直接视为无图，避免深目录拖慢。
    """
    if _depth > 8:
        return False
    if _seen is None:
        _seen = set()
    try:
        real = os.path.realpath(dir_path)
    except OSError:
        return False
    if real in _seen:
        return False
    _seen.add(real)
    try:
        entries = os.listdir(dir_path)
    except OSError:
        return False
    subdirs = []
    for entry in entries:
        full = os.path.join(dir_path, entry)
        try:
            if os.path.isdir(full):
                subdirs.append(full)
                continue
            if not os.path.isfile(full):
                continue
        except OSError:
            continue
        if os.path.splitext(entry)[1].lower() in _REF_IMG_EXTS:
            return True
    for sub in subdirs:
        if _dir_contains_ref_image(sub, _depth + 1, _seen):
            return True
    return False


@PromptServer.instance.routes.get("/xbhh/lora/ref-images")
async def scan_ref_images(request):
    """扫描指定目录下的图片文件，返回列表（文件名、完整路径、大小、修改时间）。
    前端传入 path 参数（绝对路径或相对 ComfyUI 根目录的路径）。
    """
    raw_path = request.query.get("path", "").strip()
    if not raw_path:
        return web.json_response({"error": "Missing parameter 'path'"}, status=400)

    # 支持相对路径（相对 ComfyUI 根目录）
    dir_path = raw_path
    if not os.path.isabs(dir_path):
        dir_path = os.path.join(folder_paths.base_path, dir_path)

    dir_path = os.path.normpath(dir_path)
    if not os.path.isdir(dir_path):
        return web.json_response({"error": f"Directory not found: {dir_path}"}, status=404)

    images = []
    try:
        for entry in os.listdir(dir_path):
            full = os.path.join(dir_path, entry)
            if not os.path.isfile(full):
                continue
            ext = os.path.splitext(entry)[1].lower()
            if ext not in _REF_IMG_EXTS:
                continue
            try:
                stat = os.stat(full)
                images.append({
                    "name": entry,
                    "path": full,
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime),
                })
            except OSError:
                continue
    except OSError as e:
        return web.json_response({"error": str(e)}, status=500)

    # 按文件名排序
    images.sort(key=lambda x: x["name"].lower())
    return web.json_response({"path": dir_path, "images": images})


# ── 系统「选择文件夹」对话框（Windows COM，进程内调用，不启动任何外部进程）────────
# 使用 IFileDialog + FOS_PICKFOLDERS，即与「选文件」完全同款的现代文件夹选择器。
# 之所以不再用 PowerShell：启动 powershell.exe 会被火绒等安全软件的行为拦截，
# 子进程被静默拦下后不会返回，前端就一直卡在「选择中」。
if os.name == "nt":
    class _GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_ulong),
            ("Data2", ctypes.c_ushort),
            ("Data3", ctypes.c_ushort),
            ("Data4", ctypes.c_ubyte * 8),
        ]

        def __init__(self, value=None):
            super().__init__()
            if not value:
                return
            a, b, c, d, e = value.strip("{}").split("-")
            self.Data1 = int(a, 16)
            self.Data2 = int(b, 16)
            self.Data3 = int(c, 16)
            for i, byte in enumerate(bytes.fromhex(d + e)):
                self.Data4[i] = byte

    _CLSID_FILE_OPEN_DIALOG = _GUID("{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}")
    _IID_IFILE_OPEN_DIALOG = _GUID("{D57C7288-D4AD-4768-BE02-9D969532D960}")
    _IID_ISHELL_ITEM = _GUID("{43826D1E-E718-42EE-BC55-A1E261C37BFE}")

    _FOS_PICKFOLDERS = 0x00000020
    _FOS_FORCEFILESYSTEM = 0x00000040
    _FOS_PATHMUSTEXIST = 0x00000800
    _SIGDN_FILESYSPATH = 0x80058000
    _COINIT_APARTMENTTHREADED = 0x2
    _HR_CANCELLED = -2147023673  # 0x800704C7 ERROR_CANCELLED


def _com_vtable(ptr):
    return ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]


def _com_method(ptr, index, restype, *argtypes):
    """按 vtable 下标取出 COM 接口方法（下标 0/1/2 为 IUnknown）。"""
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(_com_vtable(ptr)[index])


def _com_release(ptr):
    ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(_com_vtable(ptr)[2])(ptr)


def _pick_directory_dialog(initial=""):
    """弹出与「选文件」同款的 Windows 现代「选择文件夹」对话框，返回所选目录路径。

    全程在当前进程内通过 COM 完成，不启动任何外部进程（避免被杀软行为拦截）。
    用户取消或调用失败时返回 None。
    """
    if os.name != "nt":
        return None

    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32
    user32 = ctypes.windll.user32

    ole32.CoCreateInstance.restype = ctypes.c_int32
    ole32.CoCreateInstance.argtypes = [
        ctypes.POINTER(_GUID), ctypes.c_void_p, ctypes.c_ulong,
        ctypes.POINTER(_GUID), ctypes.POINTER(ctypes.c_void_p),
    ]
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    shell32.SHCreateItemFromParsingName.restype = ctypes.c_int32
    shell32.SHCreateItemFromParsingName.argtypes = [
        ctypes.c_wchar_p, ctypes.c_void_p, ctypes.POINTER(_GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    user32.GetForegroundWindow.restype = ctypes.c_void_p

    # 对话框要求 STA 线程；asyncio.to_thread 用的线程可能是新的，这里显式初始化
    ole32.CoInitializeEx(None, _COINIT_APARTMENTTHREADED)

    dialog = ctypes.c_void_p()
    hr = ole32.CoCreateInstance(
        ctypes.byref(_CLSID_FILE_OPEN_DIALOG), None, 1,
        ctypes.byref(_IID_IFILE_OPEN_DIALOG), ctypes.byref(dialog),
    )
    if hr != 0 or not dialog.value:
        print(f"[xbhh] 创建文件夹选择对话框失败: 0x{hr & 0xFFFFFFFF:08X}")
        return None

    try:
        get_options = _com_method(dialog, 10, ctypes.c_int32, ctypes.POINTER(ctypes.c_ulong))
        set_options = _com_method(dialog, 9, ctypes.c_int32, ctypes.c_ulong)
        set_title = _com_method(dialog, 17, ctypes.c_int32, ctypes.c_wchar_p)
        set_folder = _com_method(dialog, 12, ctypes.c_int32, ctypes.c_void_p)
        show = _com_method(dialog, 3, ctypes.c_int32, ctypes.c_void_p)
        get_result = _com_method(dialog, 20, ctypes.c_int32, ctypes.POINTER(ctypes.c_void_p))

        options = ctypes.c_ulong(0)
        get_options(dialog, ctypes.byref(options))
        set_options(dialog, options.value | _FOS_PICKFOLDERS | _FOS_FORCEFILESYSTEM | _FOS_PATHMUSTEXIST)
        set_title(dialog, "选择参考图目录")

        if initial and os.path.isdir(initial):
            item = ctypes.c_void_p()
            if shell32.SHCreateItemFromParsingName(
                initial, None, ctypes.byref(_IID_ISHELL_ITEM), ctypes.byref(item)
            ) == 0 and item.value:
                set_folder(dialog, item)
                _com_release(item)

        # 用当前前台窗口（通常是浏览器）作为 owner，确保对话框显示在最前面而不是被挡住
        hr = show(dialog, user32.GetForegroundWindow())
        if hr != 0:
            if hr != _HR_CANCELLED:
                print(f"[xbhh] 文件夹选择对话框返回异常: 0x{hr & 0xFFFFFFFF:08X}")
            return None

        item = ctypes.c_void_p()
        if get_result(dialog, ctypes.byref(item)) != 0 or not item.value:
            return None
        try:
            get_display_name = _com_method(
                item, 5, ctypes.c_int32, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)
            )
            buf = ctypes.c_void_p()
            if get_display_name(item, _SIGDN_FILESYSPATH, ctypes.byref(buf)) != 0 or not buf.value:
                return None
            try:
                return ctypes.wstring_at(buf.value)
            finally:
                ole32.CoTaskMemFree(buf)
        finally:
            _com_release(item)
    finally:
        _com_release(dialog)


@PromptServer.instance.routes.post("/xbhh/lora/pick-directory")
async def pick_directory(request):
    """弹出系统原生「选择文件夹」对话框，返回所选目录的绝对路径。
    对话框出现在「运行 ComfyUI 的机器」上，因此仅适用于 ComfyUI 与本浏览器在同一台机器的场景。
    """
    try:
        data = await request.json()
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    initial = (data.get("initial") or "").strip()

    selected = await asyncio.to_thread(_pick_directory_dialog, initial)
    if not selected:
        return web.json_response({"cancelled": True})
    return web.json_response({"path": os.path.normpath(selected)})


@PromptServer.instance.routes.get("/xbhh/lora/ref-subdirs")
async def list_ref_subdirs(request):
    """列出指定目录下的子目录（仅返回递归包含图片的子目录），供参考图侧栏树状展开。
    前端传入 path 参数（绝对路径或相对 ComfyUI 根目录的路径）。
    """
    raw_path = request.query.get("path", "").strip()
    if not raw_path:
        return web.json_response({"error": "Missing parameter 'path'"}, status=400)

    dir_path = raw_path
    if not os.path.isabs(dir_path):
        dir_path = os.path.join(folder_paths.base_path, dir_path)

    dir_path = os.path.normpath(dir_path)
    if not os.path.isdir(dir_path):
        return web.json_response({"error": f"Directory not found: {dir_path}"}, status=404)

    try:
        names = sorted(os.listdir(dir_path), key=lambda s: s.lower())
    except OSError as e:
        return web.json_response({"error": str(e)}, status=500)

    dirs = []
    for entry in names:
        full = os.path.join(dir_path, entry)
        try:
            if not os.path.isdir(full):
                continue
        except OSError:
            continue
        if not _dir_contains_ref_image(full):
            continue
        dirs.append({"name": entry, "path": os.path.normpath(full)})

    return web.json_response({"path": dir_path, "dirs": dirs})


@PromptServer.instance.routes.get("/xbhh/lora/ref-image")
async def serve_ref_image(request):
    """从任意路径提供图片文件服务（参考图用），支持 ?thumb=<width> 缩略图。
    路径通过 ?path=<file_path> 参数传入。
    """
    raw_path = request.query.get("path", "").strip()
    if not raw_path:
        return web.Response(status=400, text="Missing 'path'")

    file_path = _resolve_ref_path(raw_path) or raw_path

    # 安全限制：只允许图片扩展名
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in _REF_IMG_EXTS:
        return web.Response(status=403, text="Not an image file")

    if not os.path.isfile(file_path):
        return web.Response(status=404, text="File not found")

    filename = os.path.basename(file_path)
    headers = {
        "Content-Disposition": f'filename="{filename}"',
        "Cache-Control": "no-cache",
    }

    # 缩略图分支：复用 lora_loader 的缩略图缓存逻辑
    thumb_param = request.query.get("thumb")
    if thumb_param:
        try:
            width = int(thumb_param)
        except (TypeError, ValueError):
            width = 0
        if 16 <= width <= 2048:
            try:
                from .lora_loader import _get_or_create_thumbnail
                import asyncio
                loop = asyncio.get_event_loop()
                thumb_path = await loop.run_in_executor(
                    None, _get_or_create_thumbnail, file_path, width
                )
                if thumb_path:
                    return web.FileResponse(thumb_path, headers=headers)
            except Exception:
                pass  # 缩略图失败回退原图

    return web.FileResponse(file_path, headers=headers)


def _resolve_ref_path(raw_path):
    """将参考图路径解析为绝对路径。
    绝对路径直接返回；相对路径先按 ComfyUI 根目录解析，找不到再依次尝试各个 LoRA 根目录。
    """
    if not raw_path:
        return None
    p = raw_path.strip()
    if not p:
        return None
    if os.path.isabs(p):
        return os.path.normpath(p)
    cand = os.path.normpath(os.path.join(folder_paths.base_path, p))
    if os.path.exists(cand):
        return cand
    try:
        for lp in folder_paths.get_folder_paths("loras") or []:
            c2 = os.path.normpath(os.path.join(lp, p))
            if os.path.exists(c2):
                return c2
    except Exception:
        pass
    return cand


def _safe_ref_filename(name):
    """校验参考图文件名：必须是纯文件名，禁止路径分隔符与 . / .."""
    name = (name or "").strip()
    if not name or name in (".", ".."):
        return None
    if "/" in name or "\\" in name:
        return None
    if os.path.basename(name) != name:
        return None
    return name


@PromptServer.instance.routes.post("/xbhh/lora/send-to-input")
async def send_ref_image_to_input(request):
    """把参考图复制进 ComfyUI 的 input 目录，返回「加载图片」节点可直接使用的图片名。

    body: {"path": "<绝对路径或相对 ComfyUI 根目录的路径>"}
    返回: {"ok": true, "name": "...", "subfolder": "xbhh_ref", "path": "xbhh_ref/xxx.png"}
    统一放进 input/xbhh_ref/ 子目录，避免污染用户自己的 input 图片；
    同名且大小一致时直接复用，避免反复发送同一张图撑大磁盘。
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    src = _resolve_ref_path((data or {}).get("path"))
    if not src or not os.path.isfile(src):
        return web.json_response({"ok": False, "error": "找不到参考图文件"}, status=404)

    ext = os.path.splitext(src)[1].lower()
    if ext not in _REF_IMG_EXTS:
        return web.json_response({"ok": False, "error": "不是受支持的图片格式"}, status=403)

    try:
        input_dir = folder_paths.get_input_directory()
    except Exception as e:
        return web.json_response({"ok": False, "error": f"无法定位 input 目录：{e}"}, status=500)

    subfolder = "xbhh_ref"
    dest_dir = os.path.join(input_dir, subfolder)
    try:
        os.makedirs(dest_dir, exist_ok=True)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"无法创建目录：{e}"}, status=500)

    base_name = os.path.basename(src)
    candidate = base_name
    dest = os.path.join(dest_dir, candidate)
    if os.path.exists(dest):
        # 同名且大小一致 → 视为同一张图，直接复用；否则追加 _1 / _2 ... 另存
        try:
            same = os.path.getsize(dest) == os.path.getsize(src)
        except OSError:
            same = False
        if not same:
            stem, _ext = os.path.splitext(base_name)
            seq = 1
            while os.path.exists(os.path.join(dest_dir, candidate)):
                candidate = f"{stem}_{seq}{_ext}"
                seq += 1
            dest = os.path.join(dest_dir, candidate)

    if not os.path.exists(dest):
        try:
            shutil.copy2(src, dest)
        except Exception as e:
            return web.json_response({"ok": False, "error": f"复制失败：{e}"}, status=500)

    return web.json_response({
        "ok": True,
        "name": candidate,
        "subfolder": subfolder,
        "path": f"{subfolder}/{candidate}",
        "type": "input",
    })


@PromptServer.instance.routes.post("/xbhh/lora/ref-image/upload")
async def upload_ref_image(request):
    """上传参考图到指定目录，支持一次多个文件；重名时自动追加序号。"""
    try:
        reader = await request.multipart()
        target_dir = None
        pending = []  # [(filename, content_type, bytes)]

        async for part in reader:
            if part.name == "dir":
                target_dir = (await part.read()).decode("utf-8").strip()
            elif part.name == "image":
                filename = _safe_ref_filename(part.filename)
                data = await part.read()
                pending.append((filename, part.headers.get("Content-Type", ""), data))

        if target_dir:
            dir_path = _resolve_ref_path(target_dir)
            if not dir_path:
                return web.json_response({"error": "Missing parameter 'dir'"}, status=400)
            if not os.path.isdir(dir_path):
                return web.json_response({"error": f"Directory not found: {dir_path}"}, status=404)
        else:
            # 未指定目录（如配方预览图上传）：落到 LoRA 目录下的内置目录，不存在则自动创建
            dir_path, _rel_dir = _get_recipe_preview_dir()
            if not dir_path or not os.path.isdir(dir_path):
                return web.json_response({"error": "无法创建配方预览图目录"}, status=500)
        if not pending:
            return web.json_response({"error": "No image file provided"}, status=400)

        saved = []
        for filename, _ctype, data in pending:
            if not filename:
                continue
            ext = os.path.splitext(filename)[1].lower()
            if ext not in _REF_IMG_EXTS:
                continue
            stem = os.path.splitext(filename)[0]

            # 重名时自动追加 _1 / _2 ...
            candidate = filename
            base = os.path.join(dir_path, candidate)
            seq = 1
            while os.path.exists(base):
                candidate = f"{stem}_{seq}{ext}"
                base = os.path.join(dir_path, candidate)
                seq += 1

            with open(base, "wb") as f:
                f.write(data)
            saved.append(candidate)

        if not saved:
            return web.json_response({"error": "No valid image saved"}, status=400)

        rel_dir = _to_rel_or_abs(dir_path)
        return web.json_response({
            "success": True,
            "saved": saved,
            "dir": dir_path,
            "rel_dir": rel_dir,
            "paths": [os.path.join(dir_path, n) for n in saved],
            # 相对路径（相对 ComfyUI 根目录），配方的 preview 字段存这个，才能随 LoRA 目录整体搬迁
            "rel_paths": [_join_rel(rel_dir, n) for n in saved],
        })

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ============================================================================
# 参考图回收站（软删除）
#   删除 = 把文件移动到 ComfyUI/user/xbhh/ref_trash/<时间戳-uuid>/，
#   并在该条目目录里写 manifest.json（记录原路径 / 原名 / 删除时间），
#   还原 = 反向 move 回原路径。这样误删永远可救。
# ============================================================================

_REF_TRASH_DIRNAME = "ref_trash"


def _get_ref_trash_root():
    """参考图回收站根目录（user/xbhh/ref_trash），不存在则创建。"""
    root = os.path.join(lora_database.get_xbhh_user_dir(), _REF_TRASH_DIRNAME)
    os.makedirs(root, exist_ok=True)
    return root


def _write_json_atomic(path, obj):
    """原子写 JSON：先写临时文件再替换，避免进程中断留下半个文件。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _trash_ref_files(paths):
    """把若干参考图移入一个新的回收站条目。返回 (entry_id, trashed, errors)。"""
    root = _get_ref_trash_root()
    entry_id = "%s-%s" % (
        datetime.datetime.now().strftime("%Y%m%d-%H%M%S"),
        uuid.uuid4().hex[:8],
    )
    entry_dir = os.path.join(root, entry_id)
    os.makedirs(entry_dir, exist_ok=True)

    trashed, errors = [], []
    for src in paths:
        name = os.path.basename(src)
        stem, ext = os.path.splitext(name)
        dst = os.path.join(entry_dir, name)
        # 同一批里可能有同名文件（来自不同目录），补序号避免互相覆盖
        seq = 1
        while os.path.exists(dst):
            dst = os.path.join(entry_dir, "%s_%d%s" % (stem, seq, ext))
            seq += 1
        try:
            shutil.move(src, dst)
        except Exception as e:
            errors.append({"path": src, "error": str(e)})
            continue
        try:
            size = os.path.getsize(dst)
        except OSError:
            size = 0
        trashed.append({
            "name": os.path.basename(dst),
            "orig_name": name,
            "orig_path": src,
            "orig_rel": _to_rel_or_abs(src),
            "size": size,
        })

    if not trashed:
        # 一张都没成功：不留下空条目目录
        try:
            os.rmdir(entry_dir)
        except OSError:
            pass
        return None, trashed, errors

    now = datetime.datetime.now().isoformat(timespec="seconds")
    manifest = {
        "id": entry_id,
        "created_at": now,
        "count": len(trashed),
        "items": [
            {
                "name": t["name"],
                "orig_name": t["orig_name"],
                "orig_path": t["orig_path"],
                "orig_rel": t["orig_rel"],
                "size": t["size"],
                "deleted_at": now,
            }
            for t in trashed
        ],
    }
    _write_json_atomic(os.path.join(entry_dir, "manifest.json"), manifest)
    return entry_id, trashed, errors


@PromptServer.instance.routes.post("/xbhh/lora/ref-image/delete")
async def delete_ref_image(request):
    """删除参考图（软删除）：不真删，而是移入回收站，并写 manifest.json 记录原路径，便于还原。

    请求体支持两种形式（向后兼容）：
      {"path": "<单个文件>"}  或  {"paths": ["<文件1>", "<文件2>"]}
    返回：{success, trash_id, trashed:[{from,name}], errors:[{path,error}]}
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    raw_paths = data.get("paths")
    if not isinstance(raw_paths, list) or not raw_paths:
        single = data.get("path")
        raw_paths = [single] if single else []
    if not raw_paths:
        return web.json_response({"error": "Missing parameter 'path'"}, status=400)

    targets, errors = [], []
    for raw in raw_paths:
        file_path = _resolve_ref_path(raw)
        if not file_path:
            errors.append({"path": raw or "", "error": "Missing 'path'"})
            continue
        if os.path.splitext(file_path)[1].lower() not in _REF_IMG_EXTS:
            errors.append({"path": file_path, "error": "Not an image file"})
            continue
        if not os.path.isfile(file_path):
            errors.append({"path": file_path, "error": "File not found"})
            continue
        targets.append(file_path)

    if not targets:
        return web.json_response({"error": "没有可删除的文件", "errors": errors}, status=404)

    try:
        entry_id, trashed, trash_errors = _trash_ref_files(targets)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    errors.extend(trash_errors)
    return web.json_response({
        "success": True,
        "trash_id": entry_id,
        "trashed": [{"from": t["orig_path"], "name": t["orig_name"]} for t in trashed],
        "errors": errors,
    })


@PromptServer.instance.routes.get("/xbhh/lora/ref-image/trash")
async def list_ref_trash(request):
    """列出回收站条目（供后续回收站 UI 使用）。"""
    root = _get_ref_trash_root()
    try:
        names = sorted(os.listdir(root), reverse=True)
    except OSError:
        names = []

    entries = []
    for name in names:
        entry_dir = os.path.join(root, name)
        if not os.path.isdir(entry_dir):
            continue
        manifest_file = os.path.join(entry_dir, "manifest.json")
        items, created = [], None
        if os.path.isfile(manifest_file):
            try:
                with open(manifest_file, "r", encoding="utf-8") as f:
                    obj = json.load(f)
                items = obj.get("items") or []
                created = obj.get("created_at")
            except Exception:
                items = []
        if not items:
            # manifest 缺失/损坏时，按目录内实际文件兜底展示
            try:
                for fn in os.listdir(entry_dir):
                    if os.path.splitext(fn)[1].lower() in _REF_IMG_EXTS:
                        items.append({"name": fn, "orig_path": "", "orig_name": fn, "size": 0})
            except OSError:
                pass
        if items:
            entries.append({"id": name, "created_at": created, "items": items})
    return web.json_response({"root": root, "entries": entries})


@PromptServer.instance.routes.post("/xbhh/lora/ref-image/trash/restore")
async def restore_ref_trash(request):
    """还原回收站条目（反向 move 回原路径）。body: {id, names?: [...]}（names 省略则整条还原）。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    entry_id = str(data.get("id") or "").strip()
    if not entry_id or entry_id in (".", "..") or "/" in entry_id or "\\" in entry_id:
        return web.json_response({"error": "Invalid id"}, status=400)

    entry_dir = os.path.join(_get_ref_trash_root(), entry_id)
    if not os.path.isdir(entry_dir):
        return web.json_response({"error": "回收站条目不存在"}, status=404)

    manifest_file = os.path.join(entry_dir, "manifest.json")
    manifest = {}
    if os.path.isfile(manifest_file):
        try:
            with open(manifest_file, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}
    items = manifest.get("items") or []

    only = data.get("names")
    only_set = set(only) if isinstance(only, list) and only else None

    restored, errors, remaining = [], [], []
    for it in items:
        src_name = it.get("name") or ""
        if only_set is not None and src_name not in only_set:
            remaining.append(it)
            continue
        src = os.path.join(entry_dir, src_name)
        if not src_name or not os.path.isfile(src):
            errors.append({"name": src_name, "error": "回收站文件已丢失"})
            continue
        orig = it.get("orig_path") or ""
        if not orig:
            errors.append({"name": src_name, "error": "缺少原路径，无法还原"})
            remaining.append(it)
            continue
        target_dir = os.path.dirname(orig)
        try:
            os.makedirs(target_dir, exist_ok=True)
        except Exception as e:
            errors.append({"name": src_name, "error": str(e)})
            remaining.append(it)
            continue
        dst = orig
        # 原位置已被新文件占用时，退让为 xxx_restored_1.ext，绝不覆盖
        if os.path.exists(dst):
            base, ext = os.path.splitext(os.path.basename(orig))
            seq = 1
            while os.path.exists(dst):
                dst = os.path.join(target_dir, "%s_restored_%d%s" % (base, seq, ext))
                seq += 1
        try:
            shutil.move(src, dst)
            restored.append({"name": src_name, "to": dst})
        except Exception as e:
            errors.append({"name": src_name, "error": str(e)})
            remaining.append(it)

    if remaining:
        if len(remaining) != len(items):
            manifest["items"] = remaining
            manifest["count"] = len(remaining)
            try:
                _write_json_atomic(manifest_file, manifest)
            except Exception:
                pass
    else:
        # 整条都还原了：清掉条目目录
        shutil.rmtree(entry_dir, ignore_errors=True)

    return web.json_response({"success": True, "restored": restored, "errors": errors})


@PromptServer.instance.routes.post("/xbhh/lora/recipe-preview/upload")
async def upload_recipe_preview(request):
    """上传配方预览图：按调用方给的 stem（= 配方名_配方ID）命名。
    同一配方 stem 固定，故替换图片即覆盖同一个文件，不会越积越多；
    同时删掉被替换的旧图，以及同 stem 的其他扩展名残留（换过图片格式时）。
    """
    try:
        reader = await request.multipart()
        stem = ""
        old_path = ""
        filename = ""
        data = None

        async for part in reader:
            if part.name == "stem":
                stem = (await part.read()).decode("utf-8").strip()
            elif part.name == "old":
                old_path = (await part.read()).decode("utf-8").strip()
            elif part.name == "image":
                filename = part.filename or ""
                data = await part.read()

        if data is None:
            return web.json_response({"error": "No image file provided"}, status=400)

        ext = os.path.splitext(filename)[1].lower()
        if ext not in _REF_IMG_EXTS:
            return web.json_response({"error": "不支持的图片格式"}, status=400)

        safe_stem = _safe_ref_filename(stem)
        if not safe_stem:
            return web.json_response({"error": "Missing parameter 'stem'"}, status=400)
        safe_stem = os.path.splitext(safe_stem)[0] or safe_stem

        dir_path, _rel_dir = _get_recipe_preview_dir()
        if not dir_path or not os.path.isdir(dir_path):
            return web.json_response({"error": "无法创建配方预览图目录"}, status=500)

        target = os.path.join(dir_path, safe_stem + ext)
        with open(target, "wb") as f:
            f.write(data)

        # 同 stem 但扩展名不同的历史残留（例如由 .png 换成 .jpg）一并清掉
        try:
            for other in os.listdir(dir_path):
                o_stem, o_ext = os.path.splitext(other)
                if o_stem == safe_stem and o_ext.lower() in _REF_IMG_EXTS and o_ext.lower() != ext:
                    _delete_recipe_preview_file(os.path.join(dir_path, other), keep=target)
        except OSError:
            pass

        # 删除被替换掉的旧图（历史遗留的原始文件名 / 旧 stem）
        _delete_recipe_preview_file(old_path, keep=target)

        rel_dir = _to_rel_or_abs(dir_path)
        rel_path = _join_rel(rel_dir, os.path.basename(target))
        return web.json_response({
            "success": True,
            "saved": [os.path.basename(target)],
            "dir": dir_path,
            "rel_dir": rel_dir,
            "paths": [target],
            "rel_paths": [rel_path],
        })

    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/xbhh/lora/recipe-preview/rename")
async def rename_recipe_preview(request):
    """配方改名后，把预览图重命名成新的 stem，保持「配方名_配方ID」的对应关系。
    只处理配方预览目录内的图片；目标已存在时直接覆盖（同一个 stem 必然属于同一配方）。
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    src = _resolve_ref_path(data.get("from"))
    stem = _safe_ref_filename(data.get("stem"))
    if not src or not stem or not os.path.isfile(src):
        return web.json_response({"error": "Invalid parameters"}, status=400)

    ext = os.path.splitext(src)[1].lower()
    if ext not in _REF_IMG_EXTS:
        return web.json_response({"error": "Not an image file"}, status=403)

    dir_path, _rel_dir = _get_recipe_preview_dir(create=False)
    if not dir_path or os.path.normcase(os.path.dirname(os.path.abspath(src))) != os.path.normcase(os.path.abspath(dir_path)):
        # 不在配方预览目录内（历史遗留路径等），保持原样不动
        return web.json_response({"success": True, "rel_path": _to_rel_or_abs(src), "unchanged": True})

    stem = os.path.splitext(stem)[0] or stem
    dst = os.path.join(dir_path, stem + ext)
    if os.path.normcase(dst) != os.path.normcase(src):
        try:
            os.replace(src, dst)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)

    rel_dir = _to_rel_or_abs(dir_path)
    return web.json_response({
        "success": True,
        "rel_path": _join_rel(rel_dir, os.path.basename(dst)),
    })


@PromptServer.instance.routes.post("/xbhh/lora/recipe-preview/delete")
async def delete_recipe_preview(request):
    """删除配方预览图（仅限配方预览目录内的图片）。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    raw = data.get("path")
    if not raw:
        return web.json_response({"error": "Missing parameter 'path'"}, status=400)
    _delete_recipe_preview_file(raw)
    return web.json_response({"success": True})


@PromptServer.instance.routes.post("/xbhh/lora/ref-image/rename")
async def rename_ref_image(request):
    """重命名参考图（仅同目录改名，不改变扩展名类型，防止覆盖已有文件）。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    file_path = _resolve_ref_path(data.get("path"))
    if not file_path:
        return web.json_response({"error": "Missing parameter 'path'"}, status=400)

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in _REF_IMG_EXTS:
        return web.json_response({"error": "Not an image file"}, status=403)
    if not os.path.isfile(file_path):
        return web.json_response({"error": "File not found"}, status=404)

    new_name = _safe_ref_filename(data.get("new_name"))
    if not new_name:
        return web.json_response({"error": "Invalid new name"}, status=400)

    new_ext = os.path.splitext(new_name)[1].lower()
    if new_ext not in _REF_IMG_EXTS:
        # 未提供/非法扩展名时沿用原扩展名
        new_name = os.path.splitext(new_name)[0] + ext

    new_path = os.path.join(os.path.dirname(file_path), new_name)
    if os.path.normcase(new_path) == os.path.normcase(file_path):
        return web.json_response({"success": True, "name": new_name, "path": file_path})
    if os.path.exists(new_path):
        return web.json_response({"error": "目标文件名已存在"}, status=409)

    try:
        os.rename(file_path, new_path)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"success": True, "name": new_name, "path": new_path})


def _suggest_free_name(dest_dir, name, taken):
    """在目标目录里为一个重名文件找一个不冲突的新名字（stem_1 / stem_2 ...）。
    taken 是本批次内已占用的名字集合（归一化后），避免同批多张图撞名。
    """
    stem, ext = os.path.splitext(name)
    cand = name
    seq = 1
    while os.path.exists(os.path.join(dest_dir, cand)) or os.path.normcase(cand) in taken:
        cand = f"{stem}_{seq}{ext}"
        seq += 1
    return cand


@PromptServer.instance.routes.post("/xbhh/lora/ref-image/move")
async def move_ref_images(request):
    """把一张或多张参考图移动到目标目录（磁盘真实移动）。

    请求体：
      {
        "dest_dir": "<绝对或相对路径>",
        "items": [{"path": "<源文件路径>", "name": "<可选：目标文件名>"}],
        "dry_run": false   # true 时只做预检，不移动任何文件
      }
    返回：
      {success, dry_run, dest_dir, moved:[{from,to,name}], conflicts:[{path,name,target,suggested}], errors:[{path,error}]}

    安全约定：绝不覆盖同名文件；遇到冲突只报告并附建议名，由前端改名后重试。
    跨盘（Windows 不同盘符）也能移动（shutil.move 内部退化为复制 + 删除）。
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    dest_dir = _resolve_ref_path(data.get("dest_dir"))
    if not dest_dir:
        return web.json_response({"error": "Missing parameter 'dest_dir'"}, status=400)
    if not os.path.isdir(dest_dir):
        return web.json_response({"error": f"目标目录不存在：{dest_dir}"}, status=404)

    items = data.get("items")
    if not isinstance(items, list) or not items:
        return web.json_response({"error": "Missing parameter 'items'"}, status=400)

    dry_run = bool(data.get("dry_run"))
    moved, conflicts, errors = [], [], []
    # 本批次内已确定的/已建议的目标名（归一化），保证同批不会撞名
    taken = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        src = _resolve_ref_path(item.get("path"))
        if not src or not os.path.isfile(src):
            continue
        raw_name = (item.get("name") or "").strip()
        name = _safe_ref_filename(raw_name) if raw_name else os.path.basename(src)
        if name:
            taken.add(os.path.normcase(name))

    for item in items:
        if not isinstance(item, dict):
            continue
        src = _resolve_ref_path(item.get("path"))
        if not src:
            errors.append({"path": item.get("path") or "", "error": "Missing 'path'"})
            continue
        ext = os.path.splitext(src)[1].lower()
        if ext not in _REF_IMG_EXTS:
            errors.append({"path": src, "error": "Not an image file"})
            continue
        if not os.path.isfile(src):
            errors.append({"path": src, "error": "File not found"})
            continue

        # 目标文件名：显式指定优先，否则沿用源文件名；扩展名非法时沿用源扩展名
        raw_name = (item.get("name") or "").strip()
        if raw_name:
            target_name = _safe_ref_filename(raw_name)
            if not target_name:
                errors.append({"path": src, "error": "非法的目标文件名"})
                continue
            if os.path.splitext(target_name)[1].lower() not in _REF_IMG_EXTS:
                target_name = os.path.splitext(target_name)[0] + ext
        else:
            target_name = os.path.basename(src)

        dst = os.path.join(dest_dir, target_name)
        # 源与目标完全一致：无需移动
        if os.path.normcase(src) == os.path.normcase(dst):
            continue

        if dry_run:
            # 预检阶段：与磁盘已有文件、或同批已占用名字冲突，都视为冲突
            if os.path.exists(dst):
                sug = _suggest_free_name(dest_dir, target_name, taken)
                taken.add(os.path.normcase(sug))
                conflicts.append({
                    "path": src,
                    "name": os.path.basename(src),
                    "target": target_name,
                    "suggested": sug,
                })
            else:
                taken.add(os.path.normcase(target_name))
                moved.append({"from": src, "to": dst, "name": target_name})
            continue

        # 正式执行：绝不覆盖，存在即跳过并报冲突
        if os.path.exists(dst):
            sug = _suggest_free_name(dest_dir, target_name, taken)
            taken.add(os.path.normcase(sug))
            conflicts.append({
                "path": src,
                "name": os.path.basename(src),
                "target": target_name,
                "suggested": sug,
            })
            continue
        try:
            shutil.move(src, dst)
            moved.append({"from": src, "to": dst, "name": target_name})
        except Exception as e:
            errors.append({"path": src, "error": str(e)})

    return web.json_response({
        "success": True,
        "dry_run": dry_run,
        "dest_dir": dest_dir,
        "moved": moved,
        "conflicts": conflicts,
        "errors": errors,
    })


@PromptServer.instance.routes.post("/xbhh/lora/reveal")
async def reveal_lora_file(request):
    """在资源管理器中定位 LoRA 文件（explorer /select 选中并打开所在文件夹）"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = (data.get("name") or "").strip()
    if not name:
        return web.json_response({"error": "Missing 'name'"}, status=400)

    conn = lora_database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT file_path FROM lora_global WHERE name = ?", (name,))
    row = cursor.fetchone()
    conn.close()

    file_path = row["file_path"] if row else ""
    if not file_path or not os.path.isfile(file_path):
        return web.json_response({"error": "File not found"}, status=404)

    try:
        # 这里必须传命令行字符串，不能传参数列表：传列表时 subprocess 会给含空格的
        # 参数整体加引号，变成 explorer "/select,D:\a b\c.safetensors"，而 explorer
        # 解析不了这种形式，会退化成打开「文档」文件夹。
        # explorer 返回码恒为 1，不作为失败依据
        subprocess.Popen(f'explorer /select,"{os.path.normpath(file_path)}"')
        return web.json_response({"success": True, "path": file_path})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/xbhh/lora/civitai-link")
async def civitai_link(request):
    """按文件 hash 解析 Civitai 模型页 ID（前端据此打开 civitai.com/models/{id}）"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = (data.get("name") or "").strip()
    if not name:
        return web.json_response({"error": "Missing 'name'"}, status=400)

    conn = lora_database.get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT hash FROM lora_global WHERE name = ?", (name,))
    row = cursor.fetchone()
    conn.close()

    if not row or not row["hash"]:
        return web.json_response({"error": "LoRA hash not found"}, status=404)

    model_id = await asyncio.to_thread(lora_database.fetch_civitai_model_id, row["hash"])
    return web.json_response({"success": bool(model_id), "model_id": model_id})


def _locate_lora_file(name, model_hash=""):
    """复检本地是否已有该 LoRA，返回相对路径，找不到返回 ""。

    依次按 完整相对路径 / 文件名 / 去扩展名的文件名 / 数据库 hash 定位。
    最后一档仍要求文件真实存在，避免数据库里的残留记录把已删除的文件误判为「存在」。
    """
    _rel_files, dir_names = _scan_lora_tree()

    def hit(rel_dir_l, fname_l):
        actual = dir_names.get((rel_dir_l, fname_l))
        if not actual:
            return ""
        return f"{rel_dir_l}/{actual[0]}" if rel_dir_l else actual[0]

    target_l = str(name or "").replace("\\", "/").strip().lstrip("/").lower()
    if target_l:
        rel_dir_l, _, fname_l = target_l.rpartition("/")
        found = hit(rel_dir_l, fname_l)
        if found:
            return found
        # 配方里记的是旧目录：文件被挪到别的子目录时按文件名兜底
        for (d_l, f_l) in dir_names:
            if f_l == fname_l:
                return hit(d_l, f_l)
        # 配方里可能只存了不带扩展名的名字
        stem_l = os.path.splitext(fname_l)[0]
        if stem_l:
            for (d_l, f_l) in dir_names:
                if os.path.splitext(f_l)[0] == stem_l:
                    return hit(d_l, f_l)

    if model_hash:
        row = None
        try:
            conn = lora_database.get_db_connection()
            cursor = conn.cursor()
            if len(model_hash) == 64:
                cursor.execute("SELECT name FROM lora_global WHERE hash = ?", (model_hash,))
            else:
                # Civitai 的 AutoV2 只有 10~12 位，是本地 64 位 SHA256 的前缀
                cursor.execute("SELECT name FROM lora_global WHERE hash LIKE ?", (model_hash + "%",))
            row = cursor.fetchone()
            conn.close()
        except Exception:
            row = None
        if row and row["name"]:
            db_name_l = str(row["name"]).replace("\\", "/").strip().lstrip("/").lower()
            rel_dir_l, _, fname_l = db_name_l.rpartition("/")
            return hit(rel_dir_l, fname_l)
    return ""


@PromptServer.instance.routes.post("/xbhh/lora/exists")
async def check_lora_exists(request):
    """下载前复检：文件可能刚被移动/移回，前端缓存不一定是最新的。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = str(data.get("name") or "").strip()
    model_hash = str(data.get("hash") or "").strip().lower()
    if not name and not model_hash:
        return web.json_response({"error": "缺少 name 或 hash"}, status=400)

    found = await asyncio.to_thread(_locate_lora_file, name, model_hash)
    return web.json_response({"success": True, "exists": bool(found), "name": found})


def _civitai_search_query(name):
    """把 LoRA 文件名整理成适合搜索的关键词（去目录/扩展名，下划线连字符换空格）。"""
    base = os.path.splitext(os.path.basename((name or "").replace("\\", "/")))[0]
    for ch in ("_", "-"):
        base = base.replace(ch, " ")
    return " ".join(base.split())


@PromptServer.instance.routes.post("/xbhh/lora/civitai-resolve")
async def civitai_resolve(request):
    """为「未找到本地文件」的 LoRA 查找 Civitai 候选。
    优先按 hash 精确定位（分享文本携带 hash / 本地库记录），否则按文件名搜索。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = (data.get("name") or "").strip()
    lora_hash = (data.get("hash") or "").strip()

    if not lora_hash and name:
        conn = lora_database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT hash FROM lora_global WHERE name = ?", (name,))
        row = cursor.fetchone()
        conn.close()
        if row and row["hash"]:
            lora_hash = row["hash"]

    candidates = []
    source = ""
    message = ""

    if lora_hash:
        cand = await asyncio.to_thread(lora_database.resolve_civitai_by_hash, lora_hash)
        if cand:
            candidates = [cand]
            source = "hash"

    if not candidates:
        query = _civitai_search_query(name)
        if query:
            found = await asyncio.to_thread(lora_database.search_civitai_models, query, 6)
            if found:
                candidates = found
                source = "search"
            else:
                message = "未在 Civitai 找到匹配的 LoRA"
        elif not message:
            message = "缺少可用的 LoRA 名称或 hash"

    bridge_available = await asyncio.to_thread(lora_database.civitai_bridge_health)

    return web.json_response({
        "success": bool(candidates),
        "source": source,
        "hash": lora_hash,
        "candidates": candidates,
        "bridge_available": bridge_available,
        "message": message,
    })


@PromptServer.instance.routes.post("/xbhh/lora/civitai-download")
async def civitai_download(request):
    """下载补齐：优先交给本机 CivitaiFreeTool，连不上则用内置下载器（落到 LoRA 根目录）。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    candidate = data.get("candidate") if isinstance(data.get("candidate"), dict) else data
    if not isinstance(candidate, dict):
        return web.json_response({"error": "无效的下载候选"}, status=400)
    if not (candidate.get("download_url") or candidate.get("version_id")):
        return web.json_response({"error": "该候选没有可用的下载地址"}, status=400)

    # mode="native"：跳过本机 CivitaiFreeTool，直接用内置下载器（前端「直连内置」按钮）
    force_native = str(data.get("mode") or "").strip().lower() == "native"
    bridge_available = False
    if not force_native:
        bridge_available = await asyncio.to_thread(lora_database.civitai_bridge_health)
    if bridge_available:
        target_url = (candidate.get("download_url") or "").strip()
        if not target_url and candidate.get("version_id"):
            target_url = f"https://civitai.com/api/download/models/{candidate.get('version_id')}"
        ok, msg = await asyncio.to_thread(lora_database.civitai_bridge_download, target_url)
        if ok:
            return web.json_response({"success": True, "mode": "bridge", "message": msg})

    result = await asyncio.to_thread(lora_database.start_civitai_download, candidate)
    if not result.get("success"):
        return web.json_response({"error": result.get("message") or "启动下载失败"}, status=500)
    return web.json_response({
        "success": True,
        "mode": "native",
        "task_id": result["task_id"],
        "message": "已开始下载（内置下载器）",
    })


@PromptServer.instance.routes.get("/xbhh/lora/civitai-download/status")
async def civitai_download_status(request):
    """查询内置下载任务进度。"""
    task_id = (request.query.get("task_id") or "").strip()
    if not task_id:
        return web.json_response({"error": "Missing 'task_id'"}, status=400)
    task = lora_database.get_civitai_download_task(task_id)
    if not task:
        return web.json_response({"error": "Task not found"}, status=404)
    return web.json_response({"success": True, "task": task})


@PromptServer.instance.routes.post("/xbhh/lora/rename")
async def rename_lora_api(request):
    """重命名 LoRA 文件及其预览图，同步更新数据库"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    old_name = (data.get("name") or "").strip()
    new_basename = (data.get("new_name") or "").strip()
    if not old_name or not new_basename:
        return web.json_response({"error": "缺少 name 或 new_name"}, status=400)

    success, result = await asyncio.to_thread(lora_database.rename_lora, old_name, new_basename)
    if success:
        # 同时失效 lora_loader 的智能列表缓存（/xbhh/loras、LoRA 堆下拉的数据源），
        # 否则 Windows 目录 mtime 延迟期内返回旧名列表
        try:
            from . import lora_loader
            lora_loader.invalidate_lora_list_cache()
        except Exception:
            pass
        return web.json_response({"success": True, **result})
    return web.json_response({"error": result}, status=400)


@PromptServer.instance.routes.get("/xbhh/lora/check-duplicates")
async def check_duplicate_loras_api(request):
    """全局检查重复 LoRA：按文件内容 sha256 判定，不依赖数据库（数据库 hash 为主键，副本会被合并）。"""
    try:
        groups = await asyncio.to_thread(lora_database.find_duplicate_loras)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    total_files = sum(len(g["loras"]) for g in groups)
    # 重复占用：每组保留第一个，其余为可清理的冗余空间
    waste = sum(sum(l["size"] for l in g["loras"][1:]) for g in groups)
    return web.json_response({
        "success": True,
        "groups": groups,
        "total_files": total_files,
        "waste": waste,
    })


@PromptServer.instance.routes.post("/xbhh/lora/delete-files")
async def delete_lora_files_api(request):
    """批量清理重复 LoRA：直接删除主文件 + 同名预览图（硬删除），并移除数据库记录。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    names = data.get("names") or []
    if not isinstance(names, list) or not names:
        return web.json_response({"error": "缺少 names"}, status=400)

    deleted = []
    errors = []
    for name in names:
        name = (name or "").strip()
        if not name:
            continue
        try:
            success, result = await asyncio.to_thread(lora_database.delete_lora_file, name)
        except Exception as e:
            success, result = False, str(e)
        if success:
            deleted.append(name)
        else:
            errors.append({"name": name, "error": result})

    if deleted:
        # 同时失效 lora_loader 的智能列表缓存（/xbhh/loras、LoRA 堆下拉的数据源）
        try:
            from . import lora_loader
            lora_loader.invalidate_lora_list_cache()
        except Exception:
            pass

    return web.json_response({
        "success": True,
        "deleted": deleted,
        "errors": errors,
    })


@PromptServer.instance.routes.post("/xbhh/lora/update-base-model")
async def update_base_model_api(request):
    """手动覆盖 LoRA 底模名（优先于文件元数据，重新扫描不会被覆盖）"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = (data.get("name") or "").strip()
    base_model = (data.get("base_model") or "").strip()
    if not name:
        return web.json_response({"error": "缺少 name"}, status=400)

    ok = await asyncio.to_thread(lora_database.set_base_model_override, name, base_model)
    return web.json_response({"success": ok, "base_model": base_model})


# ============================================================================
# 数据安全：外部清单备份 + 按 hash 重下（Tier 2）
# ============================================================================

@PromptServer.instance.routes.post("/xbhh/lora/backup/export")
async def backup_export_api(request):
    """导出整库清单（文件指纹 + 用户数据）到指定或默认备份目录。
    body: { dir?: string }（可选，导出时临时指定的落点；不传则用设置里的 backup_dir）。"""
    try:
        data = await request.json()
    except Exception:
        data = {}
    raw_dir = (data.get("dir") or "").strip() if isinstance(data, dict) else ""
    result = await asyncio.to_thread(lora_database.export_lora_manifest, raw_dir or None)
    status = 200 if result.get("success") else 500
    return web.json_response(result, status=status)


@PromptServer.instance.routes.get("/xbhh/lora/backup/list")
async def backup_list_api(request):
    """列出备份目录下的清单文件，并回传当前生效的目录。"""
    raw_dir = (request.query.get("dir") or "").strip()
    settings = lora_database.get_settings()
    dir_path = await asyncio.to_thread(lora_database._resolve_backup_dir, raw_dir or None)
    manifests = await asyncio.to_thread(lora_database.list_lora_manifests, raw_dir or None)
    return web.json_response({
        "success": True,
        "dir": dir_path,
        "manifests": manifests,
        "settings_dir": settings.get("backup_dir") or "",
        "auto_enabled": bool(settings.get("backup_auto_enabled")),
        "last_export": settings.get("backup_last_export") or "",
    })


@PromptServer.instance.routes.post("/xbhh/lora/backup/inspect")
async def backup_inspect_api(request):
    """体检：读取清单，按 hash 与当前库比对，返回存在 / 缺失数量与缺失明细。
    body: { path?: string, dir?: string }（path 优先；都不传则读设置目录下的 latest）。"""
    try:
        data = await request.json()
    except Exception:
        data = {}
    path = (data.get("path") or "").strip() if isinstance(data, dict) else ""
    raw_dir = (data.get("dir") or "").strip() if isinstance(data, dict) else ""
    manifest = await asyncio.to_thread(lora_database.read_lora_manifest, path or None, raw_dir or None)
    if not manifest:
        return web.json_response({"error": "未找到可用的备份清单"}, status=404)
    report = await asyncio.to_thread(lora_database.inspect_manifest, manifest)
    report["success"] = True
    report["manifest_path"] = path or ""
    report["manifest_dir"] = raw_dir or ""
    return web.json_response(report)


@PromptServer.instance.routes.post("/xbhh/lora/backup/restore")
async def backup_restore_api(request):
    """一键重下缺失：读取清单 → 体检 → 对缺失项启动后台重下并回写用户数据。
    body: { path?: string, dir?: string, hashes?: string[] }
    hashes 给定时只恢复这些 hash（前端可让用户勾选），否则恢复全部缺失项。"""
    try:
        data = await request.json()
    except Exception:
        data = {}
    path = (data.get("path") or "").strip() if isinstance(data, dict) else ""
    raw_dir = (data.get("dir") or "").strip() if isinstance(data, dict) else ""
    hashes = data.get("hashes") if isinstance(data, dict) else None

    manifest = await asyncio.to_thread(lora_database.read_lora_manifest, path or None, raw_dir or None)
    if not manifest:
        return web.json_response({"error": "未找到可用的备份清单"}, status=404)

    report = await asyncio.to_thread(lora_database.inspect_manifest, manifest)
    missing = report.get("missing") or []
    if isinstance(hashes, list) and hashes:
        wanted = set(str(h).lower() for h in hashes)
        missing = [m for m in missing if m.get("hash") in wanted]
    if not missing:
        return web.json_response({"success": True, "total": 0, "message": "没有需要恢复的缺失文件"})

    result = await asyncio.to_thread(lora_database.start_restore_job, manifest, missing)
    return web.json_response(result)


@PromptServer.instance.routes.get("/xbhh/lora/backup/restore/status")
async def backup_restore_status_api(request):
    """查询恢复任务进度。"""
    job_id = (request.query.get("job_id") or "").strip()
    if not job_id:
        return web.json_response({"error": "Missing 'job_id'"}, status=400)
    job = await asyncio.to_thread(lora_database.get_restore_job, job_id)
    if not job:
        return web.json_response({"error": "Task not found"}, status=404)
    return web.json_response({"success": True, "job": job})


@PromptServer.instance.routes.post("/xbhh/lora/backup/restore/cancel")
async def backup_restore_cancel_api(request):
    """取消进行中的恢复任务。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    job_id = (data.get("job_id") or "").strip()
    if not job_id:
        return web.json_response({"error": "缺少 job_id"}, status=400)
    ok = await asyncio.to_thread(lora_database.cancel_restore_job, job_id)
    return web.json_response({"success": ok})

