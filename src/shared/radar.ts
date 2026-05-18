export type RadarEvidenceType = "hard_data" | "official" | "announcement" | "market" | "news" | "research";

export type RadarEvidenceBreakdown = Partial<Record<RadarEvidenceType, number>>;

export type RadarSource = {
  source: string;
  query: string;
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
  sourceType?: RadarEvidenceType;
  weight?: number;
};

export type RadarCitation = RadarSource & {
  id: string;
  sourceType: RadarEvidenceType;
  weight: number;
  score?: number;
};

export type RadarCoverageItem = {
  label: string;
  sourceCount: number;
  evidenceTypes: RadarEvidenceType[];
  note: string;
  topSourceIds?: string[];
};

export type RadarCoverageStatus = "formal" | "watched" | "insufficient";

export type RadarCoverageReview = {
  label: string;
  status: RadarCoverageStatus;
  sourceCount: number;
  evidenceTypes: RadarEvidenceType[];
  note: string;
  sourceIds?: string[];
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
  confidence?: "低" | "中" | "高";
  evidenceTypes?: RadarEvidenceType[];
  supportingSourceCount?: number;
  sourceIds?: string[];
  changeReason?: string;
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
  evidenceBreakdown?: RadarEvidenceBreakdown;
  evidenceSources?: RadarCitation[];
  softCoverage?: RadarCoverageItem[];
  coverageReview?: RadarCoverageReview[];
  confidenceSummary?: string;
  changeLog?: string[];
  fromCache?: boolean;
  reuseReason?: string;
  refreshWarning?: string;
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
