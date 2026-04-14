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

  // 2. Suppress download — ONLY when extension triggered it (window.__aluraRevisorCapturing === true)
  // When the user clicks "Baixar traduções (ZIP)" manually, the download proceeds normally.

  const _origDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    if (
      this instanceof HTMLAnchorElement &&
      this.download &&
      event.type === "click" &&
      _zipUrls.has(this.href) &&
      window.__aluraRevisorCapturing
    ) {
      console.log("[Revisor] Download suprimido via dispatchEvent");
      window.__aluraRevisorCapturing = false;
      _zipUrls.delete(this.href);
      URL.revokeObjectURL(this.href);
      return false;
    }
    return _origDispatch.apply(this, arguments);
  };

  const _origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && _zipUrls.has(this.href) && window.__aluraRevisorCapturing) {
      console.log("[Revisor] Download suprimido via .click()");
      window.__aluraRevisorCapturing = false;
      _zipUrls.delete(this.href);
      URL.revokeObjectURL(this.href);
      return;
    }
    return _origClick.apply(this, arguments);
  };

  document.addEventListener("click", function (e) {
    const a = e.target.closest ? e.target.closest("a[download]") : null;
    if (!a) return;
    if (_zipUrls.has(a.href) && window.__aluraRevisorCapturing) {
      console.log("[Revisor] Download suprimido via document click");
      window.__aluraRevisorCapturing = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      _zipUrls.delete(a.href);
      URL.revokeObjectURL(a.href);
    }
  }, true);

  console.log("[Revisor] injected-ferramentas-ia.js carregado, overrides ativos.");
})();
