import { MODEL_TOOL_NAMES, MODEL_TOOL_TEXT } from '@nexus/wire';

export function catalogToolNames(): readonly string[] {
  return MODEL_TOOL_NAMES;
}

/** 一個工具在目錄裡那一節必須含有的字串（wire 的 `MODEL_TOOL_TEXT` 登記過的）。 */
export function catalogToolText(name: string): readonly string[] {
  const text = MODEL_TOOL_TEXT[name];
  if (text === undefined) throw new Error(`wire 的 MODEL_TOOL_TEXT 沒有登記 ${name}`);
  return text;
}
