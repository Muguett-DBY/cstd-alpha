import { describe, expect, test, vi } from "vitest";
import { printReportAsPdf } from "./export-report";

describe("PDF report export", () => {
  test("enters print mode and restores the document after printing", () => {
    const classes = new Set<string>();
    const closedDetail = { open: false };
    const openDetail = { open: true };
    let afterPrint: (() => void) | undefined;
    const documentLike = {
      title: "CSTD Alpha",
      body: {
        classList: {
          add: (value: string) => classes.add(value),
          remove: (value: string) => classes.delete(value),
        },
      },
      querySelectorAll: () => [closedDetail, openDetail],
    };
    const windowLike = {
      print: vi.fn(),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "afterprint") afterPrint = handler;
      }),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(() => 7),
      clearTimeout: vi.fn(),
    };

    printReportAsPdf(
      { company: { name: 'Example: "Alpha"/Beta' } },
      { document: documentLike, window: windowLike },
    );

    expect(documentLike.title).toBe("Example- -Alpha--Beta-CSTD-Alpha-Report.pdf");
    expect(classes.has("printing-report")).toBe(true);
    expect(closedDetail.open).toBe(true);
    expect(openDetail.open).toBe(true);
    expect(windowLike.print).toHaveBeenCalledOnce();

    afterPrint?.();

    expect(documentLike.title).toBe("CSTD Alpha");
    expect(classes.has("printing-report")).toBe(false);
    expect(closedDetail.open).toBe(false);
    expect(openDetail.open).toBe(true);
    expect(windowLike.removeEventListener).toHaveBeenCalledWith("afterprint", expect.any(Function));
    expect(windowLike.clearTimeout).toHaveBeenCalledWith(7);
  });

  test("restores print state when the browser print API throws", () => {
    const classes = new Set<string>();
    const detail = { open: false };
    const documentLike = {
      title: "CSTD Alpha",
      body: {
        classList: {
          add: (value: string) => classes.add(value),
          remove: (value: string) => classes.delete(value),
        },
      },
      querySelectorAll: () => [detail],
    };
    const windowLike = {
      print: vi.fn(() => { throw new Error("print unavailable"); }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(() => 9),
      clearTimeout: vi.fn(),
    };

    expect(() =>
      printReportAsPdf(
        { company: { name: "Example" } },
        { document: documentLike, window: windowLike },
      ),
    ).toThrow("print unavailable");

    expect(documentLike.title).toBe("CSTD Alpha");
    expect(classes.has("printing-report")).toBe(false);
    expect(detail.open).toBe(false);
    expect(windowLike.clearTimeout).toHaveBeenCalledWith(9);
  });
});
