import { describe, expect, test, vi } from "vitest";
import {
  hasDismissedInstallPrompt,
  INSTALL_PROMPT_DISMISSED_KEY,
  rememberInstallPromptDismissed,
} from "./usePwaInstallPrompt";

function createStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: vi.fn((key: string) => (key === INSTALL_PROMPT_DISMISSED_KEY ? value : null)),
    setItem: vi.fn((key: string, nextValue: string) => {
      if (key === INSTALL_PROMPT_DISMISSED_KEY) value = nextValue;
    }),
  };
}

describe("PWA install prompt storage helpers", () => {
  test("detects when the install prompt was previously dismissed", () => {
    expect(hasDismissedInstallPrompt(createStorage("1"))).toBe(true);
    expect(hasDismissedInstallPrompt(createStorage("0"))).toBe(false);
    expect(hasDismissedInstallPrompt(createStorage(null))).toBe(false);
  });

  test("does not throw when dismissed prompt storage is unavailable", () => {
    const blockedStorage = {
      getItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
    };

    expect(hasDismissedInstallPrompt(blockedStorage)).toBe(false);
    expect(rememberInstallPromptDismissed(blockedStorage)).toBe(false);
  });

  test("records dismissed install prompts when storage is writable", () => {
    const storage = createStorage();

    expect(rememberInstallPromptDismissed(storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(INSTALL_PROMPT_DISMISSED_KEY, "1");
    expect(hasDismissedInstallPrompt(storage)).toBe(true);
  });
});
