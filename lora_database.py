import os
import re
import sqlite3
import json
import hashlib
import struct
import urllib.request
import urllib.error
import urllib.parse
import threading
import time
import shutil
import datetime
import folder_paths

def get_xbhh_user_dir():
    """获取并确保创建 XBHH 在 ComfyUI user 目录下的专属持久化数据文件夹"""
    try:
        if hasattr(folder_paths, "get_user_directory"):
            base_dir = folder_paths.get_user_directory()
        else:
            base_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "user")
            if not os.path.exists(base_dir):
                base_dir = os.path.dirname(os.path.abspath(__file__))
    except Exception:
        base_dir = os.path.dirname(os.path.abspath(__file__))
    
    user_data_dir = os.path.join(base_dir, "xbhh")
    os.makedirs(user_data_dir, exist_ok=True)
    return user_data_dir

def get_db_path():
    """获取数据库完整路径，若 user 目录中无数据库但旧插件目录有，则自动完成迁移"""
    user_data_dir = get_xbhh_user_dir()
    user_db_path = os.path.join(user_data_dir, "lora_trigger_word.db")
    
    # 检查旧插件目录下的数据库
    legacy_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    legacy_db_path = os.path.join(legacy_dir, "lora_trigger_word.db")
    
    # 如果 user 目录数据库不存在，且旧目录存在数据库，则自动迁移
    if not os.path.exists(user_db_path) and os.path.exists(legacy_db_path):
        try:
            print(f"[XBHH DB] 正在从旧路径迁移提示词数据库: {legacy_db_path} -> {user_db_path}")
            shutil.copy2(legacy_db_path, user_db_path)
            print("[XBHH DB] 提示词数据库自动迁移成功！数据已持久化至 ComfyUI user 目录。")
        except Exception as e:
            print(f"[XBHH DB] 数据库迁移失败，错误: {e}")
            return legacy_db_path
            
    return user_db_path

DB_DIR = get_xbhh_user_dir()
DB_PATH = get_db_path()

# Lock for SQLite thread safety
_db_lock = threading.Lock()

# Global stopword list for TF-IDF tag extraction
STOPWORDS = {
    'masterpiece', 'best quality', 'highly detailed', 'ultra-detailed', 'solo',
    '1girl', '1boy', 'girls', 'boys', 'background', 'looking at viewer', 'simple background',
    'blurry', 'watermark', 'signature', 'username', 'jpeg artifacts', 'cropped',
    'worst quality', 'low quality', 'normal quality', 'monochrome', 'grayscale', 'portrait',
    'sketches', 'comic', 'bad anatomy', 'bad hands', 'text', 'error', 'missing fingers',
    'extra digit', 'fewer digits', 'signature', 'watermark', 'username', 'blurry',
    'photorealistic', 'photo', '3d', 'realistic', 'year 2023', 'year 2024', 'sensitive',
    'censored', 'bar censor'
}

def get_db_connection():
    """Get a connection to the SQLite database."""
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initialize SQLite tables and B-Tree indexes."""
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # 1. Global table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS lora_global (
                hash TEXT PRIMARY KEY,
                name TEXT,
                file_path TEXT,
                file_size INTEGER,
                file_mtime REAL,
                user_trigger TEXT,
                auto_trigger TEXT,
                trained_words TEXT,
                metadata TEXT,
                use_count INTEGER DEFAULT 0,
                last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # Create B-Tree indexes for fast name and path queries
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_lora_name ON lora_global (name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_lora_use ON lora_global (use_count)")

        # 检查并为 lora_global 动态追加 profiles 字段（多套提示词预设 Profile）
        cursor.execute("PRAGMA table_info(lora_global)")
        cols = [col[1] for col in cursor.fetchall()]
        if "profiles" not in cols:
            cursor.execute("ALTER TABLE lora_global ADD COLUMN profiles TEXT")
        # 检查并为 lora_global 动态追加 category 字段（LoRA 分类标签，如画风/人物/场景）
        if "category" not in cols:
            cursor.execute("ALTER TABLE lora_global ADD COLUMN category TEXT")
        # base_model 覆盖列：用户手动修改底模名后存此列，优先于文件元数据
        if "base_model_override" not in cols:
            cursor.execute("ALTER TABLE lora_global ADD COLUMN base_model_override TEXT")
        # rating 列：用户手动评级（0-5 星，0 表示未评分）
        if "rating" not in cols:
            cursor.execute("ALTER TABLE lora_global ADD COLUMN rating INTEGER DEFAULT 0")

        # 2. LFU Cache table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS lora_cache (
                hash TEXT PRIMARY KEY,
                name TEXT,
                user_trigger TEXT,
                auto_trigger TEXT,
                trained_words TEXT,
                use_count INTEGER
            )
        """)
        
        conn.commit()
        conn.close()

# ============================================================================
# Safetensors Parsing Helpers (moved here to avoid circular imports)
# ============================================================================
def read_safetensors_metadata(file_path):
    """Read safetensors file metadata header safely."""
    try:
        with open(file_path, 'rb') as f:
            header_size_bytes = f.read(8)
            if len(header_size_bytes) < 8:
                return {}
            header_size = struct.unpack('<Q', header_size_bytes)[0]
            if header_size > 100 * 1024 * 1024: # Limit to 100MB
                return {}
            header_bytes = f.read(header_size)
            header = json.loads(header_bytes)
            return header.get('__metadata__', {})
    except Exception as e:
        print(f"[XBHH DB] Error reading safetensors metadata: {e}")
        return {}

def parse_tag_frequency(metadata):
    """Extract and merge training tag frequencies from ss_tag_frequency metadata."""
    tag_freq_raw = metadata.get('ss_tag_frequency', '')
    if not tag_freq_raw:
        return {}
    try:
        if isinstance(tag_freq_raw, str):
            tag_freq = json.loads(tag_freq_raw)
        else:
            tag_freq = tag_freq_raw
        
        merged = {}
        for dataset_name, tags in tag_freq.items():
            for tag, count in tags.items():
                tag = tag.strip()
                if tag:
                    merged[tag] = merged.get(tag, 0) + count
        
        return dict(sorted(merged.items(), key=lambda x: x[1], reverse=True))
    except Exception:
        return {}

# ============================================================================
# File Hashing
# ============================================================================
def calculate_file_sha256(file_path):
    """Calculate the full SHA-256 hash of a file in chunks."""
    sha256_hash = hashlib.sha256()
    try:
        with open(file_path, "rb") as f:
            for byte_block in iter(lambda: f.read(1024 * 1024), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    except Exception as e:
        print(f"[XBHH DB] Error hashing file {file_path}: {e}")
        return None

# 自动触发词：取训练标签中出现次数最高的前 N 个
AUTO_TRIGGER_TOP_N = 5

def extract_auto_trigger(tags_freq, limit=AUTO_TRIGGER_TOP_N):
    """从 ss_tag_frequency 中按原始出现次数降序提取触发词（非 TF-IDF）。"""
    if not tags_freq:
        return ""

    ranked = [
        (tag.strip(), count)
        for tag, count in tags_freq.items()
        if tag.strip()
        and tag.lower() not in STOPWORDS
        and len(tag.strip()) > 1
        and not tag.strip().isdigit()
    ]
    if not ranked:
        return ""

    ranked.sort(key=lambda x: x[1], reverse=True)
    return ", ".join(tag for tag, _ in ranked[:limit])


def recalculate_auto_triggers(hashes=None):
    """根据训练标签最高频次重新计算模型的 auto_trigger。

    hashes 为 None 时重算全部；否则只重算指定的 hash 列表。
    返回 {hash: 新的 auto_trigger} 便于前端就地更新，避免整页重载。
    """
    results = {}
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()

        if hashes:
            placeholders = ",".join("?" * len(hashes))
            cursor.execute(
                f"SELECT hash, metadata FROM lora_global WHERE hash IN ({placeholders})",
                list(hashes),
            )
        else:
            cursor.execute("SELECT hash, metadata FROM lora_global")
        rows = cursor.fetchall()

        for row in rows:
            m_hash, meta_str = row['hash'], row['metadata']
            if not meta_str:
                continue
            try:
                metadata = json.loads(meta_str)
                tags_freq = parse_tag_frequency(metadata)
                auto_trigger = extract_auto_trigger(tags_freq)
                if auto_trigger:
                    cursor.execute(
                        "UPDATE lora_global SET auto_trigger = ? WHERE hash = ?",
                        (auto_trigger, m_hash),
                    )
                    results[m_hash] = auto_trigger
            except Exception:
                pass

        conn.commit()
        conn.close()

    return results


# 兼容旧函数名
recalculate_all_tfidf = recalculate_auto_triggers

# ============================================================================
# LFU Cache Sync
# ============================================================================
def sync_lfu_cache(limit=50):
    """Rebuild the LFU cache table from lora_global."""
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Clear existing cache
        cursor.execute("DELETE FROM lora_cache")
        
        # Insert Top N models
        cursor.execute("""
            INSERT INTO lora_cache (hash, name, user_trigger, auto_trigger, trained_words, use_count)
            SELECT hash, name, user_trigger, auto_trigger, trained_words, use_count
            FROM lora_global
            ORDER BY use_count DESC, last_used DESC
            LIMIT ?
        """, (limit,))
        
        conn.commit()
        conn.close()

# ============================================================================
# Civitai API Fetch
# ============================================================================
def fetch_civitai_trigger_words(model_hash):
    """Fetch model version trigger words from Civitai API by hash (prioritizes civitai.red for full model catalog)."""
    settings = get_settings()
    api_key = settings.get("civitai_api_key", "").strip()

    domains = ["civitai.red", "civitai.com"]
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                       '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    }
    # Civitai 官方推荐 Bearer 头；同时 URL 携带 ?token= 兼容 civitai.red 镜像
    if api_key:
        headers['Authorization'] = f'Bearer {api_key}'

    # 用于在 token 无效时跨域名短路：避免重复打无效 token 浪费时间
    token_invalid = False

    for domain in domains:
        if token_invalid:
            # 已知 token 无效，不必再请求第二个域名
            break

        url = f"https://{domain}/api/v1/model-versions/by-hash/{model_hash}"
        if api_key:
            url += f"?token={api_key}"

        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode('utf-8'))
                trained_words = data.get('trainedWords', [])
                if trained_words:
                    words_str = ", ".join(trained_words)
                    return words_str
        except urllib.error.HTTPError as e:
            if e.code == 401:
                # token 无效或过期：标记后停止后续重试
                token_invalid = True
                print(f"[XBHH DB] Civitai ({domain}) 返回 401 - API Key 无效或已过期，已停止后续请求")
            elif e.code == 404:
                # 当前域名没找到该 hash 的版本，正常情况，继续尝试下一个域名
                pass
            else:
                print(f"[XBHH DB] Civitai ({domain}) HTTP error for {model_hash}: {e.code} - {e.reason}")
        except Exception as e:
            print(f"[XBHH DB] Error querying Civitai ({domain}) API for {model_hash}: {e}")

    return ""


def fetch_civitai_model_id(model_hash):
    """按文件 hash 查询 Civitai 模型页 ID（by-hash API 返回的 modelId 字段）。
    找到返回正整数，未找到/失败返回 0。"""
    settings = get_settings()
    api_key = settings.get("civitai_api_key", "").strip()

    domains = ["civitai.red", "civitai.com"]
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    }
    if api_key:
        headers['Authorization'] = f'Bearer {api_key}'

    token_invalid = False
    for domain in domains:
        if token_invalid:
            break
        url = f"https://{domain}/api/v1/model-versions/by-hash/{model_hash}"
        if api_key:
            url += f"?token={api_key}"
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode('utf-8'))
                model_id = data.get('modelId')
                if model_id:
                    return int(model_id)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                token_invalid = True
                print(f"[XBHH DB] Civitai ({domain}) 返回 401 - API Key 无效或已过期，已停止后续请求")
            elif e.code == 404:
                pass  # 该域名没有此 hash 的版本，继续尝试下一个域名
            else:
                print(f"[XBHH DB] Civitai ({domain}) HTTP error for {model_hash}: {e.code} - {e.reason}")
        except Exception as e:
            print(f"[XBHH DB] Error querying Civitai ({domain}) API for {model_hash}: {e}")

    return 0


# ============================================================================
# Civitai Resolve & Download（缺失 LoRA 补齐）
# ============================================================================
CIVITAI_BRIDGE_URL = "http://127.0.0.1:47531"
CIVITAI_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

_civitai_download_lock = threading.Lock()
_civitai_download_tasks = {}
_CIVITAI_TASK_TTL = 3600


def _civitai_headers(accept="application/json"):
    settings = get_settings()
    api_key = settings.get("civitai_api_key", "").strip()
    headers = {'User-Agent': CIVITAI_UA, 'Accept': accept}
    if api_key:
        headers['Authorization'] = f'Bearer {api_key}'
    return headers, api_key


def _civitai_api_get(path):
    """双域名（civitai.red / civitai.com）请求 Civitai API。
    返回 (data, error)：data 为解析后的 JSON（失败为 None），error 为简短错误说明。"""
    headers, api_key = _civitai_headers()
    token_invalid = False
    last_error = "请求失败"
    for domain in ["civitai.red", "civitai.com"]:
        if token_invalid:
            break
        url = f"https://{domain}{path}"
        if api_key:
            url += ("&" if "?" in url else "?") + f"token={api_key}"
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=12) as response:
                return json.loads(response.read().decode('utf-8')), ""
        except urllib.error.HTTPError as e:
            if e.code == 401:
                token_invalid = True
                last_error = "API Key 无效或已过期"
                print(f"[XBHH DB] Civitai ({domain}) 返回 401 - API Key 无效或已过期")
            elif e.code == 404:
                last_error = "not_found"
            else:
                last_error = f"HTTP {e.code}"
        except Exception as e:
            last_error = str(e)
    return None, last_error


def _normalize_version(data, source, model=None, model_id=None, model_hash=None):
    """把 Civitai 的 model-version 结构压成前端需要的精简候选。

    data  — by-hash / models 接口里的版本对象
    model — models 列表接口里的模型对象（可选，用于取模型名称）
    """
    if not isinstance(data, dict):
        return None
    files = data.get("files") or []
    f0 = files[0] if files and isinstance(files[0], dict) else {}
    hashes = f0.get("hashes") or {}
    preview = ""
    for img in (data.get("images") or []):
        if isinstance(img, dict) and img.get("url"):
            preview = img["url"]
            break
    mid = model_id or data.get("modelId") or (model.get("id") if isinstance(model, dict) else 0) or 0
    vid = data.get("id") or 0
    name = (model.get("name") if isinstance(model, dict) else "") or data.get("modelName") or ""
    version_name = data.get("name") or ""
    page_url = ""
    if mid:
        page_url = f"https://civitai.com/models/{mid}"
        if vid:
            page_url += f"?modelVersionId={vid}"
    try:
        size_kb = float(f0.get("sizeKB") or 0)
    except Exception:
        size_kb = 0.0
    return {
        "source": source,
        "model_id": int(mid) if mid else 0,
        "version_id": int(vid) if vid else 0,
        "name": str(name),
        "version_name": str(version_name),
        "file_name": str(f0.get("name") or ""),
        "download_url": str(f0.get("downloadUrl") or ""),
        "size_kb": size_kb,
        "base_model": str(data.get("baseModel") or ""),
        "trained_words": data.get("trainedWords") or [],
        "preview": preview,
        "page_url": page_url,
        "hash": str(model_hash or hashes.get("SHA256") or "").lower(),
    }


def resolve_civitai_by_hash(model_hash):
    """按 SHA256 精确定位 Civitai 版本。未找到返回 None。"""
    model_hash = (model_hash or "").strip()
    if not model_hash:
        return None
    data, err = _civitai_api_get(f"/api/v1/model-versions/by-hash/{urllib.parse.quote(model_hash)}")
    if not data:
        return None
    return _normalize_version(data, "hash", model_hash=model_hash)


def search_civitai_models(query, limit=6):
    """按文件名/关键词搜索 Civitai LoRA，返回候选列表（每个模型取最新版本）。"""
    query = (query or "").strip()
    if not query:
        return []
    try:
        limit = max(1, min(12, int(limit)))
    except Exception:
        limit = 6
    path = (f"/api/v1/models?query={urllib.parse.quote(query)}&types=LORA"
            f"&limit={limit}&sort=Most%20Downloaded&nsfw=true")
    data, err = _civitai_api_get(path)
    items = (data or {}).get("items") if isinstance(data, dict) else None
    out = []
    for m in (items or []):
        if not isinstance(m, dict):
            continue
        versions = m.get("versions") or []
        v = versions[0] if versions and isinstance(versions[0], dict) else None
        if not v:
            continue
        cand = _normalize_version(v, "search", model=m, model_id=m.get("id"))
        if cand:
            out.append(cand)
    return out


def civitai_bridge_health():
    """检测本机 CivitaiFreeTool 下载器是否在运行。"""
    try:
        req = urllib.request.Request(CIVITAI_BRIDGE_URL + "/api/health",
                                     headers={'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return isinstance(data, dict) and bool(data.get("ok")) and data.get("app") == "CivitaiFreeTool"
    except Exception:
        return False


def civitai_bridge_download(page_url):
    """把下载任务交给本机 CivitaiFreeTool。返回 (ok, message)。"""
    page_url = (page_url or "").strip()
    if not page_url:
        return False, "缺少下载链接"
    try:
        body = json.dumps({"url": page_url}).encode("utf-8")
        req = urllib.request.Request(
            CIVITAI_BRIDGE_URL + "/api/download", data=body, method="POST",
            headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        if isinstance(data, dict) and data.get("ok"):
            return True, str(data.get("msg") or "已交给 CivitaiFreeTool 下载")
        return False, (str(data.get("msg")) if isinstance(data, dict) else "") or "下载器返回失败"
    except Exception as e:
        return False, f"无法连接 CivitaiFreeTool：{e}"


def get_loras_root_dir():
    """LoRA 主目录（新下载文件落在这里）。"""
    try:
        paths = folder_paths.get_folder_paths("loras")
        if paths:
            return paths[0]
    except Exception:
        pass
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "loras")


def _safe_lora_filename(name):
    name = os.path.basename(str(name or "").replace("\\", "/")).strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    if not name:
        return ""
    if not name.lower().endswith(".safetensors"):
        name = (os.path.splitext(name)[0] if "." in name else name) + ".safetensors"
    return name


def _relative_lora_name(abs_path):
    """绝对路径转 ComfyUI 风格相对名（与 get_filename_list 一致，Windows 用反斜杠）。"""
    root = get_loras_root_dir()
    try:
        rel = os.path.relpath(abs_path, root)
    except Exception:
        rel = os.path.basename(abs_path)
    if rel.startswith(".."):
        rel = os.path.basename(abs_path)
    return rel.replace("/", os.sep)


def _find_lora_by_basename(fname):
    """在所有 LoRA 目录里按文件名（大小写不敏感）找已存在的文件，返回相对名或 ""。

    内置下载器只会往主目录落文件，但用户可能把同名 LoRA 放在子目录里；
    落盘前查一遍可以避免下载出第二份重复文件。
    """
    base_l = os.path.basename(str(fname or "")).lower()
    if not base_l:
        return ""
    try:
        roots = folder_paths.get_folder_paths("loras")
    except Exception:
        return ""
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                if fn.lower() == base_l:
                    return os.path.relpath(os.path.join(dirpath, fn), root)
    return ""


def _update_civitai_task(task_id, **kw):
    with _civitai_download_lock:
        task = _civitai_download_tasks.get(task_id)
        if task:
            task.update(kw)


def start_civitai_download(candidate):
    """启动原生下载任务（后台线程）。返回 {success, task_id} 或 {success:False, message}。"""
    if not isinstance(candidate, dict):
        return {"success": False, "message": "无效的下载候选"}
    now = time.time()
    with _civitai_download_lock:
        for tid in list(_civitai_download_tasks.keys()):
            t = _civitai_download_tasks[tid]
            if t.get("status") in ("done", "error") and now - t.get("created", now) > _CIVITAI_TASK_TTL:
                _civitai_download_tasks.pop(tid, None)
        task_id = f"dl{int(now * 1000)}{len(_civitai_download_tasks)}"
        _civitai_download_tasks[task_id] = {
            "id": task_id, "status": "pending", "progress": 0,
            "downloaded": 0, "total": 0, "message": "准备下载...",
            "file_name": "", "created": now,
        }
    threading.Thread(target=_civitai_download_worker, args=(task_id, candidate), daemon=True).start()
    return {"success": True, "task_id": task_id}


def get_civitai_download_task(task_id):
    with _civitai_download_lock:
        task = _civitai_download_tasks.get(task_id)
        return dict(task) if task else None


def _civitai_download_worker(task_id, candidate):
    """原生下载：流式写入 .part → SHA256 校验 → 落到 LoRA 根目录 → 抓预览图 → 入库。"""
    try:
        download_url = str(candidate.get("download_url") or "").strip()
        version_id = candidate.get("version_id") or 0
        if not download_url and version_id:
            download_url = f"https://civitai.com/api/download/models/{version_id}"
        if not download_url:
            _update_civitai_task(task_id, status="error", message="该候选没有可用的下载地址")
            return

        expected_hash = str(candidate.get("hash") or "").strip().lower()
        fname = _safe_lora_filename(candidate.get("file_name") or candidate.get("name"))
        if not fname:
            fname = f"civitai_{version_id or candidate.get('model_id') or int(time.time())}.safetensors"

        # 落盘前按文件名全目录查重：同名文件可能在子目录里，避免再下一份
        existing = _find_lora_by_basename(fname)
        if existing:
            try:
                from . import lora_loader
                lora_loader.invalidate_lora_list_cache()
            except Exception:
                pass
            _update_civitai_task(task_id, status="done", progress=100,
                                 message="本地已有同名文件，跳过下载", file_name=existing)
            print(f"[XBHH DB] Civitai 补齐跳过（本地已存在）: {existing}")
            return

        root = get_loras_root_dir()
        os.makedirs(root, exist_ok=True)
        target = os.path.join(root, fname)
        if os.path.exists(target):
            base, ext = os.path.splitext(fname)
            target = os.path.join(root, f"{base}_{version_id or int(time.time())}{ext}")
        part_path = target + ".part"

        headers, api_key = _civitai_headers(accept="*/*")
        url = download_url
        if api_key and "token=" not in url:
            url += ("&" if "?" in url else "?") + f"token={api_key}"

        def _open(u):
            return urllib.request.urlopen(urllib.request.Request(u, headers=headers), timeout=30)

        _update_civitai_task(task_id, status="downloading", message="连接中...")
        resp = None
        try:
            resp = _open(url)
        except Exception as first_err:
            alt = url
            if "civitai.red" in url:
                alt = url.replace("civitai.red", "civitai.com")
            elif "civitai.com" in url:
                alt = url.replace("civitai.com", "civitai.red")
            if alt != url:
                try:
                    resp = _open(alt)
                except Exception:
                    resp = None
            if resp is None:
                msg = str(first_err)
                if "401" in msg or "403" in msg:
                    msg = "下载被拒绝（需登录/API Key，或该模型禁止匿名下载）"
                _update_civitai_task(task_id, status="error", message=f"下载失败：{msg}")
                return

        try:
            total = int(resp.headers.get("Content-Length") or 0)
        except Exception:
            total = 0

        digest = hashlib.sha256()
        downloaded = 0
        last_tick = 0.0
        try:
            with open(part_path, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    digest.update(chunk)
                    downloaded += len(chunk)
                    now = time.time()
                    if now - last_tick > 0.3:
                        last_tick = now
                        pct = int(downloaded * 100 / total) if total else 0
                        _update_civitai_task(
                            task_id, status="downloading", progress=pct,
                            downloaded=downloaded, total=total,
                            message=(f"下载中 {pct}%" if total else f"下载中 {downloaded // 1048576} MB"))
        except Exception as e:
            try:
                resp.close()
            except Exception:
                pass
            try:
                if os.path.exists(part_path):
                    os.remove(part_path)
            except Exception:
                pass
            _update_civitai_task(task_id, status="error", message=f"写入失败：{e}")
            return
        try:
            resp.close()
        except Exception:
            pass

        if not downloaded:
            try:
                os.remove(part_path)
            except Exception:
                pass
            _update_civitai_task(task_id, status="error", message="下载内容为空")
            return

        actual_hash = digest.hexdigest()
        if len(expected_hash) == 64 and actual_hash != expected_hash:
            try:
                os.remove(part_path)
            except Exception:
                pass
            _update_civitai_task(
                task_id, status="error",
                message=f"SHA256 校验失败（期望 {expected_hash[:12]}…，实际 {actual_hash[:12]}…）")
            return

        try:
            os.replace(part_path, target)
        except Exception as e:
            _update_civitai_task(task_id, status="error", message=f"保存失败：{e}")
            return

        # 顺带抓一张预览图（命名 <文件名>.preview.png，符合 ComfyUI 预览约定）
        preview_url = str(candidate.get("preview") or "").strip()
        if preview_url:
            try:
                with urllib.request.urlopen(
                        urllib.request.Request(preview_url, headers={'User-Agent': CIVITAI_UA}),
                        timeout=15) as pr:
                    with open(os.path.splitext(target)[0] + ".preview.png", "wb") as pf:
                        pf.write(pr.read())
            except Exception:
                pass

        rel_name = _relative_lora_name(target)
        try:
            scan_single_file(rel_name, target)
        except Exception as e:
            print(f"[XBHH DB] Civitai 补齐后入库失败: {e}")
        try:
            from . import lora_loader
            lora_loader.invalidate_lora_list_cache()
        except Exception:
            pass

        _update_civitai_task(task_id, status="done", progress=100, message="补齐完成",
                             downloaded=downloaded, total=total, file_name=rel_name)
        print(f"[XBHH DB] Civitai 补齐完成: {rel_name}")
    except Exception as e:
        print(f"[XBHH DB] Civitai 下载任务异常: {e}")
        _update_civitai_task(task_id, status="error", message=f"下载任务异常：{e}")


# ============================================================================
# Rename & Base Model Override
# ============================================================================

def rename_lora(old_name, new_basename):
    """重命名 LoRA 文件及其预览图。返回 (success, new_name_or_error)。
    new_basename 不含 .safetensors 后缀；保留原目录路径。
    """
    if not new_basename or not new_basename.strip():
        return False, "新名字不能为空"
    new_basename = new_basename.strip()

    old_path = folder_paths.get_full_path("loras", old_name)
    if not old_path or not os.path.isfile(old_path):
        return False, "LoRA 文件未找到"

    # 组新相对名：保留原目录前缀。
    # 分隔符必须沿用原名：ComfyUI 的 get_filename_list 在 Windows 下返回反斜杠
    # 分隔的相对名（recursive_search 用 os.path.relpath），数据库和前端列表存的
    # 都是这种格式。若一律按 "/" 拼接，子目录下的 LoRA 会丢掉目录前缀，导致
    # 数据库按名字匹配失败、预览图 URL 也指向错误位置。
    if "\\" in old_name:
        sep = "\\"
    elif "/" in old_name:
        sep = "/"
    else:
        sep = ""
    dir_prefix = old_name.rsplit(sep, 1)[0] + sep if sep else ""
    new_filename = new_basename + ".safetensors"
    new_rel_name = dir_prefix + new_filename
    new_path = os.path.join(os.path.dirname(old_path), new_filename)

    # 目标已存在（排除自身大小写改名）
    if os.path.normcase(os.path.abspath(new_path)) != os.path.normcase(os.path.abspath(old_path)) \
            and os.path.isfile(new_path):
        return False, "该名字已存在"

    # 重命名预览图（所有常见后缀）；Windows 下文件可能被短暂占用，重试几次
    old_base = os.path.splitext(old_path)[0]
    new_base = os.path.splitext(new_path)[0]
    for ext in [".png", ".jpg", ".jpeg", ".webp", ".preview.png", ".preview.jpeg", ".preview.webp"]:
        old_img = old_base + ext
        new_img = new_base + ext
        if os.path.isfile(old_img) and os.path.normcase(old_img) != os.path.normcase(new_img):
            for attempt in range(3):
                try:
                    os.rename(old_img, new_img)
                    break
                except OSError as e:
                    if attempt == 2:
                        print(f"[XBHH DB] 预览图重命名失败 {old_img}: {e}")
                    else:
                        time.sleep(0.15)

    # 重命名主文件
    try:
        os.rename(old_path, new_path)
    except OSError as e:
        return False, f"重命名失败: {e}"

    # 更新数据库。
    # 匹配条件带上 file_path：不同调用方传进来的 old_name 分隔符可能不同
    # （"/" 或 "\"），只按名字匹配会漏掉，导致重命名后数据库记录对不上。
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE lora_global SET name = ?, file_path = ? WHERE name = ? OR file_path = ?",
            (new_rel_name, new_path, old_name, old_path)
        )
        conn.commit()
        conn.close()

    # 失效 ComfyUI 文件名缓存。注意：缓存键是文件夹名（"loras"），不是磁盘路径。
    # Windows 目录 mtime 更新有延迟，靠 mtime 检测会短暂返回旧列表（旧名文件已不存在
    # → 列表里整个 LoRA 消失），必须主动按正确键清除
    try:
        folder_paths.filename_list_cache.pop("loras", None)
    except Exception:
        pass

    sync_lfu_cache()

    # 探测重命名后的实际预览图（服务端真相，前端不再自行拼接路径）
    # 格式与 metadata-batch 一致：loras/<相对路径去后缀>.<ext>
    preview_image = None
    preview_mtime = None
    for ext in ["png", "jpg", "jpeg", "webp", "preview.png", "preview.jpeg", "preview.webp"]:
        img_path = new_base + "." + ext
        if os.path.isfile(img_path):
            preview_image = f"loras/{dir_prefix}{new_basename}.{ext}"
            preview_mtime = int(os.path.getmtime(img_path))
            break

    return True, {
        "new_name": new_rel_name,
        "preview_image": preview_image,
        "preview_mtime": preview_mtime,
    }


def _write_manifest_atomic(path, obj):
    """原子写 manifest.json：先写临时文件再替换，避免进程中断留下半个文件。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _find_other_same_content(model_hash, exclude_path, size=None):
    """在 loras 目录里找出内容 hash 相同、但路径不等于 exclude_path 的另一个文件。

    用于「删除某个副本时，把共用记录转交给存活的另一份」。找不到返回 None，
    否则返回 (name, path)。先按文件大小过滤再算 sha256，避免无谓地哈希大文件。
    """
    if not model_hash:
        return None
    exclude = os.path.normcase(os.path.abspath(exclude_path))
    try:
        lora_list = folder_paths.get_filename_list("loras")
    except Exception:
        return None
    for other_name in lora_list:
        try:
            other_path = folder_paths.get_full_path("loras", other_name)
        except Exception:
            continue
        if not other_path or not os.path.isfile(other_path):
            continue
        if os.path.normcase(os.path.abspath(other_path)) == exclude:
            continue
        try:
            st = os.stat(other_path)
        except OSError:
            continue
        if size is not None and st.st_size != size:
            continue
        cached = _dup_hash_cache.get(other_path)
        if cached and cached[0] == st.st_size and abs(cached[1] - st.st_mtime) < 1.0:
            other_hash = cached[2]
        else:
            other_hash = calculate_file_sha256(other_path)
            if not other_hash:
                continue
            _dup_hash_cache[other_path] = (st.st_size, st.st_mtime, other_hash)
        if other_hash == model_hash:
            return other_name, other_path
    return None


def delete_lora_file(name):
    """直接删除 LoRA 主文件及其同名预览图（硬删除），并移除数据库记录。

    返回 (success, {"name", "path", "deleted", "errors"}) 或 (False, error)。
    """
    if not name or not name.strip():
        return False, "名字不能为空"
    name = name.strip()

    file_path = folder_paths.get_full_path("loras", name)
    if not file_path or not os.path.isfile(file_path):
        return False, "LoRA 文件未找到"

    try:
        file_size = os.path.getsize(file_path)
    except OSError:
        file_size = None

    # 收集要删除的文件：主文件 + 同名预览图（与 rename_lora 一致的后缀集合）
    targets = [file_path]
    base = os.path.splitext(file_path)[0]
    for ext in [".png", ".jpg", ".jpeg", ".webp", ".preview.png", ".preview.jpeg", ".preview.webp"]:
        img = base + ext
        if os.path.isfile(img):
            targets.append(img)

    deleted, errors = [], []
    main_deleted = False
    for src in targets:
        # Windows 下文件可能被短暂占用，重试几次
        ok = False
        for attempt in range(3):
            try:
                os.remove(src)
                ok = True
                break
            except OSError as e:
                if attempt == 2:
                    errors.append({"path": src, "error": str(e)})
                    break
                time.sleep(0.15)
        if not ok:
            continue
        if src == file_path:
            main_deleted = True
        deleted.append(os.path.basename(src))

    # 主文件没删掉：视为删除失败
    if not main_deleted:
        err = next((e["error"] for e in errors if e["path"] == file_path), "未知错误")
        return False, f"删除失败: {err}"

    # 处理数据库记录。lora_global 以「文件内容 hash」为主键，内容完全相同的副本会
    # 共用同一条记录（里面存着触发词、预设、评分等）。所以只有当磁盘上已无同内容
    # 副本时才删除该记录；否则把记录转交给存活的另一份，避免删掉一个副本时连累
    # 另一份的提示词一起消失（外部手动删除不动数据库，因此没有这个问题）。
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT hash FROM lora_global WHERE name = ? OR file_path = ?", (name, file_path))
        row = cursor.fetchone()
        conn.close()

    if row:
        # 先释放锁再算 hash：哈希大文件可能耗时，不能占着数据库锁
        survivor = _find_other_same_content(row["hash"], file_path, file_size)
        with _db_lock:
            conn = get_db_connection()
            cursor = conn.cursor()
            if survivor:
                cursor.execute(
                    "UPDATE lora_global SET name = ?, file_path = ? WHERE hash = ?",
                    (survivor[0], survivor[1], row["hash"]),
                )
            else:
                cursor.execute("DELETE FROM lora_global WHERE hash = ?", (row["hash"],))
            conn.commit()
            conn.close()

    # 失效 ComfyUI 文件名缓存（键是文件夹名 "loras"）
    try:
        folder_paths.filename_list_cache.pop("loras", None)
    except Exception:
        pass

    sync_lfu_cache()

    return True, {
        "name": name,
        "path": file_path,
        "deleted": deleted,
        "errors": errors,
    }


# 重复 LoRA 检测的文件哈希缓存：key=文件路径，value=(size, mtime, sha256)。
# 仅在进程内缓存，ComfyUI 重启后首次检查重新计算，避免每次点击都重读大文件。
_dup_hash_cache = {}

# 预览图扩展名（与 get_lora_preview_path / delete_lora_file 保持一致）
_PREVIEW_EXTS = ["png", "jpg", "jpeg", "webp", "preview.png", "preview.jpeg", "preview.webp"]


def _lora_has_preview(file_path):
    """判断 LoRA 是否有同名预览图（决定重复清理时优先保留哪个）。"""
    base = os.path.splitext(file_path)[0]
    for ext in _PREVIEW_EXTS:
        if os.path.isfile(base + "." + ext):
            return True
    return False


def find_duplicate_loras():
    """按文件内容 sha256 找出重复的 LoRA（同一文件的多个副本）。

    为什么不用 lora_global.hash：该表以 hash 为主键，内容相同的副本会被
    scan_single_file 的 ON CONFLICT(hash) 合并成一条记录（后扫描的覆盖先扫描的
    name/file_path），所以数据库里根本看不到重复，另一个文件反而查不到 hash。

    优化：内容相同的副本文件大小必然相同，因此先按 size 分组，只有大小存在冲突的
    文件才需要计算 sha256，绝大多数文件会被直接跳过。
    返回 [{"hash": str, "loras": [{"name", "path", "size", "has_preview"}, ...]}, ...]
    组内已按「优先保留带预览图」排序，故第 0 个即推荐保留项。
    """
    try:
        lora_list = folder_paths.get_filename_list("loras")
    except Exception:
        return []

    # 按文件大小分组：大小唯一的文件不可能是副本，无需读取
    by_size = {}
    for name in lora_list:
        try:
            path = folder_paths.get_full_path("loras", name)
            if not path or not os.path.isfile(path):
                continue
            st = os.stat(path)
        except Exception:
            continue
        by_size.setdefault(st.st_size, []).append((name, path, st.st_size, st.st_mtime))

    by_hash = {}
    for group in by_size.values():
        if len(group) < 2:
            continue
        for name, path, size, mtime in group:
            cached = _dup_hash_cache.get(path)
            if cached and cached[0] == size and abs(cached[1] - mtime) < 1.0:
                model_hash = cached[2]
            else:
                model_hash = calculate_file_sha256(path)
                if not model_hash:
                    continue
                _dup_hash_cache[path] = (size, mtime, model_hash)
            by_hash.setdefault(model_hash, []).append({
                "name": name,
                "path": path,
                "size": size,
                "has_preview": _lora_has_preview(path),
            })

    groups = [{"hash": h, "loras": items} for h, items in by_hash.items() if len(items) > 1]
    # 组内排序：优先保留带预览图的（有预览的排前），其次按名称，保证「保留第一个」语义稳定
    for g in groups:
        g["loras"].sort(key=lambda l: (not l["has_preview"], l["name"]))
    # 占用空间多的排前面
    groups.sort(key=lambda g: sum(l["size"] for l in g["loras"]), reverse=True)
    return groups


def set_base_model_override(name, base_model):
    """设置/清除 LoRA 的底模覆盖名。空字符串清除覆盖。"""
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE lora_global SET base_model_override = ? WHERE name = ?",
            (base_model.strip() if base_model else None, name)
        )
        conn.commit()
        affected = cursor.rowcount
        conn.close()
    # 注意：sync_lfu_cache 内部会获取 _db_lock，绝不能在 with _db_lock 块内调用
    # （非重入锁会自锁死，导致整个应用所有 DB 操作永久挂起）
    sync_lfu_cache()
    return affected > 0


# ============================================================================
# Background Scanning Engine
# ============================================================================
def scan_single_file(lora_name, file_path):
    """Scan and process a single LoRA file. Update database if changed or new."""
    try:
        stat = os.stat(file_path)
        size = stat.st_size
        mtime = stat.st_mtime
    except OSError:
        return
        
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if the file is already scanned and unmodified
        cursor.execute(
            "SELECT hash, name, file_path, file_size, file_mtime FROM lora_global WHERE name = ? OR file_path = ?", 
            (lora_name, file_path)
        )
        row = cursor.fetchone()
        
        if row and row['file_size'] == size and abs(row['file_mtime'] - mtime) < 1.0:
            # 记录在库里但名字/路径对不上（文件被手工改名/移动过，或历史遗留的数据）时
            # 顺手纠正。否则其它按名字查库的接口（触发词、底模覆盖等）都查不到这条
            # 记录，表现为"数据凭空消失"；右键打开文件夹也会因旧路径失效而报文件未找到。
            # 注意「移动」文件不改变 size/mtime，走的就是这个提前返回分支，所以路径
            # 必须在这里一起纠正，否则条目会永远指着旧位置。
            if row['name'] != lora_name or row['file_path'] != file_path:
                cursor.execute(
                    "UPDATE lora_global SET name = ?, file_path = ? WHERE hash = ?",
                    (lora_name, file_path, row['hash'])
                )
                conn.commit()
            conn.close()
            return
            
        conn.close()
        
    # File is new or changed. Needs hashing and scanning.
    print(f"[XBHH DB] Scanning/Hashing new or modified LoRA: {lora_name} ...")
    model_hash = calculate_file_sha256(file_path)
    if not model_hash:
        return
        
    metadata = read_safetensors_metadata(file_path)
    metadata_json = json.dumps(metadata) if metadata else None
    
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if hash already exists under another name (file renamed/copied)
        cursor.execute("SELECT user_trigger, use_count FROM lora_global WHERE hash = ?", (model_hash,))
        existing = cursor.fetchone()
        user_trigger = existing['user_trigger'] if existing else None
        use_count = existing['use_count'] if existing else 0
        
        cursor.execute("""
            INSERT INTO lora_global
            (hash, name, file_path, file_size, file_mtime, user_trigger, metadata, use_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(hash) DO UPDATE SET
                name = excluded.name,
                file_path = excluded.file_path,
                file_size = excluded.file_size,
                file_mtime = excluded.file_mtime,
                metadata = excluded.metadata
        """, (model_hash, lora_name, file_path, size, mtime, user_trigger, metadata_json, use_count))
        
        conn.commit()
        conn.close()

def run_background_scanner():
    """Full scan of all LoRAs in the background thread."""
    def worker():
        # Delay slightly to allow ComfyUI startup to complete
        time.sleep(3)
        print("[XBHH DB] Starting background LoRA database scan...")
        
        lora_list = folder_paths.get_filename_list("loras")
        for lora_name in lora_list:
            file_path = folder_paths.get_full_path("loras", lora_name)
            if file_path and os.path.isfile(file_path):
                scan_single_file(lora_name, file_path)

        # 清理失效条目：文件已被删除的 LoRA 从库中移除（列表为空时跳过，防止误清整个库）
        if lora_list:
            existing = set(lora_list)
            with _db_lock:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT name FROM lora_global")
                names = [r["name"] for r in cursor.fetchall()]
                stale = [n for n in names if n and n not in existing]
                if stale:
                    cursor.executemany(
                        "DELETE FROM lora_global WHERE name = ?",
                        [(n,) for n in stale],
                    )
                    conn.commit()
                    print(f"[XBHH DB] 已清理 {len(stale)} 个失效条目（文件已删除）")
                conn.close()

        # After scanning all files, recalculate auto triggers from tag frequency
        recalculate_auto_triggers()
        sync_lfu_cache()
        print("[XBHH DB] Background scan and auto trigger calculation complete!")

    t = threading.Thread(target=worker, daemon=True)
    t.start()

# Initialize Database Schema at import time
init_db()


def increment_lora_use(name):
    """Increment use count of LoRA and sync LFU cache."""
    if not name:
        return
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE lora_global 
            SET use_count = use_count + 1, last_used = CURRENT_TIMESTAMP 
            WHERE name = ?
        """, (name,))
        conn.commit()
        conn.close()
    sync_lfu_cache()


def get_settings():
    """获取全站通用配置（保存在 ComfyUI user 目录中）"""
    settings_file = os.path.join(get_xbhh_user_dir(), "settings.json")
    if os.path.exists(settings_file):
        try:
            with open(settings_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"disable_auto_trigger": False}


def save_settings(settings):
    """保存全站通用配置。

    先写临时文件再 os.replace 原子替换：即使写入中途崩溃/断电，也不会把
    settings.json 写坏（该文件现在同时存着参考图目录、配方等数据）。
    """
    settings_file = os.path.join(get_xbhh_user_dir(), "settings.json")
    tmp_file = settings_file + ".tmp"
    try:
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, settings_file)
        return True
    except Exception as e:
        print(f"[XBHH Settings] Error saving settings: {e}")
        try:
            if os.path.exists(tmp_file):
                os.remove(tmp_file)
        except Exception:
            pass
        return False


def get_lora_profiles(name):
    """获取指定 LoRA 的多套提示词预设 Profile 列表"""
    if not name:
        return []
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT profiles FROM lora_global WHERE name = ?", (name,))
        row = cursor.fetchone()
        conn.close()
    if row and row["profiles"]:
        try:
            return json.loads(row["profiles"])
        except Exception:
            pass
    return []


def update_lora_profiles(name, profiles):
    """更新指定 LoRA 的多套提示词预设 Profile 列表"""
    if not name:
        return False
    profiles_json = json.dumps(profiles, ensure_ascii=False) if profiles else None
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("UPDATE lora_global SET profiles = ? WHERE name = ?", (profiles_json, name))
        conn.commit()
        conn.close()
    return True


# 预置分类（用户可在管理器里直接选，也可自定义输入）
DEFAULT_LORA_CATEGORIES = ["画风", "人物", "角色", "场景", "服装", "动作", "概念", "材质", "其他"]

# 底模关键词：路径中出现这些词时，视为底模类型（如 ill/noob 的画风 LoRA 不能混用）
# 同一底模的画风 LoRA 才能叠加，跨底模混用会崩图
BASE_MODEL_KEYWORDS = (
    "ill", "illust", "illustrious", "illxl", "ill-xl",
    "noob", "noobai", "noobai-xl", "noob-x",
    "pony", "animagine", "anything",
    "sd15", "sd1.5", "sdxl", "flux", "sdxl-base",
)

# 无意义的根目录前缀，推断分类时跳过
_ROOT_DIR_NOISE = ("diy", "loras", "my", "models", "custom", "自定义")


def _match_base_model(segment):
    """判断某段路径是否是底模关键词，是则返回规范名，否则返回空串"""
    s = segment.lower().strip()
    if not s:
        return ""
    for k in BASE_MODEL_KEYWORDS:
        if s == k or s.startswith(k):
            return segment.strip()
    return ""


def infer_category_from_path(name):
    """
    从 LoRA 的 name（含相对路径）推断分类标签（2026-09-10 重构）。
    取文件前两级目录拼成标签：最近的父目录在前、祖父目录在后，
    跳过无意义根前缀（diy/loras 等）。底模目录不再跳过——不同底模用的 LoRA
    本来就不同，目录名是用户自己整理的最真实分类。如：
      画风\\anima\\mimidu.safetensors      → "anima 画风"
      diy\\画风\\anima\\mimidu.safetensors → "anima 画风"（跳过 diy）
      画风\\ill\\anima\\x.safetensors      → "anima ill"
      画风\\某角色.safetensors             → "画风"
      某角色.safetensors                   → ""（无法推断）
    """
    if not name:
        return ""
    parts = [p for p in re.split(r"[\\/]+", name) if p]
    if len(parts) < 2:
        return ""
    dirs = [d.strip() for d in parts[:-1]
            if d.strip() and d.strip().lower() not in _ROOT_DIR_NOISE]
    if not dirs:
        return ""
    two = dirs[-2:]  # 最近两级目录
    two.reverse()    # 叶子在前、父级在后
    return " ".join(two)


def infer_base_model_from_path(name):
    """
    从 LoRA 路径提取底模类型（ill/noob/pony 等）。
    用于提示 AI：不同底模的画风 LoRA 不能混用。
    """
    if not name:
        return ""
    parts = [p for p in re.split(r"[\\/]+", name) if p]
    for p in parts:
        m = _match_base_model(p)
        if m:
            return m
    return ""


def get_lora_category(name):
    """获取指定 LoRA 的分类标签；优先用户标注，其次路径推断"""
    if not name:
        return ""
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT category FROM lora_global WHERE name = ?", (name,))
        row = cursor.fetchone()
        conn.close()
    if row and row["category"]:
        return row["category"]
    # 没有用户标注则从路径推断
    return infer_category_from_path(name)


def update_lora_category(name, category):
    """更新指定 LoRA 的分类标签（空字符串表示清除自定义，回退到路径推断）"""
    if not name:
        return False
    cat = (category or "").strip()
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("UPDATE lora_global SET category = ? WHERE name = ?", (cat or None, name))
        conn.commit()
        conn.close()
    return True


def set_lora_rating(name, rating):
    """设置 LoRA 星级评分（0-5，0 表示未评分）。超出范围会被截断。"""
    if not name:
        return False
    try:
        val = int(rating)
    except (TypeError, ValueError):
        return False
    val = max(0, min(5, val))
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("UPDATE lora_global SET rating = ? WHERE name = ?", (val, name))
        changed = cursor.rowcount > 0
        conn.commit()
        conn.close()
    # 没匹配到行说明数据库里没有这个 LoRA（多半是改名后列表未刷新），返回 False 让前端提示
    return changed


# ============================================================================
# Tier 2: 外部清单备份 + 按 hash 重下（灾难恢复）
#   背景：「误删」由 Tier1 回收站兜底；而「整个 ComfyUI 目录被删」只能靠外部备份。
#   本模块把整个 LoRA 库导出成一份自包含 JSON 清单（文件指纹 + 用户数据），
#   落在用户可配的外部目录；恢复时按 hash 与当前库比对，列出缺失，再由 Civitai
#   按 hash 重下（SHA256 校验）并入库，最后把清单里的用户数据写回数据库。
#   注意：只有 Civitai 收录、能按 hash 定位的模型才可重下；国内平台 / 下架 /
#   自训模型不在覆盖范围内（需要 Tier 3 的打包备份）。
# ============================================================================

_MANIFEST_SCHEMA = "xbhh.lora.manifest"
_MANIFEST_VERSION = 1
_BACKUP_DIRNAME = "backup"
_MANIFEST_LATEST = "lora_manifest_latest.json"


def get_backup_root_dir():
    """默认备份根目录（user/xbhh/backup），不存在则创建。"""
    root = os.path.join(get_xbhh_user_dir(), _BACKUP_DIRNAME)
    os.makedirs(root, exist_ok=True)
    return root


def _resolve_backup_dir(raw_dir=None):
    """决定备份落点：显式传入 > settings.backup_dir > 默认 user/xbhh/backup。
    相对路径按 user/xbhh 目录解析；目录不可用时回退到默认目录。"""
    settings = get_settings()
    raw = raw_dir if raw_dir not in (None, "") else settings.get("backup_dir")
    raw = str(raw or "").strip()
    if raw:
        path = os.path.expanduser(os.path.expandvars(raw))
        if not os.path.isabs(path):
            path = os.path.join(get_xbhh_user_dir(), path)
    else:
        path = get_backup_root_dir()
    try:
        os.makedirs(path, exist_ok=True)
        return path
    except Exception as e:
        print(f"[XBHH Backup] 备份目录不可用({path}): {e}，回退到默认目录")
        return get_backup_root_dir()


def _collect_manifest_entries():
    """读取 lora_global 全表，整理成清单条目（文件指纹 + 用户数据）。"""
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT hash, name, file_path, file_size, user_trigger, auto_trigger, "
            "trained_words, use_count, category, base_model_override, rating, profiles "
            "FROM lora_global")
        rows = cursor.fetchall()
        conn.close()
    entries = []
    for r in rows:
        h = (r["hash"] or "").strip()
        if not h:
            continue
        name = r["name"] or ""
        fp = r["file_path"] or ""
        if not fp or not os.path.isfile(fp):
            fp = folder_paths.get_full_path("loras", name) or fp
        exists = bool(fp) and os.path.isfile(fp)
        profiles = []
        if r["profiles"]:
            try:
                profiles = json.loads(r["profiles"])
            except Exception:
                profiles = []
        entries.append({
            "hash": h,
            "name": name,
            "size": int(r["file_size"] or 0),
            "exists": exists,
            "has_preview": _lora_has_preview(fp) if exists else False,
            "user_trigger": r["user_trigger"] or "",
            "auto_trigger": r["auto_trigger"] or "",
            "trained_words": r["trained_words"] or "",
            "use_count": int(r["use_count"] or 0),
            "category": r["category"] or "",
            "base_model_override": r["base_model_override"] or "",
            "rating": int(r["rating"] or 0),
            "profiles": profiles,
        })
    return entries


def export_lora_manifest(raw_dir=None):
    """把整库导出成 JSON 清单（文件指纹 + 用户数据），写入指定/默认备份目录。
    写两份：带时间戳的历史文件 + lora_manifest_latest.json（恢复默认读它）。"""
    entries = _collect_manifest_entries()
    now = datetime.datetime.now()
    dir_path = _resolve_backup_dir(raw_dir)
    payload = {
        "schema": _MANIFEST_SCHEMA,
        "version": _MANIFEST_VERSION,
        "exported_at": now.isoformat(timespec="seconds"),
        "count": len(entries),
        "loras": entries,
    }
    target = os.path.join(dir_path, f"lora_manifest_{now.strftime('%Y%m%d-%H%M%S')}.json")
    try:
        _write_manifest_atomic(target, payload)
        _write_manifest_atomic(os.path.join(dir_path, _MANIFEST_LATEST), payload)
    except Exception as e:
        return {"success": False, "message": f"写入备份失败：{e}"}
    print(f"[XBHH Backup] 已导出 {len(entries)} 条 LoRA 清单 -> {target}")
    return {
        "success": True,
        "dir": dir_path,
        "path": target,
        "latest_path": os.path.join(dir_path, _MANIFEST_LATEST),
        "count": len(entries),
        "exported_at": payload["exported_at"],
    }


def list_lora_manifests(raw_dir=None):
    """列出备份目录下的清单文件（按修改时间倒序）。count 为 -1 表示文件损坏。"""
    dir_path = _resolve_backup_dir(raw_dir)
    out = []
    try:
        names = os.listdir(dir_path)
    except OSError:
        return out
    for fn in names:
        if not (fn.startswith("lora_manifest_") and fn.endswith(".json")):
            continue
        full = os.path.join(dir_path, fn)
        try:
            st = os.stat(full)
        except OSError:
            continue
        try:
            with open(full, "r", encoding="utf-8") as f:
                d = json.load(f)
            count = int(d.get("count") or len(d.get("loras") or []))
        except Exception:
            count = -1
        out.append({
            "file": fn, "path": full, "size": st.st_size, "mtime": st.st_mtime,
            "count": count, "is_latest": fn == _MANIFEST_LATEST,
        })
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def read_lora_manifest(path=None, raw_dir=None):
    """读取清单。path 显式给出则读它，否则读所选目录下的 latest。非法/缺失返回 None。"""
    if not path:
        path = os.path.join(_resolve_backup_dir(raw_dir), _MANIFEST_LATEST)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[XBHH Backup] 读取清单失败 {path}: {e}")
        return None
    if not isinstance(data, dict) or data.get("schema") != _MANIFEST_SCHEMA:
        return None
    return data


def inspect_manifest(manifest):
    """按 hash 与当前库比对：present = 已存在（hash 入库且文件在），其余为 missing。"""
    manifest = manifest or {}
    loras = manifest.get("loras") or []
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT hash, name, file_path FROM lora_global")
        rows = cursor.fetchall()
        conn.close()
    db = {r["hash"]: r for r in rows}
    present, missing = [], []
    for e in loras:
        h = (e.get("hash") or "").strip()
        if not h:
            continue
        known = db.get(h)
        found = False
        if known:
            fp = known["file_path"] or folder_paths.get_full_path("loras", known["name"] or "") or ""
            found = bool(fp) and os.path.isfile(fp)
        if not found:
            # hash 未入库时退一步：同名文件且大小一致视为已存在，避免误报（如库未扫描完）
            fp2 = folder_paths.get_full_path("loras", e.get("name") or "")
            if fp2 and os.path.isfile(fp2):
                try:
                    sz = os.path.getsize(fp2)
                except OSError:
                    sz = -1
                if not e.get("size") or sz == e.get("size"):
                    found = True
        item = {"hash": h, "name": e.get("name") or "", "size": int(e.get("size") or 0)}
        (present if found else missing).append(item)
    manifest_hashes = set(i["hash"] for i in present) | set(i["hash"] for i in missing)
    extra = [h for h in db.keys() if h not in manifest_hashes]
    return {
        "total": len(present) + len(missing),
        "present_count": len(present),
        "missing_count": len(missing),
        "extra_count": len(extra),
        "missing": missing,
        "present": present,
        "exported_at": manifest.get("exported_at") or "",
    }


def apply_manifest_user_data(entries):
    """把清单里的用户数据按 hash 写回数据库。只填补空白，不覆盖本地已有值：
    use_count 取较大值，rating 仅在本地为 0（未评分）时写入。返回命中的条目数。"""
    if not entries:
        return 0
    hit = 0
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()
        for e in entries:
            h = (e.get("hash") or "").strip()
            if not h:
                continue
            profiles_json = None
            if e.get("profiles"):
                try:
                    profiles_json = json.dumps(e["profiles"], ensure_ascii=False)
                except Exception:
                    profiles_json = None
            cursor.execute("""
                UPDATE lora_global SET
                    user_trigger = COALESCE(NULLIF(user_trigger, ''), ?),
                    auto_trigger = COALESCE(NULLIF(auto_trigger, ''), ?),
                    trained_words = COALESCE(NULLIF(trained_words, ''), ?),
                    category = COALESCE(NULLIF(category, ''), ?),
                    base_model_override = COALESCE(NULLIF(base_model_override, ''), ?),
                    rating = CASE WHEN COALESCE(rating, 0) = 0 THEN ? ELSE rating END,
                    use_count = CASE WHEN COALESCE(use_count, 0) < ? THEN ? ELSE use_count END,
                    profiles = COALESCE(NULLIF(profiles, ''), ?)
                WHERE hash = ?
            """, (
                e.get("user_trigger") or None,
                e.get("auto_trigger") or None,
                e.get("trained_words") or None,
                e.get("category") or None,
                e.get("base_model_override") or None,
                int(e.get("rating") or 0),
                int(e.get("use_count") or 0), int(e.get("use_count") or 0),
                profiles_json,
                h,
            ))
            if cursor.rowcount:
                hit += 1
        conn.commit()
        conn.close()
    return hit


# ============================================================================
# 恢复任务（后台逐项重下缺失 LoRA）
# ============================================================================
_restore_lock = threading.Lock()
_restore_jobs = {}
_restore_cancel = set()
_RESTORE_TTL = 3600


def _update_restore_job(job_id, **kw):
    with _restore_lock:
        job = _restore_jobs.get(job_id)
        if job:
            job.update(kw)


def _update_restore_item(job_id, index, **kw):
    with _restore_lock:
        job = _restore_jobs.get(job_id)
        if job and 0 <= index < len(job["items"]):
            job["items"][index].update(kw)


def _bump_restore(job_id, done=0, succeeded=0, failed=0, not_found=0):
    with _restore_lock:
        job = _restore_jobs.get(job_id)
        if not job:
            return
        job["done"] = job.get("done", 0) + done
        job["succeeded"] = job.get("succeeded", 0) + succeeded
        job["failed"] = job.get("failed", 0) + failed
        job["not_found"] = job.get("not_found", 0) + not_found
        total = job.get("total", 0)
        job["progress"] = int(job["done"] * 100 / total) if total else 0


def get_restore_job(job_id):
    with _restore_lock:
        job = _restore_jobs.get(job_id)
        if not job:
            return None
        out = dict(job)
        out["items"] = [dict(it) for it in job["items"]]
        return out


def cancel_restore_job(job_id):
    with _restore_lock:
        if job_id in _restore_jobs:
            _restore_cancel.add(job_id)
            return True
    return False


def start_restore_job(manifest, missing_items):
    """为缺失项启动后台重下任务（顺带把清单里的用户数据写回库）。
    missing_items 为 [{hash, name, size}, ...]。返回 {success, job_id, total}。"""
    missing_items = list(missing_items or [])
    now = time.time()
    with _restore_lock:
        for jid in list(_restore_jobs.keys()):
            j = _restore_jobs[jid]
            if j.get("status") in ("done", "error", "cancelled") and \
                    now - j.get("finished", j.get("created", now)) > _RESTORE_TTL:
                _restore_jobs.pop(jid, None)
        job_id = f"rs{int(now * 1000)}{len(_restore_jobs)}"
        _restore_jobs[job_id] = {
            "id": job_id, "status": "pending", "created": now, "finished": None,
            "total": len(missing_items), "done": 0, "succeeded": 0,
            "failed": 0, "not_found": 0, "progress": 0,
            "current": "", "message": "准备恢复...",
            "items": [
                {"hash": it.get("hash", ""), "name": it.get("name", ""),
                 "size": int(it.get("size") or 0), "status": "pending", "message": ""}
                for it in missing_items
            ],
        }
    threading.Thread(target=_restore_worker, args=(job_id, manifest, missing_items),
                     daemon=True).start()
    return {"success": True, "job_id": job_id, "total": len(missing_items)}


def _restore_worker(job_id, manifest, missing_items):
    total = len(missing_items)
    _update_restore_job(job_id, status="running", message="开始恢复缺失 LoRA...")
    try:
        for idx, item in enumerate(missing_items):
            with _restore_lock:
                if job_id in _restore_cancel:
                    _update_restore_job(job_id, status="cancelled", message="已取消")
                    break
            h = item.get("hash", "")
            name = item.get("name") or (h[:12] if h else "未知")
            _update_restore_item(job_id, idx, status="downloading", message="正在查找 Civitai...")
            _update_restore_job(job_id, current=name,
                                message=f"恢复中 {idx + 1}/{total}：{name}")

            try:
                cand = resolve_civitai_by_hash(h)
            except Exception as e:
                print(f"[XBHH Restore] 按 hash 查询 Civitai 失败 {h}: {e}")
                cand = None
            if not cand:
                _update_restore_item(job_id, idx, status="not_found",
                                     message="Civitai 未收录（无法按 hash 重下）")
                _bump_restore(job_id, not_found=1, done=1)
                continue

            res = start_civitai_download(cand)
            if not res.get("success"):
                _update_restore_item(job_id, idx, status="failed",
                                     message=res.get("message") or "启动下载失败")
                _bump_restore(job_id, failed=1, done=1)
                continue

            tid = res["task_id"]
            final = None
            while True:
                with _restore_lock:
                    if job_id in _restore_cancel:
                        break
                t = get_civitai_download_task(tid)
                if not t:
                    final = {"status": "error", "message": "下载任务丢失"}
                    break
                _update_restore_item(job_id, idx, status="downloading",
                                     message=t.get("message") or "下载中...")
                if t.get("status") in ("done", "error"):
                    final = t
                    break
                time.sleep(0.5)

            with _restore_lock:
                cancelled = job_id in _restore_cancel
            if cancelled:
                _update_restore_job(job_id, status="cancelled", message="已取消")
                break

            if final and final.get("status") == "done":
                _update_restore_item(job_id, idx, status="done", message="已恢复并入库")
                _bump_restore(job_id, succeeded=1, done=1)
            else:
                _update_restore_item(job_id, idx, status="failed",
                                     message=(final or {}).get("message") or "下载失败")
                _bump_restore(job_id, failed=1, done=1)
    except Exception as e:
        print(f"[XBHH Restore] 恢复任务异常: {e}")
        _update_restore_job(job_id, status="error", message=f"恢复任务异常：{e}",
                            finished=time.time())
        return

    # 全部处理完后回写用户数据：已有行填补空白，新下载行补全触发词/分类/评级/配方等
    try:
        n = apply_manifest_user_data((manifest or {}).get("loras") or [])
        print(f"[XBHH Restore] 用户数据回写完成，命中 {n} 条")
    except Exception as e:
        print(f"[XBHH Restore] 用户数据回写失败: {e}")

    with _restore_lock:
        job = _restore_jobs.get(job_id)
        cancelled = job and job.get("status") == "cancelled"
    if not cancelled:
        _update_restore_job(job_id, status="done", progress=100,
                            message="恢复完成", finished=time.time())
    else:
        _update_restore_job(job_id, finished=time.time())


# ============================================================================
# 每日自动导出调度线程
# ============================================================================
_backup_scheduler_started = False


def start_backup_scheduler():
    """启动「每天自动导出一次」的后台线程（仅当 settings.backup_auto_enabled 为真）。"""
    global _backup_scheduler_started
    if _backup_scheduler_started:
        return
    _backup_scheduler_started = True

    def worker():
        time.sleep(20)
        while True:
            try:
                settings = get_settings()
                if settings.get("backup_auto_enabled"):
                    last = str(settings.get("backup_last_export") or "")[:10]
                    today = datetime.date.today().isoformat()
                    if last != today:
                        res = export_lora_manifest()
                        if res.get("success"):
                            settings = get_settings()
                            settings["backup_last_export"] = res.get("exported_at")
                            save_settings(settings)
            except Exception as e:
                print(f"[XBHH Backup] 自动导出失败: {e}")
            time.sleep(1800)

    threading.Thread(target=worker, daemon=True).start()



