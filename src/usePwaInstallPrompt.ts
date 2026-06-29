import { useEffect, useState } from "react";
import { getBrowserLocalStorage } from "./browser-storage";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export const INSTALL_PROMPT_DISMISSED_KEY = "cstd-alpha-install-dismissed";

type InstallPromptStorage = Pick<Storage, "getItem" | "setItem">;

function getInstallPromptStorage(): InstallPromptStorage | undefined {
  return getBrowserLocalStorage();
}

export function hasDismissedInstallPrompt(storage = getInstallPromptStorage()) {
  if (!storage) return false;
  try {
    return storage.getItem(INSTALL_PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberInstallPromptDismissed(storage = getInstallPromptStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function usePwaInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      if (hasDismissedInstallPrompt()) return;
      if (!window.matchMedia("(max-width: 820px), (pointer: coarse)").matches) return;
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      setInstallPrompt(null);
      rememberInstallPromptDismissed();
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => ({ outcome: "dismissed" as const, platform: "" }));
    if (choice.outcome !== "accepted") rememberInstallPromptDismissed();
    setVisible(false);
    setInstallPrompt(null);
  }

  function dismiss() {
    rememberInstallPromptDismissed();
    setVisible(false);
  }

  return { visible, install, dismiss };
}
