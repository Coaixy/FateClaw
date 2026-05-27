---
name: jingzhan-paipan
description: 周易经占排盘：按大衍筮法、略筮法或指定卦爻生成卦象与取辞数据。
---

# 周易经占排盘

本地计算（基于 `iching-shifa`）。经占排盘产出卦象数据及古法取辞规则。

## 使用流程

1. 确认用户想用经占（周易古法）
2. 确认起卦方式（推荐大衍筮法或略筮法）
3. 调用 Pi custom tool `jingzhan_paipan`
4. 如果用户要求解读，排盘成功后继续调用 `interpret_xuanxue`

## 调用方式

```js
jingzhan_paipan({
  method: "dayan",
  question: "近期运势"
})
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

排盘输出包含 `benGua`（本卦）、`zhiGua`（变卦）、`huGua`（互卦）的卦象数据，以及 `dongYaoCount`（动爻数量）和 `explanation`（古法取辞规则）。
