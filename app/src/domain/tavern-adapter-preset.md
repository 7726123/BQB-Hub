# 酒馆世界书 → 本软件适配指南

> 只在与「把酒馆世界书转成当前软件能用的世界书」的对话中阅读此文档。
> 这不是稳定注入内容，需要时自己读，不需要时忽略。

## 目标

把酒馆（SillyTavern）导出的世界书 JSON，转成当前软件的世界书：
- 去掉酒馆特有、当前软件无意义的字段/条目
- 把有用的设定保留为当前软件的条目类型：角色 / 世界观 / 其他 / 初始
- 拿不准的条目**问用户**，给候选，而不是擅自杀

## 酒馆世界书长什么样

JSON 顶层通常是：
```json
{
  "entries": { "0": {...}, "1": {...}, ... },
  "name": "..."
}
```
（`entries` 可能是**对象** `{ "0": {...} }` 或**数组**；对象时 uid 在外层 key）

每条 entry 有一堆酒馆字段：`key`、`keysecondary`、`triggers`、`comment`、`content`、`constant`、`selective`、`selectiveLogic`、`position`、`order`、`disable`、`useProbability`、`probability`、`extensions`、`outletName`、`sticky`、`cooldown`、`delay`、`useGroupScoring`、`vectorized`、`addMemo`、`characterFilter`、`role` 等。

## 适配规则（按优先级）

### 1. 明显是酒馆系统残留 → 直接丢弃，不用问用户

- `content` 为空、`key`/`keysecondary`/`triggers` 也全空
- `content` 是**纯变量块**：`$xxx = ...`、`{{setvar::...}}`、`{{getvar::...}}`、`<% ... %>`（注意：**comment 里带"变量"不算**，`[InitVar]` 开局状态描述要保留）
- `comment` 是系统分隔条：以 `====` 开头（`====变量系统====_开始` 等），或含「变量系统」「正则」「触发器」「占位」
- `extensions.regex_script` / `extensions.macro_script` 存在
- `outletName` 存在（酒馆世界书流绑定）
- `extensions.notes` 是对酒馆的注入指令（"inject before system prompt" 等）

### 2. 明显是设定 → 自动保留并映射

- **有 `key`**（或 keysecondary/triggers）→ 保留，`keys` 取 key+keysecondary+triggers 去重
- **comment 带类型前缀** → 按前缀定类型：
  - `角色:` / `人物:` → 类型「角色」
  - `世界观:` / `设定:` / `背景:` / `规则:` → 类型「世界观」
  - `初始:` → 类型「初始」
- **`[InitVar]`**（mvu 开局状态，含时间/地点/角色初始状态）→ 保留为「其他」（不赋予「初始」语义——初始在本软件是"正文为空时注入一次"的特殊类型，会语义错位）
- **`[mvu_update]` / `[mvu_plot]`**（规则文本，不含 macro）→ 保留为「其他」（不赋予「世界观」语义）
- `disable:true` → 保留但设为不注入
- 名称：comment 去前缀第一段 → 第一个 key → content 首行

### 3. 拿不准（没有 key 也没有类型前缀，但 content 是正经设定文本）→ 问用户

典型：`角色引入`、`故事基调`、`身份隐藏规则` 这种 comment 没有类型前缀、key 为空，但 content 明显是设定。
- 给用户 2~3 个候选：保留为对应类型 / 改为角色 / 丢弃
- 候选要带 `preview`（改写后的样子）和 `recommendation`（推荐项）
- **如果一次有超过 3 条拿不准，提供批量选项**：「全部保留」「全部丢弃」「只保留明显角色的」——让用户一次决定，别逐条折磨

### 3. 数值/状态系统（不询问用户，AI 处理）

软件**无法保存数值/变量**（好感度 87、getvar、stat_data、状态容器等）。这类条目**不进 needs_user**，走 `ai_transform`：

- 含可读设定文本 → **AI 用大白话改写后写入**（如「好感度 87」→「对主角好感颇深」），改写后作为「其他」条目；不保留任何数值/变量引用
- 纯宏/纯数值（剥掉宏后没有内容）→ **直接删除**（reason: numeric_system）

报告里有「【需 AI 转述】」区块，列出每条改/删。「好感度 0」这类初始字段也属于数值系统，改写成"初始关系"。

### 4. 写入

- 用户全拍板后，用 `upsert_entry` / `apply_character` / `delete_entry` 把 kept 写入世界书（调用即生效）
- 角色→`apply_character`（content 以「姓名：xxx」开头），世界观/其他/初始→`upsert_entry`
- 不需要额外的提交步骤（旧版 `write_to_worldbook` 已移除）

## content 清洗（自动做，报告里可见）

保留的条目，`content` 内部会**机械清洗**以下酒馆残留（不靠 AI 判断，纯规则）：
- SillyTavern 取值/声明类宏（`{{getvar::…}}`/`{{setvar::…}}`/`{{random::…}}`/`{{//…}}`/`{{format_message_variable::…}}`）→ 删除
- EJS 模板标签 `<% ... %>`：控制流（if/else/for/end）整块删；标签内是可读文本则保留文本
- 状态机标签块 `<status_current_variable>…</status_current_variable>`、`<state_bar>`、`<initvar>`、`<timer>` 等 → 整块删除

**主角占位符例外（保留，不要删、不要改写成人名）**：
- `{{user}}`（含 `{{ user }}` 空格写法）与 `{user}` 是**主角占位符**——软件在写作时会自动把它替换成用户设定的主角名。删掉会让句子变碎；改写成具体人名则会让用户换主角/改名字后这条设定失效。
- `{{char}}` 是「当前条目所属角色」的占位符：软件没有 `{{char}}` 的运行时替换，落库时会被替换成该条目名（如「月宫绾音」）。

清洗只动机械标记，**不动规则文本**（例如"好感度≥400 触发告白"保留）。清洗数量在报告每条 kept 后有「（内容已清洗 N 处酒馆标记）」标注。

## 原则

- **拿不准就问，但别问太多**：有批量选项就用批量选项
- **不擅自杀掉看起来像设定的**：只有明确是酒馆残留才不问直接丢
- **保持原意**：映射类型时尊重原作者意图（`[InitVar]` 是开局状态，不是垃圾）
- 工具的 `json_text` 就是用户粘的 JSON 原文；`decisions` 是上一轮用户对 needs_user 的决定