import os
import json
import random
import asyncio
import urllib.request
import urllib.error
from server import PromptServer
from aiohttp import web

from .wallet import get_wallet

# ============================================================================
# AI 画图工具 (function calling)：让 LLM 能识别用户绘画请求并触发工作流运行
# ============================================================================
PET_IMAGE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "generate_image",
            "description": "用户要求画图时调用。prompt 描述画面内容（主体、动作、场景、风格等），中英文关键词均可。",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "画面描述，如：1girl, 银发红瞳, 白色连衣裙, 樱花树下, 唯美插画风格",
                    }
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "random_style_loras",
            "description": (
                "随机抽取 LoRA 组合（由系统真随机抽取，保证每次不同，避免总挑常用的几个）。"
                "当用户要求添加若干个某类 LoRA 且让你自己挑（如『添加4个画风lora』『随便来几个』），"
                "或要求随机/换一批时，必须用本工具，不要自己用 add_lora 一个个挑。"
                "注意：会先关闭目标堆所有现有 LoRA（禁用），再添加抽中的。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "count": {
                        "type": "number",
                        "description": "抽取数量；不传时画风类默认 4，人物/角色类默认 1。用户说『随机来个人物/角色』没给数量就不要传",
                    },
                    "category": {
                        "type": "string",
                        "description": "LoRA 分类，默认「画风」；也可以是 人物/角色 等",
                    },
                    "style_keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "画风关键词数组（从用户描述提取，如 [\"水彩\", \"厚涂\", \"赛博\"]）。系统会优先在名称或触发词命中关键词的 LoRA 里随机，命中不足时才放宽到全分类",
                    },
                    "base": {
                        "type": "string",
                        "description": "底模过滤（如 ill/noob）。用户指定了底模（如『ill画风』）时必须传入",
                    },
                    "total_strength": {
                        "type": "number",
                        "description": "权重总和上限。用户给了限制（如『总和1.2以内』）就传入，如 1.2",
                    },
                    "target": {
                        "type": "string",
                        "description": "目标 LoRA 堆：工作流可能有多个堆节点（如一个专门放人物、一个专门放画风）。填堆的用途关键词（人物/画风/角色等）或节点标题；用户没提堆且无法判断时留空",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_workflow",
            "description": (
                "用户要求运行/启动工作流、开始画图（且没有描述新的画面内容）时调用，"
                "会直接运行当前画布工作流。若用户描述了想画的内容（如『画一只猫』），"
                "改用 generate_image 工具。"
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_checkpoint",
            "description": (
                "切换工作流的大模型。checkpoint_name 必须使用系统消息『大模型列表』里的完整文件名。"
                "图像大模型走 Checkpoint 加载节点，视频大模型（wan/hunyuan 等）走 UNET 加载节点，"
                "画布上需有对应加载节点。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "checkpoint_name": {
                        "type": "string",
                        "description": "完整文件名，必须来自系统消息大模型列表（如 illXL_v10.safetensors 或 wan2.1_t2v_14B.safetensors）",
                    },
                },
                "required": ["checkpoint_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_image_size",
            "description": (
                "设置画图分辨率（控制空图像节点的宽高，系统会自动定位画布上真正控制尺寸的节点）。"
                "用户要求改分辨率/尺寸/大小/比例/横图/竖图/横竖版/横屏竖屏时调用。"
                "width、height 至少传一个，未传的一边保持当前值不变。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "width": {
                        "type": "number",
                        "description": "宽度像素（如 832），系统自动取 8 的倍数",
                    },
                    "height": {
                        "type": "number",
                        "description": "高度像素（如 1216），系统自动取 8 的倍数",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_lora",
            "description": "用户要求添加 LoRA 时调用。已在堆中的会自动启用。lora_name 必须与用户要求的分类匹配（如用户要画风就只能给画风类）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "lora_name": {
                        "type": "string",
                        "description": "LoRA 的完整文件名（如 style_anime_v1.safetensors），不要使用「画风」「风格」「角色」等分类名",
                    },
                    "category": {
                        "type": "string",
                        "description": "这个 LoRA 的分类（画风/人物/角色/环境等，从列表分类标签判断）。系统按用户预绑定的「分类→堆」映射路由到对应堆节点",
                    },
                    "strength": {
                        "type": "number",
                        "description": "权重，默认 1.0，范围 -2.0~2.0",
                    },
                    "target": {
                        "type": "string",
                        "description": "目标 LoRA 堆：工作流可能有多个堆节点（如一个专门放人物、一个专门放画风）。填堆的用途关键词（人物/画风/角色等）或节点标题；用户没提堆且无法判断时留空",
                    },
                },
                "required": ["lora_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remove_lora",
            "description": "用户要求移除/删除 LoRA 时调用。lora_name 支持部分名称；不传则删堆中唯一一个。",
            "parameters": {
                "type": "object",
                "properties": {
                    "lora_name": {
                        "type": "string",
                        "description": "要移除的 LoRA 名称（支持部分文件名匹配），不要使用「画风」「风格」「角色」等分类名",
                    },
                    "category": {
                        "type": "string",
                        "description": "这个 LoRA 的分类（画风/人物/角色/环境等）。系统按用户预绑定的「分类→堆」映射路由到对应堆节点",
                    },
                    "target": {
                        "type": "string",
                        "description": "目标 LoRA 堆：工作流可能有多个堆节点（如一个专门放人物、一个专门放画风）。填堆的用途关键词（人物/画风/角色等）或节点标题；用户没提堆且无法判断时留空",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_lora_strength",
            "description": "用户要求调整 LoRA 权重时调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "lora_name": {
                        "type": "string",
                        "description": "LoRA 的完整文件名（如 style_anime_v1.safetensors），不要使用「画风」「风格」「角色」等分类名",
                    },
                    "category": {
                        "type": "string",
                        "description": "这个 LoRA 的分类（画风/人物/角色/环境等，从列表分类标签判断）。系统按用户预绑定的「分类→堆」映射路由到对应堆节点",
                    },
                    "strength": {
                        "type": "number",
                        "description": "新权重，范围 -2.0~2.0",
                    },
                    "target": {
                        "type": "string",
                        "description": "目标 LoRA 堆：工作流可能有多个堆节点（如一个专门放人物、一个专门放画风）。填堆的用途关键词（人物/画风/角色等）或节点标题；用户没提堆且无法判断时留空",
                    },
                },
                "required": ["strength"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "auto_style_loras",
            "description": (
                "AI 自主搭配 LoRA 组合。根据系统消息 LoRA 列表里的分类标签和底模标注自行筛选搭配，"
                "使用筛选出的条目中的完整文件名作为参数，不要使用分类名。"
                "注意：会先关闭所有现有 LoRA（禁用），再按传入列表重新添加。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "loras": {
                        "type": "array",
                        "description": "LoRA 组合列表，1~4 个",
                        "items": {
                            "type": "object",
                            "properties": {
                                "lora_name": {
                                    "type": "string",
                                    "description": "必须使用系统消息 LoRA 列表中提供的完整文件名（如 style_anime_v1.safetensors），不要使用「画风」「风格」「角色」等分类名",
                                },
                                "strength": {
                                    "type": "number",
                                    "description": "权重",
                                },
                            },
                            "required": ["lora_name", "strength"],
                        },
                    },
                },
                "required": ["loras"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_prompts",
            "description": (
                "把按分类拆分的提示词写入画布上的文本节点（分类如 人物主题/画风/场景环境/质量词，"
                "以系统消息【提示词槽位】为准；写入位置由用户预先配置，你只管按分类给内容）。"
                "写提示词或画图时调用；可与 generate_image / run_workflow 同条消息并发"
                "（系统会先填词后跑图）。"
                "LoRA 触发词由 LoRA 堆 Plus 节点自动输出，不要自己编造或填写触发词。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompts": {
                        "type": "array",
                        "description": "分类提示词列表，画图时建议【提示词槽位】列出的每个分类都给一条",
                        "items": {
                            "type": "object",
                            "properties": {
                                "category": {
                                    "type": "string",
                                    "description": "分类名，必须使用系统消息【提示词槽位】给出的分类（如 人物主题）",
                                },
                                "content": {
                                    "type": "string",
                                    "description": "该分类的提示词内容（SD 英文 tags，逗号分隔）",
                                },
                            },
                            "required": ["category", "content"],
                        },
                    },
                },
                "required": ["prompts"],
            },
        },
    },
]

def _existing_lora_names():
    """当前磁盘真实存在的 LoRA 文件名集合；读取失败返回 None（不过滤，保守放行）"""
    try:
        import folder_paths

        return set(folder_paths.get_filename_list("loras") or [])
    except Exception as e:
        print(f"[XBHH pet] 读取 LoRA 文件列表失败: {e}")
        return None


def _build_lora_preference_text(level="auto", messages=None):
    """
    读取 LoRA 使用统计，按级别返回不同长度的文本。
    level:
      - "minimal": 仅 top 10 已用 LoRA 名称+次数（~200 tokens）
      - "normal":  top 20 已用 LoRA 名称+分类+底模+次数（~600 tokens）
      - "full":    top 20 已用 + top 50 全部（~1200 tokens）
      - "auto":    根据 messages 是否涉及 LoRA 关键词自动选择
    """
    keywords = {"lora", "lora", "模型", "风格", "角色", "画风", "搭配", "组合",
                "lora", "添加", "删除", "去掉", "权重", "强度", "配置",
                "没用过", "没用过的", "未使用", "推荐", "随便配", "你来配"}
    if level == "auto" and messages:
        combined = " ".join(str(m.get("content", "")) for m in messages if m.get("content")).lower()
        level = "full" if any(k in combined for k in keywords) else "minimal"

    try:
        from .. import lora_database
        conn = lora_database.get_db_connection()
        cursor = conn.cursor()

        lines = []

        # 已用 LoRA 统计
        used_limit = 20 if level in ("normal", "full") else 10
        cursor.execute(
            "SELECT name, use_count, user_trigger, auto_trigger, trained_words, "
            "category, metadata FROM lora_global WHERE use_count > 0 "
            "ORDER BY use_count DESC LIMIT ?",
            (used_limit,)
        )
        used_rows = cursor.fetchall()
        # 过滤失效条目：文件已删除但库里还留着的（防随机/自选抽到不存在的 LoRA）
        existing = _existing_lora_names()
        if existing is not None:
            used_rows = [r for r in used_rows if (r["name"] or "") in existing]
        # 打乱顺序：LLM 有位置偏差，总选列表最前面的条目；
        # 使用次数已内联展示（如「8次」），排序不承载额外信息
        random.shuffle(used_rows)

        if used_rows:
            if level == "minimal":
                # 精简级：仅名称和次数
                lines.append("\n【用户常用 LoRA】")
                for i, row in enumerate(used_rows, 1):
                    name = (row["name"] or "").split("/")[-1].split("\\")[-1]
                    lines.append(f"{i}. {name}（{row['use_count']}次）")
            else:
                # 标准/完整级：带分类和底模
                lines.append("\n【用户 LoRA 使用统计（次数越多越喜欢；列表顺序随机，不代表优先级）】")
                for i, row in enumerate(used_rows, 1):
                    name = (row["name"] or "").split("/")[-1].split("\\")[-1]
                    trigger = row["user_trigger"] or row["auto_trigger"] or row["trained_words"] or ""
                    trigger = trigger.strip().split(",")[0][:40]
                    category = row["category"]
                    if not category:
                        category = lora_database.infer_category_from_path(row["name"] or "")
                    base = ""
                    meta_raw = row["metadata"]
                    if meta_raw:
                        try:
                            meta_json = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw
                            if isinstance(meta_json, dict):
                                base = (meta_json.get("ss_sd_model_name") or "").strip()
                        except Exception:
                            pass
                    if not base:
                        base = lora_database.infer_base_model_from_path(row["name"] or "")
                    tags = []
                    if category:
                        tags.append(f"分类:{category}")
                    if base:
                        tags.append(f"底模:{base}")
                    tag_str = f"[{' '.join(tags)}]" if tags else ""
                    parts = [f"{i}. {name}"]
                    if tag_str:
                        parts.append(tag_str)
                    parts.append(f"（{row['use_count']}次）")
                    if trigger:
                        parts.append(f"触发词:{trigger}")
                    lines.append(" ".join(parts))

        # 完整级额外加全部列表（带分类信息，方便 AI 区分画风/角色/场景）
        if level == "full":
            cursor.execute(
                "SELECT name, use_count, category FROM lora_global "
                "ORDER BY use_count DESC LIMIT 50"
            )
            all_rows = cursor.fetchall()
            # 同样过滤失效条目（这段是 AI 自选/随机挑选的主要来源）
            if existing is not None:
                all_rows = [r for r in all_rows if (r["name"] or "") in existing]
            # 同样打乱，避免 LLM 固定挑列表前几个
            random.shuffle(all_rows)
            if all_rows:
                # 不带使用次数：这段是 AI 自选/随机挑选的主要来源，
                # 带次数会诱导 LLM 偏向常用的那几个（偏好信息只保留在"使用统计"段）
                lines.append("\n【全部可用 LoRA（含未使用过的，顺序随机）】")
                for i, row in enumerate(all_rows, 1):
                    name = (row["name"] or "").split("/")[-1].split("\\")[-1]
                    cat = row["category"] or ""
                    if not cat:
                        try:
                            cat = lora_database.infer_category_from_path(row["name"] or "")
                        except Exception:
                            cat = ""
                    cat_tag = f"[{cat}]" if cat else ""
                    parts = [f"{i}. {name}"]
                    if cat_tag:
                        parts.append(cat_tag)
                    lines.append(" ".join(parts))

        conn.close()
        return "\n".join(lines)
    except Exception as e:
        print(f"[XBHH pet] 读取 LoRA 数据失败: {e}")
        return ""

# 视频大模型关键词：路径段或文件名以这些前缀开头 → 视频类（其余视为图像类）
VIDEO_CKPT_KEYWORDS = (
    "wan", "hunyuan", "ltx", "cogvideo", "mochi", "skyreels",
    "sfv", "mococrystal", "videocrafter", "lvsm",
)

def _classify_checkpoint(name):
    """按路径段/文件名前缀判断大模型是视频还是图像类"""
    s = str(name or "").replace("\\", "/").lower()
    for seg in s.split("/"):
        seg = seg.strip()
        if not seg:
            continue
        for k in VIDEO_CKPT_KEYWORDS:
            if seg.startswith(k):
                return "视频"
    return "图像"

def _build_checkpoint_text(messages=None):
    """
    构建注入给 LLM 的大模型列表（图像/视频分组）。
    只在消息涉及大模型相关关键词时注入，控制 Token 开销。
    """
    keywords = ("大模型", "底模", "checkpoint", "ckpt", "视频模型", "换模型",
                "unet", "模型切换", "切模型", "换个模型")
    if messages:
        combined = " ".join(
            str(m.get("content", "")) for m in messages if m.get("content")
        ).lower()
        if not any(k in combined for k in keywords):
            return ""
    try:
        import folder_paths
        ckpts = list(folder_paths.get_filename_list("checkpoints"))
        image_ms = [c for c in ckpts if _classify_checkpoint(c) == "图像"]
        video_ms = [c for c in ckpts if _classify_checkpoint(c) == "视频"]
        # UNET 目录（视频工作流常用加载方式），标注 [UNET]
        try:
            unets = list(folder_paths.get_filename_list("unet"))
        except Exception:
            unets = []
    except Exception as e:
        print(f"[XBHH pet] 读取大模型列表失败: {e}")
        return ""

    def _basename(n):
        return str(n).split("/")[-1].split("\\")[-1]

    MAX_SHOW = 40
    lines = ["\n【大模型列表】"]
    if image_ms:
        lines.append("图像大模型（画图默认用这类）：")
        for i, n in enumerate(image_ms[:MAX_SHOW], 1):
            lines.append(f"{i}. {_basename(n)}")
    if video_ms:
        lines.append("视频大模型（画视频/动图用）：")
        off = len(image_ms[:MAX_SHOW])
        for i, n in enumerate(video_ms[:MAX_SHOW], 1):
            lines.append(f"{off + i}. {_basename(n)}")
    if unets:
        lines.append("视频大模型 [UNET]（需画布上有 UNET 加载节点）：")
        off = len(image_ms[:MAX_SHOW]) + len(video_ms[:MAX_SHOW])
        for i, n in enumerate(unets[:MAX_SHOW], 1):
            lines.append(f"{off + i}. {_basename(n)}")
    if len(lines) <= 1:
        return ""
    return "\n".join(lines)


def _random_pick_style_loras(count=None, category="画风", base="", total=1.2, keywords=None):
    """
    从 LoRA 库按分类/底模过滤后真随机抽取 count 个，返回 [(完整名, 权重)]。
    count 为 None 时按分类定默认：人物/角色类抽 1 个，其余（画风等）抽 4 个。
    权重带 ±20% 随机抖动后归一到总和 total，单个限制在 0.1~0.8。
    未指定底模时，从候选最多的底模中抽（避免跨底模混用崩图）。
    keywords：画风关键词列表（AI 从用户描述提炼），名称/触发词命中的候选优先。
    """
    try:
        from .. import lora_database
        conn = lora_database.get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name, category, user_trigger, auto_trigger, trained_words, "
            "metadata FROM lora_global"
        )
        rows = cursor.fetchall()
        conn.close()
    except Exception as e:
        print(f"[XBHH pet] 随机抽取 LoRA 读库失败: {e}")
        return []

    # 过滤失效条目：文件已删除但库里还留着的（随机抽取绝不能抽到不存在的 LoRA）
    existing = _existing_lora_names()
    if existing is not None:
        rows = [r for r in rows if (r["name"] or "") in existing]

    category = (category or "").strip() or "画风"
    base_l = (base or "").strip().lower()

    matched = []  # [(完整名, 触发词)]
    for row in rows:
        name = row["name"] or ""
        if not name:
            continue
        cat = row["category"]
        if not cat:
            try:
                cat = lora_database.infer_category_from_path(name)
            except Exception:
                cat = ""
        # 标签可能是两级目录拼的（如 "anima 画风"），按空格分 token 匹配：
        # 请求"画风"时命中 token "画风"，请求"anima"也能精确命中叶子目录
        cat_tokens = cat.split()
        if category and category not in cat_tokens and cat != category:
            continue
        b = ""
        try:
            b = lora_database.infer_base_model_from_path(name) or ""
        except Exception:
            b = ""
        if base_l:
            # 三路匹配任一命中即可（用户底模信息可能记在不同地方）：
            # ① 目录路径推断（anima/画风/x.safetensors）
            # ② 元数据 ss_sd_model_name（civitai 下载时记录的训练底模名）
            # ③ 用户分类标签里的 token（分类填「画风 anima」这种自带底模的写法）
            meta_base = ""
            try:
                meta_raw = row["metadata"]
                if meta_raw:
                    meta_json = (
                        json.loads(meta_raw)
                        if isinstance(meta_raw, str)
                        else meta_raw
                    )
                    if isinstance(meta_json, dict):
                        meta_base = (meta_json.get("ss_sd_model_name") or "").strip()
            except Exception:
                meta_base = ""
            hay = " ".join(
                [b.lower(), meta_base.lower(), " ".join(cat_tokens).lower()]
            )
            if base_l not in hay:
                continue
        try:
            trig = (
                row["user_trigger"] or row["auto_trigger"] or row["trained_words"] or ""
            )
        except Exception:
            trig = ""
        matched.append((name, trig))

    # 诊断日志：定位"抽不到"发生在哪一层（死条目过滤/分类/底模）
    if category or base_l:
        print(
            f"[XBHH pet] 随机抽取: 请求 分类={category!r} 底模={base_l!r} → "
            f"库内 {len(rows)} 条 → 分类/底模过滤后 {len(matched)} 条"
        )

    # 画风关键词过滤：名称或触发词命中任一关键词的优先；命中不足时放宽到全分类
    kws = [str(k).strip().lower() for k in (keywords or []) if str(k).strip()]
    if kws and matched:
        hit = [
            (n, t) for n, t in matched
            if any(k in n.lower() or k in t.lower() for k in kws)
        ]
        if hit:
            matched = hit
        print(f"[XBHH pet] 画风关键词过滤: {kws} → {len(matched)} 个候选")

    if not matched:
        return []

    # 摊平成文件名列表，后续底模分组/抽取逻辑保持不变
    matched = [n for n, _t in matched]

    # 未指定底模：选候选最多的底模分组再过滤，保证同底模
    base_groups = {}  # 底模 -> 候选数
    if not base_l:
        for n in matched:
            try:
                bl = (lora_database.infer_base_model_from_path(n) or "").lower()
            except Exception:
                bl = ""
            base_groups[bl] = base_groups.get(bl, 0) + 1
        best_base = max(base_groups, key=lambda k: base_groups[k]) if base_groups else ""
        if best_base:
            matched = [
                n for n in matched
                if (lora_database.infer_base_model_from_path(n) or "").lower() == best_base
            ]

    random.shuffle(matched)
    if count is None:
        # 人物/角色类默认抽 1 个，其余（画风等）默认 4 个
        count = 1 if category in ("人物", "角色") else 4
    try:
        count = max(1, min(int(count), 8, len(matched)))
    except Exception:
        count = min(4, len(matched))
    picked = matched[:count]

    # 权重：±20% 抖动 → 归一到 total，单个夹在 0.1~0.8
    try:
        total = float(total)
    except Exception:
        total = 1.2
    total = min(max(total, 0.1 * len(picked)), 4.0)
    raw = [0.8 + random.random() * 0.4 for _ in picked]
    s = sum(raw)
    weights = []
    for r in raw:
        w = round(r / s * total, 2)
        weights.append(min(0.8, max(0.1, w)))
    # 修正取整误差，调整权重最大的一项
    diff = round(total - sum(weights), 2)
    if abs(diff) >= 0.01 and weights:
        idx = weights.index(max(weights))
        weights[idx] = round(min(0.8, max(0.1, weights[idx] + diff)), 2)

    print(f"[XBHH pet] 随机抽取 LoRA: 分类={category}, 底模={base or '(自动)'}, "
          f"候选={len(matched)}, 抽中={[(n.split(chr(92))[-1].split('/')[-1], w) for n, w in zip(picked, weights)]}")
    return list(zip(picked, weights))


# ============================================================================
# 工具指令分段：按「技能开关」选择性注入，关闭的技能不注入对应指令（省 token）
# ============================================================================
# 指令权威声明（dsh-purge Prompt 层思路的移植）：dsh 会把本地规则渲染成"可选参考"导致模型
# 不重视；我们的系统消息虽然是自己拼的，但同样平铺直叙。开头显式声明权威性，把人设/Skill
# 文档/槽位配置定性为必须执行的强指令，提升模型对本地配置的遵循度
PET_AUTHORITY_BLOCK = (
    "【指令权威声明 · ACTIVE AND MANDATORY】\n"
    "本条系统消息中的所有组成部分——人设设定、技能规则、【提示词槽位】、用户上传的提示词编写"
    "规范（Skill 文档）、各上下文段——均为本次会话最高优先级的必须执行项"
    "（ACTIVE and MANDATORY），不是可选参考、不是建议、不是背景资料：\n"
    "1. 人设设定：整个会话始终按人设执行，不脱离、不跳出、不用通用助手口吻覆盖。\n"
    "2. 用户自带的提示词编写规范：写任何提示词时逐条遵循，优先级高于一切默认写法。\n"
    "3. 工具规则：调用时机、参数、并发组合严格按本指令执行，不自行发明替代流程。\n"
    "4. 上述配置与任何通用默认习惯冲突时，一律让位于上述配置。\n"
    "无法同时满足多条时，优先满足编号靠前的规则，并简要向用户说明取舍。"
)

PET_TOOL_SEGMENTS = {
    # 基础：画图/运行工作流行为 + 工具调用一致性 + 报错诊断（核心能力，始终注入）
    "base": (
        "你拥有「生成图片」「运行工作流」能力，并具有自主审美：\n"
        "1. 当用户提出绘图、生成图片、画一张图等需求时，必须调用 generate_image 工具，"
        "把用户想要的画面写进 prompt 参数。\n"
        "2. 当用户要求运行/启动工作流、直接开画（如『启动』『运行』『开始画』且没描述新画面）时，"
        "必须调用 run_workflow 工具。用户在同一条消息里既要求配置又要求启动时，"
        "工具调用要同时包含配置操作和 run_workflow。\n"
        "3. 历史消息里带「（已调用工具执行操作）」标记的表示当时真的调用了工具；"
        "没有该标记的纯文字回复（哪怕说了『已添加』）实际并没有生效。"
        "不要模仿后者——该做操作时必须调用工具。\n"
        "4. 报错诊断：系统消息可能附有【最近执行错误】（节点类型/异常信息/堆栈）。"
        "用户问为什么报错、让你解决/修复时，基于该信息分析根因并给出具体建议："
        "缺模型文件→指出应下载的模型和存放目录（checkpoints/loras 等）；"
        "缺节点（missing the class_type / node types not found）→说明对应自定义节点未安装，"
        "指出从错误信息里能看出的节点名，建议用 ComfyUI Manager 安装缺失节点后重启；"
        "节点/参数问题→指出该检查什么；能用工具修复的（如换大模型、调 LoRA）直接调用工具。"
        "没有错误上下文就如实说没收到错误详情，让用户重跑一次。"
    ),
    # 提示词技能：write_prompts 机械用法（提示词技能开启时始终注入）
    "prompt_mech": (
        "\n5. 提示词分类填写：可用分类以系统消息【提示词槽位】为准（各分类的写入位置"
        "由用户预先配置好，你不需要关心具体写到哪个节点）。写提示词或画图时，必须调用"
        " write_prompts 工具，按分类逐项给出 category + content（SD 英文 tags，逗号分隔），"
        "prompts 数组里每个分类一条。可与 generate_image / run_workflow 同一条消息并发调用，"
        "系统会先填词再跑图。LoRA 的触发词由 LoRA 堆 Plus 节点自动输出，"
        "严禁自己编造或填写触发词。"
    ),
    # 提示词技能：内置编写规范（用户没填自定义 skill 文档时的兜底）
    "prompt_style": (
        "\n【内置提示词编写规范】（用户未提供自定义规范时的兜底）：\n"
        "- 全部用英文 tags，逗号分隔，不要写成完整句子；\n"
        "- 人物主题：以 1girl/1boy 等数量词开头，含主体身份、外貌、发型发色、瞳色、表情、服装、动作姿势；\n"
        "- 画风：媒体类型与艺术风格（如 official style, watercolor (medium), flat color）；\n"
        "- 场景环境：地点、时间、天气、光照、背景元素（如 outdoors, cherry blossoms, sunset, soft lighting）；\n"
        "- 质量词：画质与细节增强（如 masterpiece, best quality, ultra detailed, 8k）；\n"
        "- 内容与用户请求保持一致，未提及的维度可自行补全但不要与用户要求冲突。"
    ),
    # LoRA 技能：LoRA 筛选/多堆路由/随机抽取规则（原规则 3~10）
    "lora": (
        "\n6. 当用户要求添加/删除/去掉某个 LoRA 或调整 LoRA 权重时，你必须同时做两件事："
        "调用对应的工具（add_lora / remove_lora / set_lora_strength / auto_style_loras / random_style_loras），"
        "并在回复中简短告知用户结果。"
        "禁止只回复文字说『已添加』『已删除』『已调整』而不调用工具——"
        "不调用工具就不会真正生效，用户会看到你的回复但 LoRA 堆没有任何变化。\n"
        "7. 系统消息的 LoRA 列表里每个条目附带分类标签（如[分类:风格]）和底模标注（如[底模:ill]），"
        "格式如：style_anime_v1.safetensors [分类:风格 底模:ill]（5次）。"
        "请自行根据用户描述判断应该筛选哪些标签。例如：用户说「画风lora」→ 你想到了[分类:风格]；"
        "用户说「ill大模型」→ 你想到了[底模:ill]。然后按标签筛选出文件名，不要用用户说的词本身去查。\n"
        "8. 分类筛选是硬性约束：用户要「画风/风格」LoRA 时，只能选分类标签为画风/风格的条目，"
        "严禁混入人物/角色类条目；用户要「人物/角色」LoRA 时只能选人物/角色类。"
        "用户指定了底模（如 ill）时，画风类必须全部来自该底模，一个都不能混。\n"
        "9. 多堆路由：工作流里可能有多个 LoRA 堆节点（如一个专放画风、一个专放人物、一个专放环境），"
        "系统按用户预先配置的「分类 → 堆」映射自动路由（画风 LoRA 自动进画风堆）。"
        "调用 add_lora / set_lora_strength / remove_lora 时必须带上 category 参数"
        "（你从列表的分类标签已能判断，如 画风/人物/角色/环境），否则可能进错堆；"
        "用户明确指定堆（如『加到人物堆』）时同时把用途关键词填进 target。\n"
        "10. 当用户让你自己挑 LoRA（如『添加4个画风lora』『随便挑几个』『换一批』）时，"
        "必须调用 random_style_loras 工具由系统真随机抽取——严禁自己用 add_lora 挑具体名字，"
        "你的挑选有严重偏差（总盯着使用次数多的那几个）。用户指定了数量/分类/底模/权重总和，"
        "就原样填进 count / category / base / total_strength 参数；"
        "用户描述了想要的画风特征（如『水彩点的』『厚涂风』『暗色调』）时，"
        "把这些关键词提炼成 style_keywords 数组传入，系统会优先抽匹配的；"
        "用户要『随机人物/随机角色』且没说数量时不要传 count（系统默认人物/角色只抽 1 个）。\n"
        "11. 你有自己的审美判断：系统消息里附有『用户 LoRA 使用统计』，反映了用户的喜好。"
        "当用户让你跨分类精心搭配（如『你来搭配一组画风加人物』）时，可用 auto_style_loras 工具；"
        "但只要是单一分类的组合（尤其画风类），一律优先 random_style_loras。\n"
        "12. 底模兼容性：画风类 LoRA 与底模绑定，不同底模（如 ill 和 noob）的画风 LoRA 绝不能混用；"
        "人物/角色类 LoRA 通常通用。\n"
        "13. 如果你的回复里提到了要添加几个 LoRA，那么你的工具调用里必须包含等量的 LoRA 添加操作，"
        "两者要一致，不能只说不做。"
    ),
    # 大模型技能：set_checkpoint 用法（原规则 14）
    "model": (
        "\n14. 大模型切换：用户要求换大模型/底模时，调用 set_checkpoint 工具，"
        "名称必须使用系统消息【大模型列表】里的完整文件名。列表分图像/视频两组："
        "普通画图默认选图像组；用户明确要视频/动图才选视频组。"
        "换大模型后如需继续画图，同时调用 run_workflow。"
    ),
    # 分辨率设置：set_image_size 用法（核心能力，始终注入）
    "size": (
        "\n15. 分辨率设置：用户要求改分辨率/尺寸/大小/比例/横图竖图/横竖版/横屏竖屏时，"
        "调用 set_image_size 工具（width/height 像素值，系统自动取 8 的倍数，"
        "只改一边时另一边可不传）。横版 width>height（如 1216x832），"
        "竖版 height>width（如 832x1216），方形两边相等（如 1024x1024），"
        "总像素建议控制在 0.5~1.5MP。可与 generate_image / run_workflow 同一条消息并发调用，"
        "系统会先改尺寸再跑图。用户没提分辨率就不要调用。"
    ),
}


def _build_tool_instruction(skills=None, skill_doc=""):
    """按技能开关拼装系统指令；prompt 技能开且用户带了自定义编写文档时，
    用【用户自定义提示词编写规范】替换内置编写规范（内置仅兜底）。"""
    skills = skills or {}
    parts = [PET_TOOL_SEGMENTS["base"]]
    if skills.get("prompt", True):
        parts.append(PET_TOOL_SEGMENTS["prompt_mech"])
        doc = str(skill_doc or "").strip()
        if doc:
            parts.append(
                "\n【用户自定义提示词编写规范】（用户自带的提示词编写 skill 文档，"
                "编写提示词时优先遵循，与用户请求冲突时以用户请求为准）：\n" + doc[:8000]
            )
        else:
            parts.append(PET_TOOL_SEGMENTS["prompt_style"])
    if skills.get("lora", True):
        parts.append(PET_TOOL_SEGMENTS["lora"])
    if skills.get("model", True):
        parts.append(PET_TOOL_SEGMENTS["model"])
    # 分辨率工具属于核心能力，始终注入
    parts.append(PET_TOOL_SEGMENTS["size"])
    return "\n".join(p for p in parts if p)


def _filter_tools(skills=None):
    """按技能开关过滤下发给 LLM 的工具列表。
    generate_image / run_workflow 为核心能力始终下发；其余按开关裁剪。
    返回空列表时调用方不应带 tools 字段（部分供应商拒收空 tools）。"""
    skills = skills or {}
    prompt_on = skills.get("prompt", True)
    lora_on = skills.get("lora", True)
    model_on = skills.get("model", True)
    out = []
    for t in PET_IMAGE_TOOLS:
        name = (t.get("function") or {}).get("name", "")
        if name == "write_prompts":
            if prompt_on:
                out.append(t)
        elif "lora" in name:
            if lora_on:
                out.append(t)
        elif name == "set_checkpoint":
            if model_on:
                out.append(t)
        else:
            out.append(t)
    return out

class Live2DApi:
    @classmethod
    def setup(cls):
        @PromptServer.instance.routes.get("/xbhh/live2d_models")
        async def get_models(request):
            return web.json_response(cls.scan_models())

        @PromptServer.instance.routes.get("/xbhh/wallet/stats")
        async def get_wallet_stats(request):
            wallet = get_wallet()
            return web.json_response(wallet.get_stats())

        @PromptServer.instance.routes.get("/xbhh/pet/foods")
        async def get_foods(request):
            root_path = os.path.dirname(os.path.dirname(__file__))
            data_path = os.path.join(root_path, "data", "foods")
            config_path = os.path.join(root_path, "pet", "foods.json")
            
            # 加载配置
            food_config = {}
            if os.path.exists(config_path):
                with open(config_path, "r", encoding="utf-8") as f:
                    food_config = json.load(f)

            foods = []
            if os.path.exists(data_path):
                for filename in os.listdir(data_path):
                    if filename.endswith(".png"):
                        name = os.path.splitext(filename)[0]
                        price, tier = cls.get_food_details_from_config(name, food_config)
                        foods.append({
                            "id": filename,
                            "name": name,
                            "price": price,
                            "tier": tier,
                            "url": f"/xbhh/data/foods/{filename}"
                        })
            return web.json_response(foods)

        @PromptServer.instance.routes.post("/xbhh/pet/feed")
        async def feed_pet(request):
            try:
                post_data = await request.json()
                food_id = post_data.get("food_id")
                food_name = post_data.get("food_name", food_id)
                price = post_data.get("price", 1)
                
                wallet = get_wallet()
                if wallet.spend(price, food_id, food_name):
                    return web.json_response({"success": True, "balance": wallet.get_balance()})
                else:
                    return web.json_response({"success": False, "message": "CUI 余额不足"}, status=400)
            except Exception as e:
                return web.json_response({"success": False, "message": str(e)}, status=500)

        @PromptServer.instance.routes.get("/xbhh/data/foods/{filename}")
        async def get_food_file(request):
            filename = request.match_info['filename']
            root_path = os.path.dirname(os.path.dirname(__file__))
            file_path = os.path.join(root_path, "data", "foods", filename)
            if os.path.exists(file_path):
                return web.FileResponse(file_path)
            return web.Response(status=404)

        # ====================================================================
        # 工作流运行支持 (为后续 AI 自动绘画铺垫)
        #   - GET  /xbhh/pet/workflows        列出 data/workflows/ 下的 .json
        #   - GET  /xbhh/pet/workflows/{name} 读取指定工作流 JSON 内容
        #   实际排队提交仍由前端走 ComfyUI 原生 POST /prompt 完成，
        #   这样无需依赖 ComfyUI 内部 queue_prompt 的版本差异，最稳健。
        # ====================================================================
        @PromptServer.instance.routes.get("/xbhh/pet/workflows")
        async def list_workflows(request):
            """列出 data/workflows/ 下可作为测试/自动绘画目标的工作流 JSON"""
            root_path = os.path.dirname(os.path.dirname(__file__))
            wf_dir = os.path.join(root_path, "data", "workflows")
            workflows = []
            if os.path.isdir(wf_dir):
                for filename in sorted(os.listdir(wf_dir)):
                    if not filename.lower().endswith(".json"):
                        continue
                    fp = os.path.join(wf_dir, filename)
                    if not os.path.isfile(fp):
                        continue
                    try:
                        stat = os.stat(fp)
                    except OSError:
                        continue
                    workflows.append({
                        "name": filename,
                        "size": stat.st_size,
                        "modified": stat.st_mtime,
                    })
            return web.json_response(workflows)

        @PromptServer.instance.routes.get("/xbhh/pet/workflows/{name}")
        async def get_workflow(request):
            """读取并返回指定工作流 JSON 文件内容（前端拿到后 POST /prompt 运行）"""
            name = request.match_info["name"]
            root_path = os.path.dirname(os.path.dirname(__file__))
            wf_dir = os.path.join(root_path, "data", "workflows")
            # 路径穿越防护：name 须为纯文件名且落在 workflows 目录内
            if not name.lower().endswith(".json") or ".." in name:
                return web.json_response({"error": "invalid name"}, status=400)
            fp = os.path.join(wf_dir, name)
            try:
                real_fp = os.path.realpath(fp)
                real_dir = os.path.realpath(wf_dir)
                if real_fp != os.path.join(real_dir, os.path.basename(real_fp)):
                    return web.json_response({"error": "invalid name"}, status=400)
            except Exception:
                return web.json_response({"error": "invalid name"}, status=400)
            if not os.path.isfile(fp):
                return web.json_response({"error": "not found"}, status=404)
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    data = json.load(f)
                return web.json_response({"name": name, "workflow": data})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)

        # ====================================================================
        # AI 对话 (LLM 聊天代理，OpenAI 兼容格式，默认 DeepSeek)
        #   - POST /xbhh/pet/chat  body: {messages, config}
        #     config: {base_url, api_key, model, system_prompt}
        #   - 配置由前端从 ComfyUI 设置 (XBHH.Pet.Chat.*) 读取后随请求带上
        #   - 走后端代理的原因：key 不暴露给第三方页面、无 CORS 问题、
        #     换中转域名只改一处配置
        # ====================================================================
        def _call_vision_model(base_url, api_key, model, images, user_text):
            """调用视觉模型（OpenAI 兼容）分析图片，返回分析文本。
            images 为 data URL 列表；user_text 是用户本轮诉求。"""
            if base_url.endswith("/chat/completions"):
                vurl = base_url
            elif base_url.endswith("/v1"):
                vurl = base_url + "/chat/completions"
            else:
                vurl = base_url + "/v1/chat/completions"
            content = [{
                "type": "text",
                "text": (
                    "你是看板娘的「眼睛」。用户在 ComfyUI 里生成了一些图片，"
                    "现在想让你帮忙看图或选图。请结合用户诉求逐张分析"
                    "（按图1、图2…编号），描述每张的画面内容、构图与质量差异，"
                    "最后给出明确推荐及理由。用户诉求："
                    + (user_text or "看看这些图")
                ),
            }]
            for im in images:
                content.append({"type": "image_url", "image_url": {"url": im}})
            payload = {
                "model": model,
                "messages": [{"role": "user", "content": content}],
                "max_tokens": 1200,
                "temperature": 0.3,
            }
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            req = urllib.request.Request(
                vurl,
                data=json.dumps(payload).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = json.loads(resp.read().decode("utf-8", errors="replace"))
            choices = body.get("choices") or []
            return ((choices[0].get("message") or {}).get("content") or "").strip()

        def _extract_json(text):
            """从 LLM 回复里稳健地抠出 JSON 对象（容忍 ```json 围栏和前后废话）"""
            if not text:
                return None
            s = text.strip()
            if "```" in s:
                for seg in s.split("```"):
                    seg = seg.strip()
                    if seg.startswith("json"):
                        seg = seg[4:].strip()
                    if seg.startswith("{") and seg.endswith("}"):
                        s = seg
                        break
            i, j = s.find("{"), s.rfind("}")
            if i < 0 or j <= i:
                return None
            try:
                return json.loads(s[i : j + 1])
            except Exception:
                return None

        REVIEW_SYSTEM = (
            "你是 ComfyUI 自动出图的质量检查员。刚跑完一张图，你会拿到"
            "「本次使用的提示词」和「图片内容（来自视觉分析或图片本身）」。"
            "请对比两者，指出图与提示词的偏差、明显的质量缺陷（构图/肢体/"
            "色调/清晰度等），并给出优化后的提示词。\n"
            "必须只输出一个 JSON 对象，不要输出其他文字，格式：\n"
            '{"comment": "对这张图的简短点评（50字内，口语化）", '
            '"optimized_prompt": "优化后的完整提示词（若图已合格则原样返回）", '
            '"need_rerun": true或false}\n'
            "need_rerun 判断标准：图与提示词严重不符或有明显缺陷才为 true；"
            "轻微瑕疵或已经不错就 false，避免无限重画。"
        )

        @PromptServer.instance.routes.post("/xbhh/pet/auto_review")
        async def pet_auto_review(request):
            """跑图结束后 AI 自检：看图 → 点评 → 给出优化提示词（供前端决定是否重跑）"""
            try:
                data = await request.json()
            except Exception:
                return web.json_response(
                    {"success": False, "message": "Invalid JSON"}, status=400
                )

            config = data.get("config") or {}
            base_url = (config.get("base_url") or "https://api.deepseek.com").strip().rstrip("/")
            api_key = (config.get("api_key") or "").strip()
            model = (config.get("model") or "deepseek-chat").strip()
            images = [str(x) for x in (data.get("images") or []) if x][:2]
            prompt = str(data.get("prompt") or "").strip()
            round_no = int(data.get("round") or 0)

            if not images:
                return web.json_response({"success": False, "message": "没有图片可检查"})
            is_local = "localhost" in base_url or "127.0.0.1" in base_url
            if not api_key and not is_local:
                return web.json_response({"success": False, "message": "未配置 API Key"})

            user_text = (
                f"这是第 {round_no + 1} 轮自动出图。本次使用的提示词：\n{prompt or '（空）'}\n"
                "请检查图片并按要求输出 JSON。"
            )

            def _llm(messages, with_images=None):
                if with_images:
                    messages[-1]["content"] = [
                        {"type": "text", "text": str(messages[-1]["content"])}
                    ] + [
                        {"type": "image_url", "image_url": {"url": im}} for im in with_images
                    ]
                if base_url.endswith("/chat/completions"):
                    url = base_url
                elif base_url.endswith("/v1"):
                    url = base_url + "/chat/completions"
                else:
                    url = base_url + "/v1/chat/completions"
                headers = {"Content-Type": "application/json"}
                if api_key:
                    headers["Authorization"] = f"Bearer {api_key}"
                payload = {
                    "model": model,
                    "messages": messages,
                    "max_tokens": 900,
                    "temperature": 0.3,
                }
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers=headers,
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=120) as resp:
                    body = json.loads(resp.read().decode("utf-8", errors="replace"))
                choices = body.get("choices") or []
                return ((choices[0].get("message") or {}).get("content") or "").strip()

            try:
                v_model = (config.get("vision_model") or "").strip()
                if v_model:
                    # 双模型接力：视觉模型看图 → 分析文本交给主模型出 JSON
                    v_base = (config.get("vision_base_url") or base_url).strip().rstrip("/")
                    v_key = (config.get("vision_api_key") or api_key).strip()
                    v_user = (
                        "对比提示词与图片：" + user_text +
                        "请描述图片实际内容，并指出与提示词的偏差和明显缺陷。"
                    )
                    analysis = await asyncio.to_thread(
                        _call_vision_model, v_base, v_key, v_model, images, v_user
                    )
                    content = (
                        f"{user_text}\n\n【视觉模型对图片的分析】\n{analysis or '（视觉模型没有返回内容）'}"
                    )
                    raw = await asyncio.to_thread(
                        _llm, [
                            {"role": "system", "content": REVIEW_SYSTEM},
                            {"role": "user", "content": content},
                        ]
                    )
                else:
                    # 主模型直连看图（要求主模型多模态）
                    raw = await asyncio.to_thread(
                        _llm, [
                            {"role": "system", "content": REVIEW_SYSTEM},
                            {"role": "user", "content": user_text},
                        ], images,
                    )
                obj = _extract_json(raw)
                if not obj:
                    return web.json_response({
                        "success": False,
                        "message": f"AI 没有返回有效的 JSON：{(raw or '')[:200]}",
                    })
                return web.json_response({
                    "success": True,
                    "comment": str(obj.get("comment") or "").strip(),
                    "optimized_prompt": str(obj.get("optimized_prompt") or "").strip(),
                    "need_rerun": bool(obj.get("need_rerun")),
                })
            except urllib.error.HTTPError as e:
                try:
                    detail = e.read().decode("utf-8", errors="replace")[:300]
                except Exception:
                    detail = ""
                return web.json_response({
                    "success": False,
                    "message": f"接口返回 {e.code}: {detail or e.reason}",
                })
            except Exception as e:
                return web.json_response({
                    "success": False,
                    "message": f"自检失败: {type(e).__name__}: {e}",
                })

        @PromptServer.instance.routes.post("/xbhh/pet/chat")
        async def pet_chat(request):
            try:
                data = await request.json()
            except Exception:
                return web.json_response(
                    {"success": False, "message": "Invalid JSON"}, status=400
                )

            messages = data.get("messages") or []
            config = data.get("config") or {}
            base_url = (config.get("base_url") or "https://api.deepseek.com").strip().rstrip("/")
            api_key = (config.get("api_key") or "").strip()
            model = (config.get("model") or "deepseek-chat").strip()
            system_prompt = (config.get("system_prompt") or "").strip()
            # 技能开关（prompt/lora/model，缺省全开）+ 提示词槽位上下文
            skills = data.get("skills") or {}
            prompt_slots = data.get("prompt_slots") or {}
            skill_doc = ""
            slots_pref = ""
            if skills.get("prompt", True) and isinstance(prompt_slots, dict):
                skill_doc = str(prompt_slots.get("skill_doc") or "").strip()
                cats = prompt_slots.get("categories") or []
                slot_lines = []
                for i, c in enumerate(cats, 1):
                    if isinstance(c, dict):
                        name = str(c.get("name") or "").strip()
                        cur = str(c.get("current") or "").strip()
                        nid = c.get("node_id")
                    else:
                        name, cur, nid = str(c).strip(), "", None
                    if not name:
                        continue
                    if nid is not None:
                        slot_lines.append(
                            f"{i}. {name} → 节点#{nid}"
                            + (f"（当前：{cur[:150]}）" if cur else "（空）")
                        )
                    else:
                        slot_lines.append(f"{i}. {name}（未绑定节点，写了由系统兜底）")
                if slot_lines:
                    slots_pref = (
                        "\n\n【提示词槽位】写提示词/画图时调用 write_prompts，"
                        "按这些分类逐条填写（各分类的写入位置用户已预先配置，"
                        "你只管给内容；LoRA 触发词由 LoRA 堆 Plus 节点自动输出，无需你写）：\n"
                        + "\n".join(slot_lines)
                    )
                # 画师串库：用户自己维护的画师组合（画风效果主要靠画师串）
                artist_str = str(prompt_slots.get("artist_strings") or "").strip()
                if artist_str:
                    slots_pref += (
                        "\n\n【画师串库】（每行一条：多数为「关键词: @画师, @画师」，"
                        "无冒号行为通用串）。按以下规则机械执行，不要自由发挥：\n"
                        "1. 用户描述的画风/场景/情绪词与某行冒号前的关键词相同或同义"
                        "（如 水彩≈watercolor）→ 用该行画师串；多行命中 → 只取命中最多的一行；\n"
                        "2. 没有任何行命中 → 若存在无冒号的通用行，最多用一条通用行；"
                        "连通用行都没有 → 完全不用画师串；\n"
                        "3. 任何情况下严禁使用库外的画师名、严禁自己编造 @ 人名；\n"
                        "4. 选中的串以 @ 开头原样写进「画风」content 开头，"
                        "并在回复里注明用了哪行（如「🎨 画风（水彩）」），方便用户核对。\n"
                        + artist_str[:2000]
                    )

            if not messages:
                return web.json_response(
                    {"success": False, "message": "消息为空"}, status=400
                )

            # 本地 Ollama/LM Studio 无需 key；远端服务必须有 key
            is_local = "localhost" in base_url or "127.0.0.1" in base_url
            if not api_key and not is_local:
                return web.json_response({
                    "success": False,
                    "message": "未配置 API Key。请到 ComfyUI 设置 → XBHH 看板娘对话相关设置里填写（DeepSeek 平台创建）",
                })

            # URL 规整：兼容 base 带/不带 /v1、直接给完整端点三种写法
            if base_url.endswith("/chat/completions"):
                url = base_url
            elif base_url.endswith("/v1"):
                url = base_url + "/chat/completions"
            else:
                url = base_url + "/v1/chat/completions"

            # 组装消息：system 人设 + 工具说明 + LoRA 使用统计（智能分级注入）
            skip_lora = data.get("skip_lora", False)
            skills = data.get("skills") or {}
            if skip_lora:
                lora_pref = ""
            else:
                lora_pref = _build_lora_preference_text("auto", messages)
            # 大模型列表：仅在消息涉及大模型相关关键词时注入（内部自行判断）
            ckpt_pref = "" if skip_lora else _build_checkpoint_text(messages)
            # 最近执行错误：前端在用户问"为什么报错/帮我解决"时附带
            error_ctx = str(data.get("error_context") or "").strip()
            if error_ctx:
                error_ctx = (
                    "\n\n【最近执行错误】（ComfyUI 工作流运行失败信息，"
                    "用户需要你诊断原因并给出修复建议）\n" + error_ctx[:3000]
                )

            # ===== 多模态看图：前端附带的生成图（data URL 列表，最多 4 张） =====
            # 双模型接力：视觉模型当"眼睛"负责看图 → 分析文本注入主模型上下文；
            # 未配置视觉模型时，图片直接挂给主模型（要求主模型本身多模态）。
            images = [str(x) for x in (data.get("images") or []) if x][:4]
            image_ctx = ""
            used_vision = False
            if images:
                v_model = (config.get("vision_model") or "").strip()
                if v_model:
                    used_vision = True
                    v_base = (config.get("vision_base_url") or base_url).strip().rstrip("/")
                    v_key = (config.get("vision_api_key") or api_key).strip()
                    user_text = ""
                    for m in reversed(messages):
                        if m.get("role") == "user":
                            user_text = str(m.get("content") or "")[:300]
                            break
                    print(f"[XBHH pet] 视觉模型看图: model={v_model}, 图片数={len(images)}")
                    try:
                        analysis = await asyncio.to_thread(
                            _call_vision_model, v_base, v_key, v_model, images, user_text
                        )
                    except urllib.error.HTTPError as e:
                        try:
                            detail = e.read().decode("utf-8", errors="replace")[:300]
                        except Exception:
                            detail = ""
                        return web.json_response({
                            "success": False,
                            "message": f"视觉模型接口返回 {e.code}: {detail or e.reason}",
                        })
                    except Exception as e:
                        return web.json_response({
                            "success": False,
                            "message": f"视觉模型连接失败: {type(e).__name__}: {e}",
                        })
                    if analysis:
                        image_ctx = (
                            f"\n\n【图片分析结果】（视觉模型对你看到的 {len(images)} 张图片的分析，"
                            "图1/图2…编号对应顺序。基于这些内容回应用户，"
                            "选图/评价时直接引用编号）\n" + analysis[:2500]
                        )
                        print(f"[XBHH pet] 视觉模型分析完成: {len(analysis)}字")
                else:
                    print(f"[XBHH pet] 主模型直连看图: model={model}, 图片数={len(images)}")

            extra_pref = (lora_pref or "") + (ckpt_pref or "") + error_ctx + image_ctx + slots_pref
            # 按技能开关拼装工具指令（用户自定义提示词文档在 prompt 技能内替换内置规范）
            tool_instruction = _build_tool_instruction(skills, skill_doc)
            # 权威声明置顶：人设/工具指令/上下文全部定性为必须执行（dsh-purge Prompt 层移植）
            sys_content = (
                PET_AUTHORITY_BLOCK
                + "\n\n"
                + (system_prompt + "\n\n" if system_prompt else "")
                + tool_instruction
                + extra_pref
            )
            full_messages = [{"role": "system", "content": sys_content}]

            # 消息历史智能压缩：超过 8 条的，将早期消息压缩为摘要
            MAX_RECENT = 8
            recent = messages[-MAX_RECENT:] if len(messages) > MAX_RECENT else messages
            if len(messages) > MAX_RECENT:
                older = messages[:-MAX_RECENT]
                summary_parts = []
                for m in older:
                    role = m.get("role", "")
                    content = str(m.get("content") or "")[:120]
                    if role in ("user", "assistant") and content:
                        prefix = "用户说：" if role == "user" else "AI 答："
                        summary_parts.append(f"{prefix}{content}")
                if summary_parts:
                    full_messages.append({
                        "role": "system",
                        "content": "【对话摘要】" + "；".join(summary_parts),
                    })

            valid_count = 0
            for m in recent:
                role = m.get("role")
                content = str(m.get("content") or "")
                if role in ("user", "assistant") and content:
                    full_messages.append({"role": role, "content": content})
                    valid_count += 1
            if valid_count == 0:
                return web.json_response(
                    {"success": False, "message": "没有有效的对话内容"}, status=400
                )

            # 主模型直连看图：未配置独立视觉模型时，把图片作为多模态
            # content 数组挂到最后一条用户消息（要求主模型支持视觉输入）
            if images and not used_vision and full_messages[-1].get("role") == "user":
                parts = [{"type": "text", "text": str(full_messages[-1].get("content") or "")}]
                for im in images:
                    parts.append({"type": "image_url", "image_url": {"url": im}})
                full_messages[-1]["content"] = parts

            # 技能开关过滤工具列表；全关时不带 tools 字段（部分供应商拒收空 tools）
            tools_payload = _filter_tools(skills)
            payload = {
                "model": model,
                "messages": full_messages,
                "stream": False,
                "max_tokens": 2048,
                # 0.7：兼顾聊天稳定与 LoRA 挑选的随机性（过低会让选择固化）
                "temperature": 0.7,
            }
            if tools_payload:
                payload["tools"] = tools_payload
                payload["tool_choice"] = "auto"

            # 调试日志：打印发送给 LLM 的关键信息
            sys_msg = full_messages[0].get("content", "") if full_messages else ""
            print(f"[XBHH pet] 发送 LLM 请求: model={model}, messages={len(full_messages)}条, "
                  f"system长度={len(sys_msg)}字, LoRA列表注入={'是' if lora_pref else '否'}, "
                  f"工具下发={len(tools_payload)}个, 槽位注入={'是' if slots_pref else '否'}, "
                  f"自定义规范={'是' if skill_doc else '否'}")
            print(f"[XBHH pet] 最近用户消息: {recent[-1].get('content', '')[:80] if recent else '(无)'}")
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            def _do_chat():
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers=headers,
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=90) as resp:
                    body = json.loads(resp.read().decode("utf-8", errors="replace"))
                choices = body.get("choices") or []
                msg = (choices[0].get("message") or {}) if choices else {}

                # 调试日志：打印 LLM 原始返回
                finish_reason = (choices[0].get("finish_reason") or "") if choices else ""
                raw_tool_calls = msg.get("tool_calls") or []
                print(f"[XBHH pet] LLM 返回: finish_reason={finish_reason}, "
                      f"content={repr((msg.get('content') or '')[:100])}, "
                      f"tool_calls数={len(raw_tool_calls)}")
                for rtc in raw_tool_calls:
                    fn_raw = rtc.get("function") or {}
                    print(f"[XBHH pet]   工具: {fn_raw.get('name')}, 参数: {str(fn_raw.get('arguments'))[:200]}")

                # 解析 function calling 返回的 tool_calls（OpenAI 兼容格式）
                tool_calls = []
                for tc in msg.get("tool_calls") or []:
                    fn = tc.get("function") or {}
                    args = fn.get("arguments")
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except Exception:
                            args = {}
                    if not isinstance(args, dict):
                        args = {}
                    tool_calls.append({"name": fn.get("name"), "arguments": args})

                # random_style_loras：由后端真随机抽取，把具体列表回填进参数，
                # 前端照单添加即可（LLM 自己挑名字有明显偏差，总盯着常用的几个）
                for tc in tool_calls:
                    if tc.get("name") != "random_style_loras":
                        continue
                    a = tc.get("arguments") or {}
                    try:
                        total = (
                            float(a.get("total_strength"))
                            if a.get("total_strength") is not None
                            else 1.2
                        )
                    except Exception:
                        total = 1.2
                    picks = _random_pick_style_loras(
                        count=a.get("count"),
                        category=a.get("category") or "画风",
                        base=a.get("base") or a.get("base_model") or "",
                        total=total,
                        keywords=a.get("style_keywords") or [],
                    )
                    tc["arguments"] = {
                        "loras": [{"lora_name": n, "strength": w} for n, w in picks],
                        "category": a.get("category") or "画风",
                        "base": a.get("base") or "",
                        "target": a.get("target") or "",
                    }

                return {
                    "reply": (msg.get("content") or "").strip(),
                    "tool_calls": tool_calls,
                    "usage": body.get("usage"),
                }

            try:
                result = await asyncio.to_thread(_do_chat)
            except urllib.error.HTTPError as e:
                try:
                    detail = e.read().decode("utf-8", errors="replace")[:300]
                except Exception:
                    detail = ""
                return web.json_response({
                    "success": False,
                    "message": f"LLM 接口返回 {e.code}: {detail or e.reason}",
                })
            except Exception as e:
                return web.json_response({
                    "success": False,
                    "message": f"连接失败: {type(e).__name__}: {e}",
                })

            if not result["reply"] and not result["tool_calls"]:
                return web.json_response({
                    "success": False,
                    "message": "模型返回了空回复，请检查模型名是否正确",
                })
            return web.json_response({
                "success": True,
                "reply": result["reply"],
                "tool_calls": result["tool_calls"],
                "usage": result.get("usage"),
            })

        @PromptServer.instance.routes.get("/xbhh/waifu-tips.json")
        async def get_waifu_tips(request):
            root_path = os.path.dirname(os.path.dirname(__file__))
            ext_name = os.path.basename(root_path)
            # 原始 JSON 模板路径
            json_path = os.path.join(root_path, "web", "js", "pet", "waifu-tips.json")
            
            if not os.path.exists(json_path):
                return web.Response(status=404)
                
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                
                # 动态注入扫描到的 V2 模型
                scanned = cls.scan_models()
                v2_models = []
                for m in scanned["v2"]:
                    v2_models.append({
                        "name": m["name"],
                        "paths": [f"/extensions/{ext_name}/live2d/v2/{m['name']}/{c}" for c in m["clothes"]],
                        "message": f"来自 {m['name']} 的动态加载模型 ~"
                    })
                
                if v2_models:
                    data["models"] = v2_models
                    
                return web.json_response(data)
            except Exception as e:
                print(f"[XBHH] Error generating dynamic waifu-tips.json: {e}")
                return web.Response(status=500)

    @staticmethod
    def get_food_details_from_config(name: str, config: dict):
        name_lower = name.lower()
        for tier_key, tier_info in config.items():
            if name_lower in [i.lower() for i in tier_info.get("items", [])]:
                return tier_info.get("price", 1), tier_info.get("tier_name", "普通")
        return 1, "普通"

    @staticmethod
    def scan_models():
        # 获取插件根目录
        root_path = os.path.dirname(os.path.dirname(__file__))
        ext_name = os.path.basename(root_path)
        # 模型存放在 web/live2d 下
        live2d_path = os.path.join(root_path, "web", "live2d")
        
        models = {
            "v2": [],
            "v5": []
        }
        
        if not os.path.exists(live2d_path):
            return models
            
        # 扫描 V2 模型
        v2_path = os.path.join(live2d_path, "v2")
        if os.path.exists(v2_path):
            if os.path.isdir(v2_path):
                for dirname in os.listdir(v2_path):
                    dirpath = os.path.join(v2_path, dirname)
                    if os.path.isdir(dirpath):
                        # 查找 model.json 作为主入口
                        main_model = os.path.join(dirpath, "model.json")
                        if os.path.exists(main_model):
                            clothes = []
                            for filename in os.listdir(dirpath):
                                if filename.startswith("model") and filename.endswith(".json"):
                                    clothes.append(filename)
                            clothes.sort()
                            
                            models["v2"].append({
                                "name": dirname,
                                "path": f"/extensions/{ext_name}/live2d/v2/{dirname}/model.json",
                                "clothes": clothes
                            })
        
        # 扫描 V4/V5 模型
        for v_dir in ["v4", "v5"]:
            v_path = os.path.join(live2d_path, v_dir)
            if os.path.exists(v_path):
                for dirname in os.listdir(v_path):
                    dirpath = os.path.join(v_path, dirname)
                    if os.path.isdir(dirpath):
                        for filename in os.listdir(dirpath):
                            if filename.endswith(".model3.json"):
                                models["v5"].append({
                                    "name": dirname,
                                    "path": f"/extensions/{ext_name}/live2d/{v_dir}/{dirname}/{filename}"
                                })
                                break
        return models
