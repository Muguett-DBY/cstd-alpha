#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree


EVIDENCE_VERSION = "v1"
DEFAULT_MIN_SOURCES = 36
MAX_SELECTED_SOURCES = 320
MAX_GOOGLE_NEWS_SHARE = 0.35
MAX_SINGLE_SOURCE_SHARE = 0.38
MIN_GOOGLE_NEWS_SOURCES = 18
MIN_STRUCTURED_SOURCES = 80
MIN_UNIQUE_SOURCES = 3
MAX_DYNAMIC_COMPANY_CANDIDATES = int(os.environ.get("RADAR_DYNAMIC_COMPANY_CANDIDATES", "160"))
MAX_DYNAMIC_COMPANY_FINANCIALS = int(os.environ.get("RADAR_DYNAMIC_COMPANY_FINANCIALS", "90"))
EASTMONEY_COMPANY_CHUNK_SIZE = 25
ANYSEARCH_API_URL = "https://api.anysearch.com/v1/search"
ANYSEARCH_MAX_QUERIES = int(os.environ.get("ANYSEARCH_MAX_QUERIES", "360"))
ANYSEARCH_RESULTS_PER_QUERY = int(os.environ.get("ANYSEARCH_RESULTS_PER_QUERY", "2"))
ANYSEARCH_CONCURRENCY = max(1, int(os.environ.get("ANYSEARCH_CONCURRENCY", "10")))
SEARXNG_ENDPOINTS = [endpoint.strip().rstrip("/") for endpoint in re.split(r"[\n,]", os.environ.get("SEARXNG_ENDPOINTS", "")) if endpoint.strip().startswith(("http://", "https://"))]
SEARXNG_MAX_QUERIES = int(os.environ.get("SEARXNG_MAX_QUERIES", "120"))
SEARXNG_CONCURRENCY = max(1, int(os.environ.get("SEARXNG_CONCURRENCY", "6")))
TUSHARE_API_URL = "https://api.tushare.pro"
TUSHARE_MAX_COMPANIES = int(os.environ.get("TUSHARE_MAX_COMPANIES", "1"))
TUSHARE_BATCH_ENABLED = os.environ.get("TUSHARE_BATCH_ENABLED", "1") != "0"
TUSHARE_COMPANY_FALLBACK_ENABLED = os.environ.get("TUSHARE_COMPANY_FALLBACK_ENABLED", "0") == "1"
TUSHARE_BATCH_MAX_ROWS = int(os.environ.get("TUSHARE_BATCH_MAX_ROWS", "120"))
TUSHARE_ENDPOINTS = [
    ("disclosure_date", "announcement", "financial_metric", "ts_code,end_date,ann_date,pre_date,actual_date,modify_date", "ts_code"),
    ("daily_basic", "market", "valuation_metric", "ts_code,trade_date,pe_ttm,pb,total_mv,circ_mv,turnover_rate", "date_range"),
    ("income", "announcement", "financial_metric", "ts_code,end_date,ann_date,revenue,n_income_attr_p,total_profit,basic_eps", "period"),
    ("cashflow", "announcement", "financial_metric", "ts_code,end_date,ann_date,n_cashflow_act,c_free_cashflow", "period"),
    ("fina_indicator", "announcement", "financial_metric", "ts_code,end_date,ann_date,grossprofit_margin,netprofit_margin,roe,roa,debt_to_assets,ocfps", "period"),
    ("dividend", "announcement", "financial_metric", "ts_code,end_date,ann_date,cash_div,cash_div_tax,div_proc", "ts_code"),
    ("anns_d", "announcement", "financial_metric", "ts_code,ann_date,title", "date_range"),
]
TUSHARE_BATCH_ENDPOINTS = [
    ("daily_basic", "market", "valuation_metric", "ts_code,trade_date,pe_ttm,pb,total_mv,circ_mv,turnover_rate", "trade_date"),
    ("income", "announcement", "financial_metric", "ts_code,end_date,ann_date,revenue,n_income_attr_p,total_profit,basic_eps", "period"),
    ("cashflow", "announcement", "financial_metric", "ts_code,end_date,ann_date,n_cashflow_act,c_free_cashflow", "period"),
    ("fina_indicator", "announcement", "financial_metric", "ts_code,end_date,ann_date,grossprofit_margin,netprofit_margin,roe,roa,debt_to_assets,ocfps", "period"),
    ("dividend", "announcement", "financial_metric", "ts_code,end_date,ann_date,cash_div,cash_div_tax,div_proc", "empty"),
    ("anns_d", "announcement", "financial_metric", "ts_code,ann_date,title", "date_range"),
]

ANYSEARCH_EVIDENCE_PROFILES = [
    {
        "profile": "industry_data",
        "terms": "价格 库存 产能 销量 开工率 运价 装机 出口 同比 环比",
        "sourceType": "news",
        "domains": ("finance", "business"),
        "contentTypes": ("data", "news", "web"),
        "freshness": "week",
        "tags": ("finance.market", "business.industry"),
    },
    {
        "profile": "announcement",
        "terms": "财报 业绩预告 业绩快报 经营现金流 毛利率 净利润 营收 订单",
        "sourceType": "news",
        "domains": ("finance", "business"),
        "contentTypes": ("doc", "data", "news", "web"),
        "freshness": "month",
        "tags": ("finance.company", "business.company"),
    },
    {
        "profile": "policy",
        "terms": "政策 监管 文件 出口管制 集采 补贴 审批 核准",
        "sourceType": "news",
        "domains": ("business", "legal"),
        "contentTypes": ("doc", "news", "web"),
        "freshness": "month",
        "tags": ("legal.regulation", "business.policy"),
    },
    {
        "profile": "risk",
        "terms": "亏损 过剩 停牌 异动 需求下滑 库存高企 价格下跌 减值",
        "sourceType": "news",
        "domains": ("finance", "business"),
        "contentTypes": ("news", "web", "doc"),
        "freshness": "week",
        "tags": ("finance.risk", "business.news"),
    },
]

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

FINE_INDUSTRY_TAXONOMY = [
    {"group": "高景气成长", "industry": "半导体/AI算力", "keywords": ("半导体", "芯片", "存储", "HBM", "算力", "服务器", "数据中心", "光模块", "PCB", "CPO")},
    {"group": "高景气成长", "industry": "半导体设备/材料", "keywords": ("半导体设备", "光刻", "刻蚀", "薄膜", "测试设备", "硅片", "电子特气", "光刻胶")},
    {"group": "高景气成长", "industry": "AI应用/软件", "keywords": ("AI应用", "人工智能", "大模型", "软件", "工业软件", "办公软件", "云计算")},
    {"group": "高景气成长", "industry": "机器人/具身智能", "keywords": ("机器人", "人形机器人", "具身智能", "减速器", "伺服", "传感器")},
    {"group": "高景气成长", "industry": "创新药/医疗服务", "keywords": ("创新药", "医药", "医疗", "CXO", "药", "研发服务", "商业化", "临床", "药监")},
    {"group": "高景气成长", "industry": "电力电网/能源基础设施", "keywords": ("电力", "电网", "特高压", "变压器", "储能电站", "发电量", "装机")},
    {"group": "高景气成长", "industry": "军工/航空航天", "keywords": ("军工", "航空", "航天", "导弹", "卫星", "商业航天", "低空经济")},
    {"group": "高景气成长", "industry": "新材料", "keywords": ("新材料", "碳纤维", "膜材料", "合成生物", "高分子", "陶瓷材料")},
    {"group": "高景气成长", "industry": "新能源汽车/智能驾驶", "keywords": ("新能源汽车", "新能源车", "智能驾驶", "乘用车", "汽车出口", "车企", "销量")},
    {"group": "高景气成长", "industry": "消费电子/端侧AI", "keywords": ("消费电子", "端侧AI", "手机", "可穿戴", "AR", "VR", "MR")},
    {"group": "周期品", "industry": "战略有色金属", "keywords": ("有色", "铜", "钨", "稀土", "小金属", "黄金", "铝", "锂", "镍", "钴")},
    {"group": "周期品", "industry": "锂电储能", "keywords": ("锂电", "电池", "储能", "碳酸锂", "磷酸铁锂", "固态电池")},
    {"group": "周期品", "industry": "钢铁", "keywords": ("钢铁", "螺纹钢", "热卷", "铁矿石", "焦煤", "焦炭")},
    {"group": "周期品", "industry": "水泥/建材", "keywords": ("水泥", "建材", "玻璃", "防水", "石膏板")},
    {"group": "周期品", "industry": "基础化工", "keywords": ("化工", "MDI", "纯碱", "烧碱", "尿素", "农药", "化纤", "钛白粉")},
    {"group": "周期品", "industry": "煤炭", "keywords": ("煤炭", "动力煤", "焦煤", "煤价")},
    {"group": "周期品", "industry": "石油石化", "keywords": ("石油", "石化", "原油", "炼化", "油服")},
    {"group": "周期品", "industry": "航运物流", "keywords": ("航运", "港口", "物流", "BDI", "CCFI", "SCFI", "集运", "运价")},
    {"group": "周期品", "industry": "生猪养殖", "keywords": ("猪", "生猪", "养殖", "畜牧", "能繁母猪", "猪价")},
    {"group": "周期品", "industry": "种植/农产品", "keywords": ("农业", "种植", "种业", "玉米", "大豆", "小麦", "白糖")},
    {"group": "过剩/衰退", "industry": "光伏产业链", "keywords": ("光伏", "硅料", "硅片", "组件", "逆变器", "TOPCon", "BC电池", "多晶硅", "工业硅")},
    {"group": "过剩/衰退", "industry": "地产链", "keywords": ("地产", "房地产", "竣工", "新开工", "家居", "物业")},
    {"group": "过剩/衰退", "industry": "传统消费", "keywords": ("食品饮料", "白酒", "乳制品", "啤酒", "调味品", "服装", "零售")},
    {"group": "过剩/衰退", "industry": "传统燃油车/零部件", "keywords": ("燃油车", "汽车零部件", "经销商", "乘用车")},
    {"group": "稳定现金流", "industry": "电力/水电", "keywords": ("水电", "火电", "核电", "绿电", "公用事业", "发电")},
    {"group": "稳定现金流", "industry": "电信运营", "keywords": ("电信", "运营商", "移动", "联通", "电信运营")},
    {"group": "稳定现金流", "industry": "燃气/环保", "keywords": ("燃气", "环保", "水务", "固废")},
    {"group": "稳定现金流", "industry": "高速公路/铁路", "keywords": ("高速公路", "铁路", "收费公路")},
    {"group": "稳定现金流", "industry": "银行", "keywords": ("银行", "息差", "不良率", "拨备")},
    {"group": "稳定现金流", "industry": "保险/券商", "keywords": ("保险", "券商", "证券", "资管")},
    {"group": "消费服务", "industry": "家电/消费出海", "keywords": ("家电", "消费出海", "品牌出海", "跨境", "出口")},
    {"group": "消费服务", "industry": "旅游/酒店/免税", "keywords": ("旅游", "酒店", "免税", "景区", "出行")},
    {"group": "消费服务", "industry": "传媒/游戏/互联网", "keywords": ("传媒", "游戏", "互联网", "广告", "短剧")},
    {"group": "制造业", "industry": "机械设备", "keywords": ("机械", "机床", "工程机械", "叉车", "注塑机")},
    {"group": "制造业", "industry": "通用自动化", "keywords": ("自动化", "工控", "PLC", "伺服", "工业机器人")},
    {"group": "制造业", "industry": "仪器仪表/检测", "keywords": ("仪器", "检测", "计量", "传感器")},
    {"group": "制造业", "industry": "轻工包装/造纸", "keywords": ("包装", "造纸", "轻工", "纸浆")},
    {"group": "医药健康", "industry": "医疗器械", "keywords": ("医疗器械", "设备", "耗材", "IVD")},
    {"group": "医药健康", "industry": "中药/消费医疗", "keywords": ("中药", "消费医疗", "眼科", "牙科", "医美")},
    {"group": "交通运输", "industry": "航空机场", "keywords": ("航空", "机场", "客座率", "航班")},
    {"group": "交通运输", "industry": "快递/供应链", "keywords": ("快递", "供应链", "物流", "仓储")},
]
FINE_INDUSTRY_TAXONOMY.extend(
    [
        {"group": "科技成长", "industry": "存储芯片", "keywords": ("存储", "DRAM", "NAND", "HBM", "内存", "闪存"), "themes": ("HBM存储", "存储涨价", "AI服务器")},
        {"group": "科技成长", "industry": "AI算力芯片", "keywords": ("AI芯片", "GPU", "ASIC", "推理芯片", "算力芯片"), "themes": ("国产算力", "AI服务器", "推理芯片")},
        {"group": "科技成长", "industry": "光模块/CPO", "keywords": ("光模块", "CPO", "800G", "1.6T", "光通信"), "themes": ("光模块升级", "AI数据中心")},
        {"group": "科技成长", "industry": "PCB/服务器链", "keywords": ("PCB", "覆铜板", "服务器", "交换机", "高速铜缆"), "themes": ("AI服务器", "高速互联")},
        {"group": "科技成长", "industry": "晶圆代工/封测", "keywords": ("晶圆代工", "封测", "先进封装", "Chiplet"), "themes": ("先进封装", "国产替代")},
        {"group": "科技成长", "industry": "港股互联网平台", "keywords": ("港股互联网", "平台经济", "回购", "广告", "电商", "腾讯", "阿里", "美团"), "themes": ("港股互联网回购", "平台经济修复")},
        {"group": "科技成长", "industry": "港股电讯", "keywords": ("港股电讯", "运营商", "中移动", "中电信", "中联通", "派息"), "themes": ("高股息央企", "港股电讯")},
        {"group": "高端制造", "industry": "低空经济", "keywords": ("低空经济", "eVTOL", "无人机", "飞行汽车"), "themes": ("低空经济", "商业化落地")},
        {"group": "高端制造", "industry": "商业航天", "keywords": ("商业航天", "卫星", "火箭", "星链", "卫星互联网"), "themes": ("商业航天", "卫星互联网")},
        {"group": "高端制造", "industry": "工程机械", "keywords": ("工程机械", "挖掘机", "叉车", "起重机", "海外收入"), "themes": ("制造业出海", "设备更新")},
        {"group": "高端制造", "industry": "工业母机/机床", "keywords": ("工业母机", "机床", "数控", "刀具", "五轴"), "themes": ("国产替代", "设备更新")},
        {"group": "高端制造", "industry": "船舶制造", "keywords": ("船舶", "造船", "手持订单", "新船价格", "船厂"), "themes": ("船舶周期", "订单交付")},
        {"group": "新能源", "industry": "光伏硅料", "keywords": ("硅料", "多晶硅", "工业硅", "硅料价格"), "themes": ("光伏出清", "硅料价格")},
        {"group": "新能源", "industry": "光伏组件", "keywords": ("组件", "电池片", "TOPCon", "BC电池", "组件价格"), "themes": ("光伏出清", "技术迭代")},
        {"group": "新能源", "industry": "逆变器", "keywords": ("逆变器", "户储", "组串式", "微逆"), "themes": ("储能出海", "逆变器库存")},
        {"group": "新能源", "industry": "风电", "keywords": ("风电", "海风", "陆风", "风机", "海缆"), "themes": ("海风开工", "装机复苏")},
        {"group": "新能源", "industry": "锂矿/锂盐", "keywords": ("锂矿", "锂盐", "碳酸锂", "氢氧化锂"), "themes": ("锂价反弹", "库存变化")},
        {"group": "新能源", "industry": "锂电池/材料", "keywords": ("锂电池", "正极", "负极", "隔膜", "电解液"), "themes": ("储能需求", "产能过剩")},
        {"group": "新能源", "industry": "固态/钠电池", "keywords": ("固态电池", "钠电池", "半固态", "硫化物"), "themes": ("固态电池", "技术突破")},
        {"group": "新能源", "industry": "电网设备", "keywords": ("电网设备", "特高压", "变压器", "电表", "配网"), "themes": ("电网投资", "AI用电")},
        {"group": "医药医疗", "industry": "港股创新药", "keywords": ("港股创新药", "license out", "出海", "临床", "药明", "百济"), "themes": ("创新药出海", "BD交易")},
        {"group": "医药医疗", "industry": "CXO", "keywords": ("CXO", "CDMO", "CRO", "订单", "投融资"), "themes": ("医药投融资", "订单恢复")},
        {"group": "医药医疗", "industry": "医药商业/药店", "keywords": ("药店", "医药商业", "集采", "处方外流"), "themes": ("集采影响", "消费医疗")},
        {"group": "消费", "industry": "白酒", "keywords": ("白酒", "批价", "库存", "动销", "茅台"), "themes": ("白酒批价", "消费复苏")},
        {"group": "消费", "industry": "食品饮料", "keywords": ("食品饮料", "啤酒", "乳制品", "调味品", "休闲食品"), "themes": ("消费复苏", "成本改善")},
        {"group": "消费", "industry": "纺织服装", "keywords": ("纺织", "服装", "运动鞋服", "出口", "品牌"), "themes": ("品牌出海", "消费复苏")},
        {"group": "消费", "industry": "港股消费/博彩", "keywords": ("港股消费", "博彩", "澳门", "客流", "免税"), "themes": ("港股博彩", "旅游恢复")},
        {"group": "金融地产", "industry": "港股银行/保险", "keywords": ("港股银行", "港股保险", "息差", "新业务价值", "分红"), "themes": ("高股息", "保险复苏")},
        {"group": "金融地产", "industry": "地产开发", "keywords": ("地产开发", "销售面积", "拿地", "保交楼", "房价"), "themes": ("地产链修复", "政策托底")},
        {"group": "金融地产", "industry": "港股物业", "keywords": ("港股物业", "物管", "在管面积", "收缴率"), "themes": ("物业现金流", "地产链压力")},
        {"group": "金融地产", "industry": "AH折溢价", "keywords": ("AH溢价", "AH折价", "两地上市", "港股通"), "themes": ("AH折溢价", "南向资金")},
        {"group": "周期资源", "industry": "铜/铝", "keywords": ("铜", "铝", "LME", "沪铜", "电解铝"), "themes": ("铜价上涨", "库存低位")},
        {"group": "周期资源", "industry": "黄金/贵金属", "keywords": ("黄金", "白银", "贵金属", "金价"), "themes": ("金价上涨", "避险")},
        {"group": "周期资源", "industry": "稀土/钨钼", "keywords": ("稀土", "钨", "钼", "小金属", "出口管制"), "themes": ("战略金属", "出口管制")},
        {"group": "周期资源", "industry": "钢铁长材/板材", "keywords": ("螺纹钢", "热卷", "钢材", "铁水", "钢厂利润"), "themes": ("钢铁复苏", "地产需求")},
        {"group": "周期资源", "industry": "水泥玻璃", "keywords": ("水泥", "玻璃", "熟料", "浮法", "开工率"), "themes": ("建材复苏", "产能出清")},
        {"group": "周期资源", "industry": "化工品", "keywords": ("纯碱", "烧碱", "MDI", "尿素", "钛白粉"), "themes": ("化工价差", "库存周期")},
        {"group": "交通物流", "industry": "集运/油运", "keywords": ("集运", "油运", "VLCC", "欧线", "运价期货"), "themes": ("航运旺季", "红海扰动")},
        {"group": "交通物流", "industry": "港口", "keywords": ("港口", "吞吐量", "集装箱", "外贸"), "themes": ("出口链", "港口吞吐")},
        {"group": "公用事业/高股息", "industry": "煤电/火电", "keywords": ("火电", "煤电", "电价", "容量电价"), "themes": ("高股息央企", "电价机制")},
        {"group": "公用事业/高股息", "industry": "核电", "keywords": ("核电", "核准", "装机", "利用小时"), "themes": ("核电核准", "稳定现金流")},
        {"group": "公用事业/高股息", "industry": "高速公路", "keywords": ("高速公路", "通行费", "车流量", "分红"), "themes": ("高股息", "车流恢复")},
    ]
)
existing_topic_names = {topic for topic, _, _ in TOPIC_QUERIES}
for taxonomy_item in FINE_INDUSTRY_TAXONOMY:
    if taxonomy_item["industry"] not in existing_topic_names:
        TOPIC_QUERIES.append((taxonomy_item["industry"], f"{taxonomy_item['industry']} {' '.join(taxonomy_item['keywords'][:6])} 财报 价格 销量 订单", "news"))

SOURCE_WEIGHTS = {
    "hard_data": 5,
    "official": 4,
    "announcement": 4,
    "market": 3,
    "news": 2,
    "research": 1,
}
WEAK_INDUSTRY_KEYWORDS = {"AI", "AR", "VR", "MR", "手机", "移动", "出口", "品牌", "设备", "材料", "电池", "销量", "库存", "药", "猪"}

DATA_SIGNAL_WORDS = ("价格", "库存", "产能", "订单", "营收", "净利润", "毛利率", "现金流", "销量", "装机", "开工率", "同比", "环比")
RISK_SIGNAL_WORDS = ("泡沫", "过剩", "亏损", "下滑", "衰退", "库存高企", "停牌", "异动")
TOPIC_SIGNAL_WORDS = (
    "半导体",
    "芯片",
    "存储",
    "HBM",
    "算力",
    "光模块",
    "PCB",
    "铜",
    "钨",
    "稀土",
    "锂",
    "有色",
    "光伏",
    "硅料",
    "储能",
    "电池",
    "猪",
    "养殖",
    "汽车",
    "智能驾驶",
    "创新药",
    "医药",
    "电力",
    "电网",
    "钢铁",
    "水泥",
    "地产",
    "航运",
    "高股息",
    "煤炭",
    "公用事业",
    "机器人",
)
TOPIC_ROLLUP_KEYWORDS = {
    "半导体/AI算力": ("半导体", "芯片", "存储", "HBM", "算力", "光模块", "PCB", "CPO", "服务器"),
    "战略有色金属": ("有色", "铜", "钨", "稀土", "小金属", "黄金", "铝", "锂", "镍", "钴"),
    "锂电储能": ("锂", "电池", "储能", "固态电池", "磷酸铁锂", "BC电池"),
    "光伏产业链": ("光伏", "硅料", "硅片", "组件", "逆变器", "TOPCon", "BC电池"),
    "生猪养殖": ("猪", "养殖", "畜牧"),
    "汽车/智能驾驶": ("汽车", "新能源车", "智能驾驶", "华为汽车", "高压快充"),
    "创新药/医疗服务": ("创新药", "医药", "医疗", "CXO", "药", "研发服务"),
    "电力电网/能源基础设施": ("电力", "电网", "特高压", "变压器", "数据中心", "电气设备"),
    "钢铁水泥/地产链": ("钢铁", "水泥", "地产", "房地产", "建材", "玻璃"),
    "航运物流": ("航运", "港口", "物流", "船舶"),
    "平稳现金流/高股息": ("高股息", "煤炭", "公用事业", "电力", "水电", "银行", "电信"),
    "机器人/AI应用": ("机器人", "人形机器人", "具身智能", "AI应用", "人工智能"),
}
for taxonomy_item in FINE_INDUSTRY_TAXONOMY:
    TOPIC_ROLLUP_KEYWORDS.setdefault(taxonomy_item["industry"], taxonomy_item["keywords"])
LOCAL_HARD_DATA_SIGNALS = [
    {
        "signalType": "commodity_price",
        "sourceType": "hard_data",
        "topic": "战略有色金属",
        "query": "铜 铝 锂 稀土 commodity_price 现货价格 期货价格 库存",
        "title": "商品价格聚合：铜/铝/LME库存、碳酸锂现货报价、稀土氧化物价格",
        "url": "https://data.stats.gov.cn/easyquery.htm#commodity_price",
        "summary": "本地硬数据层标记 commodity_price，后续采集优先核验现货价格、期货价格、交易所库存和周度报价字段。",
    },
    {
        "signalType": "commodity_price",
        "sourceType": "hard_data",
        "topic": "光伏产业链",
        "query": "硅料 硅片 组件 commodity_price 价格 开工率 库存",
        "title": "光伏价格聚合：硅料价格、硅片报价、组件价格和开工率",
        "url": "https://www.miit.gov.cn/#photovoltaic-price",
        "summary": "本地硬数据层标记 commodity_price，用价格、库存、产能和开工率字段约束光伏产业链证据。",
    },
    {
        "signalType": "financial_metric",
        "sourceType": "announcement",
        "topic": "平稳现金流/高股息",
        "query": "财报 financial_metric 营收 净利润 毛利率 经营现金流 分红",
        "title": "公告财务聚合：营收、净利润、毛利率、经营现金流和分红字段",
        "url": "https://www.cninfo.com.cn/new/disclosure#financial_metric",
        "summary": "本地公告层标记 financial_metric，优先从年报、季报、业绩预告和分红公告抽取财报指标。",
    },
    {
        "signalType": "financial_metric",
        "sourceType": "announcement",
        "topic": "创新药/医疗服务",
        "query": "创新药 财报 financial_metric 研发费用 营收 现金流 商业化",
        "title": "医药财务聚合：研发费用、商业化营收、净利润和现金流",
        "url": "https://www.sse.com.cn/disclosure/listedinfo/announcement/#medical-financial-metric",
        "summary": "本地公告层标记 financial_metric，用财报、研发费用、营收、净利润和现金流字段约束创新药证据。",
    },
    {
        "signalType": "industry_stat",
        "sourceType": "official",
        "topic": "汽车/智能驾驶",
        "query": "新能源汽车 industry_stat 销量 出口 渗透率 中汽协 乘联会",
        "title": "行业统计聚合：新能源汽车销量、出口、渗透率和智能驾驶装车量",
        "url": "https://www.caam.org.cn/#industry_stat-auto-sales",
        "summary": "本地官方统计层标记 industry_stat，优先核验月度销量、出口量、渗透率和同比/环比字段。",
    },
    {
        "signalType": "industry_stat",
        "sourceType": "official",
        "topic": "电力电网/能源基础设施",
        "query": "电力 industry_stat 发电量 装机量 用电量 国家能源局",
        "title": "能源统计聚合：发电量、装机量、用电量和电网投资",
        "url": "https://www.nea.gov.cn/#industry_stat-power",
        "summary": "本地官方统计层标记 industry_stat，用装机、发电量、用电量、电网投资和同比字段约束能源证据。",
    },
    {
        "signalType": "freight_rate",
        "sourceType": "hard_data",
        "topic": "航运物流",
        "query": "航运 freight_rate 运价 SCFI CCFI BDI 集装箱 散货",
        "title": "航运运价聚合：SCFI、CCFI、BDI运价指数和集装箱运价",
        "url": "https://www.sse.net.cn/index/singleIndex?indexType=scfi#freight_rate",
        "summary": "本地硬数据层标记 freight_rate，优先核验SCFI、CCFI、BDI、集装箱运价和同比/环比字段。",
    },
    {
        "signalType": "industry_stat",
        "sourceType": "official",
        "topic": "生猪养殖",
        "query": "生猪 industry_stat 猪价 能繁母猪 存栏 出栏 农业农村部",
        "title": "养殖统计聚合：猪价、能繁母猪存栏、生猪出栏和产能去化",
        "url": "https://www.moa.gov.cn/#industry_stat-hog",
        "summary": "本地官方统计层标记 industry_stat，优先核验猪价、存栏、出栏、产能去化和同比字段。",
    },
]

AKSHARE_FUTURES_DAILY_SIGNALS = [
    ("LC0", "碳酸锂主连", "锂电储能", "碳酸锂 期货 价格 库存 供需", "commodity_price", "hard_data"),
    ("PS0", "多晶硅主连", "光伏产业链", "多晶硅 硅料 期货 价格 产能", "commodity_price", "hard_data"),
    ("SI0", "工业硅主连", "光伏产业链", "工业硅 硅料 期货 价格 库存", "commodity_price", "hard_data"),
    ("CU0", "沪铜主连", "战略有色金属", "铜 期货 价格 库存 供需", "commodity_price", "hard_data"),
    ("RB0", "螺纹钢主连", "钢铁水泥/地产链", "钢铁 螺纹钢 期货 价格 需求", "commodity_price", "hard_data"),
    ("HC0", "热卷主连", "钢铁水泥/地产链", "钢铁 热卷 期货 价格 需求", "commodity_price", "hard_data"),
    ("I0", "铁矿石主连", "钢铁水泥/地产链", "铁矿石 期货 价格 库存", "commodity_price", "hard_data"),
    ("LH0", "生猪主连", "生猪养殖", "生猪 期货 猪价 产能 周期", "industry_stat", "hard_data"),
    ("EC0", "集运欧线主连", "航运物流", "集运欧线 期货 运价 航运", "freight_rate", "hard_data"),
]

AKSHARE_SPOT_BASIS_NAMES = {
    "CU": ("铜", "战略有色金属", "commodity_price"),
    "LC": ("碳酸锂", "锂电储能", "commodity_price"),
    "SI": ("工业硅", "光伏产业链", "commodity_price"),
    "PS": ("多晶硅", "光伏产业链", "commodity_price"),
    "RB": ("螺纹钢", "钢铁水泥/地产链", "commodity_price"),
    "HC": ("热卷", "钢铁水泥/地产链", "commodity_price"),
    "I": ("铁矿石", "钢铁水泥/地产链", "commodity_price"),
    "LH": ("生猪", "生猪养殖", "industry_stat"),
}

CPCA_SIGNALS = [
    ("狭义乘用车", "批发", "汽车/智能驾驶", "乘用车批发 销量 同比"),
    ("狭义乘用车", "出口", "汽车/智能驾驶", "汽车出口 销量 同比"),
]

EASTMONEY_INDUSTRY_INDEX_SIGNALS = [
    ("EMI00107664", "波罗的海干散货指数(BDI)", "航运物流", "航运 BDI 运价 指数", "freight_rate"),
    ("EMI00662541", "建材指数", "钢铁水泥/地产链", "建材 水泥 地产链 价格 指数", "commodity_price"),
    ("EMI00662535", "大宗商品价格指数", "战略有色金属", "大宗商品 铜 铝 有色 价格 指数", "commodity_price"),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect public evidence for the CSTD Alpha radar scan.")
    parser.add_argument("--output", default="radar-evidence.json", help="Path to write the JSON snapshot.")
    parser.add_argument("--gzip-output", default="", help="Optional path to write a gzip-compressed snapshot.")
    parser.add_argument("--offline-fixture", action="store_true", help="Generate deterministic fixture evidence without network calls.")
    parser.add_argument("--offline-google-only", action="store_true", help="Generate a bad all-news fixture and run the normal quality gate.")
    parser.add_argument("--offline-single-structured", action="store_true", help="Generate a narrow one-structured-source fixture and run the normal quality gate.")
    parser.add_argument("--min-sources", type=int, default=DEFAULT_MIN_SOURCES, help="Minimum source count required for a live snapshot.")
    args = parser.parse_args()

    raw_sources = (
        google_only_fixture_sources()
        if args.offline_google_only
        else single_structured_fixture_sources()
        if args.offline_single_structured
        else fixture_sources()
        if args.offline_fixture
        else collect_sources()
    )
    sources = select_sources(dedupe_sources(classify_source(source) for source in raw_sources), limit=MAX_SELECTED_SOURCES)
    quality = evidence_quality(sources)
    print_quality_summary("selected", quality)
    validate_quality(quality, min_sources=args.min_sources)
    financial_facts = financial_facts_from_sources(sources)
    industry_facts = industry_facts_from_sources(sources)
    indicator_values = indicator_values_from_sources(sources)
    company_candidates = company_candidates_from_sources(sources)
    industry_packets = industry_packets_from_sources(sources, financial_facts, industry_facts, company_candidates, indicator_values)

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
        "financialFacts": financial_facts,
        "industryFacts": industry_facts,
        "indicatorValues": indicator_values,
        "companyCandidates": company_candidates,
        "industryPackets": industry_packets,
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
        ("eastmoney_financials", fetch_eastmoney_financials),
        ("eastmoney_industry_indexes", fetch_eastmoney_industry_indexes),
        ("eastmoney", fetch_eastmoney_boards),
        ("sina_boards", fetch_sina_boards),
        ("google_news", fetch_google_news),
        ("anysearch", fetch_anysearch),
        ("searxng", fetch_searxng),
        ("akshare", fetch_akshare),
        ("baostock", fetch_baostock),
    ]:
        fetched = fetcher()
        print_source_summary(label, fetched)
        sources.extend(fetched)
    try:
        seed_candidates = company_candidates_from_sources([classify_source(source) for source in sources])
        dynamic_financials = fetch_dynamic_company_financials(seed_candidates)
        print_source_summary("eastmoney_dynamic_company_financials", dynamic_financials)
        sources.extend(dynamic_financials)
        tushare_facts = fetch_tushare_batch_market_facts(seed_candidates) if TUSHARE_BATCH_ENABLED else []
        print_source_summary("tushare_batch_market_facts", tushare_facts)
        sources.extend(tushare_facts)
        if TUSHARE_COMPANY_FALLBACK_ENABLED and not tushare_facts:
            tushare_company_facts = fetch_tushare_dynamic_company_facts(seed_candidates)
            print_source_summary("tushare_dynamic_company_facts", tushare_company_facts)
            sources.extend(tushare_company_facts)
    except Exception as exc:
        print(f"collector_warning dynamic_company_financials: {type(exc).__name__}: {str(exc)[:180]}")
    return sources


def local_hard_data_signal_sources() -> list[dict[str, Any]]:
    return [
        {
            "source": "本地硬数据指标聚合",
            "query": signal["query"],
            "title": signal["title"],
            "url": signal["url"],
            "summary": f"{signal['topic']}：{signal['summary']}",
            "sourceType": signal["sourceType"],
            "signalType": signal["signalType"],
            "weight": 1,
        }
        for signal in LOCAL_HARD_DATA_SIGNALS
    ]


def fetch_eastmoney_financials() -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for report_date in recent_report_dates(include_next=True, count=4):
        report_date_filter = f"{report_date[:4]}-{report_date[4:6]}-{report_date[6:]}"
        for sort_column in ("SJLTZ", "YSTZ", "UPDATE_DATE"):
            rows = fetch_eastmoney_report_rows(
                report_name="RPT_LICO_FN_CPD",
                report_filter=f'(SECURITY_TYPE_CODE="058001001")(REPORTDATE=\'{report_date_filter}\')',
                sort_columns=f"{sort_column},SECURITY_CODE",
                sort_types="-1,-1",
                page_size=24,
            )
            sources.extend(financial_report_sources(rows, report_date_filter, "东方财富业绩报表"))
        rows = fetch_eastmoney_report_rows(
            report_name="RPT_FCI_PERFORMANCEE",
            report_filter=f'(SECURITY_TYPE_CODE in ("058001001","058001008"))(REPORT_DATE=\'{report_date_filter}\')',
            sort_columns="JLRTBZCL,SECURITY_CODE",
            sort_types="-1,-1",
            page_size=24,
        )
        sources.extend(financial_report_sources(rows, report_date_filter, "东方财富业绩快报"))

    for report_date in recent_report_dates(include_next=True, count=3):
        report_date_filter = f"{report_date[:4]}-{report_date[4:6]}-{report_date[6:]}"
        rows = fetch_eastmoney_report_rows(
            report_name="RPT_PUBLIC_OP_NEWPREDICT",
            report_filter=f'(SECURITY_TYPE_CODE="058001001")(REPORT_DATE=\'{report_date_filter}\')',
            sort_columns="NOTICE_DATE,SECURITY_CODE",
            sort_types="-1,-1",
            page_size=32,
        )
        sources.extend(financial_forecast_sources(rows, report_date_filter))
    return dedupe_sources(sources)


def fetch_dynamic_company_financials(candidates: list[dict[str, Any]], report_dates: list[str] | None = None) -> list[dict[str, Any]]:
    company_codes = dynamic_company_codes(candidates)[:MAX_DYNAMIC_COMPANY_FINANCIALS]
    if not company_codes:
        return []
    sources: list[dict[str, Any]] = []
    dates = report_dates or recent_report_dates(include_next=True, count=3)
    for report_date in dates:
        report_date_filter = f"{report_date[:4]}-{report_date[4:6]}-{report_date[6:]}"
        for chunk in chunked(company_codes, EASTMONEY_COMPANY_CHUNK_SIZE):
            code_filter = ",".join(f'"{code}"' for code in chunk)
            try:
                rows = fetch_eastmoney_report_rows(
                    report_name="RPT_LICO_FN_CPD",
                    report_filter=f'(SECURITY_CODE in ({code_filter}))(REPORTDATE=\'{report_date_filter}\')',
                    sort_columns="UPDATE_DATE,SECURITY_CODE",
                    sort_types="-1,-1",
                    page_size=max(50, len(chunk) * 2),
                )
                sources.extend(financial_report_sources(rows, report_date_filter, "东方财富业绩报表"))
            except Exception as exc:
                print(f"collector_warning eastmoney_dynamic_company_financials.report.{report_date}: {type(exc).__name__}: {str(exc)[:160]}")
            try:
                rows = fetch_eastmoney_report_rows(
                    report_name="RPT_FCI_PERFORMANCEE",
                    report_filter=f'(SECURITY_CODE in ({code_filter}))(REPORT_DATE=\'{report_date_filter}\')',
                    sort_columns="UPDATE_DATE,SECURITY_CODE",
                    sort_types="-1,-1",
                    page_size=max(50, len(chunk) * 2),
                )
                sources.extend(financial_report_sources(rows, report_date_filter, "东方财富业绩快报"))
            except Exception as exc:
                print(f"collector_warning eastmoney_dynamic_company_financials.flash.{report_date}: {type(exc).__name__}: {str(exc)[:160]}")
            try:
                rows = fetch_eastmoney_report_rows(
                    report_name="RPT_PUBLIC_OP_NEWPREDICT",
                    report_filter=f'(SECURITY_CODE in ({code_filter}))(REPORT_DATE=\'{report_date_filter}\')',
                    sort_columns="NOTICE_DATE,SECURITY_CODE",
                    sort_types="-1,-1",
                    page_size=max(50, len(chunk) * 2),
                )
                sources.extend(financial_forecast_sources(rows, report_date_filter))
            except Exception as exc:
                print(f"collector_warning eastmoney_dynamic_company_financials.forecast.{report_date}: {type(exc).__name__}: {str(exc)[:160]}")
    return dedupe_sources(sources)


def dynamic_company_codes(candidates: list[dict[str, Any]]) -> list[str]:
    ranked: list[tuple[int, str]] = []
    seen: set[str] = set()
    for candidate in sorted(candidates, key=lambda item: int(item.get("evidenceStrength") or 0), reverse=True):
        if clean_text(candidate.get("market")) not in ("", "A股"):
            continue
        code = eastmoney_security_code(candidate.get("code"))
        if not code or code in seen:
            continue
        seen.add(code)
        ranked.append((dynamic_company_priority(candidate), code))
    return [code for _priority, code in sorted(ranked, reverse=True)[:MAX_DYNAMIC_COMPANY_CANDIDATES]]


def dynamic_company_priority(candidate: dict[str, Any]) -> int:
    text = f"{candidate.get('industry', '')} {candidate.get('company', '')} {candidate.get('triggerEvidence', '')}"
    base = int(candidate.get("evidenceStrength") or 0)
    priority = base
    if re.search(r"电气|电网|半导体|芯片|存储|光伏|新能源|锂|汽车|医药|CXO|生猪|养殖|地产|房地产|白酒|家电|消费|航运|钢铁|水泥|煤炭|公用|电力", text, re.I):
        priority += 12
    if re.search(r"缺财报|财报|业绩|净利润|营收|现金流|订单|中标|库存|价格", text, re.I):
        priority += 8
    return priority


def fetch_tushare_dynamic_company_facts(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    token = clean_text(os.environ.get("TUSHARE_TOKEN"))
    if not token:
        return []
    selected = [
        candidate
        for candidate in sorted(candidates, key=lambda item: int(item.get("evidenceStrength") or 0), reverse=True)
        if clean_text(candidate.get("market")) in ("", "A股") and normalize_a_share_code(candidate.get("code"))
    ][:TUSHARE_MAX_COMPANIES]
    sources: list[dict[str, Any]] = []
    for candidate in selected:
        ts_code = normalize_a_share_code(candidate.get("code"))
        if not ts_code:
            continue
        disclosure_rows = tushare_rows(token, "disclosure_date", ts_code, "ts_code,end_date,ann_date,pre_date,actual_date,modify_date", "ts_code")
        report_period = latest_tushare_period_from_rows(disclosure_rows) or latest_report_period()
        sources.extend(tushare_sources(candidate, ts_code, "disclosure_date", disclosure_rows, "announcement", "financial_metric"))
        for api_name, source_type, signal_type, fields, params_mode in TUSHARE_ENDPOINTS:
            if api_name == "disclosure_date":
                continue
            try:
                rows = tushare_rows(token, api_name, ts_code, fields, params_mode, report_period)
                sources.extend(tushare_sources(candidate, ts_code, api_name, rows, source_type, signal_type))
            except Exception as exc:
                print(f"collector_warning tushare.{api_name}.{ts_code}: {type(exc).__name__}: {str(exc)[:160]}")
    return dedupe_sources(sources)


def fetch_tushare_batch_market_facts(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    token = clean_text(os.environ.get("TUSHARE_TOKEN"))
    if not token:
        return []
    candidate_map = tushare_candidate_map(candidates)
    if not candidate_map:
        return []
    sources: list[dict[str, Any]] = []
    report_period = os.environ.get("TUSHARE_REPORT_PERIOD") or latest_report_period()
    for api_name, source_type, signal_type, fields, params_mode in TUSHARE_BATCH_ENDPOINTS:
        try:
            rows = tushare_batch_rows(token, api_name, fields, params_mode, report_period)
        except Exception as exc:
            print(f"collector_warning tushare_batch.{api_name}: {type(exc).__name__}: {str(exc)[:160]}")
            continue
        for row in rows:
            ts_code = normalize_a_share_code(row.get("ts_code"))
            candidate = candidate_map.get(ts_code)
            if not candidate:
                continue
            sources.extend(tushare_sources(candidate, ts_code, api_name, [row], source_type, signal_type))
    return dedupe_sources(sources)


def tushare_candidate_map(candidates: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    ranked: list[tuple[int, str, dict[str, Any]]] = []
    for candidate in candidates:
        if clean_text(candidate.get("market")) not in ("", "A股"):
            continue
        ts_code = normalize_a_share_code(candidate.get("code"))
        if not ts_code:
            continue
        ranked.append((dynamic_company_priority(candidate), ts_code, candidate))
    result: dict[str, dict[str, Any]] = {}
    for _priority, ts_code, candidate in sorted(ranked, reverse=True):
        result.setdefault(ts_code, candidate)
        if len(result) >= max(TUSHARE_BATCH_MAX_ROWS, 1):
            break
    return result


def tushare_batch_rows(token: str, api_name: str, fields: str, params_mode: str, report_period: str | None = None) -> list[dict[str, Any]]:
    data = post_json(
        TUSHARE_API_URL,
        {"api_name": api_name, "token": token, "params": tushare_batch_params(params_mode, report_period), "fields": fields},
        timeout=20,
    )
    if data.get("code") != 0:
        return []
    payload_data = data.get("data") or {}
    field_names = [clean_text(field) for field in payload_data.get("fields") or []]
    rows: list[dict[str, Any]] = []
    for item in payload_data.get("items") or []:
        if not isinstance(item, list):
            continue
        row = {field_names[index]: value for index, value in enumerate(item) if index < len(field_names) and field_names[index]}
        if row:
            rows.append(row)
    return rows[: max(TUSHARE_BATCH_MAX_ROWS * 3, TUSHARE_BATCH_MAX_ROWS)]


def tushare_rows(token: str, api_name: str, ts_code: str, fields: str, params_mode: str, report_period: str | None = None) -> list[dict[str, Any]]:
    data = post_json(
        TUSHARE_API_URL,
        {"api_name": api_name, "token": token, "params": tushare_params(ts_code, params_mode, report_period), "fields": fields},
        timeout=20,
    )
    if data.get("code") != 0:
        return []
    payload_data = data.get("data") or {}
    field_names = [clean_text(field) for field in payload_data.get("fields") or []]
    rows: list[dict[str, Any]] = []
    for item in payload_data.get("items") or []:
        if not isinstance(item, list):
            continue
        row = {field_names[index]: value for index, value in enumerate(item) if index < len(field_names) and field_names[index]}
        if row:
            rows.append(row)
    return rows[:10]


def tushare_batch_params(mode: str, report_period: str | None = None) -> dict[str, str]:
    if mode == "period":
        return {"period": report_period or latest_report_period()}
    if mode == "trade_date":
        return {"trade_date": os.environ.get("TUSHARE_TRADE_DATE") or latest_tushare_trade_date()}
    if mode == "date_range":
        today = datetime.now(timezone.utc).date()
        return {"start_date": os.environ.get("TUSHARE_START_DATE") or (today - timedelta(days=30)).strftime("%Y%m%d"), "end_date": os.environ.get("TUSHARE_END_DATE") or today.strftime("%Y%m%d")}
    return {}


def tushare_params(ts_code: str, mode: str, report_period: str | None = None) -> dict[str, str]:
    if mode == "period":
        return {"ts_code": ts_code, "period": report_period or latest_report_period()}
    if mode == "date_range":
        today = datetime.now(timezone.utc).date()
        return {"ts_code": ts_code, "start_date": (today - timedelta(days=30)).strftime("%Y%m%d"), "end_date": today.strftime("%Y%m%d")}
    return {"ts_code": ts_code}


def latest_tushare_trade_date() -> str:
    day = datetime.now(timezone.utc).date()
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day.strftime("%Y%m%d")


def latest_tushare_period_from_rows(rows: list[dict[str, Any]]) -> str:
    values = sorted(clean_text(row.get("end_date")) for row in rows if re.fullmatch(r"\d{8}", clean_text(row.get("end_date"))))
    return values[-1] if values else ""


def latest_report_period() -> str:
    today = datetime.now(timezone.utc).date()
    if today >= datetime(today.year, 10, 31).date():
        return f"{today.year}0930"
    if today >= datetime(today.year, 8, 31).date():
        return f"{today.year}0630"
    if today >= datetime(today.year, 4, 30).date():
        return f"{today.year}0331"
    return f"{today.year - 1}1231"


def tushare_sources(candidate: dict[str, Any], ts_code: str, api_name: str, rows: list[dict[str, Any]], source_type: str, signal_type: str) -> list[dict[str, Any]]:
    if not rows:
        return []
    company = clean_text(candidate.get("company"))
    industry = clean_text(candidate.get("industry"))
    sources: list[dict[str, Any]] = []
    for row in rows[:3]:
        period = first_text(row, ("end_date", "trade_date", "ann_date"))
        sources.append(
            compact_dict(
                {
                    "source": "Tushare Pro API",
                    "query": f"{industry or company} Tushare {api_name} 财报 估值 分红 公告",
                    "title": tushare_title(company, ts_code, api_name, row, period),
                    "url": f"https://tushare.pro/document/2?doc_id=33#{api_name}:{ts_code}:{period}",
                    "publishedAt": iso_date(period),
                    "summary": tushare_summary(api_name, row),
                    "sourceType": source_type,
                    "signalType": signal_type,
                    "weight": SOURCE_WEIGHTS.get(source_type, 3),
                    "factType": "financial" if signal_type == "financial_metric" else "",
                    "company": company,
                    "code": ts_code,
                    "market": "A股",
                    "industry": industry,
                    "metric": api_name,
                    "period": period,
                    "metrics": tushare_metrics(api_name, row),
                }
            )
        )
    return sources


def tushare_metrics(api_name: str, row: dict[str, Any]) -> dict[str, float]:
    metric_keys = {
        "daily_basic": ("pe_ttm", "pb", "total_mv", "circ_mv", "turnover_rate"),
        "income": ("revenue", "n_income_attr_p", "total_profit", "basic_eps"),
        "cashflow": ("n_cashflow_act", "c_free_cashflow"),
        "fina_indicator": ("grossprofit_margin", "netprofit_margin", "roe", "roa", "debt_to_assets", "ocfps"),
        "dividend": ("cash_div", "cash_div_tax"),
    }.get(api_name, ())
    metrics: dict[str, float] = {}
    for key in metric_keys:
        value = numeric(row.get(key))
        if value is not None:
            metrics[key] = value
    return metrics


def tushare_title(company: str, ts_code: str, api_name: str, row: dict[str, Any], period: str) -> str:
    name = company or ts_code
    if api_name == "daily_basic":
        return f"{name}({ts_code}) {period} Tushare估值：PE-TTM {number_text(row.get('pe_ttm'))}，PB {number_text(row.get('pb'))}，总市值 {number_text(row.get('total_mv'))}"
    if api_name == "income":
        return f"{name}({ts_code}) {period} Tushare利润表：营收 {number_text(row.get('revenue'))}，归母净利润 {number_text(row.get('n_income_attr_p'))}"
    if api_name == "cashflow":
        return f"{name}({ts_code}) {period} Tushare现金流：经营现金流 {number_text(row.get('n_cashflow_act'))}"
    if api_name == "fina_indicator":
        return f"{name}({ts_code}) {period} Tushare财务指标：毛利率 {format_percent(row.get('grossprofit_margin'))}，ROE {format_percent(row.get('roe'))}"
    if api_name == "dividend":
        return f"{name}({ts_code}) {period} Tushare分红：税后现金分红 {number_text(row.get('cash_div_tax'))}"
    return f"{name}({ts_code}) {period} Tushare公告：{first_text(row, ('title',)) or api_name}"


def tushare_summary(api_name: str, row: dict[str, Any]) -> str:
    if api_name == "daily_basic":
        return f"估值快照：PE-TTM {number_text(row.get('pe_ttm'))}，PB {number_text(row.get('pb'))}，总市值 {number_text(row.get('total_mv'))}。"
    if api_name == "income":
        return f"利润表字段：营收 {number_text(row.get('revenue'))}，归母净利润 {number_text(row.get('n_income_attr_p'))}，总利润 {number_text(row.get('total_profit'))}。"
    if api_name == "cashflow":
        return f"现金流字段：经营现金流 {number_text(row.get('n_cashflow_act'))}，自由现金流 {number_text(row.get('c_free_cashflow'))}。"
    if api_name == "fina_indicator":
        return f"财务指标：毛利率 {format_percent(row.get('grossprofit_margin'))}，净利率 {format_percent(row.get('netprofit_margin'))}，ROE {format_percent(row.get('roe'))}。"
    if api_name == "dividend":
        return f"分红字段：现金分红 {number_text(row.get('cash_div'))}，税后现金分红 {number_text(row.get('cash_div_tax'))}。"
    return first_text(row, ("title",)) or f"Tushare {api_name} 结构化字段。"


def fetch_eastmoney_report_rows(report_name: str, report_filter: str, sort_columns: str, sort_types: str, page_size: int) -> list[dict[str, Any]]:
    params = {
        "sortColumns": sort_columns,
        "sortTypes": sort_types,
        "pageSize": str(page_size),
        "pageNumber": "1",
        "reportName": report_name,
        "columns": "ALL",
        "filter": report_filter,
    }
    url = f"https://datacenter-web.eastmoney.com/api/data/v1/get?{urlencode(params)}"
    try:
        data = read_json(url)
    except (OSError, ValueError, URLError) as exc:
        print(f"collector_warning eastmoney_financials.{report_name}: {type(exc).__name__}: {str(exc)[:180]}")
        return []
    result = data.get("result") or {}
    rows = result.get("data", []) or []
    return rows if isinstance(rows, list) else []


def financial_report_sources(rows: list[dict[str, Any]], report_date: str, source_name: str) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for row in rows:
        code = first_text(row, ("SECUCODE", "股票代码", "SECURITY_CODE"))
        name = first_text(row, ("SECURITY_NAME_ABBR", "股票简称"))
        if not name or not is_a_or_h_market(row, code):
            continue
        industry = first_text(row, ("PUBLISHNAME", "BOARD_NAME", "所处行业")) or "行业待验证"
        revenue = first_number(row, ("TOTAL_OPERATE_INCOME", "营业总收入-营业总收入", "营业收入-营业收入"))
        profit = first_number(row, ("PARENT_NETPROFIT", "净利润-净利润"))
        revenue_yoy = first_number(row, ("YSTZ", "营业总收入-同比增长", "营业收入-同比增长"))
        profit_yoy = first_number(row, ("SJLTZ", "JLRTBZCL", "净利润-同比增长"))
        gross_margin = first_number(row, ("XSMLL", "销售毛利率"))
        cashflow_per_share = first_number(row, ("MGJYXJJE", "每股经营现金流量"))
        published_at = iso_date(first_text(row, ("NOTICE_DATE", "UPDATE_DATE", "公告日期", "最新公告日期")))
        market = market_name_from_row(row, code)
        title = f"{name}({code}) {report_date} 营收同比 {format_percent(revenue_yoy)}，净利润同比 {format_percent(profit_yoy)}"
        sources.append(
            {
                "source": source_name,
                "query": f"{market} 财报 营收 净利润 毛利率 经营现金流 {industry}",
                "title": title,
                "url": f"https://data.eastmoney.com/bbsj/{report_date[:4]}{report_date[5:7]}/yjbb.html#{quote(code)}",
                "publishedAt": published_at,
                "summary": f"公司级财报：营收 {number_text(revenue)}，净利润 {number_text(profit)}，毛利率 {format_percent(gross_margin)}，每股经营现金流 {number_text(cashflow_per_share)}，行业 {industry}。",
                "sourceType": "announcement",
                "signalType": "financial_metric",
                "weight": SOURCE_WEIGHTS["announcement"],
                "factType": "financial",
                "company": name,
                "code": code,
                "market": market,
                "industry": industry,
                "metric": "净利润",
                "value": profit,
                "yoy": profit_yoy,
                "metrics": {
                    "revenue": revenue,
                    "netProfit": profit,
                    "revenueYoy": revenue_yoy,
                    "netProfitYoy": profit_yoy,
                    "grossMargin": gross_margin,
                    "operatingCashflowPerShare": cashflow_per_share,
                },
            }
        )
    return sources


def financial_forecast_sources(rows: list[dict[str, Any]], report_date: str) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for row in rows:
        code = first_text(row, ("SECUCODE", "SECURITY_CODE"))
        name = first_text(row, ("SECURITY_NAME_ABBR",))
        if not name or not is_a_or_h_market(row, code):
            continue
        market = market_name_from_row(row, code)
        industry = first_text(row, ("PUBLISHNAME", "BOARD_NAME")) or "行业待验证"
        lower = first_number(row, ("ADD_AMP_LOWER",))
        upper = first_number(row, ("ADD_AMP_UPPER",))
        amount_lower = first_number(row, ("PREDICT_AMT_LOWER",))
        amount_upper = first_number(row, ("PREDICT_AMT_UPPER",))
        predict_type = first_text(row, ("PREDICT_TYPE",))
        reason = trim_text(first_text(row, ("CHANGE_REASON_EXPLAIN", "PREDICT_CONTENT")), 180)
        sources.append(
            {
                "source": "东方财富业绩预告",
                "query": f"{market} 业绩预告 净利润 预增 预减 {industry}",
                "title": f"{name}({code}) {report_date} {predict_type or '业绩预告'}，净利润同比 {format_percent(lower)} 至 {format_percent(upper)}",
                "url": f"https://data.eastmoney.com/bbsj/{report_date[:4]}{report_date[5:7]}/yjyg.html#{quote(code)}",
                "publishedAt": iso_date(first_text(row, ("NOTICE_DATE",))),
                "summary": reason or trim_text(first_text(row, ("PREDICT_CONTENT",)), 180),
                "sourceType": "announcement",
                "signalType": "financial_metric",
                "weight": SOURCE_WEIGHTS["announcement"],
                "factType": "financial",
                "company": name,
                "code": code,
                "market": market,
                "industry": industry,
                "metric": "净利润预告",
                "value": amount_upper if amount_upper is not None else amount_lower,
                "yoy": upper if upper is not None else lower,
                "metrics": {
                    "forecastProfitLower": amount_lower,
                    "forecastProfitUpper": amount_upper,
                    "forecastYoyLower": lower,
                    "forecastYoyUpper": upper,
                },
            }
        )
    return sources


def fetch_eastmoney_industry_indexes() -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for indicator_id, indicator_name, topic, query, signal_type in EASTMONEY_INDUSTRY_INDEX_SIGNALS:
        params = {
            "sortColumns": "REPORT_DATE",
            "sortTypes": "-1",
            "pageSize": "5",
            "pageNumber": "1",
            "reportName": "RPT_INDUSTRY_INDEX",
            "columns": "ALL",
            "filter": f'(INDICATOR_ID="{indicator_id}")',
        }
        url = f"https://datacenter-web.eastmoney.com/api/data/v1/get?{urlencode(params)}"
        try:
            data = read_json(url)
        except (OSError, ValueError, URLError) as exc:
            print(f"collector_warning eastmoney_industry_index.{indicator_id}: {type(exc).__name__}: {str(exc)[:180]}")
            continue
        rows = data.get("result", {}).get("data", []) or []
        if not rows:
            continue
        latest = rows[0]
        date = clean_date(latest.get("REPORT_DATE"))
        value = number_text(latest.get("INDICATOR_VALUE"))
        change = format_percent(latest.get("CHANGE_RATE"))
        three_month = format_percent(latest.get("CHANGERATE_3M"))
        one_year = format_percent(latest.get("CHANGERATE_1Y"))
        sources.append(
            {
                "source": "东方财富行业指数",
                "query": query,
                "title": f"{indicator_name} {date} 最新值 {value}，日变化 {change}",
                "url": url,
                "publishedAt": iso_date(date),
                "summary": f"{topic}硬数据：3个月变化 {three_month}，1年变化 {one_year}，关联板块 {clean_text(latest.get('BOARD_NAME')) or '待验证'}。",
                "sourceType": "hard_data",
                "signalType": signal_type,
                "weight": SOURCE_WEIGHTS["hard_data"],
            }
        )
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
            "fields": "f12,f14,f3,f62,f128,f140,f184",
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
            lead_name = clean_text(item.get("f128"))
            lead_code = normalize_a_share_code(item.get("f140"))
            if lead_name and lead_code:
                sources.append(
                    {
                        "source": "东方财富板块公司池",
                        "query": f"A股 板块龙头 财报候选 {name}",
                        "title": f"{lead_name}({lead_code}) 是 {name} 板块领涨/代表公司，纳入动态财报候选",
                        "url": f"https://quote.eastmoney.com/{lead_code.lower().replace('.', '')}.html",
                        "summary": f"来源于东方财富板块结构化字段，板块涨跌幅 {number_text(item.get('f3'))}%，用于公司级财报补强候选。",
                        "sourceType": "market",
                        "signalType": "company_candidate",
                        "weight": SOURCE_WEIGHTS["market"],
                        "company": lead_name,
                        "code": lead_code,
                        "market": "A股",
                        "industry": name,
                    }
                )
    return sources


def fetch_sina_boards() -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    endpoints = [
        ("新浪行业板块", "新浪行业板块 涨跌幅 成交额 领涨股", "https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php", 80),
        ("新浪概念板块", "新浪概念板块 涨跌幅 成交额 领涨股", "https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class", 240),
        ("新浪证监会行业", "证监会行业 涨跌幅 成交额 领涨股", "https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=industry", 120),
    ]
    for label, query, url, limit in endpoints:
        try:
            text = read_text(url)
            data = parse_js_object(text)
        except (OSError, ValueError, URLError) as exc:
            print(f"collector_warning sina_boards.{label}: {type(exc).__name__}: {str(exc)[:180]}")
            continue
        sources.extend(sina_board_sources(label, query, url, data, limit))
    return sources + topic_rollup_sources("新浪主题板块聚合", sources)


def sina_board_sources(label: str, query: str, base_url: str, data: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for key, value in data.items():
        if not isinstance(value, str):
            continue
        parts = [clean_text(part) for part in value.split(",")]
        if len(parts) < 6:
            continue
        code = parts[0] or clean_text(key)
        name = parts[1]
        stock_count = parts[2] if len(parts) > 2 else ""
        pct_change = parts[5] if len(parts) > 5 else ""
        amount = parts[7] if len(parts) > 7 else ""
        lead_code = parts[8] if len(parts) > 8 else ""
        lead_pct = parts[9] if len(parts) > 9 else ""
        lead_name = parts[12] if len(parts) > 12 else ""
        if not name:
            continue
        sources.append(
            {
                "source": label,
                "query": query,
                "title": f"{name} 涨跌幅 {number_text(pct_change)}%，成交额 {number_text(amount)}",
                "url": f"{base_url}#{quote(code)}",
                "summary": f"成分股 {number_text(stock_count)} 家，领涨股 {lead_name or '待验证'}{f'({lead_code})' if lead_code else ''}，领涨幅 {number_text(lead_pct)}%。",
                "sourceType": "market",
                "weight": SOURCE_WEIGHTS["market"],
            }
        )
        normalized_lead_code = normalize_a_share_code(lead_code)
        if lead_name and normalized_lead_code:
            sources.append(
                {
                    "source": "新浪板块公司池",
                    "query": f"A股 板块领涨 公司池 财报候选 {name}",
                    "title": f"{lead_name}({normalized_lead_code}) 是 {name} 板块领涨公司，纳入动态财报候选",
                    "url": f"{base_url}#{quote(normalized_lead_code)}",
                    "summary": f"来源于新浪板块结构化字段，板块涨跌幅 {number_text(pct_change)}%，领涨幅 {number_text(lead_pct)}%。",
                    "sourceType": "market",
                    "signalType": "company_candidate",
                    "weight": SOURCE_WEIGHTS["market"],
                    "company": lead_name,
                    "code": normalized_lead_code,
                    "market": "A股",
                    "industry": name,
                }
            )
    return sources[:limit]


def topic_rollup_sources(label: str, sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rollups: list[dict[str, Any]] = []
    for topic, keywords in TOPIC_ROLLUP_KEYWORDS.items():
        matched = [source for source in sources if any(keyword.lower() in source_text(source).lower() for keyword in keywords)]
        if not matched:
            continue
        names = [clean_text(source.get("title")).split(" 涨跌幅")[0] for source in matched[:6]]
        queries = [query for candidate_topic, query, _source_type in TOPIC_QUERIES if candidate_topic == topic]
        rollups.append(
            {
                "source": label,
                "query": queries[0] if queries else topic,
                "title": f"{topic} 相关板块 {len(matched)} 个，代表：{'、'.join(names[:5])}",
                "url": f"https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php#{quote(topic)}",
                "summary": "基于新浪行业/概念/证监会行业板块的涨跌幅、成交额和领涨股聚合，用于识别产业方向和市场验证线索。",
                "sourceType": "market",
                "weight": SOURCE_WEIGHTS["market"],
            }
        )
    return rollups


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


def fetch_anysearch() -> list[dict[str, Any]]:
    api_key = os.environ.get("ANYSEARCH_API_KEY", "").strip().replace("\\_", "_")
    if not api_key:
        print("collector_warning anysearch: ANYSEARCH_API_KEY not configured; skipping supplemental search")
        return []
    sources: list[dict[str, Any]] = []
    query_plans = anysearch_query_plans()[:ANYSEARCH_MAX_QUERIES]
    with ThreadPoolExecutor(max_workers=min(ANYSEARCH_CONCURRENCY, max(1, len(query_plans)))) as executor:
        futures = [executor.submit(fetch_anysearch_query_plan, query_plan, api_key) for query_plan in query_plans]
        for future in as_completed(futures):
            sources.extend(future.result())
    return sources


def fetch_searxng() -> list[dict[str, Any]]:
    if not SEARXNG_ENDPOINTS:
        print("collector_warning searxng: SEARXNG_ENDPOINTS not configured; skipping low-weight supplemental search")
        return []
    sources: list[dict[str, Any]] = []
    query_plans = anysearch_query_plans()[:SEARXNG_MAX_QUERIES]
    with ThreadPoolExecutor(max_workers=min(SEARXNG_CONCURRENCY, max(1, len(query_plans)))) as executor:
        futures = [executor.submit(fetch_searxng_query_plan, query_plan) for query_plan in query_plans]
        for future in as_completed(futures):
            sources.extend(future.result())
    return sources


def fetch_searxng_query_plan(query_plan: dict[str, Any]) -> list[dict[str, Any]]:
    for endpoint in SEARXNG_ENDPOINTS:
        try:
            url = f"{endpoint}/search?{urlencode({'q': query_plan['query'], 'format': 'json', 'language': 'zh-CN', 'categories': 'general,news'})}"
            payload = read_json(url)
            sources = searxng_sources_from_payload(payload, query_plan)
            if sources:
                return sources
        except Exception as exc:
            print(f"collector_warning searxng.{query_plan['profile']}.{query_plan['industry']}: {type(exc).__name__}: {str(exc)[:160]}")
    return []


def fetch_anysearch_query_plan(query_plan: dict[str, Any], api_key: str) -> list[dict[str, Any]]:
    try:
        request_body = {
            "query": query_plan["query"],
            "max_results": ANYSEARCH_RESULTS_PER_QUERY,
            "domains": query_plan["domains"],
            "content_types": query_plan["contentTypes"],
            "tags": query_plan["tags"],
            "zone": "cn",
            "language": "zh-CN",
            "constraint": {"freshness": query_plan["freshness"]},
        }
        payload = post_json(ANYSEARCH_API_URL, request_body, {"Authorization": f"Bearer {api_key}"}, timeout=18)
        return anysearch_sources_from_payload(payload, query_plan)
    except Exception as exc:
        print(f"collector_warning anysearch.{query_plan['profile']}.{query_plan['industry']}: {type(exc).__name__}: {str(exc)[:180]}")
        return []


def anysearch_query_plans() -> list[dict[str, Any]]:
    plans: list[dict[str, Any]] = []
    profiles_by_name = {profile["profile"]: profile for profile in ANYSEARCH_EVIDENCE_PROFILES}
    for taxonomy in FINE_INDUSTRY_TAXONOMY:
        industry = taxonomy["industry"]
        keywords = " ".join(taxonomy["keywords"][:6])
        for profile_name in anysearch_profiles_for_taxonomy(taxonomy):
            profile = profiles_by_name[profile_name]
            group_domains = anysearch_domains_for_group(taxonomy["group"], industry)
            profile_domains = list(profile["domains"])
            domains = unique_strings([*profile_domains, *[domain for domain in group_domains if domain in ("energy", "health", "legal")]])
            content_types = unique_strings(profile["contentTypes"])
            plans.append(
                {
                    "industry": industry,
                    "group": taxonomy["group"],
                    "profile": profile["profile"],
                    "query": f"{industry} {keywords} {profile['terms']} A股 港股",
                    "domains": domains,
                    "tags": unique_strings(profile["tags"]),
                    "contentTypes": content_types,
                    "freshness": profile["freshness"],
                    "sourceType": profile["sourceType"],
                }
            )
    return plans


def anysearch_profiles_for_taxonomy(taxonomy: dict[str, Any]) -> list[str]:
    needs = industry_need_flags(taxonomy)
    text = f"{taxonomy.get('group', '')} {taxonomy.get('industry', '')} {' '.join(taxonomy.get('keywords', ())) }"
    profiles = ["announcement"]
    if needs["price"] or needs["sales"] or needs["inventory"] or needs["order"]:
        profiles.append("industry_data")
    if re.search(r"政策|监管|医药|药|集采|军工|低空|商业航天|电网|新能源|光伏|地产|房地产|出口管制|稀土|钨", text, re.I):
        profiles.append("policy")
    if re.search(r"过剩|衰退|地产|房地产|光伏|机器人|低空|传统|亏损|风险|泡沫|高景气成长|周期", text, re.I):
        profiles.append("risk")
    return unique_strings(profiles)


def anysearch_domains_for_group(group: str, industry: str) -> list[str]:
    text = f"{group} {industry}"
    domains = ["finance", "business"]
    if any(word in text for word in ("能源", "电力", "光伏", "锂", "煤", "石油", "储能", "风电")):
        domains.append("energy")
    if any(word in text for word in ("医药", "医疗", "创新药", "CXO")):
        domains.append("health")
    if any(word in text for word in ("金融", "地产", "银行", "保险", "政策", "监管")):
        domains.append("legal")
    return unique_strings(domains)


def anysearch_sources_from_payload(payload: dict[str, Any], query_plan: dict[str, Any]) -> list[dict[str, Any]]:
    record = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
    results = record.get("results") if isinstance(record.get("results"), list) else []
    sources: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        title = clean_text(result.get("title"))
        url = clean_text(result.get("url"))
        if not title or not url:
            continue
        description = clean_text(result.get("description"))
        content = trim_text(result.get("content"), 700)
        source_type = "news"
        anysearch_source = clean_text(result.get("source"))
        quality_score = numeric(result.get("quality_score"))
        sources.append(
            compact_dict(
                {
                    "source": "AnySearch",
                    "query": query_plan["query"],
                    "title": title,
                    "url": url,
                    "publishedAt": clean_text(result.get("published_at")),
                    "summary": trim_text(f"{description} {content}", 900),
                    "sourceType": "news",
                    "signalType": "external_search",
                    "weight": SOURCE_WEIGHTS["news"],
                    "topic": query_plan["industry"],
                    "industry": query_plan["industry"],
                    "evidenceProfile": query_plan.get("profile"),
                    "anysearchTags": query_plan.get("tags"),
                    "anysearchContentTypes": query_plan.get("contentTypes"),
                    "anysearchFreshness": query_plan.get("freshness"),
                    "qualityScore": quality_score,
                    "anysearchScore": numeric(result.get("score")),
                    "anysearchSignalScores": result.get("signal_scores") if isinstance(result.get("signal_scores"), dict) else None,
                    "anysearchSource": anysearch_source,
                    "anysearchRequestId": clean_text(metadata.get("request_id")),
                    "cached": metadata.get("cached") if isinstance(metadata.get("cached"), bool) else False,
                }
            )
        )
    return sources


def searxng_sources_from_payload(payload: dict[str, Any], query_plan: dict[str, Any]) -> list[dict[str, Any]]:
    results = payload.get("results") if isinstance(payload.get("results"), list) else []
    sources: list[dict[str, Any]] = []
    for result in results[:2]:
        if not isinstance(result, dict):
            continue
        title = clean_text(result.get("title"))
        url = clean_text(result.get("url"))
        if not title or not url:
            continue
        content = clean_text(result.get("content")) or clean_text(result.get("snippet"))
        source_type = "official" if re.search(r"(sec\.gov|sse\.com\.cn|szse\.cn|hkexnews\.hk|gov\.cn|eastmoney\.com)", url, re.I) else "news"
        sources.append(
            compact_dict(
                {
                    "source": "SearXNG",
                    "query": query_plan["query"],
                    "title": title,
                    "url": url,
                    "publishedAt": clean_text(result.get("publishedDate") or result.get("published_date")),
                    "summary": trim_text(content, 700),
                    "sourceType": source_type,
                    "signalType": "external_search",
                    "weight": 1 if source_type == "news" else 2,
                    "topic": query_plan["industry"],
                    "industry": query_plan["industry"],
                    "evidenceProfile": query_plan.get("profile"),
                    "anysearchTags": query_plan.get("tags"),
                    "anysearchContentTypes": query_plan.get("contentTypes"),
                    "anysearchFreshness": query_plan.get("freshness"),
                    "anysearchScore": numeric(result.get("score")),
                    "anysearchSource": clean_text(result.get("engine")),
                    "cached": False,
                }
            )
        )
    return sources


def fetch_akshare() -> list[dict[str, Any]]:
    try:
        import akshare as ak  # type: ignore[import-not-found]
    except Exception:
        return []

    sources: list[dict[str, Any]] = []
    for label, fetcher in [
        ("futures_daily", lambda: fetch_akshare_futures_daily(ak)),
        ("spot_basis", lambda: fetch_akshare_spot_basis(ak)),
        ("hog_stats", lambda: fetch_akshare_hog_stats(ak)),
        ("cpca_auto", lambda: fetch_akshare_cpca_stats(ak)),
    ]:
        try:
            fetched = fetcher()
            print_source_summary(f"akshare_{label}", fetched)
            sources.extend(fetched)
        except Exception as exc:
            print(f"collector_warning akshare.{label}: {type(exc).__name__}: {str(exc)[:180]}")
    return sources


def fetch_akshare_futures_daily(ak: Any) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for symbol, label, topic, query, signal_type, source_type in AKSHARE_FUTURES_DAILY_SIGNALS:
        try:
            frame = ak.futures_zh_daily_sina(symbol=symbol)
        except Exception as exc:
            print(f"collector_warning akshare.futures_zh_daily_sina.{symbol}: {type(exc).__name__}: {str(exc)[:180]}")
            continue
        rows = frame_records(frame)
        if not rows:
            continue
        latest = rows[-1]
        previous = rows[-2] if len(rows) > 1 else {}
        close = numeric(latest.get("close"))
        previous_close = numeric(previous.get("close"))
        change = ratio_change(close, previous_close)
        date = clean_text(latest.get("date"))
        sources.append(
            {
                "source": "AKShare/Sina期货日线",
                "query": f"{topic} {query}",
                "title": f"{label} {date} 收盘 {number_text(close)}，结算 {number_text(latest.get('settle'))}，成交 {number_text(latest.get('volume'))}",
                "url": f"https://finance.sina.com.cn/futures/quotes/{symbol}.shtml",
                "publishedAt": iso_date(date),
                "summary": f"主连日线硬数据，较上一交易日收盘变化 {format_percent(change, ratio=True)}，持仓 {number_text(latest.get('hold'))}。",
                "sourceType": source_type,
                "signalType": signal_type,
                "weight": SOURCE_WEIGHTS[source_type],
            }
        )
    return sources


def fetch_akshare_spot_basis(ak: Any) -> list[dict[str, Any]]:
    target_symbols = list(AKSHARE_SPOT_BASIS_NAMES.keys())
    for date in recent_yyyymmdd_dates(skip_today=True, max_days=7):
        try:
            frame = ak.futures_spot_price(date=date, vars_list=target_symbols)
        except Exception as exc:
            print(f"collector_warning akshare.futures_spot_price.{date}: {type(exc).__name__}: {str(exc)[:180]}")
            continue
        rows = frame_records(frame)
        if rows:
            return [spot_basis_source(row) for row in rows if clean_text(row.get("symbol")) in AKSHARE_SPOT_BASIS_NAMES]
    return []


def spot_basis_source(row: dict[str, Any]) -> dict[str, Any]:
    symbol = clean_text(row.get("symbol"))
    name, topic, signal_type = AKSHARE_SPOT_BASIS_NAMES[symbol]
    date = clean_text(row.get("date"))
    dominant_contract = clean_text(row.get("dominant_contract"))
    return {
        "source": "AKShare/100ppi期现基差",
        "query": f"{topic} {name} 现货 期货 基差 价格",
        "title": f"{name} {date} 现货 {number_text(row.get('spot_price'))}，主力 {dominant_contract or '待验证'} {number_text(row.get('dominant_contract_price'))}",
        "url": f"https://www.100ppi.com/sf/day-{date}.html#{quote(symbol)}",
        "publishedAt": iso_date(date),
        "summary": f"期现硬数据：主力基差 {number_text(row.get('dom_basis'))}，基差率 {format_percent(row.get('dom_basis_rate'), ratio=True)}。",
        "sourceType": "hard_data",
        "signalType": signal_type,
        "weight": SOURCE_WEIGHTS["hard_data"],
    }


def fetch_akshare_hog_stats(ak: Any) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    try:
        frame = ak.futures_hog_core(symbol="外三元")
        rows = frame_records(frame)
        if rows:
            latest = rows[-1]
            previous = rows[-2] if len(rows) > 1 else {}
            value = numeric(latest.get("value"))
            previous_value = numeric(previous.get("value"))
            date = clean_text(latest.get("date"))
            sources.append(
                {
                    "source": "AKShare/生猪价格统计",
                    "query": "生猪养殖 猪价 外三元 现货 产能 周期",
                    "title": f"外三元猪价 {date} {number_text(value)} 元/斤，日变化 {format_percent(ratio_change(value, previous_value), ratio=True)}",
                    "url": "https://www.akshare.akfamily.xyz/data/futures/futures.html#futures-hog-core",
                    "publishedAt": iso_date(date),
                    "summary": "生猪现货价格硬数据，用于验证猪周期反转或衰退判断。",
                    "sourceType": "hard_data",
                    "signalType": "industry_stat",
                    "weight": SOURCE_WEIGHTS["hard_data"],
                }
            )
    except Exception as exc:
        print(f"collector_warning akshare.futures_hog_core: {type(exc).__name__}: {str(exc)[:180]}")

    try:
        frame = ak.index_hog_spot_price()
        rows = frame_records(frame)
        if rows:
            latest = rows[-1]
            date = clean_text(latest.get("日期"))
            sources.append(
                {
                    "source": "AKShare/生猪价格统计",
                    "query": "生猪养殖 猪价 指数 成交均价 成交均重",
                    "title": f"生猪价格指数 {date} 指数 {number_text(latest.get('指数'))}，成交均价 {number_text(latest.get('成交均价'))}",
                    "url": "https://www.akshare.akfamily.xyz/data/index/index.html#index-hog-spot-price",
                    "publishedAt": iso_date(date),
                    "summary": f"成交均重 {number_text(latest.get('成交均重'))}，4个月均线 {number_text(latest.get('4个月均线'))}。",
                    "sourceType": "hard_data",
                    "signalType": "industry_stat",
                    "weight": SOURCE_WEIGHTS["hard_data"],
                }
            )
    except Exception as exc:
        print(f"collector_warning akshare.index_hog_spot_price: {type(exc).__name__}: {str(exc)[:180]}")
    return sources


def fetch_akshare_cpca_stats(ak: Any) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for symbol, indicator, topic, query in CPCA_SIGNALS:
        try:
            frame = ak.car_market_total_cpca(symbol=symbol, indicator=indicator)
        except Exception as exc:
            print(f"collector_warning akshare.car_market_total_cpca.{symbol}.{indicator}: {type(exc).__name__}: {str(exc)[:180]}")
            continue
        latest = latest_year_month_row(frame)
        if not latest:
            continue
        month, current_year, current_value, previous_value = latest
        yoy = ratio_change(current_value, previous_value)
        sources.append(
            {
                "source": "AKShare/乘联会汽车统计",
                "query": f"{topic} {query}",
                "title": f"{symbol}{indicator} {current_year}年{month} {number_text(current_value)} 万辆，同比 {format_percent(yoy, ratio=True)}",
                "url": "http://data.cpcadata.com/TotalMarket",
                "publishedAt": f"{current_year}-{month.replace('月', '').zfill(2)}-01T00:00:00Z",
                "summary": f"乘联会月度行业统计，去年同期 {number_text(previous_value)} 万辆，用于验证汽车销量、出口和景气度。",
                "sourceType": "official",
                "signalType": "industry_stat",
                "weight": SOURCE_WEIGHTS["official"],
            }
        )
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
    if isinstance(frame, list):
        rows = frame
    else:
        try:
            rows = frame.to_dict("records")
        except Exception:
            return []
    groups: dict[str, dict[str, Any]] = {}
    company_sources: list[dict[str, Any]] = []
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
        normalized_code = normalize_a_share_code(code)
        if name and normalized_code and len(company_sources) < MAX_DYNAMIC_COMPANY_CANDIDATES:
            company_sources.append(
                {
                    "source": "BaoStock 公司池",
                    "query": f"A股 公司池 行业分类 财报候选 {industry}",
                    "title": f"{name}({normalized_code}) 属于 {industry}，纳入雷达动态财报候选",
                    "url": f"http://baostock.com/baostock/index.php/Python_API%E6%96%87%E6%A1%A3#{quote(normalized_code)}",
                    "summary": "BaoStock 行业分类提供的 A 股公司候选，用于后续东方财富财报/业绩预告补强，不直接作为财报事实。",
                    "sourceType": "official",
                    "signalType": "company_candidate",
                    "weight": SOURCE_WEIGHTS["official"],
                    "company": name,
                    "code": normalized_code,
                    "market": "A股",
                    "industry": industry,
                }
            )
    group_sources = [
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
    return group_sources + company_sources


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
    sources: list[dict[str, Any]] = fixture_financial_sources() + fixture_hard_data_sources() + fixture_dynamic_company_pool_sources()
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
    for index in range(35):
        topic, query, _source_type = TOPIC_QUERIES[index % len(TOPIC_QUERIES)]
        sources.append(
            {
                "source": "新浪行业板块",
                "query": query,
                "title": f"{topic} 新浪行业证据 {index + 1}：涨跌幅、成交额和领涨股更新",
                "url": f"https://sina.example.com/radar-evidence/{index + 1}",
                "publishedAt": "2026-05-19T00:00:00Z",
                "summary": f"{topic} 结构化行业行情样本。",
                "sourceType": "market",
                "weight": SOURCE_WEIGHTS["market"],
            }
        )
    sources.extend(fixture_anysearch_sources())
    return sources


def fixture_anysearch_sources() -> list[dict[str, Any]]:
    return [
        {
            "source": "AnySearch",
            "query": "存储芯片 HBM DRAM NAND 价格 库存 产能 销量 开工率 运价 装机 出口 同比 环比 A股 港股",
            "title": "存储芯片价格和 A/H 产业链订单线索被多源提及",
            "url": "https://anysearch.example.com/radar/storage-industry-data",
            "publishedAt": "2026-05-19T00:00:00Z",
            "summary": "AnySearch 外部搜索线索：用于发现存储芯片涨价、订单和公司候选，不替代财报或价格硬数据。",
            "sourceType": "news",
            "signalType": "external_search",
            "weight": SOURCE_WEIGHTS["news"],
            "topic": "存储芯片",
            "industry": "存储芯片",
            "evidenceProfile": "industry_data",
            "anysearchTags": ["finance.market", "business.industry"],
            "anysearchContentTypes": ["data", "news", "web"],
            "anysearchFreshness": "week",
            "qualityScore": 0.91,
            "anysearchScore": 0.86,
            "anysearchSignalScores": {"freshness": 13, "authority": 33},
            "anysearchSource": "data",
            "anysearchRequestId": "req_fixture_storage_data",
            "cached": True,
        },
        {
            "source": "AnySearch",
            "query": "存储芯片 HBM DRAM NAND 财报 业绩预告 业绩快报 经营现金流 毛利率 净利润 营收 订单 A股 港股",
            "title": "存储链 A/H 公司业绩和订单搜索线索",
            "url": "https://anysearch.example.com/radar/storage-announcement",
            "publishedAt": "2026-05-19T00:00:00Z",
            "summary": "AnySearch 外部搜索线索：用于发现公司公告、业绩预告和订单变化，仍需交易所公告或财报数据交叉验证。",
            "sourceType": "news",
            "signalType": "external_search",
            "weight": SOURCE_WEIGHTS["news"],
            "topic": "存储芯片",
            "industry": "存储芯片",
            "evidenceProfile": "announcement",
            "anysearchTags": ["finance.company", "business.company"],
            "anysearchContentTypes": ["doc", "data", "news", "web"],
            "anysearchFreshness": "month",
            "qualityScore": 0.86,
            "anysearchScore": 0.8,
            "anysearchSignalScores": {"freshness": 9, "authority": 28},
            "anysearchSource": "doc",
            "anysearchRequestId": "req_fixture_storage_announcement",
            "cached": False,
        },
        {
            "source": "AnySearch",
            "query": "创新药 出海 license out 审批 政策 监管 文件 出口管制 集采 补贴 审批 核准 A股 港股",
            "title": "创新药出海和审批进展形成补充搜索线索",
            "url": "https://anysearch.example.com/radar/biotech",
            "publishedAt": "2026-05-19T00:00:00Z",
            "summary": "AnySearch 外部搜索线索：用于发现 BD 交易、审批和商业化变化，需要财报公告交叉验证。",
            "sourceType": "news",
            "signalType": "external_search",
            "weight": SOURCE_WEIGHTS["news"],
            "topic": "创新药/医疗服务",
            "industry": "创新药/医疗服务",
            "evidenceProfile": "policy",
            "anysearchTags": ["legal.regulation", "business.policy"],
            "anysearchContentTypes": ["doc", "news", "web"],
            "anysearchFreshness": "month",
            "qualityScore": 0.88,
            "anysearchScore": 0.82,
            "anysearchSignalScores": {"freshness": 8, "authority": 35},
            "anysearchSource": "doc",
            "anysearchRequestId": "req_fixture_biotech",
            "cached": True,
        },
        {
            "source": "AnySearch",
            "query": "机器人 具身智能 亏损 过剩 停牌 异动 需求下滑 库存高企 价格下跌 减值 A股 港股",
            "title": "机器人概念交易过热和业绩兑现风险搜索线索",
            "url": "https://anysearch.example.com/radar/robot-risk",
            "publishedAt": "2026-05-19T00:00:00Z",
            "summary": "AnySearch 外部搜索线索：用于发现风险事件、交易异动和产业兑现压力，不能单独证明泡沫或衰退。",
            "sourceType": "news",
            "signalType": "external_search",
            "weight": SOURCE_WEIGHTS["news"],
            "topic": "机器人/具身智能",
            "industry": "机器人/具身智能",
            "evidenceProfile": "risk",
            "anysearchTags": ["finance.risk", "business.news"],
            "anysearchContentTypes": ["news", "web", "doc"],
            "anysearchFreshness": "week",
            "qualityScore": 0.76,
            "anysearchScore": 0.7,
            "anysearchSignalScores": {"freshness": 12, "authority": 18},
            "anysearchSource": "news",
            "anysearchRequestId": "req_fixture_robot_risk",
            "cached": False,
        },
    ]


def fixture_financial_sources() -> list[dict[str, Any]]:
    return [
        {
            "source": "东方财富业绩报表",
            "query": "A股 财报 营收 净利润 毛利率 经营现金流 化学制药",
            "title": "百济神州(688235.SH) 2026-03-31 营收同比 31.02%，净利润同比 1801.30%",
            "url": "https://data.eastmoney.com/bbsj/202603/yjbb.html#688235.SH",
            "publishedAt": "2026-05-07T00:00:00Z",
            "summary": "公司级财报：营收 10,544,044,000.00，净利润 1,607,782,000.00，毛利率待验证，每股经营现金流待验证，行业 化学制药。",
            "sourceType": "announcement",
            "signalType": "financial_metric",
            "weight": SOURCE_WEIGHTS["announcement"],
            "factType": "financial",
            "company": "百济神州",
            "code": "688235.SH",
            "market": "A股",
            "industry": "化学制药",
            "metric": "净利润",
            "value": 1607782000,
            "yoy": 1801.3,
            "metrics": {
                "revenue": 10544044000,
                "netProfit": 1607782000,
                "revenueYoy": 31.02,
                "netProfitYoy": 1801.3,
            },
        },
        {
            "source": "东方财富业绩预告",
            "query": "A股 业绩预告 净利润 预增 包装材料",
            "title": "新天力(920218.BJ) 2026-06-30 略增，净利润同比 1.00% 至 8.05%",
            "url": "https://data.eastmoney.com/bbsj/202606/yjyg.html#920218.BJ",
            "publishedAt": "2026-05-18T00:00:00Z",
            "summary": "预计2026年1-6月归属于上市公司股东的净利润盈利:4,300万元至4,600万元。",
            "sourceType": "announcement",
            "signalType": "financial_metric",
            "weight": SOURCE_WEIGHTS["announcement"],
            "factType": "financial",
            "company": "新天力",
            "code": "920218.BJ",
            "market": "A股",
            "industry": "包装材料",
            "metric": "净利润预告",
            "value": 46000000,
            "yoy": 8.05,
            "metrics": {
                "forecastProfitLower": 43000000,
                "forecastProfitUpper": 46000000,
                "forecastYoyLower": 1,
                "forecastYoyUpper": 8.05,
            },
        },
        {
            "source": "东方财富业绩报表",
            "query": "A股 财报 营收 净利润 毛利率 经营现金流 存储芯片",
            "title": "德明利(001309.SZ) 2026-03-31 营收同比 88.00%，净利润同比 494.30%",
            "url": "https://data.eastmoney.com/bbsj/202603/yjbb.html#001309.SZ",
            "publishedAt": "2026-05-01T00:00:00Z",
            "summary": "公司级财报：存储芯片链公司收入和利润改善，仍需现货价格与库存交叉验证。",
            "sourceType": "announcement",
            "signalType": "financial_metric",
            "weight": SOURCE_WEIGHTS["announcement"],
            "factType": "financial",
            "company": "德明利",
            "code": "001309.SZ",
            "market": "A股",
            "industry": "存储芯片",
            "metric": "净利润",
            "value": 420000000,
            "yoy": 494.3,
            "metrics": {"revenueYoy": 88.0, "netProfitYoy": 494.3},
        },
        {
            "source": "东方财富业绩报表",
            "query": "A股 财报 营收 净利润 毛利率 经营现金流 电网设备",
            "title": "杭电股份(603618.SH) 2026-03-31 营收同比 18.20%，净利润同比 42.50%",
            "url": "https://data.eastmoney.com/bbsj/202603/yjbb.html#603618.SH",
            "publishedAt": "2026-05-01T00:00:00Z",
            "summary": "公司级财报：营收和净利润改善，行业 电网设备。",
            "sourceType": "announcement",
            "signalType": "financial_metric",
            "weight": SOURCE_WEIGHTS["announcement"],
            "factType": "financial",
            "company": "杭电股份",
            "code": "603618.SH",
            "market": "A股",
            "industry": "电网设备",
            "metric": "净利润",
            "value": 100000000,
            "yoy": 42.5,
            "metrics": {"revenueYoy": 18.2, "netProfitYoy": 42.5},
        },
        {
            "source": "东方财富业绩报表",
            "query": "A股 财报 营收 净利润 毛利率 经营现金流 房地产开发",
            "title": "万科A(000002.SZ) 2026-03-31 营收同比 -18.40%，净利润同比 -62.10%",
            "url": "https://data.eastmoney.com/bbsj/202603/yjbb.html#000002.SZ",
            "publishedAt": "2026-05-01T00:00:00Z",
            "summary": "公司级财报：房地产开发收入和利润继续承压，用于地产链衰退验证。",
            "sourceType": "announcement",
            "signalType": "financial_metric",
            "weight": SOURCE_WEIGHTS["announcement"],
            "factType": "financial",
            "company": "万科A",
            "code": "000002.SZ",
            "market": "A股",
            "industry": "房地产开发",
            "metric": "净利润",
            "value": -3500000000,
            "yoy": -62.1,
            "metrics": {"revenueYoy": -18.4, "netProfitYoy": -62.1},
        },
        {
            "source": "东方财富业绩报表",
            "query": "A股 财报 营收 净利润 毛利率 经营现金流 白酒",
            "title": "贵州茅台(600519.SH) 2026-03-31 营收同比 10.20%，净利润同比 13.30%",
            "url": "https://data.eastmoney.com/bbsj/202603/yjbb.html#600519.SH",
            "publishedAt": "2026-05-01T00:00:00Z",
            "summary": "公司级财报：白酒龙头仍保持正增长，但批价和渠道库存需继续验证。",
            "sourceType": "announcement",
            "signalType": "financial_metric",
            "weight": SOURCE_WEIGHTS["announcement"],
            "factType": "financial",
            "company": "贵州茅台",
            "code": "600519.SH",
            "market": "A股",
            "industry": "白酒",
            "metric": "净利润",
            "value": 24000000000,
            "yoy": 13.3,
            "metrics": {"revenueYoy": 10.2, "netProfitYoy": 13.3},
        },
        {
            "source": "东方财富业绩报表",
            "query": "A股 财报 营收 净利润 毛利率 经营现金流 生猪养殖",
            "title": "牧原股份(002714.SZ) 2026-03-31 营收同比 21.40%，净利润同比 138.60%",
            "url": "https://data.eastmoney.com/bbsj/202603/yjbb.html#002714.SZ",
            "publishedAt": "2026-05-01T00:00:00Z",
            "summary": "公司级财报：猪价回升带动养殖利润修复，仍需产能和猪价验证。",
            "sourceType": "announcement",
            "signalType": "financial_metric",
            "weight": SOURCE_WEIGHTS["announcement"],
            "factType": "financial",
            "company": "牧原股份",
            "code": "002714.SZ",
            "market": "A股",
            "industry": "生猪养殖",
            "metric": "净利润",
            "value": 2800000000,
            "yoy": 138.6,
            "metrics": {"revenueYoy": 21.4, "netProfitYoy": 138.6},
        },
    ]


def fixture_hard_data_sources() -> list[dict[str, Any]]:
    today = "2026-05-18"
    return [
        {
            "source": "AKShare/Sina期货日线",
            "query": "锂电储能 碳酸锂 期货 价格 库存 供需",
            "title": f"碳酸锂主连 {today} 收盘 192,180.00，结算 191,500.00，成交 208,152.00",
            "url": "https://finance.sina.com.cn/futures/quotes/LC0.shtml",
            "publishedAt": f"{today}T00:00:00Z",
            "summary": "主连日线硬数据，较上一交易日收盘变化 1.79%，持仓 466,957.00。",
            "sourceType": "hard_data",
            "signalType": "commodity_price",
            "weight": SOURCE_WEIGHTS["hard_data"],
        },
        {
            "source": "AKShare/100ppi期现基差",
            "query": "光伏产业链 多晶硅 现货 期货 基差 价格",
            "title": "多晶硅 20260518 现货 38,000.00，主力 ps2606 36,930.00",
            "url": "https://www.100ppi.com/sf/day-20260518.html#PS",
            "publishedAt": "2026-05-18T00:00:00Z",
            "summary": "期现硬数据：主力基差 1,070.00，基差率 2.82%。",
            "sourceType": "hard_data",
            "signalType": "commodity_price",
            "weight": SOURCE_WEIGHTS["hard_data"],
        },
        {
            "source": "AKShare/乘联会汽车统计",
            "query": "汽车/智能驾驶 汽车出口 销量 同比",
            "title": "狭义乘用车出口 2026年4月 77.02 万辆，同比 82.16%",
            "url": "http://data.cpcadata.com/TotalMarket",
            "publishedAt": "2026-04-01T00:00:00Z",
            "summary": "乘联会月度行业统计，去年同期 42.28 万辆，用于验证汽车销量、出口和景气度。",
            "sourceType": "official",
            "signalType": "industry_stat",
            "weight": SOURCE_WEIGHTS["official"],
        },
        {
            "source": "AKShare/生猪价格统计",
            "query": "生猪养殖 猪价 外三元 现货 产能 周期",
            "title": "外三元猪价 2026-05-19 9.65 元/斤，日变化 0.10%",
            "url": "https://www.akshare.akfamily.xyz/data/futures/futures.html#futures-hog-core",
            "publishedAt": "2026-05-19T00:00:00Z",
            "summary": "生猪现货价格硬数据，用于验证猪周期反转或衰退判断。",
            "sourceType": "hard_data",
            "signalType": "industry_stat",
            "weight": SOURCE_WEIGHTS["hard_data"],
        },
        {
            "source": "东方财富行业指数",
            "query": "航运物流 航运 BDI 运价 指数",
            "title": "波罗的海干散货指数(BDI) 2026-05-18 最新值 3,092.00，日变化 -1.87%",
            "url": "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_INDUSTRY_INDEX",
            "publishedAt": "2026-05-18T00:00:00Z",
            "summary": "航运物流硬数据：3个月变化 49.88%，1年变化 122.77%，关联板块 航运港口。",
            "sourceType": "hard_data",
            "signalType": "freight_rate",
            "weight": SOURCE_WEIGHTS["hard_data"],
        },
        {
            "source": "公开批价统计",
            "query": "白酒 批价 库存 动销 价格",
            "title": "白酒批价样本 2026-05-18 高端酒批价环比小幅下行",
            "url": "https://example.com/baijiu-price-fixture",
            "publishedAt": "2026-05-18T00:00:00Z",
            "summary": "批价和库存线索用于验证白酒需求和渠道压力，不单独构成增长结论。",
            "sourceType": "hard_data",
            "signalType": "commodity_price",
            "weight": SOURCE_WEIGHTS["hard_data"],
        },
    ]


def fixture_dynamic_company_pool_sources() -> list[dict[str, Any]]:
    return baostock_industry_sources(
        [
            {"industry": "电网设备", "code": "sh.603618", "code_name": "杭电股份"},
            {"industry": "电气设备", "code": "sz.300820", "code_name": "英杰电气"},
            {"industry": "房地产开发", "code": "sz.000002", "code_name": "万科A"},
            {"industry": "白酒", "code": "sh.600519", "code_name": "贵州茅台"},
            {"industry": "生猪养殖", "code": "sz.002714", "code_name": "牧原股份"},
            {"industry": "存储芯片", "code": "sz.001309", "code_name": "德明利"},
        ]
    )


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


def single_structured_fixture_sources() -> list[dict[str, Any]]:
    sources = google_only_fixture_sources()
    for index in range(40):
        topic, query, _source_type = TOPIC_QUERIES[index % len(TOPIC_QUERIES)]
        sources.append(
            {
                "source": "BaoStock 行业分类",
                "query": query,
                "title": f"{topic} 行业分类覆盖 {20 + index} 家上市公司",
                "url": f"https://baostock.example.com/single-structured/{index + 1}",
                "publishedAt": "2026-05-19T00:00:00Z",
                "summary": f"{topic} 结构化行业分类样本。",
                "sourceType": "official",
                "weight": SOURCE_WEIGHTS["official"],
            }
        )
    return sources


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
    signal_type = clean_text(source.get("signalType"))
    if signal_type:
        item["signalType"] = signal_type
    for key in ("factType", "company", "code", "market", "industry", "metric"):
        text_value = clean_text(source.get(key))
        if text_value:
            item[key] = text_value
    for key in ("topic", "evidenceProfile", "anysearchFreshness", "anysearchSource", "anysearchRequestId"):
        text_value = clean_text(source.get(key))
        if text_value:
            item[key] = text_value
    for key in ("anysearchTags", "anysearchContentTypes", "anysearchSignalScores"):
        if key in source and source.get(key) is not None:
            item[key] = source.get(key)
    for key in ("value", "yoy", "metrics"):
        if key in source and source.get(key) is not None:
            item[key] = source.get(key)
    for key in ("qualityScore", "anysearchScore", "cached"):
        if key in source and source.get(key) is not None:
            item[key] = source.get(key)
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
    text = source_text(source)
    is_google_news = source.get("source") == "Google News"
    data_signal = 0 if is_google_news else 8 if any(word in text for word in DATA_SIGNAL_WORDS) else 0
    risk_signal = 4 if any(word in text for word in RISK_SIGNAL_WORDS) else 0
    topic_signal = 10 if any(word.lower() in text.lower() for word in TOPIC_SIGNAL_WORDS) else 0
    anysearch_bonus = anysearch_source_bonus(source)
    return max(0, int(source.get("weight", 2)) * 10 + data_signal + risk_signal + topic_signal + anysearch_bonus)


def anysearch_source_bonus(source: dict[str, Any]) -> int:
    if source.get("source") != "AnySearch":
        return 0
    bonus = 0
    quality_score = numeric(source.get("qualityScore"))
    if quality_score is not None:
        normalized_quality = quality_score / 100 if quality_score > 1 else quality_score
        if normalized_quality >= 0.9:
            bonus += 14
        elif normalized_quality >= 0.85:
            bonus += 10
        elif normalized_quality >= 0.75:
            bonus += 5
        elif normalized_quality < 0.55:
            bonus -= 12
    anysearch_source = clean_text(source.get("anysearchSource")).lower()
    anysearch_content_types = {clean_text(item).lower() for item in source.get("anysearchContentTypes", []) if clean_text(item)}
    if anysearch_source in ("data", "doc") or anysearch_content_types.intersection({"data", "doc"}):
        bonus += 8
    elif anysearch_source == "academic" or "academic" in anysearch_content_types:
        bonus += 6
    elif anysearch_source == "news" or "news" in anysearch_content_types:
        bonus += 3
    elif anysearch_source == "web" or "web" in anysearch_content_types:
        bonus += 1
    freshness_bonus = published_at_bonus(clean_text(source.get("publishedAt")))
    bonus += freshness_bonus
    signal_scores = source.get("anysearchSignalScores")
    if isinstance(signal_scores, dict):
        authority = numeric(signal_scores.get("authority"))
        freshness = numeric(signal_scores.get("freshness"))
        if authority is not None and authority >= 25:
            bonus += 4
        if freshness is not None and freshness >= 10:
            bonus += 3
    return bonus


def published_at_bonus(value: str) -> int:
    if not value:
        return 0
    normalized = value.replace("Z", "+00:00")
    try:
        published = datetime.fromisoformat(normalized)
    except ValueError:
        return 0
    if published.tzinfo is None:
        published = published.replace(tzinfo=timezone.utc)
    age_days = (datetime.now(timezone.utc) - published.astimezone(timezone.utc)).days
    if age_days <= 7:
        return 8
    if age_days <= 30:
        return 4
    if age_days <= 90:
        return 1
    return 0


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
    google_items = [source for source in sorted_items if source.get("source") == "Google News"]
    non_google_items = [source for source in sorted_items if source.get("source") != "Google News"]
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    max_google_news = max(1, int(limit * MAX_GOOGLE_NEWS_SHARE))
    max_per_source = max(1, int(limit * MAX_SINGLE_SOURCE_SHARE))
    reserved_google_news = min(len(google_items), MIN_GOOGLE_NEWS_SOURCES, max_google_news) if len(non_google_items) >= MIN_STRUCTURED_SOURCES else 0
    non_google_limit = limit - reserved_google_news
    minimum_by_type = {
        "hard_data": 24,
        "official": 18,
        "announcement": 8,
        "market": 28,
        "research": 6,
    }
    max_by_type = {
        "announcement": max(24, int(limit * 0.45)),
        "market": max(28, int(limit * 0.34)),
        "news": max_google_news,
    }
    anysearch_profile_minimum = max(4, min(20, int(limit * 0.09)))
    for profile in ("industry_data", "announcement", "policy", "risk"):
        for item in [source for source in non_google_items if source.get("source") == "AnySearch" and source.get("evidenceProfile") == profile][:anysearch_profile_minimum]:
            add_selected(item, selected, seen, non_google_limit, max_google_news, max_per_source, max_by_type)
    for source_type, minimum in minimum_by_type.items():
        for item in [source for source in non_google_items if source.get("sourceType") == source_type][:minimum]:
            add_selected(item, selected, seen, non_google_limit, max_google_news, max_per_source, max_by_type)
    for item in non_google_items:
        add_selected(item, selected, seen, non_google_limit, max_google_news, max_per_source, max_by_type)
    max_google_news = reserved_google_news if reserved_google_news else min(max_google_news, len(selected))
    for item in google_items:
        add_selected(item, selected, seen, limit, max_google_news, max_per_source, max_by_type)
    for item in non_google_items:
        add_selected(item, selected, seen, limit, max_google_news, max_per_source, max_by_type)
    return selected


def add_selected(
    item: dict[str, Any],
    selected: list[dict[str, Any]],
    seen: set[str],
    limit: int,
    max_google_news: int,
    max_per_source: int,
    max_by_type: dict[str, int] | None = None,
) -> None:
    if len(selected) >= limit:
        return
    if item.get("source") == "Google News" and count_where(selected, lambda source: source.get("source") == "Google News") >= max_google_news:
        return
    source_type = clean_text(item.get("sourceType"))
    if max_by_type and source_type in max_by_type and count_where(selected, lambda source: source.get("sourceType") == source_type) >= max_by_type[source_type]:
        return
    source_name = item.get("source")
    if source_name and count_where(selected, lambda source: source.get("source") == source_name) >= max_per_source:
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


def financial_facts_from_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    for source in sources:
        if source.get("factType") != "financial" and source.get("signalType") != "financial_metric":
            continue
        company = clean_text(source.get("company"))
        if not company:
            continue
        facts.append(
            compact_dict(
                {
                    "source": source.get("source"),
                    "sourceId": source.get("url"),
                    "company": company,
                    "code": source.get("code"),
                    "market": source.get("market"),
                    "industry": source.get("industry"),
                    "metric": source.get("metric") or "财务指标",
                    "value": source.get("value"),
                    "yoy": source.get("yoy"),
                    "metrics": source.get("metrics"),
                    "publishedAt": source.get("publishedAt"),
                    "title": source.get("title"),
                }
            )
        )
    return facts[:160]


def industry_facts_from_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    for source in sources:
        signal_type = clean_text(source.get("signalType"))
        if not signal_type or signal_type == "financial_metric":
            continue
        facts.append(
            compact_dict(
                {
                    "source": source.get("source"),
                    "sourceId": source.get("url"),
                    "industry": source.get("industry") or infer_topic_from_text(source_text(source)),
                    "signalType": signal_type,
                    "title": source.get("title"),
                    "summary": source.get("summary"),
                    "publishedAt": source.get("publishedAt"),
                    "sourceType": source.get("sourceType"),
                }
            )
        )
    return facts[:180]


def indicator_values_from_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source in sources:
        metrics = source.get("metrics")
        if not isinstance(metrics, dict):
            continue
        company = clean_text(source.get("company"))
        code = clean_text(source.get("code"))
        period = clean_text(source.get("period")) or clean_text(source.get("publishedAt"))[:10]
        for metric_name, metric_value in metrics.items():
            value = numeric(metric_value)
            if value is None:
                continue
            indicator_name = clean_text(metric_name)
            key = f"{code or company}|{indicator_name}|{period}|{source.get('source')}"
            if key in seen:
                continue
            seen.add(key)
            values.append(
                compact_dict(
                    {
                        "entityType": "company" if company or code else "industry",
                        "company": company,
                        "code": code,
                        "market": source.get("market"),
                        "industry": source.get("industry"),
                        "indicatorName": indicator_name,
                        "value": value,
                        "period": period,
                        "source": source.get("source"),
                        "sourceId": source.get("url"),
                        "sourceType": source.get("sourceType"),
                        "signalType": source.get("signalType"),
                    }
                )
            )
    return values[:500]


def company_candidates_from_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}
    for source in sources:
        company = clean_text(source.get("company"))
        if not company:
            continue
        if "ST" in company.upper():
            continue
        key = clean_text(source.get("code")) or company
        current = candidates.setdefault(
            key,
            {
                "company": company,
                "code": source.get("code"),
                "market": source.get("market"),
                "industry": source.get("industry"),
                "triggerEvidence": source.get("title"),
                "evidenceStrength": 0,
                "sourceTypes": [],
            },
        )
        current["evidenceStrength"] = int(current.get("evidenceStrength") or 0) + SOURCE_WEIGHTS.get(clean_text(source.get("sourceType")), 2)
        current["sourceTypes"] = unique_strings([*current.get("sourceTypes", []), clean_text(source.get("sourceType"))])
    return sorted(candidates.values(), key=lambda item: int(item.get("evidenceStrength") or 0), reverse=True)[:180]


def industry_packets_from_sources(
    sources: list[dict[str, Any]],
    financial_facts: list[dict[str, Any]],
    industry_facts: list[dict[str, Any]],
    company_candidates: list[dict[str, Any]],
    indicator_values: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    packets: list[dict[str, Any]] = []
    indicators = indicator_values or []
    for taxonomy in FINE_INDUSTRY_TAXONOMY:
        industry = taxonomy["industry"]
        keywords = tuple(taxonomy["keywords"])
        matched_sources = [source for source in sources if industry_matches(source_match_text(source), industry, keywords)]
        matched_financial = [fact for fact in financial_facts if industry_matches(f"{fact.get('industry', '')} {fact.get('title', '')} {fact.get('company', '')}", industry, keywords)]
        matched_industry = [fact for fact in industry_facts if industry_matches(f"{fact.get('industry', '')} {fact.get('title', '')} {fact.get('summary', '')}", industry, keywords)]
        matched_companies = [candidate for candidate in company_candidates if industry_matches(f"{candidate.get('industry', '')} {candidate.get('triggerEvidence', '')} {candidate.get('company', '')}", industry, keywords)]
        matched_indicators = [indicator for indicator in indicators if industry_matches(f"{indicator.get('industry', '')} {indicator.get('company', '')} {indicator.get('indicatorName', '')}", industry, keywords)]
        evidence_types = unique_strings(clean_text(source.get("sourceType")) for source in matched_sources)
        signal_types = unique_strings(clean_text(source.get("signalType")) for source in matched_sources if source.get("signalType"))
        packet_sources = sorted(matched_sources, key=lambda source: int(source.get("score") or 0), reverse=True)
        packet = {
            "group": taxonomy["group"],
            "industry": industry,
            "status": "scanned",
            "evidenceHash": industry_evidence_hash(industry, packet_sources, matched_financial, matched_industry, matched_companies),
            "sourceCount": len(matched_sources),
            "evidenceTypes": evidence_types,
            "signalTypes": signal_types,
            "themes": list(taxonomy.get("themes", ())),
            "sources": [
                compact_dict(
                    {
                        "source": source.get("source"),
                        "title": source.get("title"),
                        "url": source.get("url"),
                        "sourceType": source.get("sourceType"),
                        "signalType": source.get("signalType"),
                        "publishedAt": source.get("publishedAt"),
                    }
                )
                for source in packet_sources[:12]
            ],
            "financialFacts": matched_financial[:10],
            "industryFacts": matched_industry[:10],
            "indicatorValues": matched_indicators[:20],
            "companyCandidates": matched_companies[:10],
            "evidenceGaps": industry_evidence_gaps(taxonomy, matched_sources, matched_financial, matched_industry),
        }
        packets.append(packet)
    return packets


def industry_matches(text: str, industry: str, keywords: tuple[str, ...]) -> bool:
    cleaned = clean_text(text)
    lowered = cleaned.lower()
    if industry.lower() in lowered:
        return True
    hits = [keyword for keyword in keywords if keyword_matches_text(keyword, cleaned)]
    if not hits:
        return False
    # Very short Latin theme words such as AR/VR/MR/AI are discovery hints, not
    # enough to attach a hard-data item to an industry packet. Without this,
    # "AKShare" matched the "AR" keyword and leaked commodity data into
    # consumer-electronics packets.
    strong_hits = [keyword for keyword in hits if is_strong_industry_keyword(keyword)]
    return bool(strong_hits)


def keyword_matches_text(keyword: str, text: str) -> bool:
    cleaned_keyword = clean_text(keyword)
    if not cleaned_keyword:
        return False
    if re.fullmatch(r"[A-Za-z0-9]{1,3}", cleaned_keyword):
        return bool(re.search(rf"(?<![A-Za-z0-9]){re.escape(cleaned_keyword)}(?![A-Za-z0-9])", text, re.I))
    return cleaned_keyword.lower() in text.lower()


def is_strong_industry_keyword(keyword: str) -> bool:
    cleaned_keyword = clean_text(keyword)
    if cleaned_keyword in WEAK_INDUSTRY_KEYWORDS:
        return False
    if re.fullmatch(r"[A-Za-z0-9]{1,3}", cleaned_keyword):
        return False
    return len(cleaned_keyword) >= 2


def industry_evidence_hash(industry: str, sources: list[dict[str, Any]], financial_facts: list[dict[str, Any]], industry_facts: list[dict[str, Any]], company_candidates: list[dict[str, Any]]) -> str:
    source_payload = [f"{source.get('url', '')}|{source.get('title', '')}|{source.get('publishedAt', '')}" for source in sources[:24]]
    fact_payload = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in [*financial_facts[:12], *industry_facts[:12], *company_candidates[:12]]]
    payload = "\n".join([industry, *sorted(source_payload), *sorted(fact_payload)])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def industry_evidence_gaps(taxonomy: dict[str, Any], sources: list[dict[str, Any]], financial_facts: list[dict[str, Any]], industry_facts: list[dict[str, Any]]) -> list[str]:
    signal_types = {clean_text(source.get("signalType")) for source in sources}
    source_types = {clean_text(source.get("sourceType")) for source in sources}
    source_names = {clean_text(source.get("source")) for source in sources}
    needs = industry_need_flags(taxonomy)
    gaps: list[str] = []
    if not financial_facts and "financial_metric" not in signal_types:
        gaps.append("缺财报")
    has_price_signal = any(signal in signal_types for signal in ("commodity_price", "freight_rate")) or any(
        clean_text(source.get("signalType")) == "industry_stat"
        and re.search(r"价格|现货|期货|猪价|批价|运价|基差|收盘|结算|元/斤|元/吨", source_text(source), re.I)
        for source in sources
    )
    if needs["price"] and not has_price_signal:
        gaps.append("缺价格")
    if needs["sales"] and not industry_facts and "industry_stat" not in signal_types:
        gaps.append("缺销量")
    if needs["order"] and not any(re.search(r"订单|合同|在手订单|中标", source_text(source), re.I) for source in sources):
        gaps.append("缺订单")
    if needs["inventory"] and not any(re.search(r"库存|库容|去库|累库", source_text(source), re.I) for source in sources):
        gaps.append("缺库存")
    if len(source_types - {""}) < 2 and len(source_names - {""}) < 2:
        gaps.append("缺多源验证")
    return gaps[:4]


def industry_need_flags(taxonomy: dict[str, Any]) -> dict[str, bool]:
    industry_text = f"{taxonomy.get('group', '')} {taxonomy.get('industry', '')} {' '.join(taxonomy.get('keywords', ())) }"
    return {
        "price": bool(re.search(r"有色|铜|铝|稀土|钨|锂|光伏|硅料|钢铁|水泥|建材|玻璃|生猪|猪价|航运|运价|煤炭|石油|化工|农产品|存储|DRAM|NAND|HBM|白酒|批价", industry_text, re.I)),
        "sales": bool(re.search(r"汽车|消费|家电|纺织|医药商业|药店|医疗器械|航运|港口|航空|机场|旅游|酒店|博彩|互联网|电商|地产|房地产|销售面积", industry_text, re.I)),
        "order": bool(re.search(r"电网|设备|材料|军工|航空航天|商业航天|机器人|具身|船舶|工程机械|工业母机|光模块|PCB|服务器|低空|eVTOL|CXO", industry_text, re.I)),
        "inventory": bool(re.search(r"存储|DRAM|NAND|HBM|锂|光伏|硅料|钢铁|水泥|煤炭|化工|生猪|白酒|库存", industry_text, re.I)),
    }


def evidence_quality(sources: list[dict[str, Any]]) -> dict[str, Any]:
    source_count = len(sources)
    by_source = count_by(sources, "source")
    by_type = count_by(sources, "sourceType")
    google_count = by_source.get("Google News", 0)
    structured_count = count_where(sources, lambda source: source.get("source") != "Google News" and source.get("sourceType") != "news")
    largest_source_count = max(by_source.values(), default=0)
    return {
        "sourceCount": source_count,
        "uniqueSources": len(by_source),
        "largestSourceShare": round(largest_source_count / source_count, 4) if source_count else 0,
        "googleNewsCount": google_count,
        "googleNewsShare": round(google_count / source_count, 4) if source_count else 0,
        "structuredCount": structured_count,
        "structuredShare": round(structured_count / source_count, 4) if source_count else 0,
        "bySource": by_source,
        "byType": by_type,
        "bySignalType": {key: value for key, value in count_by(sources, "signalType").items() if key != "unknown"},
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


def source_text(source: dict[str, Any]) -> str:
    return " ".join(clean_text(source.get(key)) for key in ("source", "query", "title", "summary"))


def source_match_text(source: dict[str, Any]) -> str:
    return " ".join(clean_text(source.get(key)) for key in ("industry", "company", "title", "summary"))


def evidence_hash(sources: list[dict[str, Any]]) -> str:
    payload = "\n".join(
        sorted(f"{item.get('url', '')}|{item.get('title', '')}|{item.get('source', '')}|{item.get('query', '')}|{item.get('publishedAt', '')}" for item in sources)
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def read_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; CSTDAlphaEvidenceBot/1.0; +https://alpha.custard.top)"})
    with urlopen(request, timeout=20) as response:
        data = response.read()
        content_type = response.headers.get("content-type", "")
        charset = ""
        if "charset=" in content_type:
            charset = content_type.split("charset=", 1)[1].split(";", 1)[0].strip()
        if charset.lower() in ("iso-8859-1", "latin1", "latin-1"):
            charset = ""
        for encoding in ["utf-8", "gb18030", charset]:
            if not encoding:
                continue
            try:
                return data.decode(encoding)
            except (LookupError, UnicodeDecodeError):
                continue
        return data.decode("utf-8", errors="ignore")


def read_json(url: str) -> dict[str, Any]:
    return json.loads(read_text(url))


def post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None, timeout: int = 25) -> dict[str, Any]:
    request_headers = {
        "User-Agent": "Mozilla/5.0 (compatible; CSTDAlphaEvidenceBot/1.0; +https://alpha.custard.top)",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    request_headers.update(headers or {})
    request = Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=request_headers, method="POST")
    with urlopen(request, timeout=timeout) as response:
        data = response.read()
    return json.loads(data.decode("utf-8"))


def parse_js_object(text: str) -> dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("missing JavaScript object")
    payload = text[start : end + 1]
    parsed = json.loads(payload)
    return parsed if isinstance(parsed, dict) else {}


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


def frame_records(frame: Any) -> list[dict[str, Any]]:
    try:
        return frame.to_dict("records")
    except Exception:
        return []


def latest_year_month_row(frame: Any) -> tuple[str, int, float, float] | None:
    rows = frame_records(frame)
    if not rows:
        return None
    year_columns = sorted(
        [clean_text(column) for column in getattr(frame, "columns", []) if re.fullmatch(r"\d{4}年", clean_text(column))],
        reverse=True,
    )
    if len(year_columns) < 2:
        return None
    current_column, previous_column = year_columns[0], year_columns[1]
    current_year = int(current_column.replace("年", ""))
    for row in reversed(rows):
        month = clean_text(row.get("月份"))
        current_value = numeric(row.get(current_column))
        previous_value = numeric(row.get(previous_column))
        if month and current_value is not None and previous_value is not None:
            return month, current_year, current_value, previous_value
    return None


def recent_report_dates(include_next: bool, count: int) -> list[str]:
    today = datetime.now(timezone.utc).date()
    max_date = today + timedelta(days=120) if include_next else today
    quarter_ends = [(3, 31), (6, 30), (9, 30), (12, 31)]
    dates: list[datetime] = []
    for year in range(today.year, today.year - 3, -1):
        for month, day in reversed(quarter_ends):
            date = datetime(year, month, day, tzinfo=timezone.utc)
            if date.date() <= max_date:
                dates.append(date)
    dates = sorted(dates, reverse=True)
    return [date.strftime("%Y%m%d") for date in dates[:count]]


def recent_yyyymmdd_dates(skip_today: bool, max_days: int) -> list[str]:
    start = datetime.now(timezone.utc).date() - (timedelta(days=1) if skip_today else timedelta(days=0))
    return [(start - timedelta(days=offset)).strftime("%Y%m%d") for offset in range(max_days)]


def first_number(row: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        value = numeric(row.get(key))
        if value is not None:
            return value
    return None


def is_a_or_h_market(row: dict[str, Any], code: str) -> bool:
    security_type = clean_text(row.get("SECURITY_TYPE"))
    market = clean_text(row.get("TRADE_MARKET"))
    return "A股" in security_type or "港股" in security_type or code.endswith((".SH", ".SZ", ".BJ", ".HK"))


def market_name_from_row(row: dict[str, Any], code: str) -> str:
    security_type = clean_text(row.get("SECURITY_TYPE"))
    market = clean_text(row.get("TRADE_MARKET"))
    if "港" in security_type or code.endswith(".HK") or "港" in market:
        return "港股"
    return "A股"


def normalize_a_share_code(value: Any) -> str:
    text = clean_text(value)
    if not text:
        return ""
    lowered = text.lower()
    match = re.search(r"(sh|sz|bj)[\._-]?(\d{6})", lowered)
    if match:
        suffix = {"sh": "SH", "sz": "SZ", "bj": "BJ"}[match.group(1)]
        return f"{match.group(2)}.{suffix}"
    match = re.search(r"(\d{6})\.(SH|SZ|BJ)", text, re.I)
    if match:
        return f"{match.group(1)}.{match.group(2).upper()}"
    match = re.fullmatch(r"\d{6}", text)
    if match:
        prefix = text[:2]
        suffix = "SH" if prefix in ("60", "68", "90") else "BJ" if prefix in ("43", "83", "87", "92") else "SZ"
        return f"{text}.{suffix}"
    return ""


def eastmoney_security_code(value: Any) -> str:
    normalized = normalize_a_share_code(value)
    if not normalized:
        return ""
    return normalized.split(".", 1)[0]


def chunked(values: list[str], size: int) -> list[list[str]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def numeric(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            if value != value:
                return None
        except Exception:
            return None
        return float(value)
    text = clean_text(value).replace(",", "").replace("%", "")
    if not text or text.lower() in ("nan", "none", "null", "nat"):
        return None
    try:
        result = float(text)
    except ValueError:
        return None
    if result != result:
        return None
    return result


def ratio_change(current: float | None, previous: float | None) -> float | None:
    if current is None or previous in (None, 0):
        return None
    return (current - previous) / previous


def format_percent(value: Any, ratio: bool = False) -> str:
    number = numeric(value)
    if number is None:
        return "待验证"
    if ratio:
        number *= 100
    return f"{number:.2f}%"


def clean_date(value: Any) -> str:
    text = clean_text(value)
    match = re.search(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}", text)
    if not match:
        return text
    parts = re.split(r"[-/]", match.group(0))
    return f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"


def iso_date(value: Any) -> str:
    text = clean_date(value)
    if re.fullmatch(r"\d{8}", text):
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return f"{text}T00:00:00Z"
    return ""


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\n", " ").replace("\r", " ").split())


def trim_text(value: Any, max_length: int) -> str:
    text = clean_text(value)
    return text if len(text) <= max_length else f"{text[: max_length - 1]}…"


def number_text(value: Any) -> str:
    number = numeric(value)
    if number is not None:
        return f"{number:,.2f}"
    return clean_text(value) or "待验证"


def compact_dict(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item not in ("", None, [], {})}


def unique_strings(values: list[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return result


def infer_topic_from_text(text: str) -> str:
    for topic, keywords in TOPIC_ROLLUP_KEYWORDS.items():
        if any(keyword.lower() in text.lower() for keyword in keywords):
            return topic
    return "其他待验证方向"


if __name__ == "__main__":
    sys.exit(main())
