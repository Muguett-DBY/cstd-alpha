#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree


EVIDENCE_VERSION = "v1"
DEFAULT_MIN_SOURCES = 36
MAX_SELECTED_SOURCES = 128
MAX_GOOGLE_NEWS_SHARE = 0.5
MIN_STRUCTURED_SOURCES = 30
MIN_UNIQUE_SOURCES = 2

TOPIC_QUERIES = [
    ("半导体/AI算力", "存储芯片 DRAM NAND HBM AI 服务器 价格 库存", "hard_data"),
    ("战略有色金属", "铜 钨 稀土 锂 价格 库存 供需", "hard_data"),
    ("锂电储能", "碳酸锂 储能 电池 价格 库存 产能", "hard_data"),
    ("光伏产业链", "硅料 光伏组件 价格 产能 开工率", "hard_data"),
    ("生猪养殖", "猪价 能繁母猪 产能 去化 周期", "hard_data"),
    ("汽车/智能驾驶", "新能源汽车 销量 出口 智能驾驶 数据", "hard_data"),
    ("创新药/医疗服务", "创新药 审批 临床 商业化 业绩", "official"),
    ("电力电网/能源基础设施", "发电量 装机量 电网 特高压 数据中心 用电", "official"),
    ("钢铁水泥/地产链", "钢铁 水泥 价格 开工率 地产 需求", "hard_data"),
    ("航运物流", "航运 运价 CCFI SCFI BDI 供需", "hard_data"),
    ("消费出海", "家电 消费 出海 出口 品牌 业绩", "news"),
    ("机器人/AI应用", "人形机器人 具身智能 AI应用 订单 商业化", "news"),
    ("平稳现金流/高股息", "高股息 分红 经营现金流 公用事业 电信 水电", "announcement"),
]

SOURCE_WEIGHTS = {
    "hard_data": 5,
    "official": 4,
    "announcement": 4,
    "market": 3,
    "news": 2,
    "research": 1,
}

DATA_SIGNAL_WORDS = ("价格", "库存", "产能", "订单", "营收", "净利润", "毛利率", "现金流", "销量", "装机", "开工率", "同比", "环比")
RISK_SIGNAL_WORDS = ("泡沫", "过剩", "亏损", "下滑", "衰退", "库存高企", "停牌", "异动")


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect public evidence for the CSTD Alpha radar scan.")
    parser.add_argument("--output", default="radar-evidence.json", help="Path to write the JSON snapshot.")
    parser.add_argument("--gzip-output", default="", help="Optional path to write a gzip-compressed snapshot.")
    parser.add_argument("--offline-fixture", action="store_true", help="Generate deterministic fixture evidence without network calls.")
    parser.add_argument("--offline-google-only", action="store_true", help="Generate a bad all-news fixture and run the normal quality gate.")
    parser.add_argument("--min-sources", type=int, default=DEFAULT_MIN_SOURCES, help="Minimum source count required for a live snapshot.")
    args = parser.parse_args()

    raw_sources = google_only_fixture_sources() if args.offline_google_only else fixture_sources() if args.offline_fixture else collect_sources()
    sources = select_sources(dedupe_sources(classify_source(source) for source in raw_sources), limit=MAX_SELECTED_SOURCES)
    quality = evidence_quality(sources)
    print_quality_summary("selected", quality)
    validate_quality(quality, min_sources=args.min_sources)

    now = datetime.now(timezone.utc)
    snapshot = {
        "version": EVIDENCE_VERSION,
        "source": "github-actions-python",
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "asOfDate": now.date().isoformat(),
        "evidenceHash": evidence_hash(sources),
        "sourceCount": len(sources),
        "quality": quality,
        "sources": sources,
    }

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    if args.gzip_output:
        gzip_output = Path(args.gzip_output)
        gzip_output.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(gzip_output, "wt", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, separators=(",", ":"))

    print(f"wrote {len(sources)} radar evidence sources to {output}")
    return 0


def collect_sources() -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for label, fetcher in [
        ("eastmoney", fetch_eastmoney_boards),
        ("google_news", fetch_google_news),
        ("akshare", fetch_akshare),
        ("baostock", fetch_baostock),
    ]:
        fetched = fetcher()
        print_source_summary(label, fetched)
        sources.extend(fetched)
    return sources


def fetch_eastmoney_boards() -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    endpoints = [
        ("东方财富行业板块", "m:90+t:2"),
        ("东方财富概念板块", "m:90+t:3"),
    ]
    for label, fs in endpoints:
        query = {
            "pn": "1",
            "pz": "40",
            "po": "1",
            "np": "1",
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            "fltt": "2",
            "invt": "2",
            "fid": "f3",
            "fs": fs,
            "fields": "f12,f14,f3,f62,f128,f184",
        }
        try:
            data = read_json(f"https://push2.eastmoney.com/api/qt/clist/get?{urlencode(query)}")
        except (OSError, ValueError, URLError):
            continue
        for item in data.get("data", {}).get("diff", []) or []:
            name = clean_text(item.get("f14"))
            if not name:
                continue
            sources.append(
                {
                    "source": label,
                    "query": "东方财富板块/行业/概念数据",
                    "title": f"{name} 涨跌幅 {number_text(item.get('f3'))}%，主力净流入 {number_text(item.get('f62'))}",
                    "url": f"https://quote.eastmoney.com/bk/{clean_text(item.get('f12'))}.html",
                    "summary": f"领涨股 {clean_text(item.get('f128')) or '待验证'}，资金占比 {number_text(item.get('f184'))}。",
                    "sourceType": "market",
                    "weight": SOURCE_WEIGHTS["market"],
                }
            )
    return sources


def fetch_google_news() -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for topic, query, _source_type in TOPIC_QUERIES:
        url = f"https://news.google.com/rss/search?q={quote(query + ' when:365d')}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans"
        try:
            xml = read_text(url)
            root = ElementTree.fromstring(xml)
        except (OSError, ValueError, ElementTree.ParseError, URLError):
            continue
        for item in root.findall(".//item")[:10]:
            title = clean_text(item.findtext("title"))
            link = clean_text(item.findtext("link"))
            published = parse_rss_date(item.findtext("pubDate"))
            if not title or not link:
                continue
            sources.append(
                {
                    "source": "Google News",
                    "query": f"{topic} {query}",
                    "title": title,
                    "url": link,
                    "publishedAt": published,
                    "summary": "",
                    "sourceType": "news",
                    "weight": SOURCE_WEIGHTS["news"],
                }
            )
    return sources


def fetch_akshare() -> list[dict[str, Any]]:
    try:
        import akshare as ak  # type: ignore[import-not-found]
    except Exception:
        return []

    sources: list[dict[str, Any]] = []
    for func_name, label, query, source_type in [
        ("stock_board_industry_name_em", "AKShare 行业板块", "A股 行业板块 涨跌幅 成交额", "market"),
        ("stock_board_concept_name_em", "AKShare 概念板块", "A股 概念板块 涨跌幅 成交额", "market"),
        ("stock_zh_a_spot_em", "AKShare A股行情", "A股 实时行情 涨跌幅 成交额 换手率", "market"),
        ("stock_hk_spot_em", "AKShare 港股行情", "港股 实时行情 涨跌幅 成交额", "market"),
    ]:
        try:
            frame = getattr(ak, func_name)()
        except Exception as exc:
            print(f"collector_warning akshare.{func_name}: {type(exc).__name__}: {str(exc)[:180]}")
            continue
        sources.extend(frame_rows_to_sources(frame, label, query, source_type, limit=60))
    return sources


def fetch_baostock() -> list[dict[str, Any]]:
    try:
        import baostock as bs  # type: ignore[import-not-found]
    except Exception:
        return []

    sources: list[dict[str, Any]] = []
    try:
        login = bs.login()
        if getattr(login, "error_code", "0") not in ("0", 0):
            return []
        result = bs.query_stock_industry()
        rows = result.get_data()
        sources.extend(baostock_industry_sources(rows))
    except Exception as exc:
        print(f"collector_warning baostock.query_stock_industry: {type(exc).__name__}: {str(exc)[:180]}")
        return sources
    finally:
        try:
            bs.logout()
        except Exception:
            pass
    return sources


def baostock_industry_sources(frame: Any) -> list[dict[str, Any]]:
    try:
        rows = frame.to_dict("records")
    except Exception:
        return []
    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        industry = first_text(row, ("industry", "industryClassification", "行业", "所属行业"))
        code = first_text(row, ("code", "股票代码"))
        name = first_text(row, ("code_name", "股票名称", "名称"))
        if not industry:
            continue
        group = groups.setdefault(industry, {"count": 0, "samples": []})
        group["count"] += 1
        if name and len(group["samples"]) < 4:
            group["samples"].append(f"{name}({code})" if code else name)
    return [
        {
            "source": "BaoStock 行业分类",
            "query": "A股 行业分类 公司分布",
            "title": f"{industry} 覆盖 {group['count']} 家上市公司",
            "url": f"http://baostock.com/baostock/index.php/Python_API%E6%96%87%E6%A1%A3#{quote(industry)}",
            "summary": f"样本公司：{'、'.join(group['samples']) or '待验证'}。",
            "sourceType": "official",
            "weight": SOURCE_WEIGHTS["official"],
        }
        for industry, group in sorted(groups.items(), key=lambda item: item[1]["count"], reverse=True)
    ][:40]


def frame_rows_to_sources(frame: Any, label: str, query: str, source_type: str, limit: int) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    try:
        rows = frame.head(limit).to_dict("records")
    except Exception:
        return sources
    for row in rows:
        title = first_text(row, ("板块名称", "名称", "industry", "industryClassification", "code_name", "股票名称"))
        code = first_text(row, ("板块代码", "代码", "code", "股票代码"))
        change = first_text(row, ("涨跌幅", "最新涨跌幅", "change", "涨幅"))
        amount = first_text(row, ("成交额", "总市值", "market_value", "换手率"))
        if not title:
            continue
        sources.append(
            {
                "source": label,
                "query": query,
                "title": f"{title} {('涨跌幅 ' + change) if change else ''}".strip(),
                "url": f"https://quote.eastmoney.com/bk/{code}.html" if code else "",
                "summary": f"{label}结构化数据，{('补充指标 ' + amount) if amount else '用于覆盖面验证'}。",
                "sourceType": source_type,
                "weight": SOURCE_WEIGHTS.get(source_type, 2),
            }
        )
    return sources


def fixture_sources() -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for index in range(90):
        topic, query, _source_type = TOPIC_QUERIES[index % len(TOPIC_QUERIES)]
        sources.append(
            {
                "source": "Google News",
                "query": query,
                "title": f"{topic} 新闻线索 {index + 1}：价格、库存或订单指标被新闻提及",
                "url": f"https://news.example.com/radar-evidence/{index + 1}",
                "publishedAt": "2026-05-19T00:00:00Z",
                "summary": f"{topic} 新闻线索仅用于发现方向，不可直接当作硬数据。",
                "sourceType": "hard_data",
                "weight": SOURCE_WEIGHTS["hard_data"],
            }
        )
    for index in range(45):
        topic, query, source_type = TOPIC_QUERIES[index % len(TOPIC_QUERIES)]
        sources.append(
            {
                "source": "东方财富行业板块",
                "query": query,
                "title": f"{topic} 第{index + 1}条结构化证据：涨跌幅、成交额和资金流更新",
                "url": f"https://quote.eastmoney.com/bk/offline-{index + 1}.html",
                "publishedAt": "2026-05-19T00:00:00Z",
                "summary": f"{topic} 方向用于验证证据归一化、去重、评分和覆盖面。",
                "sourceType": "market" if index % 2 else source_type,
                "weight": SOURCE_WEIGHTS.get("market" if index % 2 else source_type, 3),
            }
        )
    for index in range(35):
        topic, query, _source_type = TOPIC_QUERIES[index % len(TOPIC_QUERIES)]
        sources.append(
            {
                "source": "BaoStock 行业分类",
                "query": query,
                "title": f"{topic} 行业分类覆盖 {20 + index} 家上市公司",
                "url": f"https://baostock.example.com/radar-evidence/{index + 1}",
                "publishedAt": "2026-05-19T00:00:00Z",
                "summary": f"{topic} 结构化行业分类样本。",
                "sourceType": "official",
                "weight": SOURCE_WEIGHTS["official"],
            }
        )
    for index in range(35):
        topic, query, _source_type = TOPIC_QUERIES[index % len(TOPIC_QUERIES)]
        sources.append(
            {
                "source": "AKShare 行业板块",
                "query": query,
                "title": f"{topic} AKShare 板块证据 {index + 1}：涨跌幅和成交额更新",
                "url": f"https://akshare.example.com/radar-evidence/{index + 1}",
                "publishedAt": "2026-05-19T00:00:00Z",
                "summary": f"{topic} 结构化板块行情样本。",
                "sourceType": "market",
                "weight": SOURCE_WEIGHTS["market"],
            }
        )
    return sources


def google_only_fixture_sources() -> list[dict[str, Any]]:
    return [
        {
            "source": "Google News",
            "query": TOPIC_QUERIES[index % len(TOPIC_QUERIES)][1],
            "title": f"纯新闻来源 {index + 1}：价格和库存被新闻提及",
            "url": f"https://news.example.com/google-only/{index + 1}",
            "publishedAt": "2026-05-19T00:00:00Z",
            "sourceType": "hard_data",
            "weight": SOURCE_WEIGHTS["hard_data"],
        }
        for index in range(90)
    ]


def classify_source(source: dict[str, Any]) -> dict[str, Any]:
    raw_source = clean_text(source.get("source"))
    source_type = "news" if raw_source == "Google News" else source.get("sourceType") or infer_source_type(source)
    weight = SOURCE_WEIGHTS["news"] if raw_source == "Google News" else int(source.get("weight") or SOURCE_WEIGHTS.get(source_type, 2))
    item = {
        "source": raw_source,
        "query": clean_text(source.get("query")),
        "title": clean_text(source.get("title")),
        "url": clean_text(source.get("url")),
        "publishedAt": clean_text(source.get("publishedAt")),
        "summary": clean_text(source.get("summary")),
        "sourceType": source_type,
        "weight": weight,
    }
    item["score"] = score_source(item)
    return {key: value for key, value in item.items() if value not in ("", None)}


def infer_source_type(source: dict[str, Any]) -> str:
    text = " ".join(clean_text(source.get(key)) for key in ("source", "query", "title", "summary"))
    if any(word in text for word in DATA_SIGNAL_WORDS):
        return "hard_data"
    if any(word in text for word in ("统计局", "协会", "工信部", "海关", "发改委", "中汽协", "乘联会", "药监局")):
        return "official"
    if any(word in text for word in ("公告", "财报", "年报", "季报", "业绩预告")):
        return "announcement"
    if any(word in text for word in ("板块", "概念", "资金流", "涨跌幅", "成交额")):
        return "market"
    if any(word in text for word in ("研报", "券商", "评级")):
        return "research"
    return "news"


def score_source(source: dict[str, Any]) -> int:
    text = " ".join(clean_text(source.get(key)) for key in ("source", "query", "title", "summary"))
    is_google_news = source.get("source") == "Google News"
    data_signal = 0 if is_google_news else 8 if any(word in text for word in DATA_SIGNAL_WORDS) else 0
    risk_signal = 4 if any(word in text for word in RISK_SIGNAL_WORDS) else 0
    return int(source.get("weight", 2)) * 10 + data_signal + risk_signal


def dedupe_sources(items: Any) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for item in items:
        if not item.get("source") or not item.get("query") or not item.get("title"):
            continue
        key = item.get("url") or f"{item.get('source')}|{item.get('title')}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def select_sources(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    sorted_items = sorted(items, key=lambda item: item["score"], reverse=True)
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    max_google_news = max(1, int(limit * MAX_GOOGLE_NEWS_SHARE))
    minimum_by_type = {
        "hard_data": 24,
        "official": 18,
        "announcement": 8,
        "market": 28,
        "research": 6,
    }
    for source_type, minimum in minimum_by_type.items():
        for item in [source for source in sorted_items if source.get("source") != "Google News" and source.get("sourceType") == source_type][:minimum]:
            add_selected(item, selected, seen, limit, max_google_news)
    for item in sorted_items:
        if item.get("source") != "Google News":
            add_selected(item, selected, seen, limit, max_google_news)
    max_google_news = min(max_google_news, len(selected))
    for item in sorted_items:
        if item.get("source") == "Google News":
            add_selected(item, selected, seen, limit, max_google_news)
    return selected


def add_selected(item: dict[str, Any], selected: list[dict[str, Any]], seen: set[str], limit: int, max_google_news: int) -> None:
    if len(selected) >= limit:
        return
    if item.get("source") == "Google News" and count_where(selected, lambda source: source.get("source") == "Google News") >= max_google_news:
        return
    key = item.get("url") or f"{item.get('source')}|{item.get('title')}"
    if key in seen:
        return
    seen.add(key)
    selected.append(item)


def validate_quality(quality: dict[str, Any], min_sources: int) -> None:
    failures: list[str] = []
    if quality["sourceCount"] < min_sources:
        failures.append(f"sourceCount {quality['sourceCount']}/{min_sources}")
    if quality["uniqueSources"] < MIN_UNIQUE_SOURCES:
        failures.append(f"uniqueSources {quality['uniqueSources']}/{MIN_UNIQUE_SOURCES}")
    if quality["googleNewsShare"] > MAX_GOOGLE_NEWS_SHARE:
        failures.append(f"googleNewsShare {quality['googleNewsShare']:.2f}/{MAX_GOOGLE_NEWS_SHARE:.2f}")
    if quality["structuredCount"] < MIN_STRUCTURED_SOURCES:
        failures.append(f"structuredCount {quality['structuredCount']}/{MIN_STRUCTURED_SOURCES}")
    if failures:
        raise SystemExit(f"insufficient evidence quality: {', '.join(failures)}")


def evidence_quality(sources: list[dict[str, Any]]) -> dict[str, Any]:
    source_count = len(sources)
    by_source = count_by(sources, "source")
    by_type = count_by(sources, "sourceType")
    google_count = by_source.get("Google News", 0)
    structured_count = count_where(sources, lambda source: source.get("source") != "Google News" and source.get("sourceType") != "news")
    return {
        "sourceCount": source_count,
        "uniqueSources": len(by_source),
        "googleNewsCount": google_count,
        "googleNewsShare": round(google_count / source_count, 4) if source_count else 0,
        "structuredCount": structured_count,
        "structuredShare": round(structured_count / source_count, 4) if source_count else 0,
        "bySource": by_source,
        "byType": by_type,
    }


def print_source_summary(label: str, sources: list[dict[str, Any]]) -> None:
    print(f"collector_source {label}: {json.dumps({'count': len(sources), 'bySource': count_by(sources, 'source'), 'byType': count_by(sources, 'sourceType')}, ensure_ascii=False, sort_keys=True)}")


def print_quality_summary(label: str, quality: dict[str, Any]) -> None:
    print(f"collector_quality {label}: {json.dumps(quality, ensure_ascii=False, sort_keys=True)}")


def count_by(sources: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for source in sources:
        value = clean_text(source.get(key)) or "unknown"
        counts[value] = counts.get(value, 0) + 1
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


def count_where(sources: list[dict[str, Any]], predicate: Any) -> int:
    return sum(1 for source in sources if predicate(source))


def evidence_hash(sources: list[dict[str, Any]]) -> str:
    payload = "\n".join(
        sorted(f"{item.get('url', '')}|{item.get('title', '')}|{item.get('source', '')}|{item.get('query', '')}|{item.get('publishedAt', '')}" for item in sources)
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def read_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; CSTDAlphaEvidenceBot/1.0; +https://alpha.custard.top)"})
    with urlopen(request, timeout=20) as response:
        return response.read().decode("utf-8", errors="ignore")


def read_json(url: str) -> dict[str, Any]:
    return json.loads(read_text(url))


def parse_rss_date(value: str | None) -> str:
    if not value:
        return ""
    try:
        from email.utils import parsedate_to_datetime

        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return ""


def first_text(row: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = clean_text(row.get(key))
        if value:
            return value
    return ""


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\n", " ").replace("\r", " ").split())


def number_text(value: Any) -> str:
    if isinstance(value, (int, float)):
        return f"{value:,.2f}"
    return clean_text(value) or "待验证"


if __name__ == "__main__":
    sys.exit(main())
