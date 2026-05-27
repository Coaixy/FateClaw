---
name: bazi-paipan
description: 八字排盘：四柱、大运、完整流年、格局，基于 bazi-ts-lib 本地确定性算法计算。
---

# 八字排盘

根据用户的阳历出生时间和性别生成四柱八字，含大运、完整流年列表、格局。基于 `bazi-ts-lib`（底层 tyme4ts），本地计算，无网络依赖。

## 使用流程

1. 从用户消息中提取：阳历出生日期、出生时间（精确到分钟更好）、性别
2. 调用 Pi custom tool `bazi_paipan`，直接传入 JSON 参数
3. 如果用户要求解读，排盘成功后继续调用 `interpret_xuanxue`

## 调用方式

执行：

```js
bazi_paipan({
  solarDate: "1990-05-15",
  hour: 10,
  minute: 30,
  gender: "男"
})
```

## 参数说明

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| solarDate | string | 是 | — | 阳历日期 YYYY-MM-DD |
| hour | integer | 是 | — | 出生小时 0-23 |
| minute | integer | 否 | 0 | 出生分钟 0-59（影响起运精度） |
| gender | string | 是 | — | 男/女/male/female |
| zishiMode | string | 否 | early | 子时切换：early(23点算次日) / late(算当日) |
| childLimitMode | string | 否 | default | 起运算法：default/china95/lunar_sect1/lunar_sect2 |
| include | string[] | 否 | 全部 | 限定返回部分，避免输出过大 |

### include 可选值

- `bazi` 四柱八字
- `fortune` 大运 + 完整流年列表
- `pattern` 格局

默认全返回四柱、大运、从出生年到最后一步大运结束年的完整流年与格局。

## 流年规则

- 可用年份范围：出生公历年份到最后一柱大运的 `endYear`
- `annuals` 固定返回可用范围内所有流年，不再裁剪窗口
- 每条流年包含：公历年、农历年描述、虚岁、干支、天干、地支、纳音、十神、十二长生
- `currentAnnualYear` 用于标记运行时当前流年；排盘脚本不接受目标年份参数

## 返回结构（简略）

```json
{
  "bazi": {
    "birthTime": "1990年05月15日 巳时",
    "gender": "男",
    "baziString": "庚午 辛巳 戊戌 丁巳",
    "pillars": {
      "year": { "sixtyCycle": "庚午", "sound": "路旁土", "tenStar": "食神", "...": "..." },
      "month": { "sixtyCycle": "辛巳", "...": "..." },
      "day": { "sixtyCycle": "戊戌", "...": "..." },
      "hour": { "sixtyCycle": "丁巳", "...": "..." }
    },
    "specialSigns": { "ownSign": "...", "bodySign": "...", "kongWang": ["申", "酉"] }
  },
  "fortune": {
    "childLimit": { "startAge": 8, "startYear": 1997, "...": "..." },
    "decades": [
      { "sixtyCycle": "壬午", "startAge": 8, "endAge": 17, "tenStar": "食神", "...": "..." }
    ],
    "annuals": [
      {
        "year": 1990,
        "lunarYear": "庚午年",
        "age": 1,
        "sixtyCycle": "庚午",
        "heavenStem": "庚",
        "earthBranch": "午",
        "tenStar": "食神",
        "terrain": "沐浴",
        "sound": "路旁土"
      }
    ],
    "annualStartYear": 1990,
    "annualEndYear": 2096,
    "currentAnnualYear": 2026
  },
  "pattern": {
    "name": "...",
    "description": "...",
    "reliability": "确定"
  }
}
```
