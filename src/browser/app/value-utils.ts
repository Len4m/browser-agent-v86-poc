export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error";
}

export function safeText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return `${value}`;
  if (typeof value === "symbol") return value.description ? `Symbol(${value.description})` : "Symbol()";
  if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]";
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return json;
  } catch {
    // Fall through to a stable object tag.
  }
  return Object.prototype.toString.call(value);
}

export function setDisabled(element: Element | null, disabled: boolean): void {
  if (
    element instanceof HTMLButtonElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
  ) {
    element.disabled = disabled;
  }
}
