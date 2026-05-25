export type AssistantKeyIntent = "submit" | "newline" | "ignore";

export function assistantKeyIntent(input: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
}) {
  if (input.key !== "Enter") return "ignore";
  if (input.isComposing) return "ignore";
  if (input.shiftKey) return "newline";
  if (input.ctrlKey || input.altKey || input.metaKey) return "ignore";
  return "submit";
}

export function mergeSpeechTranscript(current: string, transcript: string) {
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) return current;
  const cleanCurrent = current.trimEnd();
  if (!cleanCurrent) return cleanTranscript;
  const needsSpace = !/[，。！？；：、\s]$/.test(cleanCurrent);
  return `${cleanCurrent}${needsSpace ? " " : ""}${cleanTranscript}`;
}

export function speechErrorMessage(error?: string) {
  if (error === "not-allowed" || error === "service-not-allowed") return "麦克风权限被拒绝，请允许浏览器使用麦克风。";
  if (error === "no-speech") return "没有识别到语音，请再试一次。";
  if (error === "audio-capture") return "没有检测到可用麦克风。";
  if (error === "network") return "浏览器内置语音服务暂时不可用；已切回手动输入，可稍后重试或使用系统听写。";
  if (error === "aborted") return "";
  return "语音识别失败，请稍后重试。";
}

export function canRestartSpeechAfterError(error?: string) {
  return error === "no-speech";
}
