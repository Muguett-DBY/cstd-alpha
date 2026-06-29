import { getBrowserSessionStorage } from "./browser-storage";

export const PRELOAD_RECOVERY_STORAGE_KEY = "cstd-alpha:preload-recovery-at";
export const PRELOAD_RECOVERY_TTL_MS = 30_000;

type PreloadRecoveryTarget = {
  addEventListener(type: "vite:preloadError", listener: EventListener): void;
  removeEventListener(type: "vite:preloadError", listener: EventListener): void;
};

type PreloadRecoveryStorage = Pick<Storage, "getItem" | "setItem">;

type PreloadRecoveryLocation = {
  reload: () => void;
};

type PreloadRecoveryOptions = {
  location?: PreloadRecoveryLocation;
  now?: () => number;
  storage?: PreloadRecoveryStorage;
  target?: PreloadRecoveryTarget;
};

export function installPreloadErrorRecovery(options: PreloadRecoveryOptions = {}) {
  const browserWindow = typeof window === "undefined" ? undefined : window;
  const target = options.target ?? browserWindow;
  const storage = options.storage ?? getBrowserSessionStorage(browserWindow);
  const reloadLocation = options.location ?? browserWindow?.location;
  const now = options.now ?? Date.now;

  if (!target || !storage || !reloadLocation) {
    return () => undefined;
  }

  const onPreloadError: EventListener = (event) => {
    const currentTimestamp = now();

    try {
      const previousValue = storage.getItem(PRELOAD_RECOVERY_STORAGE_KEY);
      const previousTimestamp = previousValue === null ? NaN : Number(previousValue);

      if (
        Number.isFinite(previousTimestamp) &&
        currentTimestamp - previousTimestamp < PRELOAD_RECOVERY_TTL_MS
      ) {
        return;
      }

      storage.setItem(PRELOAD_RECOVERY_STORAGE_KEY, String(currentTimestamp));
    } catch {
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
