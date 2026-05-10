import type { InvestmentReport, ModuleScore } from "../shared/report";

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
      subtitle("CSTD Alpha / 公司质量分 CQS + 综合投资吸引力分 IAS", docx),
      paragraph(`报告日期：${formatDate(report.asOf)}`, docx),
      paragraph(`股票代码 / 市场：${[report.company.ticker, report.company.market].filter(Boolean).join(" / ") || "未识别"}`, docx),
      scoreTable(report, docx),
      heading("核心一句话", docx),
      paragraph(report.oneSentence, docx),
      heading("模块评分", docx),
      moduleTable(report.moduleScores, docx),
      heading("红线与封顶", docx),
      ...riskParagraphs(report, docx),
      heading("公司概况", docx),
      paragraph(report.sections.companyOverview, docx),
      heading("行业与细分赛道", docx),
      paragraph(report.sections.industry, docx),
      heading("商业模式与价值链", docx),
      paragraph(report.sections.businessModel, docx),
      heading("竞争优势与护城河", docx),
      paragraph(report.sections.moat, docx),
      heading("管理层、治理结构与股东文化", docx),
      paragraph(report.sections.governance, docx),
      heading("财务质量与现金流", docx),
      paragraph(report.sections.financialQuality, docx),
      heading("成长空间与重大转折", docx),
      paragraph(report.sections.growth, docx),
      heading("估值与安全边际", docx),
      paragraph(report.sections.valuation, docx),
      heading("风险清单与反证条件", docx),
      paragraph(report.sections.risks, docx),
      heading("最终投资结论", docx),
      paragraph(report.sections.finalConclusion, docx),
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
      tableRow(["投资结论", report.conclusion, "公司质量分 CQS", `${report.cqs} / 100`], docx, true),
      tableRow(["综合投资吸引力 IAS", `${report.ias} / 100`, "评级说明", scoreLabel(report.ias)], docx),
    ],
  });
}

function moduleTable(modules: ModuleScore[], docx: Docx) {
  return new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    borders: tableBorders(docx),
    rows: [
      tableRow(["模块", "权重", "得分", "核心摘要"], docx, true),
      ...modules.map((module) => tableRow([module.name, `${module.weight}%`, `${module.score}`, module.summary], docx)),
    ],
  });
}

function riskParagraphs(report: InvestmentReport, docx: Docx) {
  if (!report.redFlags.length) return [paragraph("未发现触发红线封顶的事项；仍需持续跟踪后续公告和财务变化。", docx)];
  return report.redFlags.map((flag) =>
    paragraph(`${flag.severity.toUpperCase()} / ${flag.label} / IAS 封顶 ${flag.cap}: ${flag.evidence ?? ""}`, docx),
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
