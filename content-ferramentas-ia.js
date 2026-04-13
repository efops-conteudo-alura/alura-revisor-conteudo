// content-ferramentas-ia.js — injected into https://ferramentas-ia.alura.dev/*
//
// Protocol:
//   Extension → Content : FERRAMENTAS_IA_CHECK_STATUS    — is translation done?
//   Extension → Content : FERRAMENTAS_IA_TRIGGER_DOWNLOAD — click download button
//   Background ← Content: FERRAMENTAS_IA_ZIP_CAPTURED     — ZIP blob captured (base64)
//
// Technique: injects a MAIN-world script that overrides URL.createObjectURL so
// the ZIP blob is intercepted before the browser triggers the download.

(function () {
  "use strict";

  // ── 1. Inject MAIN-world interceptor ──────────────────────────────────────

  // Load the MAIN-world override as an external script (bypasses CSP that blocks inline scripts).
  // The extension URL is already whitelisted in the page's CSP.
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected-ferramentas-ia.js");
  // Do NOT call script.remove() — async external scripts may not execute if removed immediately
  (document.head || document.documentElement).appendChild(script);

  // ── 2. Relay MAIN-world message to background ─────────────────────────────

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (event.data?.type !== "FERRAMENTAS_IA_ZIP_BLOB") return;

    chrome.runtime.sendMessage({
      type: "FERRAMENTAS_IA_ZIP_CAPTURED",
      base64: event.data.base64,
      mimeType: event.data.mimeType,
      size: event.data.size,
    });
  });

  // ── 3. Handle messages from popup/background ──────────────────────────────

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    // Check if page is loaded and translation is complete
    if (msg?.type === "FERRAMENTAS_IA_CHECK_STATUS") {
      const downloadBtn = document.querySelector(
        'button.TaskTranslator_downloadButton__eWo8f, button[class*="downloadButton"]'
      );
      const ready = !!(downloadBtn && downloadBtn.getAttribute("aria-disabled") !== "true" && !downloadBtn.disabled);
      sendResponse({ ok: true, onPage: true, ready });
      return true;
    }

    // Programmatically click the download button to trigger ZIP capture
    if (msg?.type === "FERRAMENTAS_IA_TRIGGER_DOWNLOAD") {
      const downloadBtn = document.querySelector(
        'button.TaskTranslator_downloadButton__eWo8f, button[class*="downloadButton"]'
      );
      if (!downloadBtn) {
        sendResponse({ ok: false, error: "Botão de download não encontrado. Aguarde a tradução terminar." });
        return true;
      }
      if (downloadBtn.getAttribute("aria-disabled") === "true" || downloadBtn.disabled) {
        sendResponse({ ok: false, error: "Tradução ainda não concluída. Aguarde 100%." });
        return true;
      }
      downloadBtn.click();
      sendResponse({ ok: true });
      return true;
    }
  });
})();
