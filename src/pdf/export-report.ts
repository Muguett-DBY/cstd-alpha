type PrintableReport = {
  company: {
    name: string;
  };
};

type DetailLike = { open: boolean };
type DocumentLike = {
  title: string;
  body: {
    classList: {
      add(value: string): void;
      remove(value: string): void;
    };
  };
  querySelectorAll(selector: string): ArrayLike<DetailLike>;
};
type WindowLike = {
  print(): void;
  addEventListener(event: "afterprint", handler: () => void, options?: { once?: boolean }): void;
  removeEventListener(event: "afterprint", handler: () => void): void;
  setTimeout(handler: () => void, delay: number): number;
  clearTimeout(id: number): void;
};

export function printReportAsPdf(
  report: PrintableReport,
  environment: {
    document: DocumentLike;
    window: WindowLike;
  } = {
    document,
    window,
  },
) {
  const previousTitle = environment.document.title;
  const details = Array.from(environment.document.querySelectorAll(".report details"));
  const previousDetailStates = details.map((detail) => detail.open);
  let cleaned = false;
  let fallbackTimer = 0;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    environment.document.title = previousTitle;
    environment.document.body.classList.remove("printing-report");
    details.forEach((detail, index) => {
      detail.open = previousDetailStates[index];
    });
    environment.window.removeEventListener("afterprint", cleanup);
    environment.window.clearTimeout(fallbackTimer);
  };

  environment.document.title = `${safeFileName(report.company.name)}-CSTD-Alpha-Report.pdf`;
  environment.document.body.classList.add("printing-report");
  details.forEach((detail) => {
    detail.open = true;
  });
  environment.window.addEventListener("afterprint", cleanup, { once: true });
  fallbackTimer = environment.window.setTimeout(cleanup, 60_000);
  try {
    environment.window.print();
  } catch (error) {
    cleanup();
    throw error;
  }
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-");
}
