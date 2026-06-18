# Theme and PDF Export Design

## Objective

Continue Round 48 by delivering the two highest-value explicit follow-ups: site-wide dark mode and report PDF export. Dark mode is the flagship change because it affects every core workspace. PDF export is the additional user-visible increment that completes the report sharing workflow without adding a dependency.

## Product behavior

- Theme preference has three states: follow system, light, and dark.
- The preference persists in local storage and updates immediately.
- The resolved theme is applied before React loads so returning users do not see a light-theme flash.
- The browser theme color follows the resolved theme.
- Theme controls are available on the login screen and authenticated app shell.
- Report actions distinguish Word and PDF clearly.
- PDF export opens the browser print dialog with a report-only print layout suitable for “Save as PDF”.
- Printing temporarily expands collapsed report details and restores their prior state afterward.

## Architecture

- `src/theme.ts` owns preference parsing, resolution, DOM application, persistence, and the React hook.
- `src/ThemeControl.tsx` owns the reusable accessible three-option control.
- `src/pdf/export-report.ts` owns the print lifecycle and UI restoration.
- `src/index.css` owns light/dark design tokens.
- `src/App.css` consumes tokens and defines print-only layout rules.
- `index.html` contains the minimal pre-render bootstrap required to avoid theme flash.

## Error handling

- Unavailable or malformed local storage falls back to system preference.
- Browsers without modern media-query listeners still receive the initial resolved theme.
- PDF export always restores document title, body class, and collapsed sections after printing or timeout fallback.
- The PDF action reports failure through the existing toast system.

## Verification

- Unit tests cover preference parsing, theme resolution/cycling, persistence application, and print state restoration.
- Existing tests, lint, functions typecheck, and production build must pass.
- Browser QA covers login and authenticated shell where possible, desktop and mobile layouts, dark/light switching, persistence, and print preview behavior.
