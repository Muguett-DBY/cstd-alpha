type ToastItem = {
  id: number;
  message: string;
  type: "info" | "success" | "error";
};

let nextId = 0;
let listeners: Array<(toasts: ToastItem[]) => void> = [];
let toasts: ToastItem[] = [];

function notifySubscribers() {
  for (const listener of listeners) listener([...toasts]);
}

export function showToast(message: string, type: ToastItem["type"] = "info", durationMs = 4000) {
  const id = nextId++;
  toasts = [...toasts, { id, message, type }];
  notifySubscribers();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notifySubscribers();
  }, durationMs);
}

export function subscribeToToasts() {
  return {
    getSnapshot: () => [...toasts],
    subscribe: (listener: (toasts: ToastItem[]) => void) => {
      listeners.push(listener);
      return () => { listeners = listeners.filter((l) => l !== listener); };
    },
  };
}

export type { ToastItem };
