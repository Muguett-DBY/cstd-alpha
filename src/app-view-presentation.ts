import type { AppViewLoadingTarget } from "./app-view-loading";

interface AppViewPresentationOptions {
  isMobileViewport: boolean;
  role?: string | null;
}

interface AppViewPresentation {
  renderedView: AppViewLoadingTarget;
  mobileAssistantLayout: boolean;
}

export function resolveAppViewPresentation(
  activeView: AppViewLoadingTarget,
  options: AppViewPresentationOptions,
): AppViewPresentation {
  return {
    renderedView: activeView,
    mobileAssistantLayout: options.isMobileViewport && options.role === "admin" && activeView === "assistant",
  };
}
