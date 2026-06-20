import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const assistantViewSource = readFileSync(new URL("./AssistantView.tsx", import.meta.url), "utf8");
const appCssSource = readFileSync(new URL("./App.css", import.meta.url), "utf8");

describe("assistant UI regressions", () => {
  test("loads the active thread when the assistant view mounts", () => {
    expect(assistantViewSource).toMatch(/useEffect\(\(\) => \{\s*let cancelled = false;/);
    expect(assistantViewSource).toContain("await reloadThread();");
    expect(assistantViewSource).toContain("void loadThreadList();");
  });

  test("keeps the message list in the only flexible scroll row", () => {
    const chatPanelRule = appCssSource.match(/\.assistant-chat-panel\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";
    const workspaceRule = appCssSource.match(/\.assistant-workspace\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";
    const messagesRule = appCssSource.match(/\.assistant-messages\s*\{(?<body>[^}]+)\}/)?.groups?.body ?? "";

    expect(workspaceRule).toContain("height: 100%");
    expect(chatPanelRule).toContain("grid-template-rows: auto minmax(0, 1fr) auto auto");
    expect(appCssSource).toContain("grid-template-rows: auto auto minmax(0, 1fr) auto auto");
    expect(messagesRule).toContain("min-height: 0");
    expect(messagesRule).toContain("overflow-y: auto");
  });
});
