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
