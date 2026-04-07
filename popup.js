const KEY = "aluraRevisorRunState";
const KEY_HISTORY = "aluraRevisorHistory";
const KEY_DROPBOX_UPLOAD = "aluraRevisorDropboxUploadState";
const KEY_CAIXAVERSO_PROGRESS = "aluraRevisorCaixaversoProgress";

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
    const isCaixaverso = entry.type === "caixaversoCreate";
    const isDropboxUpload = entry.type === "dropboxUpload";

    const item = document.createElement("div");
    item.className = "hist-item";

    const idSpan = document.createElement("span");
    idSpan.className = "hist-id";
    if (isBatch) {
      idSpan.textContent = `Auditoria (${entry.totalCourses} curso${entry.totalCourses > 1 ? "s" : ""})`;
    } else if (isCaixaverso) {
      idSpan.textContent = `Caixaverso (${entry.totalCourses} curso${entry.totalCourses > 1 ? "s" : ""})`;
    } else if (isDropboxUpload) {
      idSpan.textContent = `Uploader Caixaverso (${entry.total} vídeo${entry.total > 1 ? "s" : ""})`;
    } else {
      idSpan.textContent = entry.courseId || "?";
    }
    item.appendChild(idSpan);

    item.appendChild(document.createTextNode(` · ${dateStr} · `));

    if (isDropboxUpload) {
      if (entry.errors === 0) {
        const okSpan = document.createElement("span");
        okSpan.className = "hist-ok";
        okSpan.textContent = "Tudo OK";
        item.appendChild(okSpan);
      } else {
        const btn = document.createElement("button");
        btn.className = "hist-report";
        btn.dataset.i = String(i);
        btn.dataset.type = "dropboxUpload";
        btn.textContent = `abrir relatório (${entry.errors} erro${entry.errors > 1 ? "s" : ""})`;
        item.appendChild(btn);
      }
    } else if (entry.ok && !isCaixaverso) {
      const okSpan = document.createElement("span");
      okSpan.className = "hist-ok";
      okSpan.textContent = "Tudo OK";
      item.appendChild(okSpan);
    } else {
      const btn = document.createElement("button");
      btn.className = "hist-report";
      btn.dataset.i = String(i);
      btn.dataset.type = isCaixaverso ? "caixaversoCreate" : (isBatch ? "batchAudit" : "review");
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
        } else if (reportBtn.dataset.type === "caixaversoCreate") {
          await chrome.tabs.sendMessage(tab.id, {
            type: "ALURA_REVISOR_SHOW_CAIXAVERSO_REPORT",
            courseResults: entry.courseResults || [],
            totalCourses: entry.totalCourses,
          });
        } else if (reportBtn.dataset.type === "dropboxUpload") {
          showDropboxUploadReport(entry);
        } else {
          await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_SHOW_REPORT", state: entry.state });
        }
      } catch (e) {
        setStatus(`Erro ao abrir relatório: ${e.message}`);
      }
    });
  });
}

function showDropboxUploadReport(entry) {
  // Remove relatório anterior se existir
  document.getElementById("dropbox-upload-report")?.remove();

  const wrap = document.createElement("div");
  wrap.id = "dropbox-upload-report";
  wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;";

  const modal = document.createElement("div");
  modal.style.cssText = "background:#fff;border-radius:10px;padding:20px;width:420px;max-height:80vh;overflow-y:auto;font-family:inherit;";

  const ok = (entry.results || []).filter(r => r.ok);
  const failed = (entry.results || []).filter(r => !r.ok);

  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
    <strong style="font-size:14px;">Upload Caixaverso — ${formatDate(entry.runAt)}</strong>
    <button id="dbup-close" style="background:none;border:none;font-size:18px;cursor:pointer;width:auto;padding:0;">✕</button>
  </div>`;

  if (ok.length > 0) {
    html += `<div style="font-size:12px;font-weight:700;color:#00a857;margin-bottom:6px;">✅ Enviados (${ok.length})</div>
    <ul style="margin:0 0 12px;padding-left:16px;font-size:12px;color:#333;">`;
    for (const r of ok) html += `<li>${r.filename}</li>`;
    html += `</ul>`;
  }

  if (failed.length > 0) {
    html += `<div style="font-size:12px;font-weight:700;color:#e53935;margin-bottom:6px;">❌ Falhas (${failed.length})</div>
    <ul style="margin:0;padding-left:16px;font-size:12px;color:#333;">`;
    for (const r of failed) html += `<li>${r.filename}<br><span style="color:#999;font-size:11px;">${r.error || "erro desconhecido"}</span></li>`;
    html += `</ul>`;
  }

  modal.innerHTML = html;
  wrap.appendChild(modal);
  document.body.appendChild(wrap);

  modal.querySelector("#dbup-close").addEventListener("click", () => wrap.remove());
  wrap.addEventListener("click", e => { if (e.target === wrap) wrap.remove(); });
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

// ---------- Token Dropbox ----------
const dropboxTokenEl = document.getElementById("dropbox-token");
const dropboxTokenSaveBtn = document.getElementById("dropbox-token-save-btn");
const dropboxTokenStatusEl = document.getElementById("dropbox-token-status");

if (dropboxTokenSaveBtn) {
  dropboxTokenSaveBtn.addEventListener("click", async () => {
    const token = dropboxTokenEl.value.trim();
    await chrome.storage.local.set({ aluraRevisorDropboxToken: token });
    dropboxTokenStatusEl.textContent = token ? "✅ Token salvo." : "Token removido.";
    setTimeout(() => { dropboxTokenStatusEl.textContent = ""; }, 2000);
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

function applyCaixaversoProgressState(state) {
  if (!state || !caixaversoStatusEl) return;
  if (state.running) {
    const cur = state.currentName ? `\n${state.currentName}` : "";
    caixaversoStatusEl.textContent = `Criando cursos… (${state.done}/${state.total})${cur}`;
  } else {
    const errMsg = state.errors > 0 ? ` · ${state.errors} erro(s) — veja o relatório no histórico` : "";
    caixaversoStatusEl.textContent = `Concluído: ${state.done}/${state.total}${errMsg}`;
  }
}

function applyDropboxUploadState(state) {
  const statusEl = document.getElementById("caixaverso-status");
  if (!statusEl) return;
  if (!state) return;
  if (state.running) {
    const file = state.currentFile ? `\n${state.currentFile}` : "";
    statusEl.textContent = `Subindo vídeos… (${state.done}/${state.total})${file}`;
  } else {
    const errMsg = state.errors > 0 ? ` · ${state.errors} erro(s)` : "";
    statusEl.textContent = `Upload concluído: ${state.done}/${state.total}${errMsg}`;
  }
}

// Sync button state and history on popup open
(async () => {
  const data = await chrome.storage.local.get([KEY, KEY_HISTORY, KEY_DROPBOX_UPLOAD, KEY_CAIXAVERSO_PROGRESS, "aluraRevisorUploaderToken", "aluraRevisorGithubToken", "aluraRevisorDropboxToken", "aluraRevisorAwsCreds", "aluraRevisorTranslatedJson", "atualizacaoDisponivel", "versaoHub"]);

  // Banner de atualização
  const updateBanner = document.getElementById("update-banner");
  const updateBannerText = document.getElementById("update-banner-text");
  const btnBaixarAtualizacao = document.getElementById("btn-baixar-atualizacao");
  if (data?.atualizacaoDisponivel && updateBanner) {
    if (updateBannerText && data.versaoHub) {
      updateBannerText.textContent = `Nova versão disponível (${data.versaoHub})! Baixe, extraia na pasta da extensão e clique em Recarregar no Chrome.`;
    }
    updateBanner.classList.add("visible");
  }
  if (btnBaixarAtualizacao) {
    btnBaixarAtualizacao.addEventListener("click", () => {
      chrome.downloads.download({ url: "https://hub-producao-conteudo.vercel.app/alura-revisor-conteudo.zip" });
    });
  }
  if (data?.aluraRevisorGithubToken && githubTokenEl) {
    githubTokenEl.value = data.aluraRevisorGithubToken;
  }
  if (data?.aluraRevisorUploaderToken && uploaderTokenEl) {
    uploaderTokenEl.value = data.aluraRevisorUploaderToken;
  }
  if (data?.aluraRevisorDropboxToken && dropboxTokenEl) {
    dropboxTokenEl.value = data.aluraRevisorDropboxToken;
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
  if (data?.[KEY_DROPBOX_UPLOAD]) applyDropboxUploadState(data[KEY_DROPBOX_UPLOAD]);
  if (data?.[KEY_CAIXAVERSO_PROGRESS]) applyCaixaversoProgressState(data[KEY_CAIXAVERSO_PROGRESS]);

  // Hint contextual quando o coordenador está no Dropbox
  try {
    const tab = await getActiveTab();
    if (tab.url?.includes("dropbox.com") && caixaversoNamesEl) {
      caixaversoNamesEl.placeholder = "(Preenchido automaticamente via seleção no Dropbox)";
      // Só mostrar hint se não houver progresso já exibido
      if (caixaversoStatusEl && !caixaversoStatusEl.textContent) {
        caixaversoStatusEl.textContent = "Selecione os vídeos no Dropbox e clique em Criar cursos.";
      }
      const uploadBtn = document.getElementById("caixaverso-upload-btn");
      if (uploadBtn) uploadBtn.style.display = "";
    }
  } catch (_) { /* popup pode abrir sem aba ativa */ }
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
  if (changes[KEY_DROPBOX_UPLOAD]) {
    applyDropboxUploadState(changes[KEY_DROPBOX_UPLOAD].newValue);
  }
  if (changes[KEY_CAIXAVERSO_PROGRESS]) {
    applyCaixaversoProgressState(changes[KEY_CAIXAVERSO_PROGRESS].newValue);
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

// ---------- Upload de Atividades do Hub ----------
const hubUploadBtn = document.getElementById("hub-upload-btn");
const hubUploadStatus = document.getElementById("hub-upload-status");

if (hubUploadBtn) {
  hubUploadBtn.addEventListener("click", async () => {
    const platform = document.querySelector("input[name='hub-platform']:checked")?.value || "alura";
    hubUploadBtn.disabled = true;
    if (hubUploadStatus) hubUploadStatus.textContent = "Iniciando…";
    try {
      const tab = await getActiveTab();
      if (!tab?.url?.includes("hub-producao-conteudo.vercel.app")) {
        if (hubUploadStatus) hubUploadStatus.textContent = "Abra uma página do Hub antes de usar.";
        hubUploadBtn.disabled = false;
        return;
      }
      const ack = await chrome.tabs.sendMessage(tab.id, {
        type: "ALURA_REVISOR_HUB_UPLOAD",
        platform,
      });
      if (ack?.ok) {
        if (hubUploadStatus) hubUploadStatus.textContent = "Processo iniciado! Acompanhe na página do Hub.";
        hubUploadBtn.disabled = false;
      } else {
        if (hubUploadStatus) hubUploadStatus.textContent = `Erro: ${ack?.error || "desconhecido"}`;
        hubUploadBtn.disabled = false;
      }
    } catch (e) {
      if (hubUploadStatus) hubUploadStatus.textContent = `Erro: ${e.message}`;
      hubUploadBtn.disabled = false;
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

// ---------- Criação de cursos Caixaverso ----------
const caixaversoNamesEl = document.getElementById("caixaverso-names");
const caixaversoCreateBtn = document.getElementById("caixaverso-create-btn");
const caixaversoStatusEl = document.getElementById("caixaverso-status");

caixaversoCreateBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  const isDropbox = tab.url?.includes("dropbox.com");
  let names = [];

  if (isDropbox) {
    // --- Fluxo Dropbox: ler seleção e disparar na aba Alura ---
    caixaversoStatusEl.textContent = "Lendo seleção do Dropbox…";
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_DROPBOX_GET_SELECTED" });
    } catch (e) {
      caixaversoStatusEl.textContent = "Erro ao ler Dropbox: recarregue a aba e tente novamente.";
      return;
    }
    if (!resp?.ok || resp.names.length === 0) {
      caixaversoStatusEl.textContent = `Nenhum arquivo reconhecido na seleção (${resp?.total ?? 0} arquivo(s) marcado(s)).`;
      return;
    }
    names = resp.names;
    caixaversoNamesEl.value = names.join("\n");

    // Encontrar ou abrir uma aba Alura para hospedar o fluxo
    const aluraTabs = await chrome.tabs.query({ url: "https://cursos.alura.com.br/*" });
    let aluraTab;
    if (aluraTabs.length > 0) {
      aluraTab = aluraTabs[0];
    } else {
      caixaversoStatusEl.textContent = "Abrindo aba Alura…";
      aluraTab = await chrome.tabs.create({ url: "https://cursos.alura.com.br" });
      await new Promise(resolve => {
        const fn = (id, info) => {
          if (id === aluraTab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(fn);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(fn);
      });
    }

    try {
      caixaversoCreateBtn.disabled = true;

      // Garante que o content script está ativo na aba Alura
      // (aba de fundo pode estar descartada ou sem content script)
      const sendToAlura = async () => chrome.tabs.sendMessage(aluraTab.id, {
        type: "ALURA_REVISOR_CAIXAVERSO_CREATE",
        names,
      });

      caixaversoStatusEl.textContent = `Criando ${names.length} curso(s)…`;
      let ack;
      try {
        ack = await sendToAlura();
      } catch (e) {
        if (!e.message?.includes("Could not establish connection")) throw e;
        // Content script não responde — recarregar aba Alura e tentar novamente
        caixaversoStatusEl.textContent = "Recarregando aba Alura…";
        await new Promise(resolve => {
          const fn = (id, info) => {
            if (id === aluraTab.id && info.status === "complete") {
              chrome.tabs.onUpdated.removeListener(fn);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(fn);
          chrome.tabs.reload(aluraTab.id);
        });
        caixaversoStatusEl.textContent = `Criando ${names.length} curso(s)…`;
        ack = await sendToAlura();
      }

      if (!ack?.ok) {
        caixaversoStatusEl.textContent = `Erro: ${ack?.error || "desconhecido"}`;
      } else {
        caixaversoStatusEl.textContent = "Criação em andamento na aba Alura…";
        chrome.tabs.update(aluraTab.id, { active: true });
      }
    } catch (e) {
      caixaversoStatusEl.textContent = `Erro: ${e.message}`;
    } finally {
      caixaversoCreateBtn.disabled = false;
    }

  } else {
    // --- Fluxo padrão: nomes da textarea ---
    const raw = caixaversoNamesEl.value.trim();
    names = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (names.length === 0) {
      caixaversoStatusEl.textContent = "Cole ao menos um nome de curso.";
      return;
    }
    try {
      caixaversoCreateBtn.disabled = true;
      caixaversoStatusEl.textContent = `Criando ${names.length} curso(s)…`;
      const ack = await chrome.tabs.sendMessage(tab.id, {
        type: "ALURA_REVISOR_CAIXAVERSO_CREATE",
        names,
      });
      if (!ack?.ok) {
        caixaversoStatusEl.textContent = `Erro: ${ack?.error || "desconhecido"}`;
      } else {
        caixaversoStatusEl.textContent = "Criação em andamento…";
      }
    } catch (e) {
      caixaversoStatusEl.textContent = `Erro: ${e.message}`;
    } finally {
      caixaversoCreateBtn.disabled = false;
    }
  }
});

// ---------- Subir vídeos do Dropbox ----------
const caixaversoUploadBtn = document.getElementById("caixaverso-upload-btn");

if (caixaversoUploadBtn) {
  caixaversoUploadBtn.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab.url?.includes("dropbox.com")) {
      caixaversoStatusEl.textContent = "Abra o Dropbox antes de usar.";
      return;
    }

    caixaversoStatusEl.textContent = "Lendo seleção do Dropbox…";
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tab.id,
        { type: "ALURA_REVISOR_DROPBOX_GET_SELECTED_FOR_UPLOAD" });
    } catch (e) {
      caixaversoStatusEl.textContent = "Erro ao ler Dropbox: recarregue a aba.";
      return;
    }

    if (!resp?.ok || resp.files.length === 0) {
      caixaversoStatusEl.textContent =
        `Nenhum .mp4 selecionado (${resp?.total ?? 0} item(ns) marcado(s)).`;
      return;
    }

    const tokenData = await chrome.storage.local.get(["aluraRevisorUploaderToken", "aluraRevisorDropboxToken"]);
    if (!tokenData?.aluraRevisorUploaderToken) {
      caixaversoStatusEl.textContent = "Configure o Token video-uploader antes.";
      return;
    }
    if (!tokenData?.aluraRevisorDropboxToken) {
      caixaversoStatusEl.textContent = "Configure o Token Dropbox antes.";
      return;
    }

    caixaversoUploadBtn.disabled = true;
    caixaversoStatusEl.textContent = `Enviando ${resp.files.length} vídeo(s)…`;

    chrome.runtime.sendMessage({
      type: "ALURA_REVISOR_DROPBOX_UPLOAD",
      files: resp.files,
    });

    caixaversoStatusEl.textContent =
      `Upload de ${resp.files.length} vídeo(s) em andamento (background)…`;
    caixaversoUploadBtn.disabled = false;
  });
}
