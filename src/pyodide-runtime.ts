export type PyodideModule = typeof import("pyodide");

export const PYODIDE_RUNTIME_VERSION = "0.29.4";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_RUNTIME_VERSION}/full/`;

export function loadPyodideModule(): Promise<PyodideModule> {
  return import(/* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`) as Promise<PyodideModule>;
}
