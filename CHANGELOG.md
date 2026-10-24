# 更新日志

本文件记录面向用户的版本变更。GitHub Release 文案可直接取用对应版本的小节。本次发布的统计、验证、提交清单与操作步骤见 [RELEASE_REPORT.md](./RELEASE_REPORT.md)。

---

## v2.0.1 — 2026-10-24

> **GitHub Release 简介（可直接粘贴）**
>
> 本次更新把 LoRA 工作流补成闭环：**配方可一键套用/撤销，缺失模型可从 Civitai 直接补齐，整库可导出清单做备份体检**。同时修复了 7 个与 hash 匹配、重复下载、撤销恢复相关的顽固问题，并补齐中英双语文档与架构图。

### ✨ 新增

**配方管理器**

- 卡片式配方库，支持配方图、标签、分类、评分、备注
- 点一次应用、再点一次按快照精确撤销；多个 LoRA 堆互不影响
- 配方可导出为分享文件，导入后缺失项可直接补齐
- 配方里的旧文件名 / 短 hash 通过前缀匹配兜底

**C 站补齐**

- 按 hash 或文件名在 Civitai 检索候选，支持 AutoV2 10~12 位前缀
- 下载前先做本地二次复检，刚移回的文件立刻识别
- 内置下载器：`.part` 流式下载 → SHA256 校验 → 落盘 → 自动预览图 → 自动入库
- 落盘前按文件名全目录查重，避免子目录已有同名文件时重复下载
- 下载完成后回填真实文件名，整行按钮置灰

**备份与体检**

- 导出整库指纹清单（文件名 / hash / 大小 + 分类、触发词、评级）
- 与当前库比对列出缺失文件
- 缺失项一键送去 C 站补齐

**其他**

- 参考图库：上传 / 重命名 / 移动 / 删除 / 回收站 / 送到 LoadImage
- LoRA 多套提示词 Profile、分类、星级、使用次数统计
- Live2D 自动读取 `.vtube.json` 热键并映射为快捷键，动画动作支持自定义按键
- `utils/update_expressions.py` 支持根目录与 `expressions/` 双位置的表情、`motions/` 与根目录的动作，idle 自动归组
- 新增 Live2D 模型：DS 面捕版、DS 鼠控版、zyby

### 🔧 优化

- LoRA 列表增量扫描 + ETag，未变化时返回 `304`
- 缩略图缓存固定在 `user/xbhh/thumbs`，不受 `temp` 清理影响
- 数据库与设置迁移到 `user/xbhh`，删除插件不丢数据

### 🐛 修复

1. 配方按 hash 找不到本地 LoRA —— AutoV2 短 hash 改为**前缀匹配**（前端与后端一致）
2. `/xbhh/lora/exists` 的 hash 查询按长度分流：64 位精确匹配、短 hash 前缀匹配
3. C 站补齐缺少下载前复检，已恢复的文件会被重复下载
4. 下载完成后配方行仍显示「未找到」，未回填真实文件名
5. 下载成功后同行另一个按钮仍可点，导致重复下载
6. 任务丢失（后端重启）时前端无限轮询
7. 内置下载器只查根目录同名文件，子目录已有同名文件时会下第二份
8. 配方撤销恢复时对名字大小写、路径分隔符敏感，Windows 下漏恢复

### 📚 文档

- 新增 [ARCHITECTURE.md](./ARCHITECTURE.md)：分层架构、15 个节点清单、**LoRA 五层数据结构图**、双 hash 分流图、触发词优先级图、4 张数据流时序图、HTTP API 一览
- 重写 [README.md](./README.md)：功能总览、安装、快速上手、FAQ、路线图
- 新增 [README_EN.md](./README_EN.md) 英文说明
- 重写 [LIVE2D_GUIDE.md](./LIVE2D_GUIDE.md)：V4/V5 目录规则、表情动作补全脚本、VTS 热键、故障排除表

### 🧱 工程

- `pyproject.toml`：版本 2.0.1，重写 description 与 keywords
- 新增 `copy_to_comfyui.bat` 本地部署脚本
- 更新 `.comfyignore` 与 GitHub Actions 发布工作流

---

## v1.5.1

- 重构 LoRA 管理器界面，新增多预设、筛选、去重选项、关闭自动触发词
- 新增预览图与更详细的 LoRA 参数
- 修复列表单列过宽、LoRA Plus 单段 tag 从管理器添加后不生效
- 新增关闭 Live2D 的开关
- 数据保存位置迁移到 `user/xbhh`，避免删除插件丢数据

---

## 本次提交清单

### 后端（Python）

```
__init__.py                 节点注册（新增配方节点，下线测试节点）
lora_metadata.py            API 路由、扫描、hash、配方图、备份体检
lora_database.py            SQLite 表结构、内置 Civitai 下载器
lora_loader.py              LoRA 列表 / 预览图 / 缩略图缓存
lora_loader_plus.py         LoRA 堆 Plus 执行逻辑
recipe_preset_manager.py    配方节点（透传 preset_text / prompt_text）
lora_test_loader.py         测试用加载器
image_title.py              图片标题节点
dynamic_text.py             动态文本节点
empty_latent.py             空 Latent 节点
layered_note.py / note_node.py  注释节点
prompt_formatter.py         提示词格式化节点
pet/__init__.py             看板娘节点注册
pet/live2d_api.py           模型扫描接口
pet/save_image_cui.py       保存图片结算金币
utils/update_expressions.py 补全 model3.json
```

### 前端

```
web/lora_manager.html               三模式管理页（LoRA / 配方 / 参考图）
web/js/loraManager.js               管理器主逻辑
web/js/recipePresetManager.js       配方面板与应用/撤销
web/js/loraCombo.js                 LoRA 堆
web/js/loraComboPlus.js             LoRA 堆 Plus
web/js/loraTestCombo.js             测试加载器 UI
web/js/dropLoader.js                拖图解析
web/js/toastTamer.js                提示节流
web/js/xbhhUserSettings.js          设置读写
web/js/whale_widget.js              看板娘小部件
web/js/pet/live2d_pet.js            Live2D 主控（含 .vtube.json 热键）
web/js/pet/live2d_v2_pet.js         V2 引擎
web/js/pet/live2d_loader.js         模型加载
utils/lora_viewer.html              单页查看器
```

### 文档与配置

```
README.md  README_EN.md  ARCHITECTURE.md  LIVE2D_GUIDE.md  CHANGELOG.md
pyproject.toml  .comfyignore  .github/workflows/publish.yml  copy_to_comfyui.bat
```

### 资源

```
web/assets/whale/             看板娘音效与动图
web/live2d/v4/DS面捕版/        新增模型
web/live2d/v4/DS鼠控版/        新增模型
web/live2d/v4/zyby/           新增模型
web/live2d/v4/按键表.txt       热键说明
```

---

## 建议 Commit Message

```
feat: v2.0.1 — 配方管理、C站补齐、备份体检与双语文档

- 配方: 卡片式配方库、应用/撤销快照、分享文件导入导出
- 补齐: 缺失 LoRA 查 Civitai, 内置下载器自动入库
- 备份: 指纹清单导出、缺失体检、一键重下
- 管理: 参考图库、多套 Profile、分类评级与使用统计
- Live2D: 自动识别 .vtube.json 热键, 动作可自定义快捷键
- 修复: AutoV2 短 hash 前缀匹配、下载复检/回填/查重、轮询超时、撤销归一化
- 文档: README 双语、ARCHITECTURE、LIVE2D_GUIDE
```

---

## 提交前检查清单

- [ ] `__pycache__/*.pyc` 当前处于已暂存状态，**不要提交**：先 `git rm -r --cached __pycache__ pet/__pycache__ utils/__pycache__`，并添加 `.gitignore`
- [ ] `backup_20260823/` 是本地临时备份，确认是否要一起提交
- [ ] `.trae/`、`.vscode/` 属于本地工具配置，按需提交
- [ ] 已确认没有超过 GitHub 100MB 限制的模型文件（当前最大文件 < 40MB）
- [ ] `pyproject.toml` 版本号与 README 徽章、CHANGELOG 一致（均为 2.0.1）
- [ ] 本地实测：管理器三种模式可打开、配方应用/撤销正常、C 站补齐能下载入库

## 发布步骤

```bash
git add README.md README_EN.md ARCHITECTURE.md LIVE2D_GUIDE.md CHANGELOG.md pyproject.toml
git add lora_metadata.py lora_database.py lora_loader.py lora_loader_plus.py recipe_preset_manager.py
git add web/lora_manager.html web/js/*.js web/js/pet/*.js
git commit
git tag v2.0.1
git push origin main --tags
```

推送后在 GitHub 新建 Release，标签选 `v2.0.1`，标题填「v2.0.1 配方 / 补齐 / 备份」，正文粘贴上面的「v2.0.1」小节即可。
