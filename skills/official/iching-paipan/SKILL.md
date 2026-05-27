---
name: iching-paipan
description: 六爻纳甲排盘：返回本卦、变卦、互卦、六亲、六兽、世应、伏神、旬空、月建等确定性数据。
---

# 六爻纳甲排盘

本地计算（基于 `iching-shifa`）。返回本卦、变卦、互卦的完整纳甲装卦，含六亲、六兽、世应、伏神、旬空、月建、节气。

## 使用流程

1. 确认用户想用六爻占卜
2. 确认起卦方式（默认大衍随机）
3. Web/API 侧排盘运行时执行本 Skill 的脚本 entry
4. 如果用户要求解读，排盘成功后的盘面进入 Pi 上下文，由解读类 Markdown Skill 继续完成分析

## 入参示例

```json
{
  "method": "dayan",
  "question": "近期工作运势"
}
```

## 参数说明

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| method | string | 否 | dayan | 起卦方式：dayan/lueshifa/manual/three/array/time |
| yao | string | manual 时必填 | — | 6 位爻字符串 6/7/8/9 |
| numbers | int[] | three/array 时必填 | — | three 长度=3；array 长度>=2 |
| datetime | string | 否 | 当前时间 | 排盘时间 YYYY-MM-DD HH:mm |
| question | string | 否 | — | 问卜主题，原样回传 |

## 爻值约定

| 爻值 | 含义 | 阴阳 | 动静 |
|------|------|------|------|
| 6 | 老阴 | 阴 | 动（变少阳） |
| 7 | 少阳 | 阳 | 静 |
| 8 | 少阴 | 阴 | 静 |
| 9 | 老阳 | 阳 | 动（变少阴） |

## 返回数据

排盘输出包含 `benGua`（本卦）、`zhiGua`（变卦）、`huGua`（互卦）的完整纳甲信息，以及六亲、六兽、世应、伏神、旬空、月建、节气等六爻体系所需的全部数据。
