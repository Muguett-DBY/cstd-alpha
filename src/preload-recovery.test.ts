import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  installPreloadErrorRecovery,
  PRELOAD_RECOVERY_STORAGE_KEY,
  PRELOAD_RECOVERY_TTL_MS,
} from "./preload-recovery";

type CapturedListener = (event: Event) => void;

function createTarget() {
  let listener: CapturedListener | undefined;
  return {
    target: {
      addEventListener: vi.fn((type: string, nextListener: EventListener) => {
        if (type === "vite:preloadError") {
          listener = (event: Event) => {
            if (typeof nextListener === "function") {
              nextListener(event);
              return;
            }
            nextListener.handleEvent(event);
          };
        }
      }),
      removeEventListener: vi.fn((type: string) => {
        if (type === "vite:preloadError") {
          listener = undefined;
        }
      }),
    },
    dispatch(event: Event) {
      listener?.(event);
    },
  };
}

function createPreloadEvent() {
  const event = new Event("vite:preloadError", { cancelable: true }) as Event & {
    payload: TypeError;
  };
  event.payload = new TypeError("Failed to fetch dynamically imported module");
  const originalPreventDefault = event.preventDefault.bind(event);
  const preventDefault = vi.fn(originalPreventDefault);
  event.preventDefault = preventDefault;
  return { event, preventDefault };
}

function createStorage(initialValue?: string) {
  const entries = new Map<string, string>();
  if (initialValue !== undefined) {
    entries.set(PRELOAD_RECOVERY_STORAGE_KEY, initialValue);
  }
  return {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
  };
}

describe("installPreloadErrorRecovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("reloads once and suppresses the first Vite preload error", () => {
    const { target, dispatch } = createTarget();
    const storage = createStorage();
    const reload = vi.fn();
    installPreloadErrorRecovery({
      location: { reload },
      now: () => 12_000,
      storage,
      target,
    });

    const { event, preventDefault } = createPreloadEvent();
    dispatch(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(PRELOAD_RECOVERY_STORAGE_KEY, "12000");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("does not reload repeatedly inside the recovery window", () => {
    const { target, dispatch } = createTarget();
    const storage = createStorage("12000");
    const reload = vi.fn();
    installPreloadErrorRecovery({
      location: { reload },
      now: () => 12_000 + PRELOAD_RECOVERY_TTL_MS - 1,
      storage,
      target,
    });

    const { event, preventDefault } = createPreloadEvent();
    dispatch(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("allows another recovery after the stale guard expires", () => {
    const { target, dispatch } = createTarget();
    const storage = createStorage("12000");
    const reload = vi.fn();
    installPreloadErrorRecovery({
      location: { reload },
      now: () => 12_000 + PRELOAD_RECOVERY_TTL_MS + 1,
      storage,
      target,
    });

    const { event, preventDefault } = createPreloadEvent();
    dispatch(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      PRELOAD_RECOVERY_STORAGE_KEY,
      String(12_000 + PRELOAD_RECOVERY_TTL_MS + 1),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("does not hide the preload error when storage is unavailable", () => {
    const { target, dispatch } = createTarget();
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const reload = vi.fn();
    installPreloadErrorRecovery({
      location: { reload },
      now: () => 12_000,
      storage,
      target,
    });

    const { event, preventDefault } = createPreloadEvent();
    dispatch(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  test("removes the installed listener", () => {
    const { target, dispatch } = createTarget();
    const reload = vi.fn();
    const uninstall = installPreloadErrorRecovery({
      location: { reload },
      now: () => 12_000,
      storage: createStorage(),
      target,
    });

    uninstall();
    const { event } = createPreloadEvent();
    dispatch(event);

    expect(target.removeEventListener).toHaveBeenCalledWith(
      "vite:preloadError",
      expect.any(Function),
    );
    expect(reload).not.toHaveBeenCalled();
  });
});
