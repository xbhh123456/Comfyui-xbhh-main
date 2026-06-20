import os
import sqlite3
import json
import hashlib
import struct
import urllib.request
import urllib.error
import threading
import time
import folder_paths

DB_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DB_DIR, "lora_trigger_word.db")

# Ensure data folder exists
os.makedirs(DB_DIR, exist_ok=True)

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
    conn = sqlite3.connect(DB_PATH)
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
    """Fetch model version trigger words from Civitai API by hash."""
    url = f"https://civitai.com/api/v1/model-versions/by-hash/{model_hash}"
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Antigravity/1.0'}
        )
        with urllib.request.urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode('utf-8'))
            trained_words = data.get('trainedWords', [])
            if trained_words:
                words_str = ", ".join(trained_words)
                return words_str
            return ""
    except urllib.error.HTTPError as e:
        print(f"[XBHH DB] Civitai HTTP error for {model_hash}: {e.code} - {e.reason}")
    except Exception as e:
        print(f"[XBHH DB] Error querying Civitai API for {model_hash}: {e}")
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

