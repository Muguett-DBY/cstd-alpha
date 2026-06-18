# Theme and PDF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a flash-free site-wide theme preference and a print-optimized report PDF export.

**Architecture:** Pure theme and print lifecycle helpers provide testable behavior. React components consume those helpers, while CSS tokens and print media rules provide visual coverage without adding runtime dependencies.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Vitest 4, CSS custom properties.

---

### Task 1: Theme behavior

**Files:**
- Create: `src/theme.test.ts`
- Create: `src/theme.ts`

- [ ] Write failing tests for invalid preference fallback, system resolution, preference cycling, and DOM/meta application.
- [ ] Run `npm test -- src/theme.test.ts` and confirm the missing module failure.
- [ ] Implement `ThemePreference`, `resolveTheme`, `nextThemePreference`, safe storage access, and `applyTheme`.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Theme control and visual tokens

**Files:**
- Create: `src/ThemeControl.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Modify: `src/App.css`
- Modify: `index.html`

- [ ] Add the reusable three-option theme control.
- [ ] Add the theme hook to the app and expose the control on login and authenticated shells.
- [ ] Add the pre-render bootstrap in `index.html`.
- [ ] Add dark tokens and replace light-only surface literals in primary workspaces with tokens.
- [ ] Verify `npm test -- src/theme.test.ts` remains green.

### Task 3: PDF print lifecycle

**Files:**
- Create: `src/pdf/export-report.test.ts`
- Create: `src/pdf/export-report.ts`
- Modify: `src/ReportView.tsx`
- Modify: `src/App.css`

- [ ] Write a failing test proving print mode changes the title, expands details, invokes print, and restores previous state.
- [ ] Run `npm test -- src/pdf/export-report.test.ts` and confirm the missing module failure.
- [ ] Implement the print lifecycle with `afterprint` and timeout cleanup.
- [ ] Add distinct “下载 Word” and “导出 PDF” report actions.
- [ ] Add report-only print CSS with stable white-paper colors and hidden application chrome.
- [ ] Re-run the focused PDF test and confirm it passes.

### Task 4: Verification and iteration record

**Files:**
- Modify: `.agent/iteration-log.md`

- [ ] Run `npm test`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run typecheck:functions`.
- [ ] Run `npm run build`.
- [ ] Run browser QA at desktop and mobile sizes.
- [ ] Update Round 49 in the iteration log with local and CI results plus next directions.
- [ ] Inspect `git diff`, commit the scoped changes, push `main`, and verify the Deploy Cloudflare Pages workflow.
