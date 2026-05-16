# 紫微斗数排盘

根据用户的阳历出生时间和性别生成紫微斗数十二宫星盘。基于 `iztro` 库本地计算，无网络依赖。

## 使用流程

1. 从用户消息中提取：阳历出生日期、出生时间（小时精确即可）、性别
2. 调用 `load_skill` 加载本 skill
3. 用 `run_skill_script` 执行 `paipan.js`，通过 stdin 传入 JSON 参数

## 调用方式

加载：

```text
load_skill({ skill_name: "ziwei-paipan" })
```

执行：

```text
run_skill_script({
  skill_name: "ziwei-paipan",
  script: "paipan.js",
  stdin: JSON.stringify({
    solarDate: "2000-08-16",
    hour: 4,
    minute: 0,
    gender: "male"
  })
})
```

## 参数说明

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| solarDate | string | 是 | — | 阳历日期 YYYY-MM-DD |
| hour | integer | 是 | — | 出生小时 0-23（24 小时制） |
| minute | integer | 否 | 0 | 出生分钟 0-59 |
| gender | string | 是 | — | male / female / 男 / 女 |
| fixLeap | boolean | 否 | true | 是否修正闰月 |
| horoscope | object | 否 | — | `{ date: "YYYY-MM-DD", scopes?: string[] }` 叠加运盘 |

时辰（`timeIndex`）由 `hour` 自动映射：`23` 时 → 晚子时(12)，`0` 时 → 早子时(0)，其余按两小时一个时辰。

### 运盘 scopes

- `decadal` 大限（10 年）
- `age` 小限（1 年，按虚岁）
- `yearly` 流年
- `monthly` 流月
- `daily` 流日
- `hourly` 流时

默认 `["decadal", "yearly"]`。

## 返回结构

```json
{
  "solarDate": "2000-8-16",
  "lunarDate": "二〇〇〇年七月十七",
  "chineseDate": "庚辰 甲申 丙午 庚寅",
  "time": "寅时",
  "sign": "狮子座",
  "zodiac": "龙",
  "soul": "破军",
  "body": "文昌",
  "fiveElementsClass": "木三局",
  "earthlyBranchOfSoulPalace": "午",
  "earthlyBranchOfBodyPalace": "戌",
  "palaces": [
    {
      "name": "财帛",
      "isBodyPalace": false,
      "isOriginalPalace": false,
      "heavenlyStem": "戊",
      "earthlyBranch": "寅",
      "majorStars": [{ "name": "武曲", "brightness": "得", "mutagen": "" }],
      "minorStars": [],
      "decadal": { "range": [83, 92], "heavenlyStem": "戊", "earthlyBranch": "寅" }
    }
  ],
  "horoscope": {
    "solarDate": "2026-4-17",
    "lunarDate": "二〇二六年三月初一",
    "decadal": {
      "name": "大限",
      "heavenlyStem": "甲",
      "earthlyBranch": "申",
      "mutagen": ["廉贞", "破军", "武曲", "太阳"],
      "palaceNames": ["迁移", "疾厄", "财帛", "..."]
    },
    "yearly": { "...": "..." }
  }
}
```

`horoscope.*.palaceNames` 是按本命盘宫位顺序排列的运盘宫位名，用来理解"今年的命宫落在本命哪个宫"。`mutagen` 是该尺度的四化（禄权科忌）。

为控制体积，当前返回结构仅保留主星、辅星的 name/brightness/mutagen，省略杂耀、长生博士将前岁前 12 神、小限等。
