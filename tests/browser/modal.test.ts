import assert from "node:assert/strict";
import test from "node:test";

import { showBaModal, showBaModalPanel } from "../../src/browser/ui/modal";

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) this.values.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.values.delete(name);
  }
}

class FakeElement extends EventTarget {
  readonly classList = new FakeClassList();
  readonly children: FakeElement[] = [];
  textContent = "";
  hidden = false;
  type = "";
  className = "";
  private readonly attributes = new Map<string, string>();

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  querySelector(): FakeElement | null {
    return null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) || null;
  }

  focus(): void {}
}

async function withModalDom<T>(run: (elements: Map<string, FakeElement>) => Promise<T>): Promise<T> {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const elements = new Map([
    ["ba-modal-overlay", new FakeElement()],
    ["ba-modal-title", new FakeElement()],
    ["ba-modal-message", new FakeElement()],
    ["ba-modal-detail", new FakeElement()],
    ["ba-modal-body", new FakeElement()],
    ["ba-modal-actions", new FakeElement()],
  ]);
  const documentTarget = new EventTarget() as EventTarget & {
    activeElement: null;
    getElementById: (id: string) => FakeElement | null;
    createElement: () => FakeElement;
  };
  documentTarget.activeElement = null;
  documentTarget.getElementById = (id) => elements.get(id) || null;
  documentTarget.createElement = () => new FakeElement();
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentTarget });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { confirm: () => true, setTimeout, clearTimeout },
  });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement });
  try {
    return await run(elements);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousHTMLElement) Object.defineProperty(globalThis, "HTMLElement", previousHTMLElement);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
}

test("modal helpers reject an already aborted operation without touching the DOM", async () => {
  const controller = new AbortController();
  controller.abort("stop");

  await assert.rejects(showBaModal({ abortSignal: controller.signal }), { name: "AbortError" });
  await assert.rejects(showBaModalPanel({ abortSignal: controller.signal }), { name: "AbortError" });
});

test("an active confirmation modal closes and rejects when the turn is stopped", async () => {
  await withModalDom(async (elements) => {
    const controller = new AbortController();
    const result = showBaModal({
      title: "Approval",
      buttons: [
        { id: "cancel", cancel: true },
        { id: "run" },
      ],
      abortSignal: controller.signal,
    });

    assert.equal(elements.get("ba-modal-overlay")?.getAttribute("aria-hidden"), "false");
    controller.abort("stopped");
    await assert.rejects(result, { name: "AbortError", message: "stopped" });
    assert.equal(elements.get("ba-modal-overlay")?.getAttribute("aria-hidden"), "true");
  });
});
