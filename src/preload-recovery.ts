import { getBrowserSessionStorage } from "./browser-storage";

export const PRELOAD_RECOVERY_STORAGE_KEY = "cstd-alpha:preload-recovery-at";
export const PRELOAD_RECOVERY_HISTORY_STATE_KEY = "__cstdAlphaPreloadRecoveryAt";
export const PRELOAD_RECOVERY_NOTICE = "应用已刷新到最新版；刚才的加载异常已自动恢复。";
export const PRELOAD_RECOVERY_TTL_MS = 30_000;

type PreloadRecoveryTarget = {
  addEventListener(type: "vite:preloadError", listener: EventListener): void;
  removeEventListener(type: "vite:preloadError", listener: EventListener): void;
};

type PreloadRecoveryStorage = Pick<Storage, "getItem" | "setItem">;
type PreloadRecoveryHistory = Pick<History, "state" | "replaceState">;

type PreloadRecoveryLocation = {
  reload: () => void;
};

type PreloadRecoveryOptions = {
  history?: PreloadRecoveryHistory;
  location?: PreloadRecoveryLocation;
  now?: () => number;
  storage?: PreloadRecoveryStorage;
  target?: PreloadRecoveryTarget;
};

type PreloadRecoveryStatusOptions = Pick<PreloadRecoveryOptions, "history" | "now" | "storage">;

type RecoveryGuard = {
  getTimestamp: () => number | null;
  setTimestamp: (timestamp: number) => boolean;
};

export function installPreloadErrorRecovery(options: PreloadRecoveryOptions = {}) {
  const browserWindow = typeof window === "undefined" ? undefined : window;
  const target = options.target ?? browserWindow;
  const storageOptionProvided = options.storage !== undefined;
  const storage = storageOptionProvided ? options.storage : getBrowserSessionStorage(browserWindow);
  const history = options.history ?? getBrowserHistory(browserWindow);
  const reloadLocation = options.location ?? browserWindow?.location;
  const now = options.now ?? Date.now;

  if (!target || !reloadLocation) {
    return () => undefined;
  }

  const guards = createRecoveryGuards({ history, includeMemoryFallback: !storageOptionProvided, storage, storageOptionProvided });
  if (guards.length === 0) return () => undefined;

  const onPreloadError: EventListener = (event) => {
    const currentTimestamp = now();
    const usableGuards: RecoveryGuard[] = [];

    for (const guard of guards) {
      const previousTimestamp = guard.getTimestamp();
      if (previousTimestamp === null) continue;
      usableGuards.push(guard);
      if (Number.isFinite(previousTimestamp) && currentTimestamp - previousTimestamp < PRELOAD_RECOVERY_TTL_MS) {
        return;
      }
    }

    if (usableGuards.length === 0 || !usableGuards.some((guard) => guard.setTimestamp(currentTimestamp))) {
      return;
    }

    event.preventDefault();
    reloadLocation.reload();
  };

  target.addEventListener("vite:preloadError", onPreloadError);

  return () => {
    target.removeEventListener("vite:preloadError", onPreloadError);
  };
}

export function hasRecentPreloadRecovery(options: PreloadRecoveryStatusOptions = {}) {
  const browserWindow = typeof window === "undefined" ? undefined : window;
  const storageOptionProvided = options.storage !== undefined;
  const storage = storageOptionProvided ? options.storage : getBrowserSessionStorage(browserWindow);
  const history = options.history ?? getBrowserHistory(browserWindow);
  const currentTimestamp = (options.now ?? Date.now)();
  const guards = createRecoveryGuards({ history, includeMemoryFallback: false, storage, storageOptionProvided });

  return guards.some((guard) => {
    const previousTimestamp = guard.getTimestamp();
    if (previousTimestamp === null) return false;
    return Number.isFinite(previousTimestamp) && currentTimestamp - previousTimestamp < PRELOAD_RECOVERY_TTL_MS;
  });
}

function createRecoveryGuards({
  history,
  includeMemoryFallback,
  storage,
  storageOptionProvided,
}: {
  history?: PreloadRecoveryHistory;
  includeMemoryFallback: boolean;
  storage?: PreloadRecoveryStorage;
  storageOptionProvided: boolean;
}) {
  if (storageOptionProvided) return storage ? [createStorageGuard(storage)] : [];

  const guards: RecoveryGuard[] = [];
  if (storage) guards.push(createStorageGuard(storage));
  if (history) guards.push(createHistoryGuard(history));
  if (includeMemoryFallback) guards.push(createMemoryGuard());
  return guards;
}

function createStorageGuard(storage: PreloadRecoveryStorage): RecoveryGuard {
  return {
    getTimestamp: () => {
      try {
        return parseRecoveryTimestamp(storage.getItem(PRELOAD_RECOVERY_STORAGE_KEY));
      } catch {
        return null;
      }
    },
    setTimestamp: (timestamp) => {
      try {
        storage.setItem(PRELOAD_RECOVERY_STORAGE_KEY, String(timestamp));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function createHistoryGuard(history: PreloadRecoveryHistory): RecoveryGuard {
  return {
    getTimestamp: () => {
      try {
        return parseRecoveryTimestamp(readHistoryRecoveryTimestamp(history.state));
      } catch {
        return null;
      }
    },
    setTimestamp: (timestamp) => {
      try {
        history.replaceState({ ...historyStateObject(history.state), [PRELOAD_RECOVERY_HISTORY_STATE_KEY]: timestamp }, "");
        return true;
      } catch {
        return false;
      }
    },
  };
}

function createMemoryGuard(): RecoveryGuard {
  let timestamp = NaN;
  return {
    getTimestamp: () => timestamp,
    setTimestamp: (nextTimestamp) => {
      timestamp = nextTimestamp;
      return true;
    },
  };
}

function getBrowserHistory(browserWindow: Window | undefined): PreloadRecoveryHistory | undefined {
  try {
    return browserWindow?.history;
  } catch {
    return undefined;
  }
}

function readHistoryRecoveryTimestamp(state: unknown) {
  if (!state || typeof state !== "object") return undefined;
  return (state as Record<string, unknown>)[PRELOAD_RECOVERY_HISTORY_STATE_KEY];
}

function historyStateObject(state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  return state as Record<string, unknown>;
}

function parseRecoveryTimestamp(value: unknown) {
  const timestamp = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : NaN;
}
