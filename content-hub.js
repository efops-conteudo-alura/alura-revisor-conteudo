// content-hub.js — injected into https://hub-producao-conteudo.vercel.app/*
// Intercepts the "Exportar JSON" button, shows a platform selection modal,
// and uploads activities directly to Alura or LATAM admin.

(function () {
  "use strict";

  // ── 1. Interceptor is injected via background.js (chrome.scripting.executeScript
  //       with world:"MAIN") to bypass the page's Content-Security-Policy.
  //       See ALURA_REVISOR_HUB_INJECT_MAIN handler in background.js.

  // ── 2. Listen for the intercepted JSON and popup messages ────────────────

  let pendingJson = null;
  let platformFromPopup = null; // set when triggered from the extension popup

  // Triggered by the extension popup button
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg?.type !== "ALURA_REVISOR_HUB_UPLOAD") return;

    const exportBtn = [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("Exportar JSON"));

    if (!exportBtn) {
      sendResponse({ ok: false, error: "Botão 'Exportar JSON' não encontrado na página." });
      return;
    }

    platformFromPopup = msg.platform || "alura";

    // Ask background to inject the MAIN world interceptor (bypasses CSP),
    // then programmatically click the export button.
    chrome.runtime.sendMessage({ type: "ALURA_REVISOR_HUB_INJECT_MAIN" }, function (result) {
      if (!result?.ok) {
        platformFromPopup = null;
        console.error("[Hub Upload] Falha ao injetar interceptor:", result?.error);
        return;
      }
      exportBtn.click();
    });

    sendResponse({ ok: true });
    return true;
  });

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (event.data?.type !== "ALURA_HUB_JSON_READY") return;
    try {
      const json = JSON.parse(event.data.content);
      if (!json?.courseId || !Array.isArray(json?.sections)) return; // guard
      pendingJson = json;

      if (platformFromPopup) {
        // Platform already chosen in popup — skip modal, go straight to upload
        const platform = platformFromPopup;
        platformFromPopup = null;
        showUploadOverlay(json, platform);
      } else {
        showPlatformModal(json);
      }
    } catch (_) {}
  });

  // ── 3. Modal ──────────────────────────────────────────────────────────────

  let modalHost = null;

  function showPlatformModal(json) {
    if (modalHost) modalHost.remove();

    modalHost = document.createElement("div");
    modalHost.id = "alura-hub-modal-host";
    Object.assign(modalHost.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,0.55)",
    });

    const shadow = modalHost.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; }
      .modal {
        background: #fff;
        border-radius: 16px;
        padding: 28px 32px;
        width: 380px;
        max-width: 95vw;
        box-shadow: 0 8px 40px rgba(0,0,0,0.22);
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      .modal h2 { font-size: 17px; font-weight: 700; color: #1a1a2e; }
      .course-badge {
        background: #f0f0f7;
        border-radius: 8px;
        padding: 8px 14px;
        font-size: 13px;
        color: #555;
      }
      .course-badge strong { color: #1a1a2e; font-size: 15px; }
      .label { font-size: 13px; font-weight: 600; color: #444; }
      .radio-group { display: flex; gap: 12px; }
      .radio-group label {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border: 2px solid #e0e0e0;
        border-radius: 10px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        color: #333;
        transition: border-color 0.15s, background 0.15s;
      }
      .radio-group label:has(input:checked) {
        border-color: #5a2d82;
        background: #f6f0ff;
        color: #5a2d82;
      }
      .radio-group input { accent-color: #5a2d82; }
      .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
      .btn-cancel {
        padding: 9px 18px;
        border: 2px solid #e0e0e0;
        border-radius: 9px;
        background: #fff;
        color: #555;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn-cancel:hover { background: #f5f5f5; }
      .btn-upload {
        padding: 9px 22px;
        border: none;
        border-radius: 9px;
        background: #5a2d82;
        color: #fff;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .btn-upload:hover { background: #4a2070; }
      .btn-upload:disabled { opacity: 0.55; cursor: not-allowed; }
      /* Progress state */
      .progress-box {
        display: none;
        flex-direction: column;
        gap: 10px;
      }
      .progress-box.visible { display: flex; }
      .progress-text { font-size: 13px; color: #444; line-height: 1.5; }
      .progress-bar-wrap {
        background: #eee;
        border-radius: 99px;
        height: 8px;
        overflow: hidden;
      }
      .progress-bar {
        height: 100%;
        background: #5a2d82;
        border-radius: 99px;
        transition: width 0.3s;
        width: 0%;
      }
      .result-box { font-size: 13px; color: #333; line-height: 1.6; }
      .result-box .ok { color: #2e7d32; font-weight: 700; }
      .result-box .err { color: #c62828; font-weight: 700; }
    `;

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `
      <h2>⬆ Upload de Atividades</h2>
      <div class="course-badge">Curso: <strong>${json.courseId}</strong></div>
      <div id="form-area">
        <div style="display:flex;flex-direction:column;gap:14px;">
          <span class="label">Plataforma de destino</span>
          <div class="radio-group">
            <label>
              <input type="radio" name="platform" value="alura" checked>
              Alura
            </label>
            <label>
              <input type="radio" name="platform" value="latam">
              Latam
            </label>
          </div>
        </div>
      </div>
      <div class="progress-box" id="progress-box">
        <span class="label" id="progress-title">Enviando atividades…</span>
        <div class="progress-text" id="progress-text">Iniciando…</div>
        <div class="progress-bar-wrap"><div class="progress-bar" id="progress-bar"></div></div>
      </div>
      <div class="result-box" id="result-box" style="display:none;"></div>
      <div class="actions" id="actions">
        <button class="btn-cancel" id="btn-cancel">Cancelar</button>
        <button class="btn-upload" id="btn-upload">⬆ Fazer Upload</button>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(modal);
    document.body.appendChild(modalHost);

    // Bind buttons
    shadow.getElementById("btn-cancel").addEventListener("click", () => {
      modalHost.remove();
      modalHost = null;
    });

    shadow.getElementById("btn-upload").addEventListener("click", () => {
      const platform = shadow.querySelector("input[name='platform']:checked")?.value || "alura";
      startUpload(json, platform, shadow);
    });
  }

  // ── 3b. Upload overlay (sem modal de confirmação — plataforma já escolhida no popup) ──

  function showUploadOverlay(json, platform) {
    if (modalHost) modalHost.remove();

    modalHost = document.createElement("div");
    modalHost.id = "alura-hub-modal-host";
    Object.assign(modalHost.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0,0,0,0.55)",
    });

    const shadow = modalHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; }
      .modal { background:#fff; border-radius:16px; padding:28px 32px; width:380px; max-width:95vw;
               box-shadow:0 8px 40px rgba(0,0,0,0.22); display:flex; flex-direction:column; gap:18px; }
      .modal h2 { font-size:17px; font-weight:700; color:#1a1a2e; }
      .course-badge { background:#f0f0f7; border-radius:8px; padding:8px 14px; font-size:13px; color:#555; }
      .course-badge strong { color:#1a1a2e; font-size:15px; }
      .label { font-size:13px; font-weight:600; color:#444; }
      .progress-text { font-size:13px; color:#444; line-height:1.5; }
      .progress-bar-wrap { background:#eee; border-radius:99px; height:8px; overflow:hidden; }
      .progress-bar { height:100%; background:#5a2d82; border-radius:99px; transition:width 0.3s; width:0%; }
      .result-box { font-size:13px; color:#333; line-height:1.6; }
      .result-box .ok { color:#2e7d32; font-weight:700; }
      .result-box .err { color:#c62828; font-weight:700; }
      .actions { display:flex; justify-content:flex-end; }
      .btn-close { padding:9px 18px; border:2px solid #e0e0e0; border-radius:9px; background:#fff;
                   color:#555; font-size:14px; font-weight:600; cursor:pointer; }
      .btn-close:hover { background:#f5f5f5; }
    `;

    const platformLabel = platform === "latam" ? "Latam" : "Alura";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `
      <h2>⬆ Enviando atividades…</h2>
      <div class="course-badge">Curso: <strong>${json.courseId}</strong> → <strong>${platformLabel}</strong></div>
      <span class="label" id="progress-title">Preparando…</span>
      <div class="progress-text" id="progress-text"></div>
      <div class="progress-bar-wrap"><div class="progress-bar" id="progress-bar"></div></div>
      <div class="result-box" id="result-box" style="display:none;"></div>
      <div class="actions" id="actions" style="display:none;">
        <button class="btn-close" id="btn-close">Fechar</button>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(modal);
    document.body.appendChild(modalHost);

    startUpload(json, platform, shadow);
  }

  // ── 4. Upload orchestration ───────────────────────────────────────────────

  async function startUpload(json, platform, shadow) {
    const formArea = shadow.getElementById("form-area");
    const progressBox = shadow.getElementById("progress-box");
    const progressText = shadow.getElementById("progress-text");
    const progressBar = shadow.getElementById("progress-bar");
    const resultBox = shadow.getElementById("result-box");
    const actions = shadow.getElementById("actions");
    const btnUpload = shadow.getElementById("btn-upload");
    const btnCancel = shadow.getElementById("btn-cancel");

    // Hide form / show progress (elements may not exist in the overlay variant)
    if (formArea) formArea.style.display = "none";
    if (progressBox) progressBox.classList.add("visible");
    if (btnUpload) btnUpload.disabled = true;
    if (btnCancel) btnCancel.style.display = "none";

    const courseId = String(json.courseId);
    const createSection = platform === "latam"
      ? "ALURA_REVISOR_CREATE_LATAM_SECTION"
      : "ALURA_REVISOR_CREATE_ALURA_SECTION";
    const createTask = platform === "latam"
      ? "ALURA_REVISOR_CREATE_LATAM_TASK"
      : "ALURA_REVISOR_CREATE_ALURA_TASK";
    const courseIdKey = platform === "latam" ? "latamCourseId" : "aluraCourseId";
    const sectionIdKey = platform === "latam" ? "latamSectionId" : "aluraSectionId";

    const validActivities = json.sections.reduce(
      (sum, s) => sum + s.activities.filter((a) => !a.skipped && !a.error).length,
      0
    );
    const totalSections = json.sections.length;

    let doneActivities = 0;
    let errors = 0;

    function updateProgress(sectionIdx, activityLabel) {
      const pct = validActivities > 0 ? Math.round((doneActivities / validActivities) * 100) : 0;
      progressBar.style.width = pct + "%";
      progressText.innerHTML =
        `Seção ${sectionIdx + 1}/${totalSections}` +
        (activityLabel ? `<br>→ ${activityLabel}` : "");
    }

    for (let si = 0; si < json.sections.length; si++) {
      const section = json.sections[si];
      updateProgress(si, null);

      let sectionResp;
      try {
        sectionResp = await chrome.runtime.sendMessage({
          type: createSection,
          [courseIdKey]: courseId,
          sectionName: section.title,
        });
      } catch (e) {
        sectionResp = { ok: false, error: e.message };
      }

      if (!sectionResp?.ok) {
        const skippable = section.activities.filter((a) => !a.skipped && !a.error).length;
        errors += skippable;
        console.warn(`[Hub Upload] Falha ao criar seção "${section.title}":`, sectionResp?.error);
        continue;
      }

      const newSectionId = sectionResp.sectionId;

      for (const activity of section.activities) {
        if (activity.skipped || activity.error) continue;

        updateProgress(si, activity.title ? `"${activity.title}"` : activity.id);

        try {
          const taskResp = await chrome.runtime.sendMessage({
            type: createTask,
            [courseIdKey]: courseId,
            [sectionIdKey]: newSectionId,
            taskEnum: activity.taskEnum,
            dataTag: activity.dataTag,
            title: activity.title,
            body: activity.body,
            opinion: activity.opinion || "",
            alternatives: activity.alternatives || [],
          });
          taskResp?.ok ? doneActivities++ : errors++;
        } catch (e) {
          errors++;
          console.warn(`[Hub Upload] Erro na atividade "${activity.title}":`, e.message);
        }
      }
    }

    // Show result
    if (progressBox) progressBox.classList.remove("visible");
    resultBox.style.display = "block";
    const platformLabel = platform === "latam" ? "Latam" : "Alura";
    if (errors === 0) {
      resultBox.innerHTML =
        `<span class="ok">✓ Upload concluído!</span><br>` +
        `${doneActivities} atividade(s) enviadas para a plataforma <strong>${platformLabel}</strong>.`;
    } else {
      resultBox.innerHTML =
        `<span class="ok">✓ ${doneActivities} atividade(s) enviadas</span> para <strong>${platformLabel}</strong>.<br>` +
        `<span class="err">✗ ${errors} erro(s)</span> — verifique o console para detalhes.`;
    }

    // Show only a close button
    actions.style.display = "flex";
    actions.innerHTML = '<button class="btn-cancel" id="btn-close">Fechar</button>';
    shadow.getElementById("btn-close").addEventListener("click", () => {
      modalHost.remove();
      modalHost = null;
    });
  }
})();
