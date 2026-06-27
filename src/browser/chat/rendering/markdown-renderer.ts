// Browser Agent v86 - Markdown streaming renderer.
// Vanilla DOM renderer based on streaming-markdown. It appends nodes
// incrementally and avoids replacing innerHTML on every token.

import { t } from "../../app/i18n";
import { scrollChatLogToBottom } from "./chat-scroll";

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const STREAMING_MARKDOWN_VENDOR = "../vendor/llm/streaming-markdown/smd.js";
const DOMPURIFY_VENDOR = "../vendor/llm/dompurify/purify.es.mjs";

interface SmdAttrData {
  index: number;
  nodes: Array<Element | null | undefined>;
}

interface SmdRenderer {
  set_attr: (data: SmdAttrData, type: unknown, value: string) => void;
}

interface StreamingMarkdownModule {
  HREF: unknown;
  SRC: unknown;
  default_renderer: (container: HTMLElement) => SmdRenderer;
  parser: (renderer: SmdRenderer) => unknown;
  parser_write: (parser: unknown, chunk: string) => void;
  parser_end: (parser: unknown) => void;
}

interface DomPurifyModule {
  sanitize: (html: string, options?: Record<string, unknown>) => string;
}

export interface MarkdownStreamRenderer {
  write: (chunk: string) => void;
  end: () => void;
  getRaw: () => string;
}

let smdPromise: Promise<StreamingMarkdownModule> | null = null;
let purifyPromise: Promise<DomPurifyModule | null> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStreamingMarkdownModule(value: unknown): value is StreamingMarkdownModule {
  return isRecord(value)
    && "HREF" in value
    && "SRC" in value
    && typeof value.default_renderer === "function"
    && typeof value.parser === "function"
    && typeof value.parser_write === "function"
    && typeof value.parser_end === "function";
}

function isDomPurifyModule(value: unknown): value is DomPurifyModule {
  return isRecord(value) && typeof value.sanitize === "function";
}

async function loadStreamingMarkdown(): Promise<StreamingMarkdownModule> {
  if (!smdPromise) {
    smdPromise = import(STREAMING_MARKDOWN_VENDOR).then((module: unknown) => {
      if (!isStreamingMarkdownModule(module)) throw new Error("Invalid streaming-markdown module");
      return module;
    });
  }
  return smdPromise;
}

async function loadDOMPurify(): Promise<DomPurifyModule | null> {
  if (!purifyPromise) {
    purifyPromise = import(DOMPURIFY_VENDOR)
      .then((module: unknown) => {
        const candidate = isRecord(module) && "default" in module ? module.default : module;
        return isDomPurifyModule(candidate) ? candidate : null;
      })
      .catch(() => null);
  }
  return purifyPromise;
}

function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.href);
    return SAFE_URL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function createSafeRenderer(smd: StreamingMarkdownModule, container: HTMLElement): SmdRenderer {
  const renderer = smd.default_renderer(container);
  const originalSetAttr = renderer.set_attr.bind(renderer);

  renderer.set_attr = (data, type, value) => {
    // streaming-markdown exposes Attr constants. Validate href/src before the
    // default renderer sets them on <a> or <img> nodes.
    if ((type === smd.HREF || type === smd.SRC) && !isSafeUrl(value)) {
      return;
    }
    originalSetAttr(data, type, value);

    const current = data.nodes[data.index];
    if (type === smd.HREF && current?.tagName === "A") {
      current.setAttribute("target", "_blank");
      current.setAttribute("rel", "noopener noreferrer");
    }
  };

  return renderer;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.className = "clipboard-fallback";
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function codeTextFromPre(pre: HTMLPreElement | null): string {
  if (!pre) return "";
  return (pre.querySelector("code")?.textContent ?? pre.textContent ?? "").replace(/\n$/, "");
}

function enhanceCodeBlocksWithCopy(root: ParentNode | null): void {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll<HTMLPreElement>("pre").forEach((pre) => {
    if (pre.closest(".ba-code-block")) return;

    const wrap = document.createElement("div");
    wrap.className = "ba-code-block";
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ba-code-copy-btn";
    btn.title = t("md.copyCode");
    btn.setAttribute("aria-label", t("md.copyCode"));
    btn.textContent = "⧉";
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void (async (): Promise<void> => {
        const ok = await copyTextToClipboard(codeTextFromPre(pre));
        if (!ok) return;
        btn.classList.add("is-copied");
        btn.title = t("common.copied");
        btn.setAttribute("aria-label", t("common.copied"));
        window.setTimeout(() => {
          btn.classList.remove("is-copied");
          btn.title = t("md.copyCode");
          btn.setAttribute("aria-label", t("md.copyCode"));
        }, 1600);
      })();
    });
    wrap.appendChild(btn);
  });
}

export async function createMarkdownStreamRenderer(container: HTMLElement): Promise<MarkdownStreamRenderer> {
  container.replaceChildren();

  const root = document.createElement("div");
  root.className = "ba-md-stream";
  container.appendChild(root);

  let raw = "";
  let parser: unknown = null;
  let smd: StreamingMarkdownModule | null = null;
  let purifier: DomPurifyModule | null = null;
  let ended = false;
  let enhanceTimer = 0;
  let codeBlockCandidate = false;

  const scheduleEnhance = (): void => {
    if (!codeBlockCandidate) return;
    if (enhanceTimer) window.clearTimeout(enhanceTimer);
    enhanceTimer = window.setTimeout(() => {
      enhanceTimer = 0;
      enhanceCodeBlocksWithCopy(root);
    }, 800);
  };

  try {
    [smd, purifier] = await Promise.all([loadStreamingMarkdown(), loadDOMPurify()]);
    const renderer = createSafeRenderer(smd, root);
    parser = smd.parser(renderer);
  } catch (error) {
    // Fallback intentionally keeps textContent only. It is less pretty but safe
    // and keeps the chat usable if a vendor file is missing.
    console.warn("Markdown streaming renderer fallback:", error);
  }

  return {
    write(chunk: string): void {
      if (ended || !chunk) return;
      raw += chunk;
      if (!codeBlockCandidate && /```|<pre[\s>]/i.test(raw)) {
        codeBlockCandidate = true;
      }
      if (parser && smd) {
        smd.parser_write(parser, chunk);
      } else {
        root.textContent = raw;
      }
      scrollChatLogToBottom(container);
      scheduleEnhance();
    },
    end(): void {
      if (ended) return;
      ended = true;
      if (enhanceTimer) {
        window.clearTimeout(enhanceTimer);
        enhanceTimer = 0;
      }
      if (parser && smd) {
        smd.parser_end(parser);
      }
      // Final DOMPurify pass protects against future renderer changes or
      // pasted/generated raw HTML in fallback scenarios.
      if (purifier?.sanitize) {
        root.innerHTML = purifier.sanitize(root.innerHTML, {
          USE_PROFILES: { html: true },
          ADD_ATTR: ["target", "aria-label", "title"],
        });
      }
      enhanceCodeBlocksWithCopy(root);
      scrollChatLogToBottom(container);
    },
    getRaw(): string {
      return raw;
    },
  };
}
