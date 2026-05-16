# Skill 名称

简要说明此 skill 的用途和适用场景。

## 使用流程

1. 从用户消息中提取关键信息
2. 先调用 `load_skill` 加载本 skill 说明
3. 按 `skill.json` 中唯一公开入口和本说明中的约定执行
4. 将结果以自然语言回复用户

## 调用方式

先加载：

```text
load_skill({
  skill_name: "my-skill"
})
```

再执行：

```text
run_skill_script({
  skill_name: "my-skill",
  script: "example.sh",
  stdin: JSON.stringify({})
})
```

## 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| ... | string | 必填 | ... |

## 回复格式

描述 AI 应该如何组织和呈现结果。
