import type { FinancialRow, InvestmentReport, ModuleScore, ScoreItem } from "../shared/report";

type Docx = typeof import("docx");

export async function buildReportDocxBlob(report: InvestmentReport) {
  const docx = await import("docx");
  const doc = new docx.Document({
    sections: [buildSection(report, docx)],
    styles: {
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          run: { font: "Microsoft YaHei", size: 21 },
          paragraph: { spacing: { after: 160, line: 320 } },
        },
      ],
    },
  });

  return docx.Packer.toBlob(doc);
}

export function downloadReportDocx(report: InvestmentReport) {
  void buildReportDocxBlob(report).then((blob) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileName(report.company.name)}-CSTD-Alpha-Report.docx`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  });
}

function buildSection(report: InvestmentReport, docx: Docx) {
  return {
    properties: {
      page: {
        margin: { top: 900, right: 900, bottom: 900, left: 900 },
      },
    },
    children: [
      title(`${report.company.name} 公司分析报告`, docx),
      subtitle("CSTD Alpha / 公司质量评分（CQS）+ 投资吸引力评分（IAS）", docx),
      paragraph(`报告日期：${formatDate(report.asOf)}`, docx),
      paragraph(`股票代码 / 市场：${[report.company.ticker, report.company.market].filter(Boolean).join(" / ") || "未识别"}`, docx),
      scoreTable(report, docx),
      heading("核心一句话", docx),
      paragraph(report.oneSentence, docx),
      heading("一页结论与评分仪表盘", docx),
      paragraph(report.fullSections.onePageConclusion, docx),
      heading("模块评分", docx),
      moduleTable(report.moduleScores, docx),
      heading("20 项详细评分", docx),
      scoreItemsTable(report.scoreItems20, docx),
      heading("红线与封顶", docx),
      ...riskParagraphs(report, docx),
      heading("公司概况与发展史", docx),
      paragraph(report.fullSections.companyOverview, docx),
      heading("行业与细分赛道分析", docx),
      paragraph(report.fullSections.industryTrack, docx),
      heading("商业模式与价值链", docx),
      paragraph(report.fullSections.businessModel, docx),
      heading("核心竞争力与长期竞争优势", docx),
      paragraph(report.fullSections.moat, docx),
      heading("管理层、治理结构与股东文化", docx),
      paragraph(report.fullSections.governance, docx),
      heading("十年财务数据总表", docx),
      financialRowsTable(report.financialTenYear.rows, docx),
      paragraph(report.financialTenYear.interpretation, docx),
      heading("财务质量与现金流分析", docx),
      paragraph(report.fullSections.financialQuality, docx),
      heading("成长空间与重大转折", docx),
      paragraph(report.fullSections.growthInflection, docx),
      heading("估值与安全边际", docx),
      paragraph(report.fullSections.valuation, docx),
      paragraph(
        `当前价格：${report.valuationAnalysis.currentPrice}；合理价值区间：${report.valuationAnalysis.fairValueRange}；期望买入区间：${report.valuationAnalysis.buyRange}；减仓区间：${report.valuationAnalysis.sellReduceRange}`,
        docx,
      ),
      heading("风险清单与反证条件", docx),
      paragraph(report.fullSections.risks, docx),
      heading("最终投资结论", docx),
      paragraph(report.fullSections.finalConclusion, docx),
      heading("账户管理与仓位规则", docx),
      paragraph(report.fullSections.accountRules, docx),
      heading("证据来源", docx),
      ...report.evidence.map((item) => paragraph(`${item.title} | ${item.source} | ${item.freshness} | ${item.url || "无 URL"}`, docx)),
      heading("使用声明", docx),
      paragraph(report.disclaimer, docx),
    ],
  };
}

function scoreTable(report: InvestmentReport, docx: Docx) {
  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    borders: tableBorders(docx),
    rows: [
      tableRow(["投资结论", report.conclusion, "公司质量评分（CQS）", `${report.cqs} / 100`], docx, true),
      tableRow(["投资吸引力评分（IAS）", `${report.ias} / 100`, "评级说明", report.qualitativeBand || scoreLabel(report.ias)], docx),
      tableRow(["估值判断", report.summaryDashboard.valuationView, "建议仓位", report.summaryDashboard.positionAdvice], docx),
    ],
  });
}

function moduleTable(modules: ModuleScore[], docx: Docx) {
  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    borders: tableBorders(docx),
    rows: [
      tableRow(["模块", "权重", "得分", "标签", "核心摘要"], docx, true),
      ...modules.map((module) => tableRow([module.name, `${module.weight}%`, `${module.score}`, module.label, module.summary], docx)),
    ],
  });
}

function scoreItemsTable(items: ScoreItem[], docx: Docx) {
  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    borders: tableBorders(docx),
    rows: [
      tableRow(["序号", "评分项", "权重", "得分", "标签", "理由"], docx, true),
      ...items.map((item, index) => tableRow([String(index + 1), item.title, `${item.weight}%`, `${item.score}`, item.label, item.reason], docx)),
    ],
  });
}

function financialRowsTable(rows: FinancialRow[], docx: Docx) {
  const years = Array.from(new Set(rows.flatMap((row) => Object.keys(row.values)))).slice(-10);
  const bodyRows = rows.length
    ? rows.map((row) => tableRow([row.metric, ...years.map((year) => row.values[year] || "-"), row.trend], docx))
    : [tableRow(["数据不足", ...years.map(() => "-"), "待验证"], docx)];

  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    borders: tableBorders(docx),
    rows: [tableRow(["指标", ...years, "趋势"], docx, true), ...bodyRows],
  });
}

function riskParagraphs(report: InvestmentReport, docx: Docx) {
  if (!report.redFlags.length) return [paragraph("未发现触发红线封顶的事项；仍需持续跟踪后续公告和财务变化。", docx)];
  return report.redFlags.map((flag) =>
    paragraph(`${flag.severity.toUpperCase()} / ${flag.label} / 投资吸引力评分（IAS）封顶 ${flag.cap}: ${flag.evidence ?? ""}`, docx),
  );
}

function title(text: string, docx: Docx) {
  return new docx.Paragraph({
    heading: docx.HeadingLevel.TITLE,
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 180 },
    children: [new docx.TextRun({ text, bold: true, size: 36, color: "111827" })],
  });
}

function subtitle(text: string, docx: Docx) {
  return new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { after: 300 },
    children: [new docx.TextRun({ text, color: "475569", size: 22 })],
  });
}

function heading(text: string, docx: Docx) {
  return new docx.Paragraph({
    heading: docx.HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 120 },
    children: [new docx.TextRun({ text, bold: true, size: 26, color: "0F766E" })],
  });
}

function paragraph(text: string, docx: Docx) {
  return new docx.Paragraph({
    spacing: { after: 160 },
    children: [new docx.TextRun({ text, size: 21, color: "111827" })],
  });
}

function tableRow(values: string[], docx: Docx, header = false) {
  return new docx.TableRow({
    children: values.map(
      (value) =>
        new docx.TableCell({
          margins: { top: 120, right: 120, bottom: 120, left: 120 },
          shading: header ? { fill: "E2E8F0" } : undefined,
          children: [
            new docx.Paragraph({
              children: [new docx.TextRun({ text: value, bold: header, size: 19 })],
            }),
          ],
        }),
    ),
  });
}

function tableBorders(docx: Docx) {
  return {
    top: { style: docx.BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
    bottom: { style: docx.BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
    left: { style: docx.BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
    right: { style: docx.BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
    insideHorizontal: { style: docx.BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
    insideVertical: { style: docx.BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
  };
}

function scoreLabel(score: number) {
  if (score >= 86) return "卓越公司，仍需严格估值纪律";
  if (score >= 76) return "优质公司，适合长期跟踪";
  if (score >= 66) return "良好公司，需等待价格和确定性";
  if (score >= 51) return "中规中矩，观察为主";
  if (score >= 31) return "平庸公司，谨慎研究";
  return "高风险或数据不足";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-");
}
