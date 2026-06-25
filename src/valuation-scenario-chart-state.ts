export function scenarioBarHeight(value: number, maxValue: number) {
  if (!Number.isFinite(value) || !Number.isFinite(maxValue) || value <= 0 || maxValue <= 0) return 32;
  return Math.round(32 + Math.min(value / maxValue, 1) * 108);
}
