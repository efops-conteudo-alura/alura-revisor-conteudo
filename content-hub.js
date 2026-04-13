// content-hub.js — injected into https://hub-producao-conteudo.vercel.app/*
//
// Protocol (fire-and-forget, no ACK):
//   Hub  → Extension : HUB_PAGE_READY      — page mounted
//   Hub  → Extension : HUB_EXPORT_REQUEST  — "Subir no Admin" clicked
//   Extension → Hub  : EXTENSION_UPLOAD_DONE — upload finished

(function () {
  "use strict";

  // Platform pre-selected via the extension popup (optional).
  // When set, skip the platform modal and go straight to upload.
  let platformFromPopup = null;

  // ── 1. Hub messages ───────────────────────────────────────────────────────

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;

    if (event.data?.type === "HUB_EXPORT_REQUEST") {
      const payload = event.data;
      if (!payload?.courseId || !Array.isArray(payload?.sections)) return;

      if (platformFromPopup) {
        const platform = platformFromPopup;
        platformFromPopup = null;
        showUploadOverlay(payload, platform);
      } else {
        showPlatformModal(payload);
      }
    }
  });

  // ── 2. Extension popup button ─────────────────────────────────────────────
  // Pre-selects the platform and programmatically clicks "Subir no Admin",
  // which causes the hub to fire HUB_EXPORT_REQUEST.

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg?.type !== "ALURA_REVISOR_HUB_UPLOAD") return;

    const uploadBtn = [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("Subir no Admin"));

    if (!uploadBtn) {
      sendResponse({ ok: false, error: "Botão 'Subir no Admin' não encontrado na página." });
      return;
    }

    platformFromPopup = msg.platform || "alura";
    sendResponse({ ok: true });
    uploadBtn.click();
    return true;
  });

  // ── 3. Platform selection modal ───────────────────────────────────────────

  let modalHost = null;

  function showPlatformModal(payload) {
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
    shadow.appendChild(buildModalStyles());

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `
      <h2>⬆ Upload de Atividades</h2>
      <div class="course-badge">Curso: <strong>${payload.courseId}</strong></div>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <span class="label">Plataforma de destino</span>
        <div class="radio-group">
          <label><input type="radio" name="platform" value="alura" checked> Alura</label>
          <label><input type="radio" name="platform" value="latam"> Latam</label>
        </div>
      </div>
      <div class="progress-box" id="progress-box"></div>
      <div class="result-box" id="result-box" style="display:none;"></div>
      <div class="actions" id="actions">
        <button class="btn-cancel" id="btn-cancel">Cancelar</button>
        <button class="btn-upload" id="btn-upload">⬆ Fazer Upload</button>
      </div>
    `;

    shadow.appendChild(modal);
    document.body.appendChild(modalHost);

    shadow.getElementById("btn-cancel").addEventListener("click", () => {
      modalHost.remove();
      modalHost = null;
    });

    shadow.getElementById("btn-upload").addEventListener("click", () => {
      const platform = shadow.querySelector("input[name='platform']:checked")?.value || "alura";
      startUpload(payload, platform, shadow);
    });
  }

  // ── 4. Upload overlay (platform already known from popup) ─────────────────

  function showUploadOverlay(payload, platform) {
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
    shadow.appendChild(buildModalStyles());

    const platformLabel = platform === "latam" ? "Latam" : "Alura";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `
      <h2>⬆ Enviando atividades…</h2>
      <div class="course-badge">Curso: <strong>${payload.courseId}</strong> → <strong>${platformLabel}</strong></div>
      <div class="progress-box" id="progress-box"></div>
      <div class="result-box" id="result-box" style="display:none;"></div>
      <div class="actions" id="actions" style="display:none;">
        <button class="btn-cancel" id="btn-close">Fechar</button>
      </div>
    `;

    shadow.appendChild(modal);
    document.body.appendChild(modalHost);

    startUpload(payload, platform, shadow);
  }

  // ── 5. Shared styles ──────────────────────────────────────────────────────

  function buildModalStyles() {
    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; }
      .modal {
        background: #fff; border-radius: 16px; padding: 28px 32px;
        width: 380px; max-width: 95vw;
        box-shadow: 0 8px 40px rgba(0,0,0,0.22);
        display: flex; flex-direction: column; gap: 18px;
      }
      .modal h2 { font-size: 17px; font-weight: 700; color: #1a1a2e; }
      .course-badge { background: #f0f0f7; border-radius: 8px; padding: 8px 14px; font-size: 13px; color: #555; }
      .course-badge strong { color: #1a1a2e; font-size: 15px; }
      .label { font-size: 13px; font-weight: 600; color: #444; }
      .radio-group { display: flex; gap: 12px; }
      .radio-group label {
        flex: 1; display: flex; align-items: center; gap: 8px;
        padding: 10px 14px; border: 2px solid #e0e0e0; border-radius: 10px;
        cursor: pointer; font-size: 14px; font-weight: 600; color: #333;
        transition: border-color 0.15s, background 0.15s;
      }
      .radio-group label:has(input:checked) { border-color: #5a2d82; background: #f6f0ff; color: #5a2d82; }
      .radio-group input { accent-color: #5a2d82; }
      .progress-box { display: flex; flex-direction: column; gap: 10px; }
      .progress-box:empty { display: none; }
      .progress-text { font-size: 13px; color: #444; line-height: 1.5; }
      .progress-bar-wrap { background: #eee; border-radius: 99px; height: 8px; overflow: hidden; }
      .progress-bar { height: 100%; background: #5a2d82; border-radius: 99px; transition: width 0.3s; width: 0%; }
      .result-box { font-size: 13px; color: #333; line-height: 1.6; }
      .result-box .ok { color: #2e7d32; font-weight: 700; }
      .result-box .err { color: #c62828; font-weight: 700; }
      .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
      .btn-cancel, .btn-close {
        padding: 9px 18px; border: 2px solid #e0e0e0; border-radius: 9px;
        background: #fff; color: #555; font-size: 14px; font-weight: 600; cursor: pointer;
      }
      .btn-cancel:hover, .btn-close:hover { background: #f5f5f5; }
      .btn-upload {
        padding: 9px 22px; border: none; border-radius: 9px;
        background: #5a2d82; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer;
      }
      .btn-upload:hover { background: #4a2070; }
      .btn-upload:disabled { opacity: 0.55; cursor: not-allowed; }
    `;
    return style;
  }

  // ── 6. Upload orchestration ───────────────────────────────────────────────

  async function startUpload(payload, platform, shadow) {
    const btnUpload = shadow.getElementById("btn-upload");
    const btnCancel = shadow.getElementById("btn-cancel");
    const progressBox = shadow.getElementById("progress-box");
    const resultBox = shadow.getElementById("result-box");
    const actions = shadow.getElementById("actions");

    if (btnUpload) btnUpload.disabled = true;
    if (btnCancel) btnCancel.style.display = "none";

    const courseId = String(payload.courseId);
    const createSection = platform === "latam"
      ? "ALURA_REVISOR_CREATE_LATAM_SECTION"
      : "ALURA_REVISOR_CREATE_ALURA_SECTION";
    const createTask = platform === "latam"
      ? "ALURA_REVISOR_CREATE_LATAM_TASK"
      : "ALURA_REVISOR_CREATE_ALURA_TASK";
    const courseIdKey = platform === "latam" ? "latamCourseId" : "aluraCourseId";
    const sectionIdKey = platform === "latam" ? "latamSectionId" : "aluraSectionId";

    const totalSections = payload.sections.length;
    const validActivities = payload.sections.reduce(
      (sum, s) => sum + s.activities.filter((a) => !a.skipped && !a.error).length,
      0
    );
    let doneActivities = 0;
    let errors = 0;

    // Build progress UI
    progressBox.innerHTML = `
      <span class="label" id="progress-label">Seção 0/${totalSections}</span>
      <div class="progress-text" id="progress-text"></div>
      <div class="progress-bar-wrap"><div class="progress-bar" id="progress-bar"></div></div>
    `;

    function updateProgress(sectionIdx, activityLabel) {
      const pct = validActivities > 0 ? Math.round((doneActivities / validActivities) * 100) : 0;
      shadow.getElementById("progress-bar").style.width = pct + "%";
      shadow.getElementById("progress-label").textContent = `Seção ${sectionIdx + 1}/${totalSections}`;
      shadow.getElementById("progress-text").innerHTML = activityLabel
        ? `→ "${activityLabel}"`
        : "";
    }

    // Busca seções já existentes na plataforma para reaproveitar os IDs
    const getSections = platform === "latam"
      ? "ALURA_REVISOR_GET_LATAM_SECTIONS"
      : "ALURA_REVISOR_GET_ALURA_SECTIONS";
    let existingSectionMap = {}; // { [número]: sectionId }
    try {
      const sectionsResp = await chrome.runtime.sendMessage({
        type: getSections,
        [courseIdKey]: courseId,
      });
      if (sectionsResp?.ok && sectionsResp.sections?.length) {
        for (const s of sectionsResp.sections) {
          existingSectionMap[s.number] = s.id;
        }
      }
    } catch (e) {
      console.warn("[Hub Upload] Não foi possível buscar seções existentes:", e.message);
    }

    for (let si = 0; si < payload.sections.length; si++) {
      const section = payload.sections[si];
      updateProgress(si, null);

      let sectionResp;
      const sectionNumber = si + 1;
      const existingSectionId = existingSectionMap[sectionNumber] ?? null;

      if (existingSectionId) {
        sectionResp = { ok: true, sectionId: existingSectionId };
      } else {
        try {
          sectionResp = await chrome.runtime.sendMessage({
            type: createSection,
            [courseIdKey]: courseId,
            sectionName: section.title,
          });
        } catch (e) {
          sectionResp = { ok: false, error: e.message };
        }
      }

      if (!sectionResp?.ok) {
        errors += section.activities.filter((a) => !a.skipped && !a.error).length;
        console.warn(`[Hub Upload] Falha ao criar seção "${section.title}":`, sectionResp?.error);
        continue;
      }

      for (const activity of section.activities) {
        if (activity.skipped || activity.error) continue;

        updateProgress(si, activity.title || activity.id);

        try {
          const taskResp = await chrome.runtime.sendMessage({
            type: createTask,
            [courseIdKey]: courseId,
            [sectionIdKey]: sectionResp.sectionId,
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

    // Report result back to the hub (for toast/feedback)
    const platformLabel = platform === "latam" ? "Latam" : "Alura";
    window.postMessage({
      type: "EXTENSION_UPLOAD_DONE",
      success: errors === 0,
      count: doneActivities,
      errors,
      platform: platformLabel,
    }, "*");

    // Show result in modal
    progressBox.innerHTML = "";
    resultBox.style.display = "block";
    if (errors === 0) {
      resultBox.innerHTML =
        `<span class="ok">✓ Upload concluído!</span><br>` +
        `${doneActivities} atividade(s) enviadas para <strong>${platformLabel}</strong>.`;
    } else {
      resultBox.innerHTML =
        `<span class="ok">✓ ${doneActivities} atividade(s) enviadas</span> para <strong>${platformLabel}</strong>.<br>` +
        `<span class="err">✗ ${errors} erro(s)</span> — verifique o console para detalhes.`;
    }

    actions.style.display = "flex";
    actions.innerHTML = '<button class="btn-close" id="btn-close">Fechar</button>';
    shadow.getElementById("btn-close").addEventListener("click", () => {
      modalHost.remove();
      modalHost = null;
    });
  }
})();
