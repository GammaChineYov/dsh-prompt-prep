# dsh-prompt-prep

DSH 插件：提示词转译。把模糊用户输入（「还是不行啊」「多1G嘛」）结合会话轨迹与历史消息，经本地 llama（8083）转成明确候选指令，供用户选择覆盖输入框。

## 功能

- **输入框上方 dock「⚡ 转译」**：取输入框 draft + 会话历史 → 本地模型 think + tool call `emit_suggestions` → 候选指令显示，点击 `setDraft` 覆盖输入框。
- **assistant 消息「💡 建议」**：基于会话轨迹生成建议指令。
- **模型自主翻轨迹**：上下文 = 事件索引（`listEvents` 轻量 seq→类型）+ 最近用户消息快照；模型觉得不够可调 `read_events(fromSeq,toSeq)` 定向拉正文（tool-call 循环）。
- **modelTrace 观察行**：dock 显示「模型翻阅：read_events(seq 132-145) → emit_suggestions」，直观看出模型有没有主动翻历史。

## 指代解析规则（v2/v5 沉淀）

1. 用户完整原话优先——最新模糊消息默认指代「用户反复抱怨/最近明确提出的问题」；
2. 轨迹只作佐证；
3. 数值维度判定：可用内存多1G ≠ 模型大小大1G；
4. 建议围绕会话最新主题，历史旧问题被转向不重复。

## 依赖

- 本地 llama.cpp 统一服务（8083，vision+translate，thinking on）——由 dsh-llama-pool 管理；
- Host 调 8083 用 subprocess spawn python（stdin 传 payload，`sys.stdin.buffer.read().decode('utf-8')` 防 Windows 编码坑）。

## 安装（本机 web profile）

同 dsh-llama-pool：Junction + profile dependencies/bundles 登记 + 重启 dsh web。
