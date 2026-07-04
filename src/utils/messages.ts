export function isAIMessage(m: any): boolean {
  if (!m) return false;
  // Class instance check
  if (m.constructor?.name === "AIMessage" || (typeof m._getType === "function" && m._getType() === "ai")) {
    return true;
  }
  // Deserialized plain object check
  if (m.id?.[2] === "AIMessage" || m.type === "ai") {
    return true;
  }
  return false;
}

export function isHumanMessage(m: any): boolean {
  if (!m) return false;
  // Class instance check
  if (m.constructor?.name === "HumanMessage" || (typeof m._getType === "function" && m._getType() === "human")) {
    return true;
  }
  // Deserialized plain object check
  if (m.id?.[2] === "HumanMessage" || m.type === "human") {
    return true;
  }
  return false;
}

export function getMessageContent(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") {
    return m.content;
  }
  if (m.kwargs?.content && typeof m.kwargs.content === "string") {
    return m.kwargs.content;
  }
  return "";
}
