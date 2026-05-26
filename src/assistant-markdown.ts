export type AssistantMarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "hr" };

export function parseAssistantMarkdown(text: string): AssistantMarkdownBlock[] {
  const blocks: AssistantMarkdownBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    const value = paragraph.join("\n").trim();
    if (value) blocks.push({ type: "paragraph", text: value });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ type: "list", items: list });
    list = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const table = tryParseTable(lines, index);
    if (table) {
      flushParagraph();
      flushList();
      blocks.push({ type: "table", headers: table.headers, rows: table.rows });
      index = table.endIndex;
      continue;
    }

    if (/^#{1,6}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s*(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (/^[-—_]{3,}$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "hr" });
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      list.push((bullet?.[1] ?? numbered?.[1] ?? "").trim());
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function tryParseTable(lines: string[], startIndex: number) {
  const headerLine = lines[startIndex] ?? "";
  const separatorLine = lines[startIndex + 1] ?? "";
  if (!headerLine.includes("|") || !isMarkdownSeparator(separatorLine)) return null;
  const headers = splitMarkdownRow(headerLine);
  if (headers.length < 2) return null;

  const rows: string[][] = [];
  let cursor = startIndex + 2;
  while (cursor < lines.length && lines[cursor].includes("|") && !isMarkdownSeparator(lines[cursor])) {
    const row = splitMarkdownRow(lines[cursor]);
    if (row.length >= 2) rows.push(Array.from({ length: headers.length }, (_, index) => row[index] ?? ""));
    cursor += 1;
  }

  return rows.length ? { headers, rows, endIndex: cursor - 1 } : null;
}

function splitMarkdownRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function isMarkdownSeparator(line: string) {
  const cells = splitMarkdownRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}
