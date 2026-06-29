import { useSyncExternalStore } from "react";
import { subscribeToToasts } from "./toast-state";

const toastStore = subscribeToToasts();

export function ToastContainer() {
  const items = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);

  if (!items.length) return null;
  return (
    <div className="toast-container" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast-item toast-${item.type}`}>
          <span className="toast-icon">{item.type === "success" ? "✓" : item.type === "error" ? "✕" : "ℹ"}</span>
          <span className="toast-message">{item.message}</span>
        </div>
      ))}
    </div>
  );
}
