# XBHH Live2D 使用与维护指南

本文档说明如何为本扩展添加新模型、管理表情与动作资源、配置热键，以及常见故障的处理方式。

---

## 1. 模型目录结构

模型统一放在 `web/live2d/` 下，按 SDK 版本分目录：

### SDK 2.0 模型（V2）

- **存放路径**：`web/live2d/v2/[模型名称]/`
- **核心入口**：`model.json`
- **换装支持**：系统会自动识别该目录下所有以 `model` 开头的 JSON（如 `model.json`、`model1.json`、`model2.json`），右键菜单或侧边栏的「衣服」图标即可切换
- **资源目录**：`motions/`（`.mtn` 动作）、`textures/`（贴图）

### SDK 4.0 / 5.0 模型（V4 / V5）

- **存放路径**：`web/live2d/v4/[模型名称]/` 或 `web/live2d/v5/[模型名称]/`
- **核心入口**：目录下任意 `*.model3.json`
- **扫描深度**：只扫一层，`v4/模型名/xxx.model3.json`。**不要再套一层目录**，否则识别不到
- **注意**：一个模型目录里只会取第一个 `*.model3.json` 作为入口

### VTube Studio 导出的模型

VTS 导出的模型同样按 V4/V5 放置。插件会额外利用两个文件：

| 文件 | 用途 |
| --- | --- |
| `*.vtube.json` | 自动读取其中的 `Hotkeys`，映射为键盘快捷键 |
| `items_pinned_to_model.json` | 模型自带道具/挂件的显隐配置，随模型一起加载 |

---

## 2. 如何添加新模型

1. **准备文件**：拿到完整的模型导出文件夹（含 `.moc` / `.moc3`、贴图、`*.model3.json` 等）
2. **放置**：
   - 后缀 `.moc` 的旧模型 → `web/live2d/v2/`
   - 后缀 `.moc3` 的新模型 → `web/live2d/v4/`（或 `v5/`）
3. **自动识别**：后端 `pet/live2d_api.py` 启动时扫描目录，前端动态生成配置，**不需要手动改 `waifu-tips.json`**
4. **刷新**：重启 ComfyUI 或刷新页面（`Ctrl + F5`），在小人身上点右键即可在模型菜单里看到

---

## 3. 表情与动作

### 3.1 文件放哪

| 类型 | 允许的位置 | 说明 |
| --- | --- | --- |
| 表情 `.exp3.json` | `expressions/` 子目录 **或** 模型根目录 | 两处都会被收集，同名以子目录优先 |
| 动作 `.motion3.json` | `motions/` 子目录 **或** 模型根目录 | 文件名含 `idle` / `idel` 的统一归到 `Idle` 组 |

### 3.2 自动补全 `model3.json`

VTS 导出的模型常常没把表情和动作写进 `model3.json`，导致菜单里空空如也。用仓库里的脚本一键补齐：

```bash
# 处理单个模型目录
python utils/update_expressions.py "web/live2d/v4/DS面捕版"

# 不传参数则处理当前目录
cd web/live2d/v4/DS鼠控版 && python ../../../utils/update_expressions.py
```

脚本会：

- 收集 `expressions/` 和根目录下的所有 `.exp3.json` 写入 `FileReferences.Expressions`
- 收集 `motions/` 和根目录下的所有 `.motion3.json` 写入 `FileReferences.Motions`
- 名字含 `idle` / `idel` 的动作统一放进 `Idle` 组，保证待机动画能跑

> 执行前建议先备份 `*.model3.json`，脚本会直接原地重写（缩进 tab、UTF-8）。

### 3.3 调用方式

- 表情：右键菜单 →「🎭 表情」
- 动作：右键菜单 →「🎬 动画」，可给每个动作绑定快捷键

---

## 4. 热键

### 4.1 模型自带热键（VTS）

- 前端自动读取模型同目录的 `.vtube.json`，把里边的 `Hotkeys` 转成键盘快捷键
- 右键菜单里有开关：**⌨️ 模型自带热键**，状态保存在 `localStorage`（键名 `xbhh_vtube_hotkeys`）
- 开关状态在菜单里会显示识别到的热键数量

### 4.2 自定义动作快捷键

右键菜单 →「🎬 动画」→ 点击动作右侧的按键按钮 → 按下组合键即可绑定；菜单底部提供「🗑️ 清除所有快捷键」。

### 4.3 与 ComfyUI 冲突

热键在输入框获得焦点时不会触发，避免打断提示词输入。若仍与浏览器/ComfyUI 快捷键冲突，请换一个组合键。

---

## 5. 关键注意事项 ⚠️

1. **缓存冲突**：改了模型文件但界面没变，先 `Ctrl + F5`；仍不行就清 `localStorage` 或右键菜单「退出」后重进
2. **相对路径**：`model3.json` / `vtube.json` 内部引用必须是相对路径，不能写绝对磁盘路径
3. **性能**：不要同时加载太多高精度 V5 模型，会明显吃内存
4. **驱动嗅探**：模型加载过慢导致 `AMotion is not defined` 时系统会自动重试，一般无需干预
5. **目录层级**：V4/V5 只扫描一层，多套一层目录会「看不到模型」

---

## 6. 故障排除

| 现象 | 排查方向 |
| --- | --- |
| 小人完全不出现 | 检查是否被隐藏（`localStorage`）、后端是否正常、控制台有无报错 |
| 右键菜单没有新模型 | 确认入口是 `*.model3.json` 且目录层级正确；看 `pet/live2d_api.py` 是否加载 |
| 无法换装 | V2 模型目录里需要有 `model1.json` 这类文件 |
| 表情/动作列表为空 | 用 `utils/update_expressions.py` 补全 `model3.json` |
| 热键没反应 | 菜单里确认「模型自带热键」为开；检查 `.vtube.json` 是否存在且含 `Hotkeys` |
| 模型错位/穿模 | 检查 `*.physics3.json`、贴图分辨率与 `model3.json` 中的引用是否一致 |
