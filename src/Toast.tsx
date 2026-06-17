import { useEffect, useState } from "react";
import { subscribeToToasts, type ToastItem } from "./toast-state";

export function ToastContainer() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const unsub = subscribeToToasts().subscribe(setItems);
    return unsub;
  }, []);

  if (!items.length) return null;
  return (
    <div className="toast-container" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast-item toast-${item.type}`}>
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}
