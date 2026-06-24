# 八字命例数据集 · 开放查询 API

一份「八字 → 真实人生结果」的标注语料（1606 例），以**只读、免登录**的 HTTP 接口对外开放查询。

- **无需鉴权**：所有接口公开访问，不需要 token。
- **CORS**：对所有来源放开（`Access-Control-Allow-Origin: *`），可在浏览器中跨域调用。接口均为简单 `GET`，不触发预检。
- **限流**：按客户端 IP 固定窗口限流 **60 次 / 分钟**，超限返回 `429`（带 `Retry-After` 头）。
- **Base URL**：与站点同源，路径前缀 `/api/bazi-cases`。

---

## GET `/api/bazi-cases` — 命例列表

按维度筛选 + 关键词搜索 + 分页。

### Query 参数（全部可选）

| 参数 | 说明 | 示例 |
|------|------|------|
| `gender` | 性别 | `男` / `女` |
| `marriage` | 婚姻状况 | `一婚` / `一婚离异` / `未婚` / `二婚` … |
| `wealth` | 按「当前」财富层级筛选 | `小康` / `温饱` / `小富` / `贫困` / `官宦` … |
| `education` | 学历 | `本科学历` / `专科学历` / `低学历` / `顶级学历` … |
| `job_type` | 职业类型 | `自由打工` / `稳定工作` |
| `q` | 关键词，在「职业」与「人生轨迹」文本中子串匹配 | `区长` |
| `limit` | 每页条数，默认 `20`，上限 `100` | `12` |
| `offset` | 偏移量，默认 `0` | `24` |

> 各筛选维度的合法取值与分布，可直接从 `/overview` 接口获取（前端展览页的筛选项即由它动态生成）。

### 响应

```json
{
  "entries": [
    {
      "id": 1,
      "bazi": "甲子 己巳 壬寅 甲辰",
      "gender": "男",
      "marriage": "一婚",
      "children_desc": "0男2女",
      "abortions_size": 0,
      "child_deaths_size": 0,
      "current_education": "顶级学历",
      "current_parent": "父母健在",
      "init_wealth": "官宦",
      "current_wealth": "官宦",
      "job": "副区长",
      "job_type": "稳定工作",
      "job_info": "职业经历从高校教师转至公务员并逐步升迁至副区长……"
    }
  ],
  "total": 1606,
  "limit": 20,
  "offset": 0
}
```

`total` 为当前筛选条件下的命中总数，用于分页。`abortions_size` / `child_deaths_size` 在源数据缺失时为 `null`。

### 示例

```bash
# 列出「女性 + 当前小康 + 经历里含『外贸』」的前 5 条
curl "https://<host>/api/bazi-cases?gender=女&wealth=小康&q=外贸&limit=5"
```

---

## GET `/api/bazi-cases/overview` — 统计概览

返回各维度的取值分布（按计数降序），其中财富分「出身」与「当前」两套，可对照看一生财富起落。

### 响应

```json
{
  "total": 1606,
  "by_gender": [{ "value": "女", "count": 1007 }, { "value": "男", "count": 599 }],
  "by_marriage": [{ "value": "一婚", "count": 717 }, ...],
  "by_job_type": [{ "value": "自由打工", "count": 1060 }, ...],
  "by_education": [{ "value": "低学历", "count": 518 }, ...],
  "by_init_wealth": [{ "value": "温饱", "count": 811 }, ...],
  "by_current_wealth": [{ "value": "小康", "count": 744 }, ...]
}
```

### 示例

```bash
curl "https://<host>/api/bazi-cases/overview"
```

---

## 数据来源与导入

- 表：`bazi_cases`（迁移 `0062-bazi-cases`）。
- 导入：`pnpm --dir ../.. exec tsx apps/api/src/app/import-bazi-cases.ts`（读 `backups/elidli_cases.jsonl`，以 `id` 为主键幂等写入，可重复运行）。
- 展览页：`/bazi-cases`（免登录公开页）。
