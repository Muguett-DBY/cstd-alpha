export function radarRefreshFallbackMessage(hasExistingRadar: boolean, error: unknown) {
  if (hasExistingRadar) return "本次刷新失败，已保留上次扫描。请稍后重试。";
  return error instanceof Error ? error.message : "雷达扫描失败。";
}
