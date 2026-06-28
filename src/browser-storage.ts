export type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key"> & {
  readonly length: number;
};

export type BrowserStorageWindow = Pick<Window, "localStorage">;

export function getBrowserLocalStorage(browserWindow?: BrowserStorageWindow): BrowserStorage | undefined {
  try {
    if (browserWindow) return browserWindow.localStorage;
    if (typeof window !== "undefined") return window.localStorage;
    return (globalThis as typeof globalThis & { localStorage?: BrowserStorage }).localStorage;
  } catch {
    return undefined;
  }
}

export function safeGetStorageItem(storage: BrowserStorage | undefined, key: string) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeSetStorageItem(storage: BrowserStorage | undefined, key: string, value: string) {
  try {
    storage?.setItem(key, value);
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function safeRemoveStorageItem(storage: BrowserStorage | undefined, key: string) {
  try {
    storage?.removeItem(key);
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function safeListStorageKeys(storage: BrowserStorage | undefined, predicate: (key: string) => boolean = () => true) {
  try {
    if (!storage) return [];
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && predicate(key)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

export function canWriteStorage(storage: BrowserStorage | undefined, probeKey: string) {
  if (!storage) return false;
  try {
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return true;
  } catch {
    try {
      storage.removeItem(probeKey);
    } catch {
      // Ignore cleanup failures; the storage surface is unavailable.
    }
    return false;
  }
}
