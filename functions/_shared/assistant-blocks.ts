import type { AssistantBlock, AssistantChartBlock, AssistantTableBlock } from "../../src/shared/assistant";

export function extractAssistantBlocks(text: string, userMessage = ""): AssistantBlock[] {
  const tables = extractMarkdownTables(text);
  const blocks: AssistantBlock[] = [];
  tables.forEach((table, index) => {
    const chartBlock = tableToChartBlock(table, index);
    if (chartBlock) {
      blocks.push(chartBlock);
    } else {
      blocks.push({ ...table, id: `table-${index + 1}`, title: table.title || inferTableTitle(userMessage, table.columns, index) });
    }
  });
  return blocks.slice(0, 6);
}

export function stripRenderedMarkdownTables(text: string) {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes("|") && isMarkdownSeparator(lines[index + 1] ?? "")) {
      index += 2;
      while (index < lines.length && lines[index].includes("|")) index += 1;
      index -= 1;
      continue;
    }
    kept.push(lines[index]);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMarkdownTables(text: string): Array<Omit<AssistantTableBlock, "id">> {
  const lines = text.split(/\r?\n/);
  const tables: Array<Omit<AssistantTableBlock, "id">> = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes("|") || !isMarkdownSeparator(lines[index + 1])) continue;
    const columns = splitMarkdownRow(lines[index]);
    if (columns.length < 2) continue;
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].includes("|") && !isMarkdownSeparator(lines[cursor]) && !isMarkdownSeparator(lines[cursor + 1] ?? "")) {
      const row = splitMarkdownRow(lines[cursor]);
      if (row.length >= 2) rows.push(normalizeRow(row, columns.length));
      cursor += 1;
    }
    if (rows.length) {
      tables.push({ type: "table", columns, rows });
      index = cursor - 1;
    }
  }
  return tables;
}

function tableToChartBlock(table: Omit<AssistantTableBlock, "id">, index: number): AssistantChartBlock | null {
  const labelColumn = table.columns[0];
  const labels = table.rows.map((row) => row[0]).filter(Boolean).slice(0, 24);
  if (labels.length < 2) return null;
  const series = table.columns
    .slice(1)
    .map((name, columnIndex) => ({
      name,
      data: table.rows.map((row) => parseNumber(row[columnIndex + 1])).filter((value): value is number => Number.isFinite(value)).slice(0, labels.length),
    }))
    .filter((item) => item.data.length === labels.length && item.data.some((value) => value !== 0))
    .slice(0, 4);
  if (!series.length) return null;
  return {
    id: `chart-${index + 1}`,
    type: "chart",
    title: `${labelColumn || "项目"}对比`,
    chartType: inferChartType(table.columns, labels, series),
    labels,
    series,
  };
}

function inferChartType(columns: string[], labels: string[], series: Array<{ name: string; data: number[] }>): "pie" | "area" | "line" | "bar" {
  if (series.length === 1) {
    const joinedName = columns.slice(1).join(" ");
    if (/(占比|比重|构成|组成|比例|份额|分布|结构)/.test(joinedName)) return "pie";
    const total = series[0].data.reduce((a, b) => a + Math.abs(b), 0);
    if ((total > 80 && total < 120) || (total > 0.8 && total < 1.2)) return "pie";
  }
  if (labels.length >= 3 && /^\d{4}$/.test(labels[0])) return "area";
  if (labels.length >= 3 && /^\d{4}[-/]\d{1,2}$/.test(labels[0])) return "area";
  if (labels.length > 8) return "line";
  return "bar";
}

function splitMarkdownRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function normalizeRow(row: string[], length: number) {
  return Array.from({ length }, (_, index) => row[index] ?? "");
}

function isMarkdownSeparator(line: string) {
  const cells = splitMarkdownRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function parseNumber(value: string | undefined) {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[,，]/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!normalized) return Number.NaN;
  return Number(normalized[0]);
}

function inferTableTitle(userMessage: string, columns: string[], index: number) {
  const joinedColumns = columns.join(" ");
  if (/反驳点|含义|关键证据|反驳/.test(joinedColumns)) return index === 0 ? "反驳要点表" : `反驳要点表 ${index + 1}`;
  if (/用户观点|用户说法/.test(joinedColumns)) return index === 0 ? "用户观点拆解" : `用户观点拆解 ${index + 1}`;
  if (/条件|触发信号|修正方向|反证|确认/.test(joinedColumns)) return index === 0 ? "反证与确认条件" : `反证与确认条件 ${index + 1}`;
  if (/跟踪项|频率|来源|意义|指标/.test(joinedColumns)) return index === 0 ? "跟踪指标表" : `跟踪指标表 ${index + 1}`;
  if (/公司|标的|股票|评分|估值/.test(joinedColumns)) return index === 0 ? "标的对比表" : `标的对比表 ${index + 1}`;
  if (/证据/.test(userMessage)) return index === 0 ? "证据矩阵" : `证据表 ${index + 1}`;
  if (/对比/.test(userMessage)) return index === 0 ? "对比表" : `对比表 ${index + 1}`;
  return index === 0 ? "分析表" : `分析表 ${index + 1}`;
}
