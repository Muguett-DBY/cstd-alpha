import { describe, expect, test } from "vitest";
import { buildDeepSeekRequestBody, cacheStableUserContent, DEEPSEEK_CACHE_PROTOCOL, stableJsonStringify } from "./deepseek-cache";

describe("DeepSeek cache stability helpers", () => {
  test("keeps stable prompt fields before volatile evidence fields", () => {
    const content = cacheStableUserContent({
      kind: "unit-cache-test",
      stable: {
        task: "stable task",
        expectedOutputShape: { z: 1, a: 2 },
      },
      volatile: {
        company: { ticker: "NVDA", name: "英伟达" },
        evidence: [{ title: "latest evidence" }],
      },
    });
    const payload = JSON.parse(content);
    expect(payload.cacheProtocol).toBe(DEEPSEEK_CACHE_PROTOCOL);
    expect(Object.keys(payload)).toEqual(["cacheProtocol", "cacheKind", "task", "expectedOutputShape", "company", "evidence"]);
    expect(Object.keys(payload.expectedOutputShape)).toEqual(["a", "z"]);
  });

  test("stableJsonStringify sorts nested object keys deterministically", () => {
    expect(stableJsonStringify({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  test("buildDeepSeekRequestBody emits a deterministic request shape", () => {
    const body = buildDeepSeekRequestBody({
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      maxTokens: 8000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(Object.keys(body)).toEqual(["model", "reasoning_effort", "response_format", "stream", "temperature", "max_tokens", "messages"]);
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning_effort: "high",
      response_format: { type: "json_object" },
      stream: false,
      temperature: 0.1,
      max_tokens: 8000,
    });
  });
});
