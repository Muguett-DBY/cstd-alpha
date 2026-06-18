import { useEffect, useRef } from "react";
import { displayExchange } from "./company-utils";
import type { CompanyCandidate } from "./shared/report";

export function CandidateModal({
  candidates,
  onSelect,
  onClose,
}: {
  candidates: CompanyCandidate[];
  onSelect: (candidate: CompanyCandidate) => void;
  onClose: () => void;
}) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const firstButton = modalRef.current?.querySelector<HTMLElement>("button");
    firstButton?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = modalRef.current?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className="modal-backdrop" role="presentation" tabIndex={-1} onKeyDown={handleKeyDown}>
      <section ref={modalRef} className="candidate-modal" role="dialog" aria-modal="true" aria-labelledby="candidate-title">
        <header>
          <div>
            <p className="brand">确认上市主体</p>
            <h2 id="candidate-title">请选择你要分析的公司</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="candidate-list">
          {candidates.map((candidate) => (
            <button key={candidate.id} type="button" className="candidate-row" onClick={() => onSelect(candidate)}>
              <strong>{candidate.name}</strong>
              <span>{candidate.code}</span>
              <span>{candidate.listingPlace}</span>
              <small>{displayExchange(candidate)}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
