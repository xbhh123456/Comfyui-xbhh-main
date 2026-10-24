import json
import re
import threading

from nodes import LoraLoader

from .lora_loader_plus import (
    FlexibleOptionalInputType,
    AnyType,
    any_type,
    get_lora_by_filename,
    get_active_trigger_from_db,
)


# ============================================================================
# LoRA 测试堆节点 — 依次单独执行每个 LoRA
# ============================================================================
class XBHHLoraTestLoader:
    """
    XBHH LoRA 测试堆

    功能与 Multi Lora Loader Plus 一致（树形选择器 / 预设导入导出 / 触发词 / 预览图），
    区别：每次执行只加载一个 LoRA（按 test_index 位置的那个），行内权重可调
    （strength / strengthTwo / 触发词权重），配合前端在每次执行完成后自动将索引 +1 并重新排队，
    从而实现「跑完一个自动跑下一个」的批量测试，直到全部跑完自动停止并归零。
    """

    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "status_text", "triggers")
    FUNCTION = "load_loras"
    CATEGORY = "XBHH/loaders"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 强制每次队列都重新执行本节点：
        # 测试循环依赖 test_index 推进触发真实执行，缓存命中会导致
        # 前端收不到 executed 事件而卡住循环
        return float("NaN")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": FlexibleOptionalInputType(type=any_type, data={
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "lora_preset": ("STRING", {"forceInput": True}),
                "test_index": ("INT", {"default": 0, "min": 0, "max": 100000}),
            }),
            "hidden": {},
        }

    def load_loras(self, model=None, clip=None, lora_preset=None, test_index=0, **kwargs):
        # 1. 收集所有 LoRA 行并按从上到下（widget 序号）排序
        rows = []  # (order, cfg)

        # 1a. 外部输入的 lora_preset（格式与 Plus 一致：on|lora|strength|strengthTwo|trigger|triggerWeight）
        #     权重字段参与实际加载，缺省按 1.0 处理
        preset_seq = 0
        if lora_preset and isinstance(lora_preset, str):
            for line in lora_preset.strip().split("\n"):
                parts = line.split("|")
                if len(parts) >= 2 and parts[1].strip():
                    try:
                        strength = float(parts[2]) if len(parts) > 2 else 1.0
                    except ValueError:
                        strength = 1.0
                    try:
                        strength_two = float(parts[3]) if len(parts) > 3 and parts[3].strip() else None
                    except ValueError:
                        strength_two = None
                    try:
                        trigger_weight = float(parts[5]) if len(parts) > 5 else 1.0
                    except ValueError:
                        trigger_weight = 1.0
                    rows.append((100000 + preset_seq, {
                        "on": parts[0] == "1",
                        "lora": parts[1].strip(),
                        "strength": strength,
                        "strengthTwo": strength_two,
                        # 第 5 段（触发词）不再从预设读取：触发词以数据库为唯一来源
                        "trigger": "",
                        "triggerWeight": trigger_weight,
                    }))
                    preset_seq += 1

        # 1b. 手动添加的行 lora_N
        for key, value in kwargs.items():
            m = re.match(r"^lora_(\d+)$", key, re.IGNORECASE)
            if m and isinstance(value, dict) and value.get("lora"):
                rows.append((int(m.group(1)), value))

        rows.sort(key=lambda x: x[0])

        # 2. 测试序列 = 已启用（on 不为 False）且有名称的行
        seq = [
            v for _, v in rows
            if v.get("on", False) and v.get("lora") and v["lora"] != "None"
        ]
        total = len(seq)
        idx = max(0, int(test_index or 0))

        status_text = ""
        triggers_text = ""
        active_name = None

        if total == 0:
            status_text = "⚠ 未添加任何 LoRA"
        elif idx >= total:
            status_text = f"✗ 索引 {idx} 超出范围（共 {total} 个）"
        else:
            row = seq[idx]
            lora_name = row["lora"]
            active_name = lora_name

            # 权重：行内可调（默认 1.0），strengthTwo 未设置（None）时跟随模型强度
            try:
                strength_model = float(row.get("strength", 1.0))
            except (TypeError, ValueError):
                strength_model = 1.0
            strength_clip = row.get("strengthTwo")
            try:
                strength_clip = float(strength_clip) if strength_clip is not None else strength_model
            except (TypeError, ValueError):
                strength_clip = strength_model

            # 触发词：数据库为准（唯一来源；数据库无记录时用行内值兜底）
            trigger = row.get("trigger", "") or ""
            db_trigger = get_active_trigger_from_db(lora_name)
            if db_trigger is not None:
                trigger = str(db_trigger).strip()
            trigger_clean = trigger.strip()
            if trigger_clean:
                # 未显式自定义权重（默认1.0）时自动同步 LoRA 强度；权重1.00或多Tag不加括号
                try:
                    trigger_weight = float(row.get("triggerWeight", 1.0))
                except (TypeError, ValueError):
                    trigger_weight = 1.0
                effective_weight = trigger_weight if abs(trigger_weight - 1.0) > 0.001 else strength_model
                is_default_weight = abs(effective_weight - 1.0) < 0.001
                is_multi_tag = "," in trigger_clean or "\n" in trigger_clean
                already_weighted = (trigger_clean.startswith("(") and trigger_clean.endswith(")")) or (":" in trigger_clean and trigger_clean.endswith(")"))
                triggers_text = trigger_clean if (is_default_weight or is_multi_tag or already_weighted) else f"({trigger_clean}:{effective_weight:.2f})"

            lora_file = get_lora_by_filename(lora_name)
            if lora_file is None:
                print(f"[XBHH] Warning: LoRA not found: {lora_name}")
                status_text = f"✗ 未找到 LoRA 文件: {lora_name}"
            else:
                # clip 不存在时 CLIP 强度归 0；双 0 权重跳过加载（循环照常推进）
                strength_clip_eff = strength_clip if clip is not None else 0

                if strength_model == 0 and strength_clip_eff == 0:
                    pass
                else:
                    # LFU 使用统计（与 Plus 一致）
                    try:
                        from . import lora_database
                        threading.Thread(
                            target=lambda: lora_database.increment_lora_use(lora_file),
                            daemon=True,
                        ).start()
                    except Exception:
                        pass

                    if model is not None:
                        try:
                            model, clip = LoraLoader().load_lora(
                                model, clip, lora_file, strength_model, strength_clip_eff
                            )
                        except Exception as e:
                            print(f"[XBHH] Error loading LoRA {lora_name}: {e}")

                status_text = f"[{idx + 1}/{total}] {lora_name}"

        # 3. 通过 ui 通知前端本轮执行信息（驱动自动推进下一轮）
        ui = {
            "test": [json.dumps(
                {"index": idx, "total": total, "lora": active_name or "", "status": status_text},
                ensure_ascii=False,
            )]
        }
        return {"ui": ui, "result": (model, clip, status_text, triggers_text)}


NODE_CLASS_MAPPINGS = {
    "XBHHLoraTestLoader": XBHHLoraTestLoader
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHLoraTestLoader": "XBHH Lora Test Loader"
}
