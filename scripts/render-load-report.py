#!/usr/bin/env python3
"""Render recorded load-test summary into standalone Chinese HTML and Markdown.

Usage: python3 scripts/render-load-report.py path/to/summary.json
No network, third-party dependencies or synthesized measurements.
"""
from __future__ import annotations

import html
import json
import math
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote


def number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def fmt(value: Any, digits: int = 2, unit: str = "") -> str:
    n = number(value)
    if n is None:
        return "未记录"
    text = f"{n:,.{digits}f}"
    if digits:
        text = text.rstrip("0").rstrip(".")
    return text + unit


def percent(value: Any) -> str:
    n = number(value)
    return fmt(n * 100, 3, "%") if n is not None else "未记录"


def bytes_text(value: Any) -> str:
    n = number(value)
    if n is None:
        return "未记录"
    for factor, suffix in ((1024**3, " GiB"), (1024**2, " MiB"), (1024, " KiB")):
        if abs(n) >= factor:
            return fmt(n / factor, 2, suffix)
    return fmt(n, 0, " B")


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def md(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def date_text(value: Any) -> str:
    if not value:
        return "未记录"
    try:
        from zoneinfo import ZoneInfo

        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return str(value) + "（原始记录未含时区）"
        return stamp.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S %Z")
    except (ValueError, TypeError, KeyError):
        return str(value)


def get(obj: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(key)
    return obj


def known_sum(values: list[Any]) -> float | None:
    nums = [number(v) for v in values]
    return sum(n for n in nums if n is not None) if nums and all(n is not None for n in nums) else None


def check_rows(checks: Any) -> list[dict[str, Any]]:
    if isinstance(checks, dict):
        return [dict(name=k, **v) if isinstance(v, dict) else {"name": k, "passed": v} for k, v in checks.items()]
    return [item if isinstance(item, dict) else {"name": str(item), "passed": None} for item in checks or []]


def check_status(check: dict[str, Any]) -> tuple[str, str]:
    value = check.get("passed")
    return ("通过", "pass") if value is True else ("未通过", "fail") if value is False else ("未记录结论", "unknown")


def status_counts(obj: Any) -> str:
    if not isinstance(obj, dict) or not obj:
        return "未记录"
    return " · ".join(f"{key}: {fmt(value, 0)}" for key, value in obj.items())


def quantile_row(values: Any) -> list[str]:
    return [fmt(get(values, key), 2, " ms") for key in ("p50", "p95", "p99", "max", "mean")]


def table(headers: list[str], rows: list[list[Any]], css: str = "") -> str:
    return (
        '<div class="table-scroll"><table class="' + esc(css) + '"><thead><tr>'
        + "".join("<th>" + esc(cell) + "</th>" for cell in headers)
        + "</tr></thead><tbody>"
        + "".join("<tr>" + "".join("<td>" + esc(cell) + "</td>" for cell in row) + "</tr>" for row in rows)
        + "</tbody></table></div>"
    )


def md_table(headers: list[str], rows: list[list[Any]]) -> str:
    return "\n".join([
        "| " + " | ".join(md(v) for v in headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
        *["| " + " | ".join(md(v) for v in row) + " |" for row in rows],
    ])


def bar_chart(scenarios: list[dict], path: tuple[str, ...], title: str, unit: str, color: str) -> str:
    points = [(scenario, number(get(scenario, *path))) for scenario in scenarios]
    valid = [(scenario, value) for scenario, value in points if value is not None]
    if not valid:
        return '<div class="chart"><h3>' + esc(title) + '</h3><p class="muted">此指标没有已记录样本。</p></div>'
    maximum = max(value for _, value in valid)
    rows = []
    for index, (scenario, value) in enumerate(valid):
        width = 0 if maximum <= 0 else value / maximum * 100
        label = scenario.get("name", f"场景 {index + 1}")
        rows.append(
            '<div class="bar-row"><div class="bar-label">' + esc(label)
            + ' <small>并发参数 ' + esc(fmt(scenario.get("concurrency"), 0)) + '</small></div>'
            + '<div class="bar-track"><div class="bar" style="width:' + f"{width:.3f}%"
            + ';background:' + color + '"></div></div><strong>' + esc(fmt(value, 2, unit)) + '</strong></div>'
        )
    return '<div class="chart"><h3>' + esc(title) + '</h3><div class="bars">' + "".join(rows) + '</div></div>'


def latency_plot(scenarios: list[dict]) -> str:
    points = []
    for index, item in enumerate(scenarios):
        concurrency = number(item.get("concurrency"))
        p95 = number(get(item, "http", "latencyMs", "p95"))
        if concurrency is not None and p95 is not None:
            points.append((index, item, concurrency, p95))
    if not points:
        return ""
    width, height, left, right, top, bottom = 900, 310, 80, 30, 25, 60
    maximum_x = max(p[2] for p in points) or 1
    maximum_y = max(p[3] for p in points) or 1
    chart_w, chart_h = width - left - right, height - top - bottom
    colors = ["#206b5a", "#ac7441", "#4f68a5", "#8c529a", "#557f34", "#b44e59"]
    circles = []
    legend = []
    ticks = []
    for step in range(5):
        y = top + chart_h * step / 4
        value = maximum_y * (1 - step / 4)
        ticks.append(f'<line x1="{left}" y1="{y}" x2="{width-right}" y2="{y}" stroke="#dfe7df"/>')
        ticks.append(f'<text x="{left-12}" y="{y+4}" text-anchor="end">{esc(fmt(value,1))}</text>')
    for value in sorted(set(p[2] for p in points)):
        x = left + value / maximum_x * chart_w
        ticks.append(f'<text x="{x}" y="{height-bottom+23}" text-anchor="middle">{esc(fmt(value,0))}</text>')
    for label_index, (_, item, concurrency, latency) in enumerate(points):
        x, y = left + concurrency / maximum_x * chart_w, top + chart_h * (1 - latency / maximum_y)
        color = colors[label_index % len(colors)]
        label = f"{item.get('name', '场景')}：并发参数 {fmt(concurrency,0)}，p95 {fmt(latency,2)} ms"
        circles.append(f'<circle cx="{x}" cy="{y}" r="6" fill="{color}" stroke="white" stroke-width="1.5"><title>{esc(label)}</title></circle>')
        legend.append(f'<span><i style="background:{color}"></i>{esc(item.get("name", "场景"))}</span>')
    return (
        '<div class="chart wide"><h3>并发参数与 HTTP p95 耗时</h3>'
        '<p class="muted">每个点为一个完整场景；同并发参数的不同场景不可直接等同。悬停可查看原值。</p>'
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="各压测场景并发参数与HTTP p95响应耗时散点图">'
        '<style>text{font:12px system-ui,sans-serif;fill:#667566}</style>'
        + "".join(ticks)
        + f'<line x1="{left}" y1="{height-bottom}" x2="{width-right}" y2="{height-bottom}" stroke="#809080"/>'
        + f'<text x="{left}" y="14">p95 / ms</text><text x="{width-right}" y="{height-8}" text-anchor="end">场景并发参数</text>'
        + "".join(circles) + '</svg><div class="legend">' + "".join(legend) + '</div></div>'
    )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("用法：python3 scripts/render-load-report.py <summary.json>")
    source = Path(sys.argv[1]).resolve()
    data = json.loads(source.read_text(encoding="utf-8"))
    scenarios = data.get("scenarios", [])
    if not isinstance(scenarios, list):
        raise SystemExit("summary.json 的 scenarios 必须为数组")
    env = data.get("environment", {})
    config = data.get("configuration", {})
    http_values = [item.get("http", {}) for item in scenarios]
    total = known_sum([item.get("requests") for item in http_values])
    good = known_sum([item.get("successful") for item in http_values])
    bad = known_sum([item.get("failed") for item in http_values])
    weighted_error = bad / total if bad is not None and total is not None and total > 0 else None
    rss_values = [number(get(item, "resources", "peakRssBytes")) for item in scenarios]
    peak_rss = max((v for v in rss_values if v is not None), default=None)
    recorded_checks = check_rows(data.get("checks"))
    scenario_names = {item.get("name") for item in scenarios}
    global_checks = [check for check in recorded_checks if check.get("scenario") not in scenario_names]
    candidates = recorded_checks + [dict(check, scenario=check.get("scenario", item.get("name"))) for item in scenarios for check in check_rows(item.get("checks"))]
    all_checks = []
    seen_checks = set()
    for check in candidates:
        key = json.dumps(check, ensure_ascii=False, sort_keys=True)
        if key not in seen_checks:
            seen_checks.add(key)
            all_checks.append(check)
    check_failures = sum(check.get("passed") is False for check in all_checks)
    check_passes = sum(check.get("passed") is True for check in all_checks)
    complete_checks = bool(all_checks) and all(check.get("passed") is True for check in all_checks)
    fatal = data.get("fatal")
    overall_label = "压测运行未完整结束，以下为已保存的部分结果" if fatal else "已记录的一致性检查全部通过" if complete_checks else "存在未通过的一致性检查" if check_failures else "一致性结论需查看明细"
    run_id = data.get("runId", source.parent.name)
    started, finished = date_text(data.get("startedAt")), date_text(data.get("finishedAt"))
    intro = "这是一轮本机回环、程序化 HTTP/SSE 压测。压测器与服务共享机器资源，结果不能直接换算为真实浏览器用户数，也不代表已测得最大容量。"
    role_rows = [
        ["并发请求 worker", "发出请求并等待响应的脚本任务；闭环模式下服务变慢会使发压速率降低。"],
        ["模拟账号", "用于身份与群组隔离的会话身份；账号数不一定等于并发请求数。"],
        ["SSE 连接", "保持在线接收通知的程序化连接；不包含真实浏览器渲染开销。"],
        ["真实浏览器用户", "本报告不按脚本连接数推定；只有明确记录的浏览器人数才展示。"],
    ]
    metric_rows = [
        ["p50 / p95 / p99", "分别表示50% / 95% / 99%的已完成请求耗时不超过该值；不是平均值，也不是最大值。"],
        ["req/s（RPS）", "测量阶段每秒完成的HTTP请求数；一次模拟用户操作可能产生多次请求。"],
        ["非2xx率", "记录为失败的HTTP请求占比，含超时/连接错误以及预期的业务拒绝；需按状态与场景区分。"],
        ["通知延迟", "从压测脚本定义的起点到SSE客户端收到通知的耗时。"],
        ["自动补查延迟", "模拟客户端收到通知并自动读取最新状态所花的总时间，不含浏览器画面渲染。"],
        ["RSS", "服务进程驻留物理内存的采样值，不等于机器总内存，也不包括压测器全部开销。"],
    ]
    account_count = config.get("accountCount", env.get("accountCount"))
    browser_count = config.get("realBrowserUsers", env.get("realBrowserUsers"))
    env_rows = [
        ["运行编号", run_id], ["开始时间（Asia/Shanghai）", started], ["结束时间（Asia/Shanghai）", finished],
        ["平台 / 架构", f"{env.get('platform','未记录')} / {env.get('arch','未记录')}"],
        ["Node.js / SQLite", f"{env.get('node','未记录')} / {env.get('sqlite','未记录')}"],
        ["CPU", env.get("cpuModel", "未记录")], ["逻辑 CPU 数", fmt(env.get("cpus"), 0)],
        ["机器总内存", bytes_text(env.get("totalMemoryBytes"))], ["服务进程 PID", fmt(env.get("serverPid"), 0)],
        ["测试范围", env.get("scope", "未记录")], ["模拟账号数", fmt(account_count, 0)], ["真实浏览器用户数", fmt(browser_count, 0)],
    ]
    http_headers = ["场景", "并发参数", "配置时长", "实际阶段时长", "停止原因", "HTTP 请求", "成功 / 失败", "错误率", "吞吐", "p50", "p95", "p99", "最大"]
    http_rows = []
    resource_rows = []
    sse_rows = []
    for item in scenarios:
        stats = item.get("http", {})
        latency = stats.get("latencyMs", {})
        http_rows.append([
            item.get("name", "未命名"), fmt(item.get("concurrency"), 0), fmt(item.get("configuredSeconds"), 1, " s"), fmt(item.get("elapsedMs"), 1, " ms"), {"duration":"达到配置时长", "request-cap":"达到请求封顶"}.get(item.get("stopReason"), item.get("stopReason") or "未记录（见描述）"),
            fmt(stats.get("requests"), 0), f"{fmt(stats.get('successful'),0)} / {fmt(stats.get('failed'),0)}", percent(stats.get("errorRate")),
            fmt(stats.get("rps"), 2, " req/s"), *[fmt(latency.get(key), 2, " ms") for key in ("p50", "p95", "p99", "max")],
        ])
        resource = item.get("resources", {})
        resource_rows.append([
            item.get("name", "未命名"), bytes_text(resource.get("peakRssBytes")),
            fmt(resource.get("cpuPercentMax"), 2, "%"), fmt(resource.get("eventLoopDelayP95MsMax"), 2, " ms"),
            fmt(resource.get("eventLoopDelayMaxMs"), 2, " ms"), bytes_text(stats.get("requestBytes")), bytes_text(stats.get("responseBytes")),
        ])
        sse = item.get("sse")
        if sse:
            sse_rows.append([
                item.get("name", "未命名"), fmt(sse.get("connections"), 0), fmt(sse.get("updates"), 0),
                fmt(sse.get("expectedNotifications"), 0), fmt(sse.get("receivedNotifications"), 0),
                str(sse.get("finalCaughtUp", "未记录")),
                fmt(get(sse, "notificationLatencyMs", "p95"), 2, " ms"), fmt(get(sse, "visibleLatencyMs", "p95"), 2, " ms"),
            ])
    sse_headers = ["场景", "SSE 连接", "保存轮数", "预期通知", "收到通知", "最终追平", "通知 p95", "自动补查 p95"]
    resource_headers = ["场景", "服务峰值 RSS", "采样 CPU 最大值", "事件循环 p95 最大值", "事件循环延迟最大值", "请求体字节", "响应体字节"]
    artifacts = data.get("artifacts", {})
    if not isinstance(artifacts, dict):
        artifacts = {}
    database_info = None
    database_name = artifacts.get("databaseInfo", "database-info.json")
    database_path = source.parent / str(database_name)
    if database_path.is_file():
        try:
            database_info = json.loads(database_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass
    database_rows = []
    if isinstance(database_info, dict):
        database_rows = [["SQLite文件总大小", bytes_text(database_info.get("fileBytes")) + "（" + fmt(database_info.get("fileBytes"),0," B") + "）"], ["压缩归档大小", bytes_text(database_info.get("compressedBytes")) + "（" + fmt(database_info.get("compressedBytes"),0," B") + "）"], ["完整性检查", database_info.get("integrity", "未记录")]]
        database_rows += [["表记录数 · " + name, fmt(value, 0)] for name, value in (database_info.get("counts") or {}).items()]
    capped = [item for item in scenarios if item.get("stopReason") == "request-cap"]
    capped_text = "读取阶段中的" + "、".join(str(item.get("name", "未命名")) for item in capped) + "达到了请求数封顶而提前停止；不能将配置时长当成实际持续时间。" if capped else "读取阶段的实际时长和停止原因见HTTP结果表；配置时长不等于所有场景持续时间。"
    summary_notes = [intro, capped_text, "一致性检查与承载容量分别评估：本轮检查通过只说明已测负载内记录正确，不等于已测得最大用户数或长时间稳定性。"]
    artifact_items = [
        ("汇总数据 summary.json", source.name),
        *[(str(label), str(name)) for label, name in artifacts.items() if isinstance(name, (str, Path))],
    ]
    if (source.parent / "verification.json").is_file():
        artifact_items.append(("独立原始数据与数据库复核", "verification.json"))
    artifact_items = list(dict.fromkeys(artifact_items))
    links = "".join('<li><a href="' + esc(quote(name, safe="/.-_")) + '">' + esc(label) + '</a> <code>' + esc(name) + '</code></li>' for label, name in artifact_items)
    limitations = data.get("limitations", [])
    if not isinstance(limitations, list):
        limitations = [limitations]
    extra_limits = [
        "本机回环网络排除了真实公网/局域网延迟；客户端与服务端共享 CPU、内存与磁盘。",
        "HTTP 吞吐以该阶段实际请求数除以阶段墙钟时间计算，不按并发参数推算；HTTP 指标不包含 SSE 消息。",
        "脚本记录的自动补查延迟不包含浏览器 DOM 渲染和用户可见的绘制时间。",
        "并发参数、模拟账号数、SSE 连接数与真实浏览器用户数不可混用；未记录的字段显示为“未记录”。",
        "p50/p95/p99 是该次样本的分位数，不是服务保证。错误率为0也不表示更大或更长负载下不会失败。",
        "CPU采样按process.cpuUsage除以墙钟时间，100%约为一个逻辑核的用量，不代表整台多核机器已占满。资源采样窗口可能跨阶段，极短阶段可能没有样本。",
        "数据一致性检查与速度指标分别展示；HTTP非2xx率包含预期业务拒绝，不能直接当成性能故障率，需结合场景说明和HTTP状态分布解释。",
    ]
    limitations = list(dict.fromkeys([str(v) for v in limitations + extra_limits]))
    sections = []
    md_sections = []
    for index, item in enumerate(scenarios, start=1):
        name = item.get("name", f"场景 {index}")
        detail = ['<article class="scenario"><div class="section-title"><span class="index">' + f"{index:02d}" + '</span><h3>' + esc(name) + '</h3></div>']
        detail.append('<p>' + esc(item.get("description", "未记录场景描述")) + '</p>')
        timing_note = f"配置时长：{fmt(item.get('configuredSeconds'),1,' s')}；实际阶段时长：{fmt(item.get('elapsedMs'),1,' ms')}；停止原因：{item.get('stopReason') or '未记录（见场景描述）'}。"
        detail.append('<p class="muted">'+esc(timing_note)+'</p>')
        stats = item.get("http", {})
        detail.append('<p class="muted">HTTP 状态分布：<code>' + esc(status_counts(stats.get("statusCounts"))) + '</code></p>')
        details_rows = []
        for kind, values in (item.get("byKind") or {}).items():
            if not isinstance(values, dict):
                continue
            details_rows.append([
                kind, fmt(values.get("requests"), 0), f"{fmt(values.get('successful'),0)} / {fmt(values.get('failed'),0)}",
                percent(values.get("errorRate")), *[fmt(get(values, "latencyMs", key), 2, " ms") for key in ("p50", "p95", "p99")],
                status_counts(values.get("statusCounts")),
            ])
        detail_headers = ["测量类型", "样本数", "成功 / 失败记录", "失败记录率", "p50", "p95", "p99", "状态记录"]
        if details_rows:
            detail.append('<p class="muted">分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。</p>')
            detail.append(table(detail_headers, details_rows))
        sse = item.get("sse")
        if sse:
            detail.append('<h4>实时通知与自动补查</h4>')
            detail.append(table(["指标", "p50", "p95", "p99", "最大", "均值"], [
                ["通知延迟", *quantile_row(sse.get("notificationLatencyMs"))],
                ["自动补查延迟（非浏览器绘制）", *quantile_row(sse.get("visibleLatencyMs"))],
            ]))
        checks = check_rows(item.get("checks"))
        if checks:
            detail.append('<h4>数据一致性检查</h4><ul class="checks">' + "".join('<li><span class="badge ' + check_status(c)[1] + '">' + check_status(c)[0] + '</span><strong>' + esc(c.get("name", "检查")) + '</strong><span>' + esc(c.get("detail", "")) + '</span></li>' for c in checks) + '</ul>')
        detail.append('</article>')
        sections.append("".join(detail))
        body = [f"### {index}. {name}", "", str(item.get("description", "未记录场景描述")), "", timing_note, "", f"HTTP 状态分布：{status_counts(stats.get('statusCounts'))}", ""]
        if details_rows:
            body += ["分类型明细可包含SSE事件样本；样本数不能直接相加当作HTTP请求数。", md_table(detail_headers, details_rows), ""]
        if sse:
            body += [md_table(["指标", "p50", "p95", "p99", "最大", "均值"], [["通知延迟", *quantile_row(sse.get("notificationLatencyMs"))], ["自动补查延迟（非浏览器绘制）", *quantile_row(sse.get("visibleLatencyMs"))]]), ""]
        body += [f"- {check_status(c)[0]}：{c.get('name','检查')}。{c.get('detail','')}" for c in checks]
        md_sections.append("\n".join(body))
    css = """
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#223b31;background:#f3f5ef;font-synthesis:none;line-height:1.65}*{box-sizing:border-box}body{margin:0}a{color:#206b5a;text-underline-offset:3px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}main{max-width:1440px;margin:auto;padding:48px 40px 64px}.eyebrow{letter-spacing:.2em;font-size:11px;color:#68806b;margin:0 0 12px}h1{font-size:clamp(28px,4vw,44px);line-height:1.2;margin:0 0 14px;font-weight:700;letter-spacing:-.03em}h2{font-size:22px;margin:0 0 18px}h3{font-size:17px;margin:0 0 12px}h4{font-size:14px;margin:18px 0 8px}.lead{max-width:1000px;color:#586d5e;margin:0 0 22px}.run-id{font-size:12px;color:#6e7f70;overflow-wrap:anywhere}.banner{padding:14px 18px;border:1px solid #cbdcc9;background:#e8efe2;border-radius:10px;color:#38563d;margin:24px 0}.banner.fail{background:#fff0e8;border-color:#e5c4b4;color:#8e492e}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0 34px}.card{background:white;border:1px solid #dce4d8;border-radius:12px;padding:22px}.card span{display:block;font-size:12px;color:#72816e}.card strong{display:block;font-size:32px;line-height:1.35;letter-spacing:-.03em;margin:8px 0 2px}.card small{color:#87917e;font-size:11px}.panel,.scenario{background:white;border:1px solid #dce4d8;border-radius:12px;padding:26px;margin:20px 0}.muted{font-size:12px;color:#788573}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}th{text-align:left;color:#62735f;background:#f5f7f0;font-weight:600;padding:10px 12px}td{padding:12px;border-bottom:1px solid #e8ece3;vertical-align:top}td:first-child{font-weight:600;color:#36553f}tr:last-child td{border-bottom:none}.environment td:last-child{white-space:normal;overflow-wrap:anywhere}.environment td:first-child{width:230px}.charts{display:grid;grid-template-columns:1fr 1fr;gap:20px}.chart{background:white;padding:24px;border:1px solid #dce4d8;border-radius:12px;min-width:0}.chart.wide{grid-column:1/-1}.chart svg{width:100%;display:block;overflow:visible}.bar-row{display:grid;grid-template-columns:minmax(140px,1fr) minmax(80px,1.2fr) auto;gap:12px;align-items:center;margin:14px 0;font-size:12px}.bar-label{overflow-wrap:anywhere}.bar-label small{display:block;font-size:10px;color:#82907e}.bar-track{height:9px;background:#edf1e8;border-radius:6px;overflow:hidden}.bar{height:100%;border-radius:6px;min-width:0}.bar-row strong{font-size:11px;text-align:right;min-width:70px}.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11px;color:#71806c}.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.section-title{display:flex;align-items:center;gap:12px}.section-title h3{margin:0}.index{color:#a6b394;font-size:24px;font-weight:600}.scenario>p{font-size:13px;color:#62725f}.checks{list-style:none;padding:0;margin:10px 0}.checks li{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid #edf0e8;font-size:12px}.checks li>span:last-child{color:#75816d}.badge{font-size:10px;padding:2px 7px;border-radius:4px;white-space:nowrap}.pass{background:#e9f2df;color:#476b36}.fail{background:#fce5db;color:#a34d2c}.unknown{background:#edf0e8;color:#79806f}.notes{font-size:13px;color:#687961;padding-left:21px}.notes li{margin:8px 0}footer{margin-top:34px;padding-top:18px;border-top:1px solid #dce4d8;color:#7a8872;font-size:11px}.config{white-space:pre-wrap;font-size:12px;color:#5c715b;background:#f5f7f0;border-radius:8px;padding:16px;overflow:auto}@media(max-width:850px){main{padding:28px 18px}.cards{grid-template-columns:repeat(2,1fr)}.charts{grid-template-columns:1fr}.panel,.scenario,.chart{padding:18px}.bar-row{grid-template-columns:minmax(120px,1fr) minmax(55px,1fr) auto;gap:8px}.environment td:first-child{width:auto}}@media print{body{background:white}main{padding:15px;max-width:none}.panel,.scenario,.chart,.card{break-inside:avoid}.table-scroll{overflow:visible}table{white-space:normal;font-size:10px}.cards{grid-template-columns:repeat(4,1fr)}a{color:inherit}h1{font-size:30px}}
"""
    document = (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>审图台 · 压力测试报告 ' + esc(run_id) + '</title><style>' + css + '</style></head><body><main>'
        '<p class="eyebrow">REVIEW DESK / LOAD TEST</p><h1>压力测试实测报告</h1><p class="lead">' + esc(intro) + '</p>'
        '<p class="run-id">运行编号 ' + esc(run_id) + ' · ' + esc(started) + '</p>'
        '<div class="banner' + (' fail' if check_failures or fatal else '') + '"><strong>' + esc(overall_label) + '</strong> · 通过 ' + str(check_passes) + ' 项，未通过 ' + str(check_failures) + ' 项。速度与正确性请分别查看。</div>'
        '<div class="cards">'
        + ''.join('<div class="card"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><small>' + esc(note) + '</small></div>' for label, value, note in [
            ("测量 HTTP 请求数", fmt(total, 0), "不包含SSE消息"),
            ("成功请求数", fmt(good, 0), "以脚本记录的成功定义为准"),
            ("HTTP 非2xx率", percent(weighted_error), "含预期业务拒绝，须查看状态分布"),
            ("服务峰值 RSS", bytes_text(peak_rss), "采样峰值，非整台机器内存"),
        ])
        + '</div><section class="panel"><h2>先看结论与口径</h2><ul class="notes">' + ''.join('<li>'+esc(v)+'</li>' for v in summary_notes) + '</ul></section><section class="panel"><h2>测试环境与参数</h2>' + table(["字段", "记录"], env_rows, "environment")
        + '<h4>原始运行参数</h4><pre class="config">' + esc(json.dumps(config, ensure_ascii=False, indent=2)) + '</pre></section>'
        + '<section class="panel"><h2>这些数量分别代表什么</h2>' + table(["术语", "本报告中的含义"], role_rows, "environment") + '</section>'
        + '<section class="panel"><h2>HTTP 测量结果</h2><p class="muted">并发参数按压测脚本场景记录。耗时是请求完成耗时，不等于服务器独占处理时间。</p>' + table(http_headers, http_rows) + '<h4>怎样读这些数值</h4>' + table(["指标", "含义"], metric_rows, "environment") + '</section>'
        + '<div class="charts">' + latency_plot(scenarios)
        + bar_chart(scenarios, ("http", "latencyMs", "p95"), "各场景 HTTP p95 耗时", " ms", "#206b5a")
        + bar_chart(scenarios, ("http", "rps"), "各场景实际 HTTP 吞吐", " req/s", "#ad7c48") + '</div>'
        + ('<section class="panel"><h2>实时通知与自动补查</h2><p class="muted">通知延迟与补查完成延迟为两项独立指标；自动补查完成不等于浏览器绘制完成。</p>' + table(sse_headers, sse_rows) + '</section>' if sse_rows else '')
        + '<section class="panel"><h2>服务资源与传输量</h2><p class="muted">CPU 100%约为一个逻辑核的用量，不是整台机器占满。采样窗口可能跨阶段，极短阶段可能无样本；峰值可能低于瞬时峰值。请求/响应字节按脚本统计口径。</p>' + table(resource_headers, resource_rows) + '</section>'
        + ('<section class="panel"><h2>运行中断记录</h2><pre class="config">' + esc(json.dumps(fatal, ensure_ascii=False, indent=2)) + '</pre></section>' if fatal else '')
        + '<section><h2>逐场景细节与一致性</h2>' + ''.join(sections) + '</section>'
        + ('<section class="panel"><h2>全局检查</h2><ul class="checks">' + ''.join('<li><span class="badge ' + check_status(c)[1] + '">' + check_status(c)[0] + '</span><strong>' + esc(c.get("name", "检查")) + '</strong><span>' + esc(c.get("detail", "")) + '</span></li>' for c in global_checks) + '</ul></section>' if global_checks else '')
        + ('<section class="panel"><h2>测试数据库归档</h2>' + table(["指标", "记录"], database_rows, "environment") + '<p class="muted">文件大小为整库归档时总量；没有按表拆分体积或基线对照，不能直接归因于版本/收据。记录数展示本轮积累的历史规模。</p></section>' if database_rows else '')
        + '<section class="panel"><h2>原始数据与复现</h2><ul class="notes">' + links + '</ul><p class="muted">HTML由已保存summary.json渲染；未知字段不推测为0。报告本身无需联网，原始文件请连同本目录保留。</p></section>'
        + '<section class="panel"><h2>解释边界</h2><ul class="notes">' + ''.join('<li>' + esc(v) + '</li>' for v in limitations) + '</ul></section>'
        + '<footer>审图台 · 独立 HTML 报告 · 所有数值来自同目录 summary.json，可打印为PDF或离线查看。</footer></main></body></html>'
    )
    markdown = "\n\n".join([
        "# 审图台压力测试实测报告", intro, f"运行编号：`{run_id}`。开始：{started}；结束：{finished}。", f"**{overall_label}**。通过{check_passes}项，未通过{check_failures}项。",
        md_table(["指标", "结果"], [["测量HTTP请求数", fmt(total,0)], ["成功请求数", fmt(good,0)], ["加权HTTP非2xx率（含预期拒绝）", percent(weighted_error)], ["服务峰值RSS", bytes_text(peak_rss)]]),
        *( ["## 运行中断记录", "```json\n" + json.dumps(fatal, ensure_ascii=False, indent=2) + "\n```"] if fatal else []),
        "## 先看结论与口径", "\n".join("- "+v for v in summary_notes),
        "## 环境与参数", md_table(["字段", "记录"], env_rows), "```json\n" + json.dumps(config, ensure_ascii=False, indent=2) + "\n```",
        "## 指标口径", md_table(["术语", "含义"], role_rows),
        "## HTTP结果", md_table(http_headers, http_rows), "### 怎样读这些数值", md_table(["指标", "含义"], metric_rows),
        *( ["## 实时通知与自动补查", md_table(sse_headers, sse_rows), "自动补查延迟不含浏览器渲染。"] if sse_rows else []),
        "## 资源与传输量", md_table(resource_headers, resource_rows),
        "## 逐场景结果", *md_sections,
        *( ["## 全局检查", "\n".join(f"- {check_status(c)[0]}：{c.get('name','检查')}。{c.get('detail','')}" for c in global_checks)] if global_checks else []),
        *(["## 测试数据库归档", md_table(["指标", "记录"], database_rows), "文件大小是整库归档时总量；没有按表拆分或基线对照，不能直接归因于版本/收据；记录数反映历史规模。"] if database_rows else []),
        "## 原始数据", "\n".join(f"- [{md(label)}]({quote(name,safe='/.-_')})" for label,name in artifact_items),
        "## 解释边界", "\n".join("- " + v for v in limitations),
        "[离线HTML图表报告](report.html)。数值均来自同目录summary.json，未知字段不推测为0。",
    ]) + "\n"
    (source.parent / "report.html").write_text(document, encoding="utf-8")
    (source.parent / "report.md").write_text(markdown, encoding="utf-8")
    print(json.dumps({"html": str(source.parent / "report.html"), "markdown": str(source.parent / "report.md"), "scenarios": len(scenarios)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
