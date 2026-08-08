import os
import sqlite3
import json
import hashlib
import struct
import urllib.request
import urllib.error
import threading
import time
import shutil
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


def recalculate_auto_triggers():
    """根据训练标签最高频次重新计算所有模型的 auto_trigger。"""
    with _db_lock:
        conn = get_db_connection()
        cursor = conn.cursor()

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
            except Exception:
                pass

        conn.commit()
        conn.close()


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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    }
    if api_key:
        headers['Authorization'] = f'Bearer {api_key}'

    for domain in domains:
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
            print(f"[XBHH DB] Civitai ({domain}) HTTP error for {model_hash}: {e.code} - {e.reason}")
        except Exception as e:
            print(f"[XBHH DB] Error querying Civitai ({domain}) API for {model_hash}: {e}")

    return ""


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
            "SELECT hash, file_size, file_mtime FROM lora_global WHERE name = ? OR file_path = ?", 
            (lora_name, file_path)
        )
        row = cursor.fetchone()
        
        if row and row['file_size'] == size and abs(row['file_mtime'] - mtime) < 1.0:
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
            INSERT OR REPLACE INTO lora_global 
            (hash, name, file_path, file_size, file_mtime, user_trigger, metadata, use_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
    """保存全站通用配置"""
    settings_file = os.path.join(get_xbhh_user_dir(), "settings.json")
    try:
        with open(settings_file, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        print(f"[XBHH Settings] Error saving settings: {e}")
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



