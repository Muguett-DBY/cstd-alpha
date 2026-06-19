import type { ThemePreference } from "./theme";

const options: Array<{ value: ThemePreference; label: string; icon: string }> = [
  { value: "system", label: "系统", icon: "◐" },
  { value: "light", label: "浅色", icon: "☀" },
  { value: "dark", label: "深色", icon: "☾" },
];

export function ThemeControl({
  value,
  onChange,
  compact = false,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
  compact?: boolean;
}) {
  return (
    <div className={`theme-control ${compact ? "compact" : ""}`} role="group" aria-label="界面主题">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          title={`${option.label}主题`}
          onClick={() => onChange(option.value)}
        >
          <span className="theme-icon" aria-hidden="true">{option.icon}</span>
          <span className="theme-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
