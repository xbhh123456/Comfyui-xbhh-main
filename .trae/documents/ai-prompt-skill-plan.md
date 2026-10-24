# AI 分类提示词填入 + 能力级技能开关 实现计划

## Context
桌宠 AI 目前收到 generate_image 工具调用后，prompt 只显示"🎨 主题：xxx"，**并未写入工作流**（live2d_v2_pet.js L2088 注释"待开发"）。用户要求：
1. AI 自己生成分类提示词（默认：人物主题/画风/场景环境/质量词，**分类可自定义增删**），按"节点标题含分类名"填入画布上对应的文本节点。
2. **LoRA 触发词不归 AI 管**：搭配现有 LoRA 堆 Plus 节点使用——其 `triggers_text` 输出（lora_loader_plus.py L254-256，按数据库实时汇总启用 LoRA 的触发词）接线后自动转入提示词节点；AI 只写创作内容，不填触发词。
3. **用户可自带"提示词编写 skill 文档"**（设置里粘贴自己的提示词编写规范，注入 LLM 优先使用；内置编写规则仅作兜底——没填自定义文档时才生效）。
4. **填入兜底链**：分类节点匹配不到时 → 优先汇入画布上标题含"其他"的节点；画布根本没有分类入口（如只有一个"人物"或"正向提示词"节点）→ 全部分类拼接后直接写入该节点。
5. AI 能力做成可独立开关的"技能"（提示词生成 / LoRA管理 / 大模型切换），关闭的技能不下发工具、不注入指令（省 token、防误触发）；画图（generate_image/run_workflow）为核心始终开启。自主创作、自动看图已有开关，保持不动。

改动仅限 3 个文件，全部前端/后端已有模式复用，无新文件。

## 一、后端 pet/live2d_api.py

### 1. 新工具 write_prompts（追加进 PET_IMAGE_TOOLS）
```python
{"type":"function","function":{
  "name":"write_prompts",
  "description":"把按分类拆分的提示词写入画布上对应标题的文本节点。写提示词/画图时调用；可与 generate_image 同条消息并发（系统先填词后跑图）。",
  "parameters":{"type":"object","properties":{
    "prompts":{"type":"array","description":"分类名必须用系统消息【提示词槽位】里的分类",
      "items":{"type":"object","properties":{
        "category":{"type":"string"},"content":{"type":"string"}},
        "required":["category","content"]}}}},
  "required":["prompts"]}}
```

### 2. 指令分段（改造 L489 PET_TOOL_INSTRUCTION）
改为 `PET_TOOL_SEGMENTS = {"base": 规则1/2/11, "prompt_mech": write_prompts 机械用法（按槽位分类调用、与画图工具并发）, "prompt_style": 内置编写规范（兜底）, "lora": 规则3~10, "model": 规则12}`，新增 `_build_tool_instruction(skills, skill_doc)`：
- prompt 技能开 → 总是拼 `prompt_mech`
- `skill_doc` 为空 → 追加 `prompt_style`（内置编写规范兜底）；`skill_doc` 非空 → 不拼内置规范，改注入用户文档

### 3. /xbhh/pet/chat（L863+）接收新字段并过滤
- `skills = data.get("skills") or {}`，键 prompt/lora/model，缺省 True（向后兼容）。过滤 tools：无 lora→剔除名字含 lora 的 5 个；无 model→剔除 set_checkpoint；无 prompt→剔除 write_prompts。过滤后为空则 payload 不带 tools 字段（部分供应商拒收空 tools）。
- `prompt_slots = data.get("prompt_slots")`：`{categories:[{name,current}], skill_doc:""}`，拼进 extra_pref：
  - `【提示词槽位】画布上有这些分类节点（括号为当前内容预览，画图/写提示词时调用 write_prompts 逐类填写；LoRA 触发词由 LoRA 堆 Plus 节点自动输出，你不需要写触发词；未匹配的由系统兜底汇总）：1. 人物主题（当前：xxx）…`
  - `【用户自定义提示词编写规范】（用户自带 skill 文档，编写提示词时优先遵循）：…`（skill_doc 非空时注入，截 4000 字符）

## 二、前端 web/js/pet/live2d_v2_pet.js

### 1. `xbhhFindPromptSlotNode(category)`
复用 L30-34 black/textW 判定，匹配优先级：① node.title 精确等于分类名 → ② title.includes(cat)（忽略大小写空格）→ ③ 双向包含 cat.includes(title) → 找不到返回 null（**不做全局兜底**，避免填错节点）；重名取第一个。

### 2. `xbhhHandlePromptToolCalls(calls)`
先定放置方案、再统一写入（避免同节点被写两次）：
1. 对每个 prompt 用 `xbhhFindPromptSlotNode(category)` 找目标节点，记录命中/未命中。
2. 未命中的分类：
   - 画布存在"其他"节点（xbhhFindPromptSlotNode("其他")）→ 未命中内容按序拼接追加进"其他"节点；
   - 无"其他"且命中数 ≤1（画布只有"人物"一个入口或只有"正向提示词"的典型场景）→ **全部分类内容**按设置里的分类顺序拼接（", "连接），整段写入唯一可用节点（命中数=1 用那个节点；=0 用现有 xbhhFindPromptNode L26-99 定位的正向节点），此模式下跳过第 1 步的单节点写入，直接整段覆盖；
   - 无"其他"且命中数 ≥2 → 未命中分类逐条 push `⚠️ 画布没找到标题含「xx」的文本节点`，不乱写。
3. 执行写入：`widget.value = content; node.setDirtyCanvas(true,true)`，push 结果文案（`✍️「分类」已写入「节点标题」` / `✍️ 未匹配分类已合并进「其他」` / `✍️ 画布无分类入口，已全部写入「节点标题」`）。

挂 `window.xbhhHandlePromptToolCalls`（同 L470 先例，供 loader 复用）。

### 3. sendChat 请求体（L1995）新增
- `skills: {prompt, lora, model}` ← xbhhSettings 的 skillPrompt/skillLora/skillModel
- `prompt_slots: {categories, skill_doc}` ← categories 读设置；current 用 xbhhFindPromptSlotNode 取各节点当前值（截 150 字符）；skill_doc 读设置的 promptSkillDoc（trim 后传）。**不收集 LoRA 触发词**（触发词由堆 Plus 的 triggers_text 输出在图上自动流转）

### 4. 执行顺序（L2050 附近）
在 LoRA 分发前先 `const promptMsgs = await xbhhHandlePromptToolCalls(toolCalls.filter(t=>t.name==="write_prompts"))`；generate_image / run_workflow 分支 lines 里并入 promptMsgs，再 setTimeout(runCurrentCanvasWorkflow, 1200)——填词 await 同步完成，必然先于跑图。

## 三、前端 web/js/pet/live2d_loader.js

### 1. 设置默认值（L458 XBHH_SETTINGS_DEFAULTS 追加）
`skillPrompt:true, skillLora:true, skillModel:true, promptCategories:["人物主题","画风","场景环境","质量词"], promptSkillDoc:""`。存 'xbhh_pet_settings'，loadXbhhSettings 合并逻辑天然兼容旧数据，无需迁移。

### 2. 设置面板（renderPetSettingsPanel 内，照 L711-720 checkbox 模式）
- 「AI 能力技能」段：3 个 checkbox（提示词生成 / LoRA 管理 / 大模型切换），onchange 即存。
- 「提示词分类」段：按 promptCategories 渲染每行（input 显示分类名 + 删除按钮），改名/删除即时 set 回数组；底部空输入框 +「添加」按钮（空名/重名不添加）。
- 「提示词编写 Skill 文档（可选）」段：多行 textarea 绑定 promptSkillDoc（输入即存，IM 组合中防抖 500ms），placeholder 说明"粘贴你自己的提示词编写规范/技能文档，留空则使用内置兜底规范"。

### 3. autoInspire（L934 请求体）
同 sendChat 增加 skills + prompt_slots；L967 工具分发处先 `await window.xbhhHandlePromptToolCalls(...)` 再 autoGenerate()。write_prompts 指令随 PET_TOOL_INSTRUCTION 自动注入，AUTO_PERSONA 无需改动。

## 边界情况
- 分类节点找不到：走兜底链（其他 → 唯一节点整段写入），只在命中数 ≥2 且无"其他"时逐条 ⚠️，不中断不重试。
- 用户自定义 skill 文档：非空时注入并跳过内置编写规范；空/纯空白时用内置兜底。
- LoRA 触发词：完全由 LoRA 堆 Plus 的 triggers_text 输出按数据库实时流转，AI 不写、前端不收集。
- 技能全关：请求不带 tools，退化为纯聊天。
- 旧 localStorage 无新 key：defaults 合并自动补全（全开 + 默认 4 分类 + 空 skill 文档）。

## 验证（ComfyUI 跑在 127.0.0.1:8001）
1. 重启 ComfyUI + Ctrl+F5，控制台无报错。
2. 画布建标题含「人物主题」「画风」「场景环境」「质量词」的文本节点；聊天"画一只银发猫娘"→ 各节点被填入、气泡逐条回报、随后自动跑图。
3. 画布只留一个「正向提示词」节点（无分类节点、无"其他"）→ 全部分类拼接后整段写入该节点。
4. 画布有「人物主题」+「其他」两个节点 → 人物命中，其余分类合并进「其他」。
5. 设置粘贴自定义 skill 文档 → 后端日志确认注入【用户自定义提示词编写规范】且无内置规范段；清空后恢复内置兜底。
6. 关「LoRA管理」→ 说"加个画风lora"→ AI 只能文字回复，不调用工具。
7. AI 添加画风 LoRA 后跑图 → 触发词经堆 Plus triggers_text 输出自动出现在最终提示词里（AI 生成内容不含触发词）。
8. 自主创作空闲分钟调 1 → write_prompts 生效后再跑图。
9. 清 xbhh_pet_settings 刷新 → 技能全开、分类恢复默认、skill 文档为空。
10. 同步 3 个文件到运行目录 D:\xbhh\ComfyUI_windows_portable\ComfyUI\custom_nodes\Comfyui-xbhh-main，逐一用 Grep 验证落盘（串行 Edit + 特征串核验，勿并行写同一文件）。
