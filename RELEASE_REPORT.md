# v2.0.1 提交报告

本报告用于本次向 GitHub 推送的变更审阅与发布操作，配套文档：[CHANGELOG.md](./CHANGELOG.md)（版本历史）、[README.md](./README.md)、[README_EN.md](./README_EN.md)、[ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 一、报告信息

| 项目 | 内容 |
| --- | --- |
| 版本 | `2.0.1`（`pyproject.toml`） |
| 基线 | `09be92c` · v1.5.1 · 2026-08-08 |
| 分支 | `main` |
| 远端 | `https://github.com/xbhh123456/xbhh-lora.git` |
| 变更规模 | 210 项：已暂存 204 / 未暂存 3 / 未跟踪 3 |
| 代码行数 | 已暂存区 **+99,887 / −3,830** |
| 报告日期 | 2026-10-24 |

一句话总结：本次是**功能级大版本**——新增配方管理器、C 站补齐与内置下载器、备份体检、参考图库，重做 Live2D 交互与热键，并修复 8 个与 hash、重复下载、撤销恢复相关的问题，同时补齐中英双语文档。

---

## 二、核心文件变更

| 文件 | 行数变化 | 说明 |
| --- | --- | --- |
| `web/lora_manager.html` | +16,531 | 三模式管理页（LoRA / 配方 / 参考图），列表、配方卡、补齐弹窗、备份体检 |
| `lora_metadata.py` | +2,772 | 扫描、hash、预览图、配方图、备份清单、C 站检索、文件操作等路由 |
| `web/js/pet/live2d_pet.js` | +3,286 | Live2D 主控：模型菜单、热键、金币、穿透 |
| `web/js/pet/live2d_loader.js` | +2,339 | V4/V5 引擎加载与降级重试 |
| `web/js/pet/live2d_v2_pet.js` | +2,240 | V2 引擎与换装 |
| `lora_database.py` | +1,494 | 表结构扩展、内置 Civitai 下载器、任务队列 |
| `pet/live2d_api.py` | +1,375 | 模型扫描接口，V2/V4/V5 自动发现 |
| `web/js/loraManager.js` | +570 | 管理器主逻辑与桥接 |
| `web/js/recipePresetManager.js` | +1,022（新增） | 配方面板、应用 / 撤销快照 |
| `utils/lora_viewer.html` | +611（新增） | 单页 LoRA 查看器 |
| `lora_loader.py` | +181 | 列表接口、预览图、缩略图缓存 |
| `lora_loader_plus.py` | +95 | LoRA 堆 Plus 执行逻辑 |
| `utils/update_expressions.py` | +117 | 兼容根目录表情/动作与 `motions/idle` |
| `recipe_preset_manager.py` | +52（新增） | 配方节点 |
| `__init__.py` | +12 | 节点注册调整 |

---

## 三、功能变更

### 1. 配方管理器

- 新增 `recipe_preset_manager.py` + `web/js/recipePresetManager.js`
- 配方结构：`{id, name, category, prompt, preview, tags, note, rating, loras[]}`
- 应用前把目标堆的 `stacks / presetText / promptText / promptTargets` 写入 `node.properties.xbhhPmBackup`
- 再次点击同一配方按快照还原；多个 LoRA 堆各自独立
- 支持配方图、标签、评分、备注、分享文件导入导出
- 名称匹配对大小写、路径分隔符做归一化

### 2. C 站补齐与内置下载器

- 缺失检测 → `/xbhh/lora/exists` 本地复检 → Civitai 候选 → 下载
- 内置下载：`.part` 流式 → SHA256 → 落 `models/loras` → `<stem>.preview.png` → 入库 → 清缓存
- 落盘前 `_find_lora_by_basename()` 全目录按文件名查重
- 前端下载成功后回填真实文件名、整行置灰；任务丢失 8 次轮询后停止

### 3. 备份与体检

- 导出整库指纹清单（名称 / hash / 大小 + 分类、触发词、评级）
- 与当前库比对列出缺失，支持一键送 C 站补齐
- 默认目录 `ComfyUI/user/xbhh/backup`

### 4. 参考图库与资料管理

- 上传、重命名、移动、删除、回收站、送到 LoadImage
- LoRA 多套提示词 Profile、分类、星级、使用次数（LFU）

### 5. Live2D

- 新增 DS 面捕版、DS 鼠控版、zyby 三套 V4 模型与鲸鱼音效素材
- 自动读取 `.vtube.json` 的 `Hotkeys` 映射为快捷键，菜单可开关
- 动画动作可自定义按键；`items_pinned_to_model.json` 随模型加载
- `update_expressions.py` 支持 `expressions/` + 根目录的表情、`motions/` + 根目录的动作，idle 自动归组

### 6. 工程与发布

- `pyproject.toml`：版本 2.0.1、description、keywords
- 新增 `copy_to_comfyui.bat`；更新 `.comfyignore` 与 `.github/workflows/publish.yml`

---

## 四、缺陷修复

| # | 现象 | 根因 | 修复位置 |
| --- | --- | --- | --- |
| 1 | 配方按 hash 找不到本地 LoRA | 配方存 AutoV2 短 hash，本地是 64 位 SHA256，严格相等永远不成立 | `web/lora_manager.html` `findLoraByName` 改前缀匹配 |
| 2 | 同上，后端兜底查询也失败 | `/xbhh/lora/exists` 用 `=` 精确匹配 | `lora_metadata.py` `_locate_lora_file` 按长度分流 |
| 3 | 文件已移回本地仍被重复下载 | 补齐流程只在打开弹窗时检查一次 | `checkLocalLoraExists()` 加复检与异常兜底 |
| 4 | 下载完成后配方行仍显示「未找到」 | 未回填后端返回的真实文件名 | 新增 `markCandidateRowDone()` |
| 5 | 下载成功后同一行还能再点，重复下载 | 只禁用了当前按钮 | 整行按钮置灰「已补齐」 |
| 6 | 后端重启后前端无限轮询 | 任务丢失分支没有终止条件 | `lostTicks >= 8` 停止并提示 |
| 7 | 子目录已有同名文件仍会再下一份 | 只查 `loras` 根目录 | `lora_database.py` `_find_lora_by_basename()` |
| 8 | Windows 下配方撤销漏恢复 | 名字比较区分大小写、斜杠方向不同 | `recipePresetManager.js` `restoreStackRows` 归一化 |

---

## 五、验证记录

| 项目 | 结果 |
| --- | --- |
| `python -m py_compile lora_metadata.py lora_database.py` | 通过（`PY OK`） |
| `GetDiagnostics` · `web/lora_manager.html` | 无报错 |
| `GetDiagnostics` · `web/js/recipePresetManager.js` | 无报错 |
| 大文件检查（>40MB） | 无，不会触发 GitHub 单文件 100MB 限制 |
| 浏览器实测 | **待你在部署环境确认**：三模式可切换、配方应用/撤销、C 站补齐下载入库 |

建议实机验证路径（部署到 `D:\xbhh\1\ComfyUI_windows_portable\ComfyUI\custom_nodes\Comfyui-xbhh-main` 并重启后端后）：

1. 管理器打开 → 三种模式切换正常，缩略图能显示
2. 加一个 LoRA 堆 → 应用配方 → 再点一次恢复原状
3. 配方里故意留一个缺失 LoRA → C 站补齐 → 下载后行变「已补齐」
4. 把 LoRA 移出再移回 → 点补齐 → 应直接判定本地已存在

---

## 六、提交前必须处理

### 1. 禁止提交缓存

当前有 9 个 `__pycache__` 项被暂存（含新增 `.pyc`）。执行：

```bash
git rm -r --cached __pycache__ pet/__pycache__ utils/__pycache__
```

建议同时新增 `.gitignore`：

```gitignore
__pycache__/
*.py[cod]
backup_2026*/
.trae/
.vscode/
```

### 2. 确认是否提交以下目录

| 路径 | 内容 | 建议 |
| --- | --- | --- |
| `backup_20260823/` | 本地旧版备份（2 个文件） | 不提交 |
| `.trae/` | AI 工具文档 | 不提交 |
| `.vscode/` | 编辑器配置 | 可选 |
| `web/live2d/v4/DS面捕版`、`DS鼠控版`、`zyby` | 第三方 Live2D 模型（140+ 个资源文件） | **确认有 redistribution 授权再提交** |

### 3. 其他提示

- `README.md` 出现 `LF will be replaced by CRLF` 警告，属 Windows 换行符提示，不影响内容
- `web/lora_manager.html` 单文件改动 1.6 万行，后续多人协作时冲突概率高，建议本次后拆分为独立 JS/CSS

---

## 七、推荐提交方式

### 方案 A：单次提交（快速）

```bash
git add README.md README_EN.md ARCHITECTURE.md LIVE2D_GUIDE.md CHANGELOG.md RELEASE_REPORT.md pyproject.toml
git add .comfyignore .github copy_to_comfyui.bat data
git add __init__.py dynamic_text.py empty_latent.py image_title.py layered_note.py note_node.py prompt_formatter.py
git add lora_database.py lora_loader.py lora_loader_plus.py lora_metadata.py lora_test_loader.py recipe_preset_manager.py
git add pet utils
git add web/lora_manager.html web/js web/assets web/live2d
git commit -F- <<'EOF'
feat: v2.0.1 — 配方管理、C站补齐、备份体检与双语文档

- 配方: 卡片式配方库、应用/撤销快照、分享文件导入导出
- 补齐: 缺失 LoRA 查 Civitai, 内置下载器自动入库
- 备份: 指纹清单导出、缺失体检、一键重下
- 管理: 参考图库、多套 Profile、分类评级与使用统计
- Live2D: 自动识别 .vtube.json 热键, 动作可自定义快捷键
- 修复: AutoV2 短 hash 前缀匹配、下载复检/回填/查重、轮询超时、撤销归一化
- 文档: README 双语、ARCHITECTURE、LIVE2D_GUIDE、CHANGELOG
EOF
git tag v2.0.1
git push origin main --tags
```

### 方案 B：拆三次提交（推荐，历史更清晰）

```bash
# 1. 清理：移除缓存、补 .gitignore
git rm -r --cached __pycache__ pet/__pycache__ utils/__pycache__
git add .gitignore
git commit -m "chore: 停止跟踪 __pycache__ 并添加 .gitignore"

# 2. 功能：代码与资源
git add __init__.py lora_database.py lora_loader.py lora_loader_plus.py lora_metadata.py \
        lora_test_loader.py recipe_preset_manager.py pet utils web .comfyignore .github \
        copy_to_comfyui.bat data dynamic_text.py empty_latent.py image_title.py \
        layered_note.py note_node.py prompt_formatter.py pyproject.toml
git commit -F- <<'EOF'
feat: v2.0.1 配方管理、C站补齐与备份体检

- 配方: 应用/撤销快照、配方图、分享导入导出
- 补齐: Civitai 检索 + 内置下载器自动入库
- 备份: 指纹清单、缺失体检、一键重下
- Live2D: .vtube.json 热键、动作快捷键、新增三套模型
- 修复: AutoV2 前缀匹配、下载复检/回填/查重、轮询超时
EOF

# 3. 文档
git add README.md README_EN.md ARCHITECTURE.md LIVE2D_GUIDE.md CHANGELOG.md RELEASE_REPORT.md
git commit -m "docs: 重写中英 README，新增架构图、Live2D 指南与更新日志"

git tag v2.0.1
git push origin main --tags
```

---

## 八、GitHub Release 文案

标题：`v2.0.1 配方 / 补齐 / 备份`

正文直接复制 [CHANGELOG.md](./CHANGELOG.md) 的「v2.0.1 — 2026-10-24」小节即可（已按 新增 / 优化 / 修复 / 文档 分组）。

---

## 九、部署提醒

本次代码改动需要部署到运行环境：

```
D:\xbhh\1\ComfyUI_windows_portable\ComfyUI\custom_nodes\Comfyui-xbhh-main
```

必须手动复制（不要用脚本覆盖整个目录），本次涉及：

```
lora_metadata.py
lora_database.py
lora_loader.py
lora_loader_plus.py
recipe_preset_manager.py
__init__.py
pet/live2d_api.py
utils/update_expressions.py
web/lora_manager.html
web/js/loraManager.js
web/js/recipePresetManager.js
web/js/loraCombo.js
web/js/loraComboPlus.js
web/js/pet/live2d_pet.js
web/js/pet/live2d_v2_pet.js
web/js/pet/live2d_loader.js
```

复制完成后：**重启 8001 后端 → 浏览器 `Ctrl + F5`**。数据库与设置会自动迁移/保持在 `ComfyUI/user/xbhh`，不会丢失。

---

## 十、结论

- 功能与修复均已落地，静态校验通过
- 唯一阻塞项：`__pycache__` 不能在暂存区，需先执行 `git rm --cached`
- 模型资源提交前请确认授权
- 建议采用**方案 B** 三次提交，发布 `v2.0.1` 并附 Release 说明
