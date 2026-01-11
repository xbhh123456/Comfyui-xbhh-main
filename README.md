# XBHH-LoRA 🎨

**ComfyUI 自定义节点集合** — 专为提升 AI 绘图工作流效率而设计

---

## ✨ 功能特性

### 🎨 LoRA 加载器

| 节点                       | 功能                                             |
| -------------------------- | ------------------------------------------------ |
| **Multi Lora Loader**      | 多 LoRA 加载器，支持树形文件夹选择、悬浮图片预览 |
| **Multi Lora Loader Plus** | Plus 版本，新增预设导入/导出功能                 |

### 📐 实用工具

| 节点            | 功能                             |
| --------------- | -------------------------------- |
| **空 Latent**   | 15 种预设分辨率 + 自定义尺寸支持 |
| **注释节点**    | 工作流内置笔记，支持搜索高亮显示 |
| **XLSX 查看器** | 直接在 ComfyUI 中查看 Excel 文件 |

### 📝 文本处理

| 节点             | 功能                              |
| ---------------- | --------------------------------- |
| **txt 随机抽取** | 从 txt 文件随机抽取一行文本       |
| **txt 选择器**   | 下拉选择 xbhh 文件夹中的 txt 文件 |
| **预设选择器**   | 预设文本选择器                    |

---

## 📦 安装

### 方式一：ComfyUI Manager（推荐）

1. 打开 ComfyUI Manager
2. 搜索 `xbhh-lora`
3. 点击安装

### 方式二：手动安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/你的用户名/xbhh-lora.git
pip install -r xbhh-lora/requirements.txt
```

### 方式三：便携版

下载 ZIP 解压到 `ComfyUI/custom_nodes/` 目录

---

## 🚀 快速开始

### Multi Lora Loader Plus

1. 添加节点：右键 → XBHH/loaders → **XBHH Multi Lora Loader Plus**
2. 点击 **➕ Add Lora** 添加 LoRA
3. 使用 **📤 导出预设** 保存配置
4. 使用 **📥 导入预设** 快速恢复配置

### 预设格式

```
enabled|lora_name|strength_model|strength_clip
1|styles/anime.safetensors|1.0|1.0
0|characters/girl.safetensors|0.8|0.8
```

---

## 📁 项目结构

```
xbhh-lora/
├── __init__.py          # 节点注册入口
├── lora_loader.py       # LoRA 加载器
├── lora_loader_plus.py  # LoRA 加载器 Plus
├── empty_latent.py      # 空 Latent 节点
├── note_node.py         # 注释节点
├── xlsx_viewer.py       # XLSX 查看器
├── xbhh_txt_selector.py # txt 选择器
├── example_node.py      # txt 随机抽取
├── preset_selector.py   # 预设选择器
├── requirements.txt     # Python 依赖
├── xbhh/                # txt 文件存放目录
└── web/
    └── js/              # 前端扩展
        ├── loraCombo.js
        ├── loraComboPlus.js
        ├── noteNode.js
        └── emptyLatent.js
```

---

## 🔧 依赖

- ComfyUI（必需）
- openpyxl（XLSX 查看器需要）

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证

MIT License

---

## 🙏 致谢

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
- [rgthree-comfy](https://github.com/rgthree/rgthree-comfy)（设计参考）
