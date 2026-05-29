// @ts-nocheck
// Browser Agent v86 - 12 Markdown streaming renderer
// Vanilla JS renderer based on streaming-markdown. It appends DOM nodes
// incrementally and avoids replacing innerHTML on every token.

(function initMarkdownStreamRenderer() {
  const safeUrlProtocols = new Set(["http:", "https:", "mailto:"]);
  let smdPromise = null;
  let purifyPromise = null;

  function loadStreamingMarkdown() {
    if (!smdPromise) {
      smdPromise = import("../vendor/llm/streaming-markdown/smd.js");
    }
    return smdPromise;
  }

  function loadDOMPurify() {
    if (!purifyPromise) {
      purifyPromise = import("../vendor/llm/dompurify/purify.es.mjs")
        .then((module) => module.default || module)
        .catch(() => null);
    }
    return purifyPromise;
  }

  function isSafeUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      return safeUrlProtocols.has(url.protocol);
    } catch {
      return false;
    }
  }

  function createSafeRenderer(smd, container) {
    const renderer = smd.default_renderer(container);
    const originalSetAttr = renderer.set_attr;

    renderer.set_attr = (data, type, value) => {
      // streaming-markdown exposes Attr constants. We validate href/src before
      // letting the default renderer set them on <a> or <img> nodes.
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

  function isNearBottom(element, tolerance = 80) {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= tolerance;
  }

  function scrollChatToBottom(container, force = false) {
    const chatLog = container.closest?.(".chat-log");
    if (!chatLog) return;
    if (force || isNearBottom(chatLog)) {
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  }

  async function copyTextToClipboard(text) {
    const value = String(text ?? "");
    if (!value) return false;
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
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

  function codeTextFromPre(pre) {
    if (!pre) return "";
    return (pre.querySelector("code")?.textContent ?? pre.textContent ?? "").replace(/\n$/, "");
  }

  function enhanceCodeBlocksWithCopy(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.closest(".ba-code-block")) return;

      const wrap = document.createElement("div");
      wrap.className = "ba-code-block";
      pre.parentNode?.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ba-code-copy-btn";
      btn.title = t("md.copyCode", "Copiar código");
      btn.setAttribute("aria-label", t("md.copyCode", "Copiar código"));
      btn.textContent = "⧉";
      btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const ok = await copyTextToClipboard(codeTextFromPre(pre));
        if (!ok) return;
        btn.classList.add("is-copied");
        btn.title = t("md.copied", "Copiado");
        btn.setAttribute("aria-label", t("md.copied", "Copiado"));
        window.setTimeout(() => {
          btn.classList.remove("is-copied");
          btn.title = t("md.copyCode", "Copiar código");
          btn.setAttribute("aria-label", t("md.copyCode", "Copiar código"));
        }, 1600);
      });
      wrap.appendChild(btn);
    });
  }

  async function BA_createMarkdownStreamRenderer(container) {
    container.replaceChildren();

    const root = document.createElement("div");
    root.className = "ba-md-stream";
    container.appendChild(root);

    let raw = "";
    let parser = null;
    let smd = null;
    let purifier = null;
    let ended = false;
    let enhanceTimer = null;
    let codeBlockCandidate = false;

    const scheduleEnhance = () => {
      if (!codeBlockCandidate) return;
      if (enhanceTimer) window.clearTimeout(enhanceTimer);
      enhanceTimer = window.setTimeout(() => {
        enhanceTimer = null;
        enhanceCodeBlocksWithCopy(root);
      }, 800);
    };

    try {
      [smd, purifier] = await Promise.all([loadStreamingMarkdown(), loadDOMPurify()]);
      const renderer = createSafeRenderer(smd, root);
      parser = smd.parser(renderer);
    } catch (error) {
      // Fallback intentionally keeps textContent only. It is less pretty but safe
      // and keeps the chat usable if the vendor file is missing.
      console.warn("Markdown streaming renderer fallback:", error);
    }

    return {
      write(chunk) {
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
        scrollChatToBottom(container);
        scheduleEnhance();
      },
      end() {
        if (ended) return;
        ended = true;
        if (enhanceTimer) {
          window.clearTimeout(enhanceTimer);
          enhanceTimer = null;
        }
        if (parser && smd) {
          smd.parser_end(parser);
        }
        // Final pass through DOMPurify protects against future renderer changes
        // or pasted/generated raw HTML in fallback scenarios.
        if (purifier?.sanitize) {
          root.innerHTML = purifier.sanitize(root.innerHTML, {
            USE_PROFILES: { html: true },
            ADD_ATTR: ["target", "aria-label", "title"],
          });
        }
        enhanceCodeBlocksWithCopy(root);
        scrollChatToBottom(container, true);
      },
      getRaw() {
        return raw;
      },
    };
  }

  window.BA_createMarkdownStreamRenderer = BA_createMarkdownStreamRenderer;
})();
