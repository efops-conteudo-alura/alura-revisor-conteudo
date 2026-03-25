const KEY = "aluraRevisorRunState";
const KEY_HISTORY = "aluraRevisorHistory";

const statusEl = document.getElementById("status");
const btn = document.getElementById("start");
const btnDownload = document.getElementById("btnDownload");
const btnUpload = document.getElementById("btnUpload");
const historyEl = document.getElementById("history");

let isRunning = false;
let isDownloading = false;
let isUploading = false;
let currentHistory = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function setRunningUI(running) {
  isRunning = running;
  btn.textContent = running ? "Parar revisão" : "Start revisão";
  btn.style.background = running ? "#e53935" : "#00c86f";
  btn.style.color = "#fff";
  if (btnDownload) btnDownload.disabled = running;
}

function setUploadingUI(uploading, count) {
  isUploading = uploading;
  if (!btnUpload) return;
  if (uploading) {
    const label = count != null ? `Subindo… (${count} vídeo(s))` : "Subindo…";
    btnUpload.textContent = label;
    btnUpload.style.background = "#e53935";
    btnUpload.style.color = "#fff";
    btn.disabled = true;
    if (btnDownload) btnDownload.disabled = true;
  } else {
    btnUpload.textContent = "Subir vídeos do curso";
    btnUpload.style.background = "#067ada";
    btnUpload.style.color = "#fff";
    btn.disabled = false;
    if (btnDownload) btnDownload.disabled = false;
  }
}

function setDownloadingUI(downloading, count) {
  isDownloading = downloading;
  if (!btnDownload) return;
  if (downloading) {
    const label = count != null ? `Baixando… (${count} vídeo(s))` : "Baixando…";
    btnDownload.textContent = label;
    btnDownload.style.background = "#e53935";
    btnDownload.style.color = "#fff";
    btn.disabled = true;
  } else {
    btnDownload.textContent = "Baixar vídeos do curso";
    btnDownload.style.background = "#1c1c1c";
    btnDownload.style.color = "#fff";
    btn.disabled = false;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Não achei a aba ativa.");
  return tab;
}

function formatDate(ts) {
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${h}:${m}`;
}

function renderHistory(history) {
  currentHistory = history || [];
  if (!historyEl) return;
  if (currentHistory.length === 0) {
    historyEl.innerHTML = "";
    return;
  }

  const fragment = document.createDocumentFragment();

  const title = document.createElement("div");
  title.className = "hist-title";
  title.textContent = "Histórico";
  fragment.appendChild(title);

  currentHistory.forEach((entry, i) => {
    const dateStr = formatDate(entry.runAt);
    const isBatch = entry.type === "batchAudit";

    const item = document.createElement("div");
    item.className = "hist-item";

    const idSpan = document.createElement("span");
    idSpan.className = "hist-id";
    if (isBatch) {
      idSpan.textContent = `Auditoria (${entry.totalCourses} curso${entry.totalCourses > 1 ? "s" : ""})`;
    } else {
      idSpan.textContent = entry.courseId || "?";
    }
    item.appendChild(idSpan);

    item.appendChild(document.createTextNode(` · ${dateStr} · `));

    if (entry.ok) {
      const okSpan = document.createElement("span");
      okSpan.className = "hist-ok";
      okSpan.textContent = "Tudo OK";
      item.appendChild(okSpan);
    } else {
      const btn = document.createElement("button");
      btn.className = "hist-report";
      btn.dataset.i = String(i);
      btn.dataset.type = isBatch ? "batchAudit" : "review";
      btn.textContent = "abrir relatório";
      item.appendChild(btn);
    }

    fragment.appendChild(item);
  });

  historyEl.innerHTML = "";
  historyEl.appendChild(fragment);

  historyEl.querySelectorAll(".hist-report").forEach((reportBtn) => {
    reportBtn.addEventListener("click", async () => {
      try {
        const i = Number(reportBtn.dataset.i);
        const entry = currentHistory[i];
        if (!entry) return;
        const tab = await getActiveTab();
        if (reportBtn.dataset.type === "batchAudit") {
          await chrome.tabs.sendMessage(tab.id, {
            type: "ALURA_REVISOR_SHOW_BATCH_REPORT",
            allResults: entry.batchResults || [],
            totalCourses: entry.totalCourses,
            courseIds: entry.courseIds,
            textualResults: entry.textualResults || [],
            checks: entry.checks || {},
          });
        } else {
          await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_SHOW_REPORT", state: entry.state });
        }
      } catch (e) {
        setStatus(`Erro ao abrir relatório: ${e.message}`);
      }
    });
  });
}

// ---------- Token GitHub ----------
const githubTokenEl = document.getElementById("github-token");
const githubTokenSaveBtn = document.getElementById("github-token-save-btn");
const githubTokenStatusEl = document.getElementById("github-token-status");

if (githubTokenSaveBtn) {
  githubTokenSaveBtn.addEventListener("click", async () => {
    const token = githubTokenEl.value.trim();
    await chrome.storage.local.set({ aluraRevisorGithubToken: token });
    githubTokenStatusEl.textContent = token ? "✅ Token salvo." : "Token removido.";
    setTimeout(() => { githubTokenStatusEl.textContent = ""; }, 2000);
  });
}

// ---------- Token video-uploader ----------
const uploaderTokenEl = document.getElementById("uploader-token");
const uploaderTokenSaveBtn = document.getElementById("uploader-token-save-btn");
const uploaderTokenStatusEl = document.getElementById("uploader-token-status");

if (uploaderTokenSaveBtn) {
  uploaderTokenSaveBtn.addEventListener("click", async () => {
    const token = uploaderTokenEl.value.trim();
    await chrome.storage.local.set({ aluraRevisorUploaderToken: token });
    uploaderTokenStatusEl.textContent = token ? "✅ Token salvo." : "Token removido.";
    setTimeout(() => { uploaderTokenStatusEl.textContent = ""; }, 2000);
  });
}

// Sync button state and history on popup open
(async () => {
  const data = await chrome.storage.local.get([KEY, KEY_HISTORY, "aluraRevisorUploaderToken", "aluraRevisorGithubToken", "aluraRevisorAwsCreds", "aluraRevisorTranslatedJson"]);
  if (data?.aluraRevisorGithubToken && githubTokenEl) {
    githubTokenEl.value = data.aluraRevisorGithubToken;
  }
  if (data?.aluraRevisorUploaderToken && uploaderTokenEl) {
    uploaderTokenEl.value = data.aluraRevisorUploaderToken;
  }
  if (data?.aluraRevisorAwsCreds) {
    if (awsAccessKeyEl) awsAccessKeyEl.value = data.aluraRevisorAwsCreds.accessKeyId || "";
    if (awsSecretKeyEl) awsSecretKeyEl.value = data.aluraRevisorAwsCreds.secretAccessKey || "";
    if (awsRegionEl) awsRegionEl.value = data.aluraRevisorAwsCreds.region || "us-east-1";
  }
  const state = data?.[KEY];
  if (state?.running) {
    if (state.mode === "download") {
      const count = (state.downloadedVideos || []).length;
      setDownloadingUI(true, count);
      setStatus(`Baixando vídeos… (${count} baixado(s))`);
    } else if (state.mode === "adminUpdate") {
      setStatus(`Atualizando admin… (${state.done || 0}/${state.total || "?"} vídeo(s))`);
    } else if (state.mode === "upload") {
      const count = (state.uploadedVideos || []).length;
      setUploadingUI(true, count);
      setStatus(`Subindo vídeos… (${count} enviado(s))`);
    } else if (state.mode === "downloadTranslated") {
      if (btnDownloadTranslated) btnDownloadTranslated.disabled = true;
      if (downloadTranslatedStatus) {
        downloadTranslatedStatus.textContent =
          `Baixando… (${state.done || 0}/${state.total || "?"})\n${state.currentTask || ""}`.trim();
      }
    } else if (state.mode === "latamTransfer") {
      if (latamTransferBtn) latamTransferBtn.disabled = true;
      if (latamStatusEl) {
        latamStatusEl.textContent =
          `Transferindo… (${state.done || 0}/${state.total || "?"})\n${state.currentTask || ""}`.trim();
      }
    } else {
      setRunningUI(true);
      setStatus("Rodando ✅\nO resultado final aparecerá como notificação do Chrome.");
    }
  }
  if (data?.aluraRevisorTranslatedJson) showJsonReadyIndicator(data.aluraRevisorTranslatedJson);
  renderHistory(data?.[KEY_HISTORY] || []);
})();

// Sync button and history when storage changes while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEY]) {
    const newValue = changes[KEY].newValue;
    if (newValue?.running && newValue?.mode === "download") {
      const count = (newValue.downloadedVideos || []).length;
      setDownloadingUI(true, count);
      setStatus(`Baixando vídeos… (${count} baixado(s))`);
    } else if (newValue?.running && newValue?.mode === "adminUpdate") {
      setStatus(`Atualizando admin… (${newValue.done || 0}/${newValue.total || "?"} vídeo(s))`);
    } else if (newValue?.running && newValue?.mode === "upload") {
      const count = (newValue.uploadedVideos || []).length;
      setUploadingUI(true, count);
      setStatus(`Subindo vídeos… (${count} enviado(s))`);
    } else if (newValue?.running && newValue?.mode === "latamTransfer") {
      if (latamStatusEl) {
        latamStatusEl.textContent =
          `Transferindo… (${newValue.done || 0}/${newValue.total || "?"})\n${newValue.currentTask || ""}`.trim();
      }
    } else if (!newValue?.running && newValue?.mode === "latamTransfer") {
      if (latamTransferBtn) latamTransferBtn.disabled = false;
      if (btnDownloadTranslated) btnDownloadTranslated.disabled = false; // fluxo combinado
      if (latamStatusEl) {
        latamStatusEl.textContent = newValue.fatalError
          ? `Erro fatal: ${newValue.fatalError}`
          : `Concluído: ${newValue.done}/${newValue.total} tasks${newValue.errors > 0 ? ` (${newValue.errors} erro(s))` : ""}.`;
      }
    } else if (newValue?.running && newValue?.mode === "renameSections") {
      if (renameSectionsStatusEl) {
        renameSectionsStatusEl.textContent =
          `Renomeando… (${newValue.done || 0}/${newValue.total || "?"})\n${newValue.currentTask || ""}`.trim();
      }
    } else if (!newValue?.running && newValue?.mode === "renameSections") {
      if (renameSectionsBtn) renameSectionsBtn.disabled = false;
      if (renameSectionsStatusEl) {
        renameSectionsStatusEl.textContent = newValue.fatalError
          ? `Erro: ${newValue.fatalError}`
          : newValue.total === 0
            ? "Nenhuma seção genérica encontrada."
            : (newValue.suggestions || 0) === 0
              ? `${newValue.total} seção(ões) genérica(s) encontrada(s), mas sem transcrições ou falha no Bedrock. Verifique o console (F12).`
              : `${newValue.suggestions} sugestão(ões) gerada(s)! Verifique o overlay na página do curso.`;
      }
    } else if (newValue?.running && newValue?.mode === "downloadTranslated") {
      if (btnDownloadTranslated) btnDownloadTranslated.disabled = true;
      const dlText = `Baixando traduções… (${newValue.done || 0}/${newValue.total || "?"})\n${newValue.currentTask || ""}`.trim();
      // Fluxo combinado: só mostrar no status do "Enviar", não duplicar no status de download
      if (latamTransferBtn?.disabled) {
        if (latamStatusEl) latamStatusEl.textContent = dlText;
      } else {
        if (downloadTranslatedStatus) downloadTranslatedStatus.textContent = dlText;
      }
    } else if (!newValue?.running && newValue?.mode === "downloadTranslated") {
      if (btnDownloadTranslated) btnDownloadTranslated.disabled = false;
      if (downloadTranslatedStatus) {
        downloadTranslatedStatus.textContent = newValue.fatalError
          ? `Erro: ${newValue.fatalError}`
          : `Concluído! ${newValue.done}/${newValue.total} atividades${newValue.errors > 0 ? ` (${newValue.errors} sem tradução)` : ""}.`;
      }
      // Atualiza indicador de JSON pronto
      if (!newValue.fatalError) {
        chrome.storage.local.get("aluraRevisorTranslatedJson").then(s => showJsonReadyIndicator(s.aluraRevisorTranslatedJson));
      }
    } else if (newValue?.running) {
      setRunningUI(true);
    } else {
      setRunningUI(false);
      if (isDownloading) {
        setDownloadingUI(false);
        setStatus("Download finalizado.");
      }
      if (isUploading) {
        setUploadingUI(false);
        setStatus("Upload finalizado.");
      }
    }
  }
  if (changes[KEY_HISTORY]) {
    renderHistory(changes[KEY_HISTORY].newValue || []);
  }
});

// ---------- Tab switching ----------
const tabReviewBtn = document.getElementById("tab-review-btn");
const tabToolsBtn = document.getElementById("tab-tools-btn");
const tabReview = document.getElementById("tab-review");
const tabTools = document.getElementById("tab-tools");

tabReviewBtn.addEventListener("click", () => {
  tabReviewBtn.classList.add("active");
  tabToolsBtn.classList.remove("active");
  tabReview.style.display = "";
  tabTools.style.display = "none";
});

tabToolsBtn.addEventListener("click", () => {
  tabToolsBtn.classList.add("active");
  tabReviewBtn.classList.remove("active");
  tabTools.style.display = "";
  tabReview.style.display = "none";
});

// ---------- Start revisão ----------
btn.addEventListener("click", async () => {
  try {
    btn.disabled = true;

    if (isRunning) {
      setStatus("Parando…");
      try {
        const tab = await getActiveTab();
        await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_STOP" });
      } catch {
        // Tab may be navigating; clear storage directly as fallback
      } finally {
        await chrome.storage.local.remove(KEY);
      }
      setRunningUI(false);
      setStatus("Revisão parada.");
    } else {
      setStatus("Iniciando…");
      const tab = await getActiveTab();
      const ack = await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_START" });

      if (!ack?.ok) {
        setStatus(`Não iniciou: ${ack?.error || "erro desconhecido"}`);
        return;
      }

      setRunningUI(true);
      setStatus("Rodando ✅\nO resultado final aparecerá como notificação do Chrome.");
    }
  } catch (e) {
    setStatus(`Erro: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Baixar vídeos ----------
if (btnDownload) {
  btnDownload.addEventListener("click", async () => {
    try {
      btnDownload.disabled = true;

      if (isDownloading) {
        setStatus("Parando download…");
        try {
          const tab = await getActiveTab();
          await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_STOP" });
        } catch {
          // Tab may be navigating; clear storage directly as fallback
        } finally {
          await chrome.storage.local.remove(KEY);
        }
        setDownloadingUI(false);
        setStatus("Download parado.");
      } else {
        setStatus("Iniciando download…");
        const tab = await getActiveTab();
        const ack = await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_START_DOWNLOAD" });

        if (!ack?.ok) {
          setStatus(`Não iniciou: ${ack?.error || "erro desconhecido"}`);
          return;
        }

        setDownloadingUI(true, 0);
        setStatus("Baixando vídeos… (0 baixado(s))");
      }
    } catch (e) {
      setStatus(`Erro: ${e.message}`);
    } finally {
      btnDownload.disabled = false;
    }
  });
}

// ---------- Subir vídeos ----------
if (btnUpload) {
  btnUpload.addEventListener("click", async () => {
    try {
      btnUpload.disabled = true;

      if (isUploading) {
        setStatus("Parando upload…");
        try {
          const tab = await getActiveTab();
          await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_STOP" });
        } catch {
          // Tab may be navigating; clear storage directly as fallback
        } finally {
          await chrome.storage.local.remove("aluraRevisorRunState");
        }
        setUploadingUI(false);
        setStatus("Upload parado.");
      } else {
        setStatus("Iniciando upload…");
        const tab = await getActiveTab();
        const ack = await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_START_UPLOAD" });

        if (!ack?.ok) {
          setStatus(`Não iniciou: ${ack?.error || "erro desconhecido"}`);
          return;
        }

        setUploadingUI(true, 0);
        setStatus("Subindo vídeos… (0 enviado(s))");
      }
    } catch (e) {
      setStatus(`Erro: ${e.message}`);
    } finally {
      btnUpload.disabled = false;
    }
  });
}

// ---------- Fork ----------
const forkUrlEl = document.getElementById("fork-url");
const forkBtn = document.getElementById("fork-btn");
const forkStatusEl = document.getElementById("fork-status");

forkBtn.addEventListener("click", () => {
  const raw = forkUrlEl.value.trim();
  const match = raw.match(/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/);
  if (!match) { forkStatusEl.textContent = "❌ URL inválida. Use: https://github.com/owner/repo"; return; }
  const [, owner, repo] = match;
  forkBtn.disabled = true;
  forkStatusEl.textContent = "Criando fork...";
  chrome.runtime.sendMessage({ type: "ALURA_REVISOR_FORK_REPO", owner, repo }, (resp) => {
    forkBtn.disabled = false;
    if (resp?.ok) {
      forkStatusEl.textContent = `✅ Fork criado: ${resp.forkUrl}`;
    } else {
      forkStatusEl.textContent = `❌ ${resp?.error || "Erro desconhecido"}`;
    }
  });
});

// ---------- Transferência para LATAM ----------
const latamCourseIdEl = document.getElementById("latam-course-id");
const latamTransferBtn = document.getElementById("latam-transfer-btn");
const latamStatusEl = document.getElementById("latam-transfer-status");
const jsonReadyIndicator = document.getElementById("json-ready-indicator");
const jsonReadyCourse = document.getElementById("json-ready-course");
const jsonReadyCount = document.getElementById("json-ready-count");

function showJsonReadyIndicator(json) {
  if (!jsonReadyIndicator || !json?.sections) return;
  const count = json.sections.reduce((s, sec) =>
    s + sec.activities.filter(a => !a.skipped && !a.error).length, 0);
  const errorCount = json.sections.reduce((s, sec) =>
    s + sec.activities.filter(a => a.error).length, 0);
  if (jsonReadyCourse) jsonReadyCourse.textContent = `Curso ${json.courseId}`;
  if (jsonReadyCount) {
    jsonReadyCount.textContent = count > 0
      ? `${count} atividade(s)${errorCount > 0 ? ` · ⚠️ ${errorCount} com erro` : ""}`
      : `⚠️ 0 válidas (${errorCount} com erro — baixe novamente)`;
  }
  jsonReadyIndicator.style.color = count > 0 ? "#2e7d32" : "#b71c1c";
  jsonReadyIndicator.style.background = count > 0 ? "#e8f5e9" : "#ffebee";
  jsonReadyIndicator.style.display = "block";
}

if (latamTransferBtn) {
  latamTransferBtn.addEventListener("click", async () => {
    const latamCourseId = (latamCourseIdEl?.value || "").trim();
    if (!/^\d+$/.test(latamCourseId)) {
      if (latamStatusEl) latamStatusEl.textContent = "Informe um ID numérico válido.";
      return;
    }
    latamTransferBtn.disabled = true;
    if (latamStatusEl) latamStatusEl.textContent = "Iniciando…";
    try {
      const tab = await getActiveTab();
      const ack = await chrome.tabs.sendMessage(tab.id, {
        type: "ALURA_REVISOR_TRANSFER_TO_LATAM",
        latamCourseId,
      });
      if (!ack?.ok) {
        if (latamStatusEl) latamStatusEl.textContent = `Erro: ${ack?.error || "desconhecido"}`;
        latamTransferBtn.disabled = false;
      }
      // se ok, o estado é atualizado via storage.onChanged
    } catch (e) {
      if (latamStatusEl) latamStatusEl.textContent = `Erro: ${e.message}`;
      latamTransferBtn.disabled = false;
    }
  });
}

// ---------- Download de atividades traduzidas ----------
const btnDownloadTranslated = document.getElementById("btnDownloadTranslated");
const downloadTranslatedStatus = document.getElementById("download-translated-status");

if (btnDownloadTranslated) {
  btnDownloadTranslated.addEventListener("click", async () => {
    btnDownloadTranslated.disabled = true;
    if (downloadTranslatedStatus) downloadTranslatedStatus.textContent = "Iniciando…";
    try {
      const tab = await getActiveTab();
      const ack = await chrome.tabs.sendMessage(tab.id, {
        type: "ALURA_REVISOR_DOWNLOAD_TRANSLATED",
      });
      if (!ack?.ok) {
        if (downloadTranslatedStatus) downloadTranslatedStatus.textContent = `Erro: ${ack?.error || "desconhecido"}`;
        btnDownloadTranslated.disabled = false;
      }
    } catch (e) {
      if (downloadTranslatedStatus) downloadTranslatedStatus.textContent = `Erro: ${e.message}`;
      btnDownloadTranslated.disabled = false;
    }
  });
}

// ---------- Credenciais AWS (Bedrock) ----------
const awsAccessKeyEl = document.getElementById("aws-access-key");
const awsSecretKeyEl = document.getElementById("aws-secret-key");
const awsRegionEl = document.getElementById("aws-region");
const awsCredsSaveBtn = document.getElementById("aws-creds-save-btn");
const awsCredsStatusEl = document.getElementById("aws-creds-status");

if (awsCredsSaveBtn) {
  awsCredsSaveBtn.addEventListener("click", async () => {
    const accessKeyId = awsAccessKeyEl?.value.trim() || "";
    const secretAccessKey = awsSecretKeyEl?.value.trim() || "";
    const region = awsRegionEl?.value.trim() || "us-east-1";
    await chrome.storage.local.set({ aluraRevisorAwsCreds: { accessKeyId, secretAccessKey, region } });
    awsCredsStatusEl.textContent = accessKeyId ? "Credenciais salvas." : "Credenciais removidas.";
    setTimeout(() => { awsCredsStatusEl.textContent = ""; }, 2000);
  });
}

// ---------- Renomear Seções com IA ----------
const renameSectionsBtn = document.getElementById("rename-sections-btn");
const renameSectionsStatusEl = document.getElementById("rename-sections-status");

if (renameSectionsBtn) {
  renameSectionsBtn.addEventListener("click", async () => {
    try {
      renameSectionsBtn.disabled = true;
      if (renameSectionsStatusEl) renameSectionsStatusEl.textContent = "Iniciando...";

      const data = await chrome.storage.local.get("aluraRevisorAwsCreds");
      const creds = data?.aluraRevisorAwsCreds;
      if (!creds?.accessKeyId || !creds?.secretAccessKey) {
        if (renameSectionsStatusEl) renameSectionsStatusEl.textContent = "Configure as credenciais AWS primeiro.";
        renameSectionsBtn.disabled = false;
        return;
      }

      const tab = await getActiveTab();
      const ack = await chrome.tabs.sendMessage(tab.id, {
        type: "ALURA_REVISOR_RENAME_SECTIONS",
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        region: creds.region || "us-east-1",
      });

      if (!ack?.ok) {
        if (renameSectionsStatusEl) renameSectionsStatusEl.textContent = `Erro: ${ack?.error || "desconhecido"}`;
        renameSectionsBtn.disabled = false;
      } else {
        if (renameSectionsStatusEl) renameSectionsStatusEl.textContent = "Processando...";
      }
    } catch (e) {
      if (renameSectionsStatusEl) renameSectionsStatusEl.textContent = `Erro: ${e.message}`;
      renameSectionsBtn.disabled = false;
    }
  });
}

// ---------- Auditoria de transcrições em lote ----------
const batchIdsEl = document.getElementById("batch-ids");
const batchAuditBtn = document.getElementById("batch-audit-btn");
const batchStatusEl = document.getElementById("batch-status");

batchAuditBtn.addEventListener("click", async () => {
  const raw = batchIdsEl.value.trim();
  const courseIds = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  if (courseIds.length === 0) {
    batchStatusEl.textContent = "Cole ao menos um ID de curso.";
    return;
  }
  const checks = {
    transcription: document.getElementById("audit-transcription").checked,
    pt: document.getElementById("audit-pt").checked,
    esp: document.getElementById("audit-esp").checked,
    downloadTextual: document.getElementById("audit-download-textual").checked,
  };
  if (!checks.transcription && !checks.pt && !checks.esp && !checks.downloadTextual) {
    batchStatusEl.textContent = "Marque ao menos um item para auditar.";
    return;
  }
  try {
    batchAuditBtn.disabled = true;
    batchStatusEl.textContent = `Auditando ${courseIds.length} curso(s)…`;
    const tab = await getActiveTab();
    const ack = await chrome.tabs.sendMessage(tab.id, {
      type: "ALURA_REVISOR_BATCH_TRANSCRIPTION_AUDIT",
      courseIds,
      checks,
    });
    if (!ack?.ok) {
      batchStatusEl.textContent = `Erro: ${ack?.error || "desconhecido"}`;
    } else {
      batchStatusEl.textContent = "Auditoria em andamento…";
    }
  } catch (e) {
    batchStatusEl.textContent = `Erro: ${e.message}`;
  } finally {
    batchAuditBtn.disabled = false;
  }
});
