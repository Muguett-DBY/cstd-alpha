import { describe, expect, test, vi } from "vitest";
import { RESEARCH_TEMPLATES, type ResearchTemplate } from "../../src/shared/user-research";
import { onRequestPut } from "./research-templates";
import type { ResearchTemplateRow } from "../_shared/user-research-db";

vi.mock("../_shared/auth", () => ({
  readSessionCookie: vi.fn(async () => ({
    userId: "user-1",
    username: "analyst",
    displayName: "Analyst",
    role: "admin",
    sessionId: "session-1",
    expiresAt: "2026-07-01T00:00:00.000Z",
  })),
}));

describe("/api/research-templates", () => {
  test("rejects malformed template entries before mutating saved templates", async () => {
    const db = researchTemplatesDb();

    const response = await onRequestPut(context(db.db, {
      templates: [
        { id: "custom-template-bad", title: "缺少提示词" },
        "not-a-template",
      ],
    }));
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("模板列表包含无效模板。");
    expect(db.sqls.some((sql) => /UPDATE user_research_templates SET deleted_at/i.test(sql))).toBe(false);
    expect(db.sqls.some((sql) => /INSERT INTO user_research_templates/i.test(sql))).toBe(false);
  });
});

function context(db: D1Database, body: unknown) {
  return {
    request: new Request("https://alpha.custard.top/api/research-templates", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: "cstd_alpha_session=session-1.token" },
      body: JSON.stringify(body),
    }),
    env: {
      AUTH_SECRET: "test-secret",
      REPORT_LIBRARY_DB: db,
    },
  } as unknown as Parameters<typeof onRequestPut>[0];
}

function researchTemplatesDb() {
  const sqls: string[] = [];
  const existingRows = RESEARCH_TEMPLATES.map((template, index) => templateRow(template, index + 1));
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql);
    let args: unknown[] = [];
    const statement = {
      bind(...nextArgs: unknown[]) {
        args = nextArgs;
        return statement;
      },
      async run() {
        return { success: true };
      },
      async first<T>() {
        return null as T;
      },
      async all<T>() {
        if (/FROM user_research_templates/i.test(sql)) {
          return { results: existingRows.filter((row) => row.user_key === args[0]) } as T;
        }
        return { results: [] } as T;
      },
    };
    return statement;
  });
  return {
    db: {
      prepare,
      batch: vi.fn(async () => []),
    } as unknown as D1Database,
    sqls,
  };
}

function templateRow(template: ResearchTemplate, sortOrder: number): ResearchTemplateRow {
  return {
    id: template.id,
    user_id: "user-1",
    user_key: "user-1",
    title: template.title,
    short_title: template.shortTitle,
    focus: template.focus,
    prompt: template.prompt,
    full_prompt: template.fullPrompt,
    section_requirements_json: JSON.stringify(template.sectionRequirements ?? []),
    enabled: template.enabled === false ? 0 : 1,
    sort_order: sortOrder,
    is_system: template.isSystem ? 1 : 0,
    deleted_at: null,
    default_title: template.title,
    default_short_title: template.shortTitle,
    default_focus: template.focus,
    default_prompt: template.prompt,
    default_full_prompt: template.fullPrompt,
    default_section_requirements_json: JSON.stringify(template.sectionRequirements ?? []),
    default_enabled: template.enabled === false ? 0 : 1,
    default_sort_order: sortOrder,
    default_is_system: template.isSystem ? 1 : 0,
    default_deleted_at: null,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
  };
}
