import type { AssistantChoiceOption, AssistantChoiceRequest } from "./shared/assistant";

export type AssistantClarificationOption = AssistantChoiceOption;
export type AssistantClarificationRequest = AssistantChoiceRequest;

export function composeClarifiedAssistantMessage(original: string, option: AssistantChoiceOption, customAnswer: string) {
  const custom = customAnswer.trim();
  return [
    original.trim(),
    "",
    "【用户澄清】",
    `选择：${option.label}`,
    `含义：${option.description}`,
    custom ? `补充：${custom}` : "",
    "请基于以上澄清回答；如果仍缺关键事实，先明确证据缺口，不要硬下结论。",
  ]
    .filter(Boolean)
    .join("\n");
}
