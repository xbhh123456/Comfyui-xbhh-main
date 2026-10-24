import os
import json
import sys

EXPR_SUFFIX = '.exp3.json'
MOTION_SUFFIX = '.motion3.json'


def strip_suffix(filename, suffix):
    return filename[:-len(suffix)] if filename.endswith(suffix) else filename


def is_idle_name(name):
    low = name.lower()
    return 'idle' in low or 'idel' in low


def collect_expressions(model_dir):
    """表情：expressions/ 子目录 + 模型根目录，两处都收"""
    expressions = []
    used = set()

    exp_dir = os.path.join(model_dir, "expressions")
    if os.path.isdir(exp_dir):
        for f in sorted(os.listdir(exp_dir)):
            if f.endswith(EXPR_SUFFIX):
                expressions.append({
                    "Name": strip_suffix(f, EXPR_SUFFIX),
                    "File": f"expressions/{f}",
                })
                used.add(f)

    for f in sorted(os.listdir(model_dir)):
        if f.endswith(EXPR_SUFFIX) and f not in used:
            expressions.append({
                "Name": strip_suffix(f, EXPR_SUFFIX),
                "File": f,
            })

    return expressions


def collect_motions(model_dir):
    """动画：motions/ 子目录 + 模型根目录，idle 统一归到 Idle 组"""
    motions = {}

    def add(group, file_path):
        motions.setdefault(group, []).append({"File": file_path})

    motions_dir = os.path.join(model_dir, "motions")
    if os.path.isdir(motions_dir):
        for f in sorted(os.listdir(motions_dir)):
            if f.endswith(MOTION_SUFFIX):
                name = strip_suffix(f, MOTION_SUFFIX)
                add("Idle" if is_idle_name(name) else name, f"motions/{f}")

    for f in sorted(os.listdir(model_dir)):
        if f.endswith(MOTION_SUFFIX):
            name = strip_suffix(f, MOTION_SUFFIX)
            add("Idle" if is_idle_name(name) else name, f)

    return motions


def update_model_config(model_dir):
    # 查找 model3.json 文件
    model_files = sorted(f for f in os.listdir(model_dir) if f.endswith('.model3.json'))
    if not model_files:
        print(f"Error: No .model3.json found in {model_dir}")
        return

    model_json_path = os.path.join(model_dir, model_files[0])
    print(f"Processing {model_json_path}...")

    with open(model_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    file_refs = data.get("FileReferences", {})

    # 1. 表情（expressions/ 与根目录都收）
    expressions = collect_expressions(model_dir)
    if expressions:
        file_refs["Expressions"] = expressions
        print(f"Added {len(expressions)} expressions.")
    else:
        print("No expressions found, skipping Expressions update.")

    # 2. 动画（motions/ 与根目录都收，idle 归到 Idle）
    motions = dict(file_refs.get("Motions") or {})
    for group, items in collect_motions(model_dir).items():
        motions[group] = items
    if motions:
        file_refs["Motions"] = motions
        print(f"Added {len(motions)} motion groups: {', '.join(motions.keys())}")
    else:
        print("No motions found, skipping Motions update.")

    data["FileReferences"] = file_refs

    # 写回文件
    with open(model_json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent='\t', ensure_ascii=False)
        f.write('\n')

    print("Done!")


if __name__ == "__main__":
    # 如果提供了路径参数则使用，否则使用当前目录
    target_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    update_model_config(target_dir)
