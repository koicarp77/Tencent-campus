# 审图台压力测试实测报告

这是一轮本机回环、程序化 HTTP/SSE 压测。压测器与服务共享机器资源，结果不能直接换算为真实浏览器用户数，也不代表已测得最大容量。

运行编号：`2026-11-01T06-08-30-117Z-c69915`。开始：2026-11-01 14:08:30 CST；结束：2026-11-01 14:08:52 CST。

**已记录的一致性检查全部通过**。通过181项，未通过0项。

| 指标 | 结果 |
| --- | --- |
| 测量HTTP请求数 | 72,871 |
| 成功请求数 | 72,870 |
| 加权HTTP非2xx率（含预期拒绝） | 0.001% |
| 服务峰值RSS | 230.45 MiB |

## 先看结论与口径

- 这是一轮本机回环、程序化 HTTP/SSE 压测。压测器与服务共享机器资源，结果不能直接换算为真实浏览器用户数，也不代表已测得最大容量。
- 读取阶段中的read-read-normal-10、read-read-normal-50、read-read-normal-100达到了请求数封顶而提前停止；不能将配置时长当成实际持续时间。
- 一致性检查与承载容量分别评估：本轮检查通过只说明已测负载内记录正确，不等于已测得最大用户数或长时间稳定性。

## 环境与参数

| 字段 | 记录 |
| --- | --- |
| 运行编号 | 2026-11-01T06-08-30-117Z-c69915 |
| 开始时间（Asia/Shanghai） | 2026-11-01 14:08:30 CST |
| 结束时间（Asia/Shanghai） | 2026-11-01 14:08:52 CST |
| 平台 / 架构 | darwin 24.6.0 / arm64 |
| Node.js / SQLite | v26.5.1 / 3.53.2 |
| CPU | Apple M4 |
| 逻辑 CPU 数 | 10 |
| 机器总内存 | 16 GiB |
| 服务进程 PID | 81,316 |
| 测试范围 | 同机loopback；独立生产构建子进程与临时磁盘SQLite；纯HTTP/SSE模拟账号，无浏览器渲染 |
| 模拟账号数 | 100 |
| 真实浏览器用户数 | 0 |

```json
{
  "levels": [
    10,
    50,
    100
  ],
  "readSeconds": 10,
  "writeIterations": 20,
  "sseUpdates": 10,
  "sseIntervalMs": 250,
  "maxReadRequestsPerStage": 20000,
  "requestTimeoutMs": 12000,
  "accountCount": 100,
  "realBrowserUsers": 0
}
```

## 指标口径

| 术语 | 含义 |
| --- | --- |
| 并发请求 worker | 发出请求并等待响应的脚本任务；闭环模式下服务变慢会使发压速率降低。 |
| 模拟账号 | 用于身份与群组隔离的会话身份；账号数不一定等于并发请求数。 |
| SSE 连接 | 保持在线接收通知的程序化连接；不包含真实浏览器渲染开销。 |
| 真实浏览器用户 | 本报告不按脚本连接数推定；只有明确记录的浏览器人数才展示。 |

## HTTP结果

| 场景 | 并发参数 | 配置时长 | 实际阶段时长 | 停止原因 | HTTP 请求 | 成功 / 失败 | 错误率 | 吞吐 | p50 | p95 | p99 | 最大 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| read-read-normal-10 | 10 | 10 s | 1,991.1 ms | 达到请求封顶 | 20,000 | 20,000 / 0 | 0% | 10,044.53 req/s | 0.83 ms | 1.67 ms | 2.41 ms | 11.39 ms |
| read-read-normal-50 | 50 | 10 s | 1,963.5 ms | 达到请求封顶 | 20,000 | 20,000 / 0 | 0% | 10,185.76 req/s | 4.45 ms | 7.25 ms | 10.7 ms | 113.05 ms |
| read-read-normal-100 | 100 | 10 s | 1,879.3 ms | 达到请求封顶 | 20,000 | 20,000 / 0 | 0% | 10,642.42 req/s | 9.01 ms | 9.95 ms | 18.01 ms | 353.08 ms |
| read-read-maximum-100 | 100 | 5 s | 5,081.2 ms | 达到配置时长 | 6,280 | 6,280 / 0 | 0% | 1,235.92 req/s | 78.78 ms | 88.43 ms | 134.49 ms | 212.3 ms |
| write-independent-10 | 10 | 未记录 | 103.8 ms | 未记录（见描述） | 200 | 200 / 0 | 0% | 1,926.85 req/s | 3.97 ms | 10.16 ms | 11.55 ms | 15.61 ms |
| write-independent-50 | 50 | 未记录 | 496.2 ms | 未记录（见描述） | 1,000 | 1,000 / 0 | 0% | 2,015.18 req/s | 22.53 ms | 36.02 ms | 45.76 ms | 74.69 ms |
| write-independent-100 | 100 | 未记录 | 1,028.7 ms | 未记录（见描述） | 2,000 | 2,000 / 0 | 0% | 1,944.14 req/s | 47.92 ms | 71.33 ms | 80.92 ms | 144.12 ms |
| same-marker-10 | 10 | 未记录 | 5.4 ms | 未记录（见描述） | 10 | 10 / 0 | 0% | 1,854.8 req/s | 3.33 ms | 5.11 ms | 5.11 ms | 5.11 ms |
| same-marker-50 | 50 | 未记录 | 44.2 ms | 未记录（见描述） | 50 | 50 / 0 | 0% | 1,131.24 req/s | 15.52 ms | 41.48 ms | 43.52 ms | 43.52 ms |
| same-marker-100 | 100 | 未记录 | 141.2 ms | 未记录（见描述） | 100 | 100 / 0 | 0% | 708.21 req/s | 43.79 ms | 131.74 ms | 138.07 ms | 139.77 ms |
| business-limit-101 | 1 | 未记录 | 4.8 ms | 未记录（见描述） | 1 | 0 / 1 | 100% | 207.24 req/s | 3.96 ms | 3.96 ms | 3.96 ms | 3.96 ms |
| sse-fanout-10 | 10 | 未记录 | 2,521 ms | 未记录（见描述） | 210 | 210 / 0 | 0% | 83.3 req/s | 5.87 ms | 13.16 ms | 14.97 ms | 15.44 ms |
| sse-fanout-50 | 50 | 未记录 | 2,528 ms | 未记录（见描述） | 1,010 | 1,010 / 0 | 0% | 399.53 req/s | 12.12 ms | 33.49 ms | 39.78 ms | 45.08 ms |
| sse-fanout-100 | 100 | 未记录 | 2,535.1 ms | 未记录（见描述） | 2,010 | 2,010 / 0 | 0% | 792.86 req/s | 18.42 ms | 44.05 ms | 52.59 ms | 59.49 ms |

### 怎样读这些数值

| 指标 | 含义 |
| --- | --- |
| p50 / p95 / p99 | 分别表示50% / 95% / 99%的已完成请求耗时不超过该值；不是平均值，也不是最大值。 |
| req/s（RPS） | 测量阶段每秒完成的HTTP请求数；一次模拟用户操作可能产生多次请求。 |
| 非2xx率 | 记录为失败的HTTP请求占比，含超时/连接错误以及预期的业务拒绝；需按状态与场景区分。 |
| 通知延迟 | 从压测脚本定义的起点到SSE客户端收到通知的耗时。 |
| 自动补查延迟 | 模拟客户端收到通知并自动读取最新状态所花的总时间，不含浏览器画面渲染。 |
| RSS | 服务进程驻留物理内存的采样值，不等于机器总内存，也不包括压测器全部开销。 |

## 实时通知与自动补查

| 场景 | SSE 连接 | 保存轮数 | 预期通知 | 收到通知 | 最终追平 | 通知 p95 | 自动补查 p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sse-fanout-10 | 10 | 10 | 100 | 100 | 10 | 15.57 ms | 82.72 ms |
| sse-fanout-50 | 50 | 10 | 500 | 500 | 50 | 9.48 ms | 113.93 ms |
| sse-fanout-100 | 100 | 10 | 1,000 | 1,000 | 100 | 10.96 ms | 128.3 ms |

自动补查延迟不含浏览器渲染。

## 资源与传输量

| 场景 | 服务峰值 RSS | 采样 CPU 最大值 | 事件循环 p95 最大值 | 事件循环延迟最大值 | 请求体字节 | 响应体字节 |
| --- | --- | --- | --- | --- | --- | --- |
| read-read-normal-10 | 118 MiB | 108.2% | 11.04 ms | 15.25 ms | 0 B | 115.07 MiB |
| read-read-normal-50 | 123.36 MiB | 98.32% | 15.1 ms | 20.02 ms | 0 B | 115.07 MiB |
| read-read-normal-100 | 124.55 MiB | 100.17% | 18.87 ms | 19.68 ms | 0 B | 115.07 MiB |
| read-read-maximum-100 | 230.45 MiB | 107.33% | 89.52 ms | 123.47 ms | 0 B | 1.05 GiB |
| write-independent-10 | 未记录 | 未记录 | 未记录 | 未记录 | 98.06 KiB | 1.17 MiB |
| write-independent-50 | 未记录 | 未记录 | 未记录 | 未记录 | 491.06 KiB | 5.86 MiB |
| write-independent-100 | 212.31 MiB | 93.57% | 53.41 ms | 53.94 ms | 982.32 KiB | 11.74 MiB |
| same-marker-10 | 未记录 | 未记录 | 未记录 | 未记录 | 4.88 KiB | 35.61 KiB |
| same-marker-50 | 未记录 | 未记录 | 未记录 | 未记录 | 24.45 KiB | 769.2 KiB |
| same-marker-100 | 未记录 | 未记录 | 未记录 | 未记录 | 48.92 KiB | 2.95 MiB |
| business-limit-101 | 未记录 | 未记录 | 未记录 | 未记录 | 217 B | 137 B |
| sse-fanout-10 | 193.12 MiB | 74.77% | 74.25 ms | 145.62 ms | 4.88 KiB | 3.38 MiB |
| sse-fanout-50 | 184.39 MiB | 18.23% | 18.55 ms | 34.11 ms | 4.88 KiB | 16.67 MiB |
| sse-fanout-100 | 189.98 MiB | 27.64% | 26.08 ms | 38.11 ms | 4.88 KiB | 33.28 MiB |

## 逐场景结果

### 1. read-read-normal-10

闭环GET review；10条标记，每条100字；无思考时间

配置时长：10 s；实际阶段时长：1,991.1 ms；停止原因：request-cap。

HTTP 状态分布：200: 20,000

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| review-read | 20,000 | 20,000 / 0 | 0% | 0.83 ms | 1.67 ms | 2.41 ms | 200: 20,000 |

- 通过：read-response-shape。{'invalidResponses': 0}

### 2. read-read-normal-50

闭环GET review；10条标记，每条100字；无思考时间

配置时长：10 s；实际阶段时长：1,963.5 ms；停止原因：request-cap。

HTTP 状态分布：200: 20,000

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| review-read | 20,000 | 20,000 / 0 | 0% | 4.45 ms | 7.25 ms | 10.7 ms | 200: 20,000 |

- 通过：read-response-shape。{'invalidResponses': 0}

### 3. read-read-normal-100

闭环GET review；10条标记，每条100字；无思考时间

配置时长：10 s；实际阶段时长：1,879.3 ms；停止原因：request-cap。

HTTP 状态分布：200: 20,000

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| review-read | 20,000 | 20,000 / 0 | 0% | 9.01 ms | 9.95 ms | 18.01 ms | 200: 20,000 |

- 通过：read-response-shape。{'invalidResponses': 0}

### 4. read-read-maximum-100

闭环GET review；100条标记，每条500字；无思考时间

配置时长：5 s；实际阶段时长：5,081.2 ms；停止原因：duration。

HTTP 状态分布：200: 6,280

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| review-read | 6,280 | 6,280 / 0 | 0% | 78.78 ms | 88.43 ms | 134.49 ms | 200: 6,280 |

- 通过：read-response-shape。{'invalidResponses': 0}

### 5. write-independent-10

每个worker编辑自己的图片，20次沿成功响应版本增量保存；每图10条标记

配置时长：未记录；实际阶段时长：103.8 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：200: 200

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| annotation-write | 200 | 200 / 0 | 0% | 3.97 ms | 10.16 ms | 11.55 ms | 200: 200 |

- 通过：worker-0-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-1-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-2-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-3-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-4-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-5-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-6-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-7-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-8-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-9-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}

### 6. write-independent-50

每个worker编辑自己的图片，20次沿成功响应版本增量保存；每图10条标记

配置时长：未记录；实际阶段时长：496.2 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：200: 1,000

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| annotation-write | 1,000 | 1,000 / 0 | 0% | 22.53 ms | 36.02 ms | 45.76 ms | 200: 1,000 |

- 通过：worker-0-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-1-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-2-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-3-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-4-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-5-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-6-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-7-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-8-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-9-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-10-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-11-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-12-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-13-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-14-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-15-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-16-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-17-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-18-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-19-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-20-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-21-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-22-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-23-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-24-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-25-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-26-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-27-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-28-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-29-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-30-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-31-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-32-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-33-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-34-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-35-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-36-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-37-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-38-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-39-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-40-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-41-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-42-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-43-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-44-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-45-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-46-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-47-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-48-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-49-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}

### 7. write-independent-100

每个worker编辑自己的图片，20次沿成功响应版本增量保存；每图10条标记

配置时长：未记录；实际阶段时长：1,028.7 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：200: 2,000

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| annotation-write | 2,000 | 2,000 / 0 | 0% | 47.92 ms | 71.33 ms | 80.92 ms | 200: 2,000 |

- 通过：worker-0-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-1-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-2-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-3-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-4-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-5-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-6-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-7-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-8-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-9-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-10-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-11-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-12-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-13-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-14-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-15-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-16-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-17-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-18-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-19-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-20-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-21-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-22-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-23-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-24-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-25-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-26-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-27-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-28-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-29-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-30-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-31-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-32-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-33-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-34-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-35-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-36-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-37-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-38-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-39-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-40-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-41-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-42-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-43-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-44-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-45-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-46-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-47-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-48-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-49-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-50-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-51-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-52-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-53-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-54-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-55-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-56-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-57-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-58-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-59-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-60-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-61-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-62-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-63-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-64-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-65-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-66-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-67-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-68-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-69-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-70-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-71-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-72-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-73-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-74-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-75-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-76-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-77-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-78-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-79-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-80-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-81-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-82-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-83-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-84-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-85-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-86-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-87-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-88-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-89-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-90-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-91-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-92-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-93-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-94-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-95-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-96-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-97-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-98-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}
- 通过：worker-99-persisted。{'acknowledged': 20, 'revision': 21, 'count': 10}

### 8. same-marker-10

所有账号从同一基准版本同时修改同一个标记，每人不同内容；检查分叉及版本

配置时长：未记录；实际阶段时长：5.4 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：200: 10

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| concurrent-same-marker | 10 | 10 / 0 | 0% | 3.33 ms | 5.11 ms | 5.11 ms | 200: 10 |

- 通过：all-concurrent-writes-acknowledged。{'statuses': [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]}
- 通过：all-distinct-contents-persisted。{'count': 10, 'revision': 11, 'expected': 10}

### 9. same-marker-50

所有账号从同一基准版本同时修改同一个标记，每人不同内容；检查分叉及版本

配置时长：未记录；实际阶段时长：44.2 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：200: 50

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| concurrent-same-marker | 50 | 50 / 0 | 0% | 15.52 ms | 41.48 ms | 43.52 ms | 200: 50 |

- 通过：all-concurrent-writes-acknowledged。{'statuses': [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200]}
- 通过：all-distinct-contents-persisted。{'count': 50, 'revision': 51, 'expected': 50}

### 10. same-marker-100

所有账号从同一基准版本同时修改同一个标记，每人不同内容；检查分叉及版本

配置时长：未记录；实际阶段时长：141.2 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：200: 100

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| concurrent-same-marker | 100 | 100 / 0 | 0% | 43.79 ms | 131.74 ms | 138.07 ms | 200: 100 |

- 通过：all-concurrent-writes-acknowledged。{'statuses': [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200]}
- 通过：all-distinct-contents-persisted。{'count': 100, 'revision': 101, 'expected': 100}

### 11. business-limit-101

业务保护对照：已有100份并发修改时再提交第101份，预期409 MERGE_LIMIT，不计为服务器容量故障

配置时长：未记录；实际阶段时长：4.8 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：409: 1

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| expected-policy-rejection | 1 | 0 / 1 | 100% | 3.96 ms | 3.96 ms | 3.96 ms | 409: 1 |

- 通过：101st-change-rejected-atomically。{'status': 409, 'code': 'MERGE_LIMIT', 'count': 100, 'revision': 101}

### 12. sse-fanout-10

N条SSE长连接；收到通知后50ms合并、串行GET图片列表及review，模拟当前页面补查（无浏览器渲染）

配置时长：未记录；实际阶段时长：2,521 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：200: 210

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sse-connect | 10 | 10 / 0 | 0% | 2.37 ms | 2.84 ms | 2.84 ms | 200: 10 |
| sse-origin-write | 10 | 10 / 0 | 0% | 4.67 ms | 14.97 ms | 14.97 ms | 200: 10 |
| sse-notification | 100 | 100 / 0 | 0% | 5.31 ms | 15.57 ms | 15.69 ms | 200: 100 |
| sse-refresh-list | 100 | 100 / 0 | 0% | 7.39 ms | 13.26 ms | 13.73 ms | 200: 100 |
| sse-refresh-review | 100 | 100 / 0 | 0% | 5.29 ms | 12.47 ms | 15.34 ms | 200: 100 |
| sse-visible | 100 | 100 / 0 | 0% | 71.46 ms | 82.72 ms | 83.51 ms | 200: 100 |

| 指标 | p50 | p95 | p99 | 最大 | 均值 |
| --- | --- | --- | --- | --- | --- |
| 通知延迟 | 5.31 ms | 15.57 ms | 15.69 ms | 15.72 ms | 5.76 ms |
| 自动补查延迟（非浏览器绘制） | 71.46 ms | 82.72 ms | 83.51 ms | 83.8 ms | 70.62 ms |

- 通过：all-notifications-received。{'expected': 100, 'received': 100}
- 通过：all-subscribers-caught-up。{'expected': 10, 'finalCaughtUp': 10, 'targetRevision': 11}
- 通过：no-unexpected-sse-disconnects。{'disconnects': 0}

### 13. sse-fanout-50

N条SSE长连接；收到通知后50ms合并、串行GET图片列表及review，模拟当前页面补查（无浏览器渲染）

配置时长：未记录；实际阶段时长：2,528 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：200: 1,010

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sse-connect | 50 | 50 / 0 | 0% | 6.07 ms | 6.8 ms | 7.17 ms | 200: 50 |
| sse-origin-write | 10 | 10 / 0 | 0% | 6.33 ms | 8.01 ms | 8.01 ms | 200: 10 |
| sse-notification | 500 | 500 / 0 | 0% | 7.44 ms | 9.48 ms | 9.79 ms | 200: 500 |
| sse-refresh-list | 500 | 500 / 0 | 0% | 21.01 ms | 35.33 ms | 44.11 ms | 200: 500 |
| sse-refresh-review | 500 | 500 / 0 | 0% | 8.1 ms | 21.35 ms | 31.8 ms | 200: 500 |
| sse-visible | 500 | 500 / 0 | 0% | 90.97 ms | 113.93 ms | 121.91 ms | 200: 500 |

| 指标 | p50 | p95 | p99 | 最大 | 均值 |
| --- | --- | --- | --- | --- | --- |
| 通知延迟 | 7.44 ms | 9.48 ms | 9.79 ms | 9.91 ms | 7.08 ms |
| 自动补查延迟（非浏览器绘制） | 90.97 ms | 113.93 ms | 121.91 ms | 122.49 ms | 91.48 ms |

- 通过：all-notifications-received。{'expected': 500, 'received': 500}
- 通过：all-subscribers-caught-up。{'expected': 50, 'finalCaughtUp': 50, 'targetRevision': 11}
- 通过：no-unexpected-sse-disconnects。{'disconnects': 0}

### 14. sse-fanout-100

N条SSE长连接；收到通知后50ms合并、串行GET图片列表及review，模拟当前页面补查（无浏览器渲染）

配置时长：未记录；实际阶段时长：2,535.1 ms；停止原因：未记录（见场景描述）。

HTTP 状态分布：200: 2,010

分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。
| 测量类型 | 样本数 | 成功 / 失败记录 | 失败记录率 | p50 | p95 | p99 | 状态记录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sse-connect | 100 | 100 / 0 | 0% | 8.08 ms | 9.28 ms | 9.39 ms | 200: 100 |
| sse-origin-write | 10 | 10 / 0 | 0% | 4.78 ms | 9.39 ms | 9.39 ms | 200: 10 |
| sse-notification | 1,000 | 1,000 / 0 | 0% | 6.03 ms | 10.96 ms | 11.84 ms | 200: 1,000 |
| sse-refresh-list | 1,000 | 1,000 / 0 | 0% | 27.33 ms | 48.51 ms | 53.62 ms | 200: 1,000 |
| sse-refresh-review | 1,000 | 1,000 / 0 | 0% | 14.34 ms | 33.92 ms | 40.17 ms | 200: 1,000 |
| sse-visible | 1,000 | 1,000 / 0 | 0% | 105.34 ms | 128.3 ms | 133.22 ms | 200: 1,000 |

| 指标 | p50 | p95 | p99 | 最大 | 均值 |
| --- | --- | --- | --- | --- | --- |
| 通知延迟 | 6.03 ms | 10.96 ms | 11.84 ms | 12.07 ms | 6.54 ms |
| 自动补查延迟（非浏览器绘制） | 105.34 ms | 128.3 ms | 133.22 ms | 134.45 ms | 101.48 ms |

- 通过：all-notifications-received。{'expected': 1000, 'received': 1000}
- 通过：all-subscribers-caught-up。{'expected': 100, 'finalCaughtUp': 100, 'targetRevision': 11}
- 通过：no-unexpected-sse-disconnects。{'disconnects': 0}

## 全局检查

- 通过：sqlite-integrity-check。ok

## 测试数据库归档

| 指标 | 记录 |
| --- | --- |
| SQLite文件总大小 | 55 MiB（57,667,584 B） |
| 压缩归档大小 | 2.47 MiB（2,592,817 B） |
| 完整性检查 | ok |
| 表记录数 · images | 169 |
| 表记录数 · annotations | 1,910 |
| 表记录数 · review_versions | 3,748 |
| 表记录数 · review_submissions | 3,410 |

文件大小是整库归档时总量；没有按表拆分或基线对照，不能直接归因于版本/收据；记录数反映历史规模。

## 原始数据

- [汇总数据 summary.json](summary.json)
- [requests](requests.jsonl)
- [csv](requests.csv)
- [resources](resources.jsonl)
- [serverLog](server-output.txt)
- [database](fixture.sqlite.gz)
- [databaseInfo](database-info.json)
- [独立原始数据与数据库复核](verification.json)

## 解释边界

- 并发数为闭环HTTP worker或SSE连接，不代表真实浏览器用户数。
- 客户端与服务端同机竞争CPU，loopback不含公网延迟；这些结果不是最大用户容量或生产SLA。
- HTTP延迟包括客户端队列、传输、响应读取与JSON解析；不包括浏览器绘制。百分位按全部已完成请求计算，错误另列。
- SSE可见延迟从保存请求开始计时，包含50ms合并及list+review补查；较新版本覆盖较旧通知时记为已追赶，而非每个中间版本都曾显示。
- 读取阶段限时且最多20000请求，耗时包括停止发起后的在途请求收尾；写入阶段为固定操作次数突发测试，未模拟用户思考时间。
- HTTP RPS只包含测量请求；初始化、预热、验证查询不计入。业务上限101保护阶段预期409应单列，不是性能错误。
- 未覆盖上传解码、大图片下载、真实浏览器内存/渲染、长时间耐久测试、多服务器部署。
- 资源指标每秒采样，极短阶段可能没有样本；event-loop histogram分辨率10ms，不是完整CPU剖析。
- 本机回环网络排除了真实公网/局域网延迟；客户端与服务端共享 CPU、内存与磁盘。
- HTTP 吞吐以该阶段实际请求数除以阶段墙钟时间计算，不按并发参数推算；HTTP 指标不包含 SSE 消息。
- 脚本记录的自动补查延迟不包含浏览器 DOM 渲染和用户可见的绘制时间。
- 并发参数、模拟账号数、SSE 连接数与真实浏览器用户数不可混用；未记录的字段显示为“未记录”。
- p50/p95/p99 是该次样本的分位数，不是服务保证。错误率为0也不表示更大或更长负载下不会失败。
- CPU采样按process.cpuUsage除以墙钟时间，100%约为一个逻辑核的用量，不代表整台多核机器已占满。资源采样窗口可能跨阶段，极短阶段可能没有样本。
- 数据一致性检查与速度指标分别展示；HTTP非2xx率包含预期业务拒绝，不能直接当成性能故障率，需结合场景说明和HTTP状态分布解释。

[离线HTML图表报告](report.html)。数值均来自同目录summary.json，未知字段不推测为0。
