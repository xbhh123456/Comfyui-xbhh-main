import os
import json
import sys

def update_model_config(model_dir):
    # 查找 model3.json 文件
    model_files = [f for f in os.listdir(model_dir) if f.endswith('.model3.json')]
    if not model_files:
        print(f"Error: No .model3.json found in {model_dir}")
        return
    
    model_json_path = os.path.join(model_dir, model_files[0])
    print(f"Processing {model_json_path}...")

    with open(model_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    file_refs = data.get("FileReferences", {})

    # 1. 自动处理 Expressions
    exp_dir = os.path.join(model_dir, "expressions")
    if os.path.exists(exp_dir) and os.path.isdir(exp_dir):
        expressions = []
        for f in os.listdir(exp_dir):
            if f.endswith('.exp3.json'):
                name = os.path.splitext(f)[0]
                expressions.append({
                    "Name": name,
                    "File": f"expressions/{f}"
                })
        file_refs["Expressions"] = expressions
        print(f"Added {len(expressions)} expressions.")
    else:
        print("No expressions directory found, skipping Expressions update.")

    # 2. 自动处理 Idle Motions
    # 扫描目录下所有包含 'idel' 或 'Idle' 的 motion3.json
    idle_motions = []
    for f in os.listdir(model_dir):
        if f.lower().endswith('.motion3.json') and ('idel' in f.lower() or 'idle' in f.lower()):
            idle_motions.append({"File": f})
    
    if idle_motions:
        motions = file_refs.get("Motions", {})
        motions["Idle"] = idle_motions
        file_refs["Motions"] = motions
        print(f"Added {len(idle_motions)} idle motions.")

    data["FileReferences"] = file_refs

    # 写回文件
    with open(model_json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent='\t', ensure_ascii=False)
    
    print("Done!")

if __name__ == "__main__":
    # 如果提供了路径参数则使用，否则使用当前目录
    target_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    update_model_config(target_dir)
