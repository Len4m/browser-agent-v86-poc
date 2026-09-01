const numberFormatter = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return fallback;
}

export function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return textValue(error, "Error");
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

export function inputById(id: string): HTMLInputElement | null {
  const input = document.getElementById(id);
  return input instanceof HTMLInputElement ? input : null;
}

export function selectById(id: string): HTMLSelectElement | null {
  const select = document.getElementById(id);
  return select instanceof HTMLSelectElement ? select : null;
}

export function elementById(id: string): HTMLElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLElement ? element : null;
}

export function eventTargetElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

export function createTextElement(
  tagName: keyof HTMLElementTagNameMap,
  className: string,
  text = "",
): HTMLElement {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

export function bytesLabel(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = numeric;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${numberFormatter.format(size)} ${units[unit]}`;
}
