// injected-ferramentas-ia.js — runs in MAIN world via <script src>
// Loaded by content-ferramentas-ia.js to bypass the page's CSP that blocks inline scripts.

(function () {
  const _zipUrls = new Set();

  // 1. Capture ZIP blob via createObjectURL override
  const _origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = _origCreate(blob);
    if (blob && blob.type && blob.type.includes("zip")) {
      console.log("[Revisor] ZIP interceptado, size:", blob.size);
      _zipUrls.add(url);
      const reader = new FileReader();
      reader.onload = function () {
        const base64 = reader.result.split(",")[1];
        window.postMessage({
          type: "FERRAMENTAS_IA_ZIP_BLOB",
          base64: base64,
          mimeType: blob.type,
          size: blob.size,
        }, "*");
      };
      reader.readAsDataURL(blob);
    }
    return url;
  };

  // 2. Suppress download via EventTarget.prototype.dispatchEvent
  // Next.js creates a detached <a> and calls dispatchEvent — not .click() and not in DOM,
  // so neither HTMLAnchorElement.prototype.click nor document capture listeners work.
  const _origDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    if (
      this instanceof HTMLAnchorElement &&
      this.download &&
      event.type === "click" &&
      _zipUrls.has(this.href)
    ) {
      console.log("[Revisor] Download suprimido via dispatchEvent");
      _zipUrls.delete(this.href);
      URL.revokeObjectURL(this.href);
      return false;
    }
    return _origDispatch.apply(this, arguments);
  };

  // 3. Also cover .click() directly on detached anchors
  const _origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && _zipUrls.has(this.href)) {
      console.log("[Revisor] Download suprimido via .click()");
      _zipUrls.delete(this.href);
      URL.revokeObjectURL(this.href);
      return;
    }
    return _origClick.apply(this, arguments);
  };

  // 4. Also cover document-level clicks (for anchors that ARE in the DOM)
  document.addEventListener("click", function (e) {
    const a = e.target.closest ? e.target.closest("a[download]") : null;
    if (!a) return;
    if (_zipUrls.has(a.href)) {
      console.log("[Revisor] Download suprimido via document click");
      e.preventDefault();
      e.stopImmediatePropagation();
      _zipUrls.delete(a.href);
      URL.revokeObjectURL(a.href);
    }
  }, true);

  console.log("[Revisor] injected-ferramentas-ia.js carregado, overrides ativos.");
})();
