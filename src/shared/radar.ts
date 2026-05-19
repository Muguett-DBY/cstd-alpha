export type RadarEvidenceType = "hard_data" | "official" | "announcement" | "market" | "news" | "research";

export type RadarEvidenceBreakdown = Partial<Record<RadarEvidenceType, number>>;

export type RadarConclusionStrength = "正式结论" | "观察" | "证据不足";

export type RadarEvidenceGap =
  | "缺财报"
  | "缺价格"
  | "缺销量"
  | "缺订单"
  | "缺库存"
  | "缺产能"
  | "缺现金流"
  | "缺政策细则"
  | "缺公司公告"
  | "缺多源验证";

export type RadarDriverTag = "需求" | "价格" | "技术" | "政策" | "市占率" | "供给收缩";

export type RadarSustainabilityTier = "短期催化" | "中期景气" | "长期护城河";

export type RadarSource = {
  source: string;
  query: string;
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
  sourceType?: RadarEvidenceType;
  signalType?: string;
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

export type RadarAnalysisJobStatus = "queued" | "running" | "completed" | "failed";

export type RadarAnalysisJob = {
  id: string;
  status: RadarAnalysisJobStatus;
  createdAt: string;
  updatedAt: string;
  evidenceHash?: string;
  message?: string;
  radarGeneratedAt?: string;
};

export type RadarCoverageReview = {
  label: string;
  status: RadarCoverageStatus;
  sourceCount: number;
  evidenceTypes: RadarEvidenceType[];
  note: string;
  sourceIds?: string[];
};

export type RadarIndustryPacket = {
  group: string;
  industry: string;
  status: "scanned";
  changeStatus?: "new" | "changed" | "unchanged";
  evidenceHash: string;
  sourceCount: number;
  evidenceTypes: RadarEvidenceType[];
  signalTypes: string[];
  evidenceGaps: RadarEvidenceGap[];
};

export type RadarAnalysisScope = {
  totalIndustryCount: number;
  changedIndustryCount: number;
  unchangedIndustryCount: number;
  previousIndustryCount: number;
};

export type RadarItem = {
  title: string;
  industries: string[];
  companies: string[];
  thesis: string;
  drivers: string[];
  evidence: string[];
  conclusionStrength: RadarConclusionStrength;
  evidenceGaps: RadarEvidenceGap[];
  driverTags: RadarDriverTag[];
  sustainabilityTier: RadarSustainabilityTier;
  durability: "短期" | "中期" | "长期" | "不确定";
  riskLevel: "低" | "中" | "高";
  confidence?: "低" | "中" | "高";
  evidenceTypes?: RadarEvidenceType[];
  supportingSourceCount?: number;
  sourceIds?: string[];
  changeReason?: string;
  counterEvidenceConditions: string[];
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
  industryPackets?: RadarIndustryPacket[];
  analysisScope?: RadarAnalysisScope;
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
