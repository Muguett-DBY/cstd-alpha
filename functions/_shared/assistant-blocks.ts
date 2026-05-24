import type { AssistantBlock, AssistantChartBlock, AssistantTableBlock } from "../../src/shared/assistant";

const CHART_REQUEST_RE = /(画图|图表|趋势图|柱状图|折线图|散点图|气泡图|矩阵|可视化|chart|table|表格|对比表)/i;

export function extractAssistantBlocks(text: string, userMessage = ""): AssistantBlock[] {
  const tables = extractMarkdownTables(text);
  const blocks: AssistantBlock[] = [];
  tables.forEach((table, index) => {
    blocks.push({ ...table, id: `table-${index + 1}`, title: table.title || inferTableTitle(userMessage, index) });
  });
  if (CHART_REQUEST_RE.test(userMessage)) {
    const chartBlocks = tables.map((table, index) => tableToChartBlock(table, index)).filter((block): block is AssistantChartBlock => Boolean(block));
    blocks.push(...chartBlocks);
  }
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
    while (cursor < lines.length && lines[cursor].includes("|") && !isMarkdownSeparator(lines[cursor])) {
      const row = splitMarkdownRow(lines[cursor]);
      if (row.length >= 2) rows.push(normalizeRow(row, columns.length));
      cursor += 1;
    }
    if (rows.length) {
      tables.push({ type: "table", columns, rows });
      index = cursor;
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
    chartType: labels.length > 8 ? "line" : "bar",
    labels,
    series,
  };
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

function inferTableTitle(userMessage: string, index: number) {
  if (/证据/.test(userMessage)) return index === 0 ? "证据矩阵" : `证据表 ${index + 1}`;
  if (/对比/.test(userMessage)) return index === 0 ? "对比表" : `对比表 ${index + 1}`;
  return index === 0 ? "结构化表格" : `结构化表格 ${index + 1}`;
}
