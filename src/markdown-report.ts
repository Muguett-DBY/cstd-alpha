export function normalizeMarkdownForReading(markdown: string) {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ")
    .replace(/\s+(?=\d{1,2}\.\s+)/g, "\n\n")
    .replace(/\s+(估值与仓位规则|待复核清单|总结)\b/g, "\n\n## $1")
    .replace(/\s+(?=\*\*反证条件：\*\*)/g, "\n")
    .replace(/\s+(?=\*\*待复核：\*\*)/g, "\n")
    .trim();
}
