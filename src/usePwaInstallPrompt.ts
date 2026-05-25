import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const INSTALL_PROMPT_DISMISSED_KEY = "cstd-alpha-install-dismissed";

export function usePwaInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      if (window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY) === "1") return;
      if (!window.matchMedia("(max-width: 820px), (pointer: coarse)").matches) return;
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      setInstallPrompt(null);
      window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");
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
    if (choice.outcome !== "accepted") window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");
    setVisible(false);
    setInstallPrompt(null);
  }

  function dismiss() {
    window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");
    setVisible(false);
  }

  return { visible, install, dismiss };
}
