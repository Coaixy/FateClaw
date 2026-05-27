---
name: my-skill
description: 简要说明此 skill 的用途和适用场景。
---

# Skill 名称

简要说明此 skill 的用途和适用场景。

## 使用流程

1. 从用户消息中提取关键信息
2. 按本 `SKILL.md` 的说明判断是否需要读取 `index.md`、`docs/`、`examples/` 或 `notes/`
3. 如果本轮 tools schema 暴露了相关确定性工具，按参数说明调用
4. 结合工具结果和 Skill 文档内容回复用户

## 调用方式

示例工具调用：

```text
my_skill_tool({
  input: "..."
})
```

## 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| ... | string | 必填 | ... |

## 回复格式

描述 AI 应该如何组织和呈现结果。
