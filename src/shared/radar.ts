export type RadarSource = {
  source: string;
  query: string;
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
};

export type RadarItem = {
  title: string;
  industries: string[];
  companies: string[];
  thesis: string;
  drivers: string[];
  evidence: string[];
  durability: "短期" | "中期" | "长期" | "不确定";
  riskLevel: "低" | "中" | "高";
  turningPoints: string[];
};

export type RadarList = {
  label: string;
  companies: string[];
  note: string;
};

export type RadarScan = {
  id: string;
  title: string;
  generatedAt: string;
  asOfDate: string;
  validUntil: string;
  model: string;
  sourceCount: number;
  sourceQueries: string[];
  fromCache?: boolean;
  reuseReason?: string;
  executiveSummary: string[];
  solidGrowth: RadarItem[];
  sustainability: RadarItem[];
  bubbleRisks: RadarItem[];
  upcomingGrowth: RadarItem[];
  decliningIndustries: RadarItem[];
  representativeCompanies: RadarList[];
  stageCompanies: RadarList[];
  limitations: string[];
};
