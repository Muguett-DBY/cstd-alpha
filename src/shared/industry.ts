export const UNKNOWN_INDUSTRY = "未分类";

export const A_SHARE_INDUSTRY_GROUPS = [
  "农林牧渔",
  "基础化工",
  "钢铁",
  "有色金属",
  "电子",
  "家用电器",
  "食品饮料",
  "纺织服饰",
  "轻工制造",
  "医药生物",
  "公用事业",
  "交通运输",
  "房地产",
  "商贸零售",
  "社会服务",
  "综合",
  "建筑材料",
  "建筑装饰",
  "电力设备",
  "国防军工",
  "计算机",
  "传媒",
  "通信",
  "银行",
  "非银金融",
  "汽车",
  "机械设备",
  "煤炭",
  "石油石化",
  "环保",
  "美容护理",
] as const;

const INDUSTRY_GROUP_MEMBERS: Record<string, string[]> = {
  农林牧渔: ["种植业", "养殖业", "农产品加工", "农业综合", "饲料", "渔业", "动物保健", "林业"],
  基础化工: ["化学原料", "化学制品", "化学纤维", "农化制品", "塑料", "橡胶", "非金属材料", "化工新材料"],
  钢铁: ["普钢", "特钢", "冶钢原料", "钢铁"],
  有色金属: ["工业金属", "贵金属", "小金属", "能源金属", "金属新材料", "有色金属"],
  电子: ["半导体", "消费电子", "元件", "光学光电子", "其他电子", "电子化学品", "军工电子", "电子"],
  家用电器: ["白色家电", "黑色家电", "小家电", "厨卫电器", "照明设备", "家电零部件", "家用电器"],
  食品饮料: ["白酒", "非白酒", "啤酒", "软饮料", "饮料乳品", "调味发酵品", "食品加工", "休闲食品", "肉制品", "烘焙食品", "保健品", "食品饮料"],
  纺织服饰: ["纺织制造", "服装家纺", "饰品", "纺织服饰"],
  轻工制造: ["造纸", "包装印刷", "家居用品", "文娱用品", "轻工制造"],
  医药生物: ["化学制药", "中药", "生物制品", "医药商业", "医疗器械", "医疗服务", "医疗美容", "医药生物"],
  公用事业: ["电力", "燃气", "环境治理", "水务", "公用事业"],
  交通运输: ["铁路公路", "航运港口", "航空机场", "物流", "公交", "交通运输"],
  房地产: ["房地产开发", "房地产服务", "房地产"],
  商贸零售: ["一般零售", "专业连锁", "贸易", "互联网电商", "商贸零售"],
  社会服务: ["旅游及景区", "酒店餐饮", "教育", "专业服务", "体育", "社会服务"],
  综合: ["综合"],
  建筑材料: ["水泥", "玻璃玻纤", "装修建材", "建筑材料"],
  建筑装饰: ["基础建设", "专业工程", "装修装饰", "工程咨询服务", "房屋建设", "建筑装饰"],
  电力设备: ["电池", "光伏设备", "风电设备", "电网设备", "电机", "其他电源设备", "电力设备"],
  国防军工: ["航空装备", "航天装备", "地面兵装", "航海装备", "军工电子", "国防军工"],
  计算机: ["软件开发", "IT服务", "计算机设备", "计算机"],
  传媒: ["游戏", "广告营销", "出版", "影视院线", "数字媒体", "电视广播", "传媒"],
  通信: ["通信设备", "通信服务", "通信"],
  银行: ["银行"],
  非银金融: ["证券", "保险", "多元金融", "非银金融"],
  汽车: ["乘用车", "商用车", "汽车零部件", "摩托车及其他", "汽车服务", "汽车"],
  机械设备: ["通用设备", "专用设备", "工程机械", "轨交设备", "自动化设备", "机械设备"],
  煤炭: ["煤炭开采", "焦炭", "煤炭"],
  石油石化: ["油气开采", "油服工程", "炼化及贸易", "石油石化"],
  环保: ["环境治理", "环保设备", "环保"],
  美容护理: ["化妆品", "个护用品", "医疗美容", "美容护理"],
};

const GROUP_BY_DETAIL = Object.fromEntries(
  Object.entries(INDUSTRY_GROUP_MEMBERS).flatMap(([group, members]) => members.map((member) => [member, group])),
) as Record<string, string>;

const ENGLISH_INDUSTRY_LABELS: Record<string, string> = {
  "consumer cyclical": "可选消费",
  "consumer defensive": "必需消费",
  "consumer goods": "消费品",
  "consumer electronics": "消费电子",
  "discount stores": "零售",
  diversified: "综合",
  environmental: "环保",
  "environmental services": "环保",
  finance: "金融",
  healthcare: "医疗保健",
  "information technology services": "IT服务",
  "medical instruments": "医疗器械",
  "real estate": "房地产",
  "real estate development": "房地产开发",
  restaurants: "餐饮",
  solar: "光伏设备",
  technology: "科技",
  telecommunications: "通信",
};

export function normalizeIndustryLabel(value: unknown) {
  if (typeof value !== "string") return undefined;
  const label = value.trim().replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+$/u, "").trim();
  if (!label || /^(AStock|UsStock|HK|EQUITY|Imported|Library|行业待验证|未分类)$/i.test(label)) return undefined;
  if (/^[-—–]+$/.test(label)) return undefined;
  return ENGLISH_INDUSTRY_LABELS[label.toLowerCase()] ?? label;
}

export function industryGroupForLabel(value: unknown) {
  const label = normalizeIndustryLabel(value);
  if (!label) return undefined;
  return GROUP_BY_DETAIL[label] ?? (A_SHARE_INDUSTRY_GROUPS.includes(label as (typeof A_SHARE_INDUSTRY_GROUPS)[number]) ? label : undefined);
}

export function industryMembersForGroup(group: string) {
  const normalized = normalizeIndustryLabel(group);
  if (!normalized) return [];
  return Array.from(new Set([normalized, ...(INDUSTRY_GROUP_MEMBERS[normalized] ?? [])]));
}

export function formatIndustryLabel(detail?: string, group?: string) {
  const normalizedDetail = normalizeIndustryLabel(detail);
  const normalizedGroup = normalizeIndustryLabel(group);
  if (normalizedDetail && normalizedGroup && normalizedDetail !== normalizedGroup) return `${normalizedGroup} / ${normalizedDetail}`;
  return normalizedDetail || normalizedGroup || UNKNOWN_INDUSTRY;
}
