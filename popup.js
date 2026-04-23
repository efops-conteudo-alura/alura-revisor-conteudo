const KEY = "aluraRevisorRunState";
const KEY_HISTORY = "aluraRevisorHistory";
const KEY_DROPBOX_UPLOAD = "aluraRevisorDropboxUploadState";
const KEY_CAIXAVERSO_PROGRESS = "aluraRevisorCaixaversoProgress";

const statusEl = document.getElementById("status");
const btn = document.getElementById("start");
const btnDownload = document.getElementById("btnDownload");
const btnUpload = document.getElementById("btnUpload");
const btnSubtitles = document.getElementById("btnSubtitles");
const subtitlesStatusEl = document.getElementById("subtitles-status");
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

function setSubtitlesUI(running, text) {
  if (!btnSubtitles) return;
  if (running) {
    btnSubtitles.textContent = text || "Gerando legendas…";
    btnSubtitles.style.background = "#e53935";
    btnSubtitles.style.color = "#fff";
    btnSubtitles.disabled = true;
    if (subtitlesStatusEl && text) subtitlesStatusEl.textContent = text;
  } else {
    btnSubtitles.textContent = "Subir legendas do curso";
    btnSubtitles.style.background = "#00c86f";
    btnSubtitles.style.color = "#1c1c1c";
    btnSubtitles.disabled = false;
    if (subtitlesStatusEl && text) subtitlesStatusEl.textContent = text;
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

// ---------- Dropbox OAuth2 PKCE ----------
const dropboxClientIdEl = document.getElementById("dropbox-client-id");
const dropboxConnectBtn = document.getElementById("dropbox-connect-btn");
const dropboxDisconnectBtn = document.getElementById("dropbox-disconnect-btn");
const dropboxAuthStatusEl = document.getElementById("dropbox-auth-status");
const dropboxRedirectHint = document.getElementById("dropbox-redirect-hint");
const dropboxRedirectUriEl = document.getElementById("dropbox-redirect-uri");

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function applyDropboxAuthState(data) {
  if (!dropboxConnectBtn) return;
  const connected = !!data?.aluraRevisorDropboxRefreshToken;
  dropboxConnectBtn.style.display = connected ? "none" : "";
  dropboxDisconnectBtn.style.display = connected ? "" : "none";
  if (dropboxAuthStatusEl) {
    dropboxAuthStatusEl.textContent = connected ? "✅ Conectado" : "";
  }
  if (dropboxClientIdEl && data?.aluraRevisorDropboxClientId) {
    dropboxClientIdEl.value = data.aluraRevisorDropboxClientId;
  }
}

if (dropboxConnectBtn) {
  const redirectUri = chrome.identity.getRedirectURL();
  if (dropboxRedirectUriEl) dropboxRedirectUriEl.textContent = redirectUri;
  if (dropboxRedirectHint) dropboxRedirectHint.style.display = "";

  dropboxConnectBtn.addEventListener("click", async () => {
    const clientId = dropboxClientIdEl?.value.trim();
    if (!clientId) {
      dropboxAuthStatusEl.textContent = "Informe o App Key antes de conectar.";
      return;
    }
    dropboxConnectBtn.disabled = true;
    dropboxAuthStatusEl.textContent = "Abrindo autenticação Dropbox…";
    try {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      const authUrl = new URL("https://www.dropbox.com/oauth2/authorize");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("token_access_type", "offline");

      const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
      const code = new URL(responseUrl).searchParams.get("code");
      if (!code) throw new Error("Código de autorização não recebido.");

      dropboxAuthStatusEl.textContent = "Trocando código por tokens…";
      const tokenResp = await fetch("https://api.dropboxapi.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      if (!tokenResp.ok) throw new Error(`Token exchange HTTP ${tokenResp.status}: ${(await tokenResp.text()).slice(0, 150)}`);
      const tokens = await tokenResp.json();
      if (!tokens.access_token) throw new Error(JSON.stringify(tokens).slice(0, 150));

      await chrome.storage.local.set({
        aluraRevisorDropboxToken: tokens.access_token,
        aluraRevisorDropboxRefreshToken: tokens.refresh_token,
        aluraRevisorDropboxTokenExpiry: Date.now() + (tokens.expires_in ?? 14400) * 1000,
        aluraRevisorDropboxClientId: clientId,
      });
      applyDropboxAuthState({ aluraRevisorDropboxRefreshToken: tokens.refresh_token, aluraRevisorDropboxClientId: clientId });
    } catch (e) {
      dropboxAuthStatusEl.textContent = `Erro: ${e.message}`;
    } finally {
      dropboxConnectBtn.disabled = false;
    }
  });
}

if (dropboxDisconnectBtn) {
  dropboxDisconnectBtn.addEventListener("click", async () => {
    await chrome.storage.local.remove([
      "aluraRevisorDropboxToken", "aluraRevisorDropboxRefreshToken",
      "aluraRevisorDropboxTokenExpiry", "aluraRevisorDropboxClientId",
    ]);
    if (dropboxAuthStatusEl) dropboxAuthStatusEl.textContent = "Desconectado.";
    applyDropboxAuthState({});
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
  const data = await chrome.storage.local.get([KEY, KEY_HISTORY, KEY_DROPBOX_UPLOAD, KEY_CAIXAVERSO_PROGRESS, "aluraRevisorUploaderToken", "aluraRevisorDropboxRefreshToken", "aluraRevisorDropboxClientId", "aluraRevisorAwsCreds", "aluraRevisorTranslatedJson", "atualizacaoDisponivel", "versaoHub"]);

  // Banner de atualização
  const updateBanner = document.getElementById("update-banner");
  const updateBannerText = document.getElementById("update-banner-text");
  const btnBaixarAtualizacao = document.getElementById("btn-baixar-atualizacao");
  const versaoAtual = chrome.runtime.getManifest().version;
  const versaoHub = data?.versaoHub;
  const desatualizada = versaoHub && versaoHub !== versaoAtual &&
    versaoHub.localeCompare(versaoAtual, undefined, { numeric: true }) > 0;
  if (desatualizada && updateBanner) {
    if (updateBannerText) {
      updateBannerText.textContent = `Nova versão disponível: v${versaoHub}`;
    }
    updateBanner.classList.add("visible");
  }
  if (btnBaixarAtualizacao) {
    btnBaixarAtualizacao.addEventListener("click", () => {
      chrome.downloads.download({ url: "https://hub-producao-conteudo.vercel.app/alura-revisor-conteudo.zip" });
    });
  }
  if (data?.aluraRevisorUploaderToken && uploaderTokenEl) {
    uploaderTokenEl.value = data.aluraRevisorUploaderToken;
  }
  applyDropboxAuthState(data);
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
    } else if (state.mode === "subtitles") {
      setSubtitlesUI(true, `Gerando legendas… (${state.done || 0}/${state.total || "?"})`);
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
    // Auto-fill pasta do curso para upload de material
    const courseMatch = tab.url?.match(/\/course\/(\d+-[^/?#]+)/);
    if (courseMatch) {
      const s3CourseFolderEl = document.getElementById("s3-course-folder");
      if (s3CourseFolderEl && !s3CourseFolderEl.value) {
        s3CourseFolderEl.value = courseMatch[1];
      }
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
    } else if (newValue?.running && newValue?.mode === "subtitles") {
      setSubtitlesUI(true, `Gerando legendas… (${newValue.done || 0}/${newValue.total || "?"})`);
    } else if (!newValue?.running && newValue?.mode === "subtitles") {
      const text = newValue.fatalError
        ? `❌ ${newValue.fatalError}`
        : `✅ ${newValue.done}/${newValue.total} legenda(s)${newValue.errors > 0 ? ` (${newValue.errors} erro(s))` : ""}`;
      setSubtitlesUI(false, text);
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
const tabCredentialsBtn = document.getElementById("tab-credentials-btn");
const tabReview = document.getElementById("tab-review");
const tabTools = document.getElementById("tab-tools");
const tabCredentials = document.getElementById("tab-credentials");

function setActiveTab(activeBtn, activePanel) {
  [tabReviewBtn, tabToolsBtn, tabCredentialsBtn].forEach(b => b.classList.remove("active"));
  [tabReview, tabTools, tabCredentials].forEach(p => p.style.display = "none");
  activeBtn.classList.add("active");
  activePanel.style.display = "";
}

tabReviewBtn.addEventListener("click", () => setActiveTab(tabReviewBtn, tabReview));
tabToolsBtn.addEventListener("click", () => setActiveTab(tabToolsBtn, tabTools));
tabCredentialsBtn.addEventListener("click", () => setActiveTab(tabCredentialsBtn, tabCredentials));

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

// ---------- Subir legendas ----------
if (btnSubtitles) {
  btnSubtitles.addEventListener("click", async () => {
    try {
      btnSubtitles.disabled = true;
      setStatus("Iniciando geração de legendas…");
      const tab = await getActiveTab();
      const ack = await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_START_SUBTITLES" });
      if (!ack?.ok) {
        setStatus(`Não iniciou: ${ack?.error || "erro desconhecido"}`);
        btnSubtitles.disabled = false;
        return;
      }
      setSubtitlesUI(true, "Gerando legendas… (0/?)");
    } catch (e) {
      setStatus(`Erro: ${e.message}`);
      btnSubtitles.disabled = false;
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
const btnSendJsonToSelector = document.getElementById("btn-send-json-to-selector");
const sendJsonToSelectorStatus = document.getElementById("send-json-to-selector-status");

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
  // Mostra botão de enviar somente quando há atividades válidas
  if (btnSendJsonToSelector) btnSendJsonToSelector.style.display = count > 0 ? "" : "none";
}

if (btnSendJsonToSelector) {
  btnSendJsonToSelector.addEventListener("click", async () => {
    btnSendJsonToSelector.disabled = true;
    if (sendJsonToSelectorStatus) { sendJsonToSelectorStatus.textContent = "Abrindo Hub e injetando JSON…"; sendJsonToSelectorStatus.style.display = ""; }

    const stored = await chrome.storage.local.get("aluraRevisorTranslatedJson");
    const json = stored?.aluraRevisorTranslatedJson;
    if (!json) {
      if (sendJsonToSelectorStatus) sendJsonToSelectorStatus.textContent = "Erro: JSON não encontrado.";
      btnSendJsonToSelector.disabled = false;
      return;
    }

    const courseId = json.courseId || "curso";
    const jsonStr = JSON.stringify(json, null, 2);
    const filename = `${courseId}-atividades-traduzidas.json`;

    await chrome.storage.local.remove("aluraRevisorHubInjectStatus");
    await chrome.storage.local.set({ aluraRevisorPendingHubInject: { jsonStr, filename } });

    // Acorda o SW — retenta até 3x para cobrir race condition de startup
    for (let i = 0; i < 3; i++) {
      try { await chrome.runtime.sendMessage({ type: "OPEN_HUB_FOR_INJECT" }); break; }
      catch (_) { await new Promise(r => setTimeout(r, 400)); }
    }

    // Aguarda resultado do background (25s)
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 25000);
      function check() {
        chrome.storage.local.get("aluraRevisorHubInjectStatus", (data) => {
          if (data?.aluraRevisorHubInjectStatus) { clearTimeout(timeout); resolve(data.aluraRevisorHubInjectStatus); }
          else setTimeout(check, 500);
        });
      }
      check();
    });

    btnSendJsonToSelector.disabled = false;
    if (!sendJsonToSelectorStatus) return;
    if (!result) {
      sendJsonToSelectorStatus.textContent = "Hub aberto — JSON será injetado ao carregar.";
    } else if (!result.ok) {
      sendJsonToSelectorStatus.textContent = "Erro: " + (result.error || "desconhecido");
    } else {
      sendJsonToSelectorStatus.textContent = `✓ JSON enviado! (${filename})`;
      sendJsonToSelectorStatus.style.color = "#2e7d32";
    }
  });
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

// ---------- Enviar atividades para o Seletor ----------
const btnSendToSelector = document.getElementById("btnSendToSelector");
const sendToSelectorStatus = document.getElementById("send-to-selector-status");

function setSelectorStatus(msg) {
  if (sendToSelectorStatus) sendToSelectorStatus.textContent = msg;
}

if (btnSendToSelector) {
  btnSendToSelector.addEventListener("click", async () => {
    btnSendToSelector.disabled = true;
    setSelectorStatus("Procurando aba do ferramentas-ia.alura.dev…");

    try {
      // 1. Find the ferramentas-ia tab
      const tabs = await chrome.tabs.query({ url: "https://ferramentas-ia.alura.dev/*" });
      if (!tabs.length) {
        setSelectorStatus("Abra ferramentas-ia.alura.dev e aguarde a tradução terminar.");
        btnSendToSelector.disabled = false;
        return;
      }
      const ferramTab = tabs[0];
      const courseIdMatch = ferramTab.url?.match(/\/tradutor-tarefas\/[^/]+\/(\d+)/);
      const courseId = courseIdMatch ? courseIdMatch[1] : "curso";

      // 2. Check if translation is done via scripting.executeScript (no content script connection needed)
      setSelectorStatus("Verificando status da tradução…");
      let statusResult;
      try {
        const [frame] = await chrome.scripting.executeScript({
          target: { tabId: ferramTab.id },
          func: () => {
            const btn = document.querySelector(
              'button.TaskTranslator_downloadButton__eWo8f, button[class*="downloadButton"]'
            );
            return {
              ready: !!(btn && btn.getAttribute("aria-disabled") !== "true" && !btn.disabled),
            };
          },
        });
        statusResult = frame?.result;
      } catch (e) {
        setSelectorStatus("Erro ao verificar status: " + e.message);
        btnSendToSelector.disabled = false;
        return;
      }

      if (!statusResult?.ready) {
        setSelectorStatus("Tradução ainda não concluída. Aguarde 100% no ferramentas-ia.alura.dev.");
        btnSendToSelector.disabled = false;
        return;
      }

      // 3. Ensure the postMessage relay listener is active (re-inject if content script disconnected)
      try {
        await chrome.scripting.executeScript({
          target: { tabId: ferramTab.id },
          world: "ISOLATED",
          func: () => {
            if (window.__aluraRevisorRelayActive) return;
            window.__aluraRevisorRelayActive = true;
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
          },
        });
      } catch (e) {
        // non-fatal — original content script may still be relaying
      }

      // 4. Clear any old captured ZIP and trigger download to capture the new one
      await chrome.storage.local.remove("aluraRevisorCapturedZip");
      setSelectorStatus("Capturando ZIP…");
      try {
        await chrome.scripting.executeScript({
          target: { tabId: ferramTab.id },
          world: "MAIN",
          func: () => {
            // Signal the injected interceptor to suppress this specific download
            window.__aluraRevisorCapturing = true;
            const btn = document.querySelector(
              'button.TaskTranslator_downloadButton__eWo8f, button[class*="downloadButton"]'
            );
            if (btn) btn.click();
          },
        });
      } catch (e) {
        setSelectorStatus("Erro ao acionar download: " + e.message);
        btnSendToSelector.disabled = false;
        return;
      }

      // 4. Wait for the ZIP to be captured (up to 15 seconds)
      setSelectorStatus("Aguardando captura do ZIP…");
      const zipData = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 15000);
        function check() {
          chrome.storage.local.get("aluraRevisorCapturedZip", (data) => {
            if (data?.aluraRevisorCapturedZip?.base64) {
              clearTimeout(timeout);
              resolve(data.aluraRevisorCapturedZip);
            } else {
              setTimeout(check, 300);
            }
          });
        }
        check();
      });

      if (!zipData) {
        setSelectorStatus("Tempo esgotado aguardando o ZIP. Tente novamente.");
        btnSendToSelector.disabled = false;
        return;
      }

      // 5. Find Hub tab on the upload page
      setSelectorStatus(`ZIP capturado (${Math.round(zipData.size / 1024)} KB). Procurando aba do Hub…`);
      const hubTabs = await chrome.tabs.query({ url: "https://hub-producao-conteudo.vercel.app/*" });
      if (!hubTabs.length) {
        setSelectorStatus("ZIP capturado! Abra o Hub (hub-producao-conteudo.vercel.app) para enviar.");
        btnSendToSelector.disabled = false;
        return;
      }

      const hubTab = hubTabs[0];
      if (!hubTab.url?.includes("/seletor-de-atividades/upload")) {
        setSelectorStatus("ZIP capturado! Navegue para /seletor-de-atividades/upload no Hub e tente novamente.");
        btnSendToSelector.disabled = false;
        return;
      }

      // 6. Inject ZIP directly into the DropZone's hidden file input via DataTransfer
      setSelectorStatus("Injetando ZIP no Hub…");
      const filename = `${courseId}-atividades-traduzidas.zip`;
      const [injectResult] = await chrome.scripting.executeScript({
        target: { tabId: hubTab.id },
        world: "MAIN",
        args: [zipData.base64, filename],
        func: (base64, filename) => {
          try {
            // Convert base64 → Uint8Array → File
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const file = new File([bytes], filename, { type: "application/zip" });

            // Find the DropZone's hidden file input
            const input = document.querySelector('input[type="file"][accept*=".zip"]');
            if (!input) return { ok: false, error: "Input de arquivo não encontrado. Verifique se está na página de upload." };

            // Use native files setter so React's onChange picks it up
            const dt = new DataTransfer();
            dt.items.add(file);
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files").set;
            nativeSetter.call(input, dt.files);
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        },
      });

      if (!injectResult?.result?.ok) {
        setSelectorStatus("Erro ao injetar no Hub: " + (injectResult?.result?.error || "desconhecido"));
        btnSendToSelector.disabled = false;
        return;
      }

      setSelectorStatus(`✓ ZIP enviado ao Hub! (${filename}, ${Math.round(zipData.size / 1024)} KB)`);
    } catch (e) {
      setSelectorStatus("Erro: " + e.message);
    }

    btnSendToSelector.disabled = false;
  });
}

// ---------- Baixar atividades traduzidas ----------
const btnDownloadTranslated = document.getElementById("btnDownloadTranslated");
const downloadTranslatedStatus = document.getElementById("download-translated-status");

function setDownloadStatus(html, isHtml = false) {
  if (!downloadTranslatedStatus) return;
  if (isHtml) downloadTranslatedStatus.innerHTML = html;
  else downloadTranslatedStatus.textContent = html;
}

async function runTranslation(noDownload) {
  try {
    const tab = await getActiveTab();
    const ack = await chrome.tabs.sendMessage(tab.id, {
      type: "ALURA_REVISOR_DOWNLOAD_TRANSLATED",
      noDownload,
    });
    if (!ack?.ok) {
      setDownloadStatus(`Erro: ${ack?.error || "desconhecido"}`);
      btnDownloadTranslated.disabled = false;
    }
    // Progress updates come via storage state listener
  } catch (e) {
    setDownloadStatus(`Erro: ${e.message}`);
    btnDownloadTranslated.disabled = false;
  }
}

if (btnDownloadTranslated) {
  btnDownloadTranslated.addEventListener("click", async () => {
    btnDownloadTranslated.disabled = true;
    setDownloadStatus("Iniciando tradução…");
    await runTranslation(false);
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
    downloadPt: document.getElementById("audit-download-pt").checked,
    downloadEsp: document.getElementById("audit-download-esp").checked,
  };
  if (!checks.transcription && !checks.pt && !checks.esp && !checks.downloadTextual && !checks.downloadPt && !checks.downloadEsp) {
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

    const tokenData = await chrome.storage.local.get(["aluraRevisorUploaderToken", "aluraRevisorDropboxRefreshToken"]);
    if (!tokenData?.aluraRevisorUploaderToken) {
      caixaversoStatusEl.textContent = "Configure o Token video-uploader antes.";
      return;
    }
    if (!tokenData?.aluraRevisorDropboxRefreshToken) {
      caixaversoStatusEl.textContent = "Conecte o Dropbox antes (aba Ferramentas).";
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

// ---------- Upload de Material (S3) ----------
{
  const S3_HISTORY_KEY = "aluraRevisorUploadHistory";
  const MAX_HISTORY = 30;

  const s3CourseFolderEl  = document.getElementById("s3-course-folder");
  const s3SubfolderEl     = document.getElementById("s3-subfolder");
  const s3FileInput       = document.getElementById("s3-file-input");
  const s3FolderInput     = document.getElementById("s3-folder-input");
  const s3FileSelectBtn   = document.getElementById("s3-file-select-btn");
  const s3FolderSelectBtn = document.getElementById("s3-folder-select-btn");
  const s3FileNameEl      = document.getElementById("s3-file-name");
  const s3UploadBtn       = document.getElementById("s3-upload-btn");
  const s3UploadStatus    = document.getElementById("s3-upload-status");
  const s3ResultDiv       = document.getElementById("s3-result");
  const s3ResultUrlEl     = document.getElementById("s3-result-url");
  const s3CopyBtn         = document.getElementById("s3-copy-btn");
  const s3ResultMultiDiv  = document.getElementById("s3-result-multi");
  const s3ResultMultiList = document.getElementById("s3-result-multi-list");
  const s3HistoryWrap     = document.getElementById("s3-history-wrap");
  const s3HistoryList     = document.getElementById("s3-history-list");
  const s3HistoryClearBtn = document.getElementById("s3-history-clear-btn");

  let s3SelectedFiles = [];
  let s3Mode = "file";

  // ---- Histórico ----
  function fmtDate(iso) {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  }

  function buildHistoryItem(entry) {
    const div = document.createElement("div");
    div.style.cssText = "border:1px solid #d0e8ff;border-radius:6px;padding:6px 8px;font-size:11px;background:#fafeff;";
    const dateStr = fmtDate(entry.date);
    if (entry.type === "file") {
      const url = entry.links[0].url;
      div.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;"><span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="${url}">${entry.label}</span><span style="color:#999;white-space:nowrap;font-size:10px;">${dateStr}</span></div><div style="display:flex;gap:4px;margin-top:4px;"><button class="s3-hist-copy" data-url="${url}" style="font-size:10px;padding:3px 8px;background:#fff;border:1px solid #3b9eff;color:#067ada;border-radius:4px;cursor:pointer;">Copiar</button><a href="${url}" target="_blank" style="font-size:10px;padding:3px 8px;background:#fff;border:1px solid #ddd;color:#555;border-radius:4px;text-decoration:none;white-space:nowrap;">Abrir</a></div>`;
    } else {
      const fid = `hf${entry.id}`;
      const rows = entry.links.map(l => `<div style="padding:4px 0;border-bottom:1px solid #f0f0f0;"><div style="font-size:10px;color:#444;font-weight:500;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${l.url}">${l.name}</div><div style="display:flex;gap:4px;"><button class="s3-hist-copy" data-url="${l.url}" style="font-size:10px;padding:2px 8px;background:#fff;border:1px solid #3b9eff;color:#067ada;border-radius:4px;cursor:pointer;white-space:nowrap;">Copiar</button><a href="${l.url}" target="_blank" style="font-size:10px;padding:2px 8px;background:#fff;border:1px solid #ddd;color:#555;border-radius:4px;text-decoration:none;white-space:nowrap;">Abrir</a></div></div>`).join("");
      div.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;"><span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">📁 ${entry.label}</span><span style="color:#999;white-space:nowrap;font-size:10px;">${dateStr}</span></div><div style="display:flex;gap:4px;margin-top:4px;"><button class="s3-hist-expand" data-target="${fid}" style="font-size:10px;padding:3px 8px;background:#fff;border:1px solid #ddd;color:#555;border-radius:4px;cursor:pointer;">Ver links (${entry.links.length}) ▾</button></div><div id="${fid}" style="display:none;margin-top:4px;">${rows}</div>`;
    }
    return div;
  }

  function renderS3History(history) {
    if (!s3HistoryWrap || !s3HistoryList) return;
    if (!history?.length) { s3HistoryWrap.style.display = "none"; return; }
    s3HistoryWrap.style.display = "";
    s3HistoryList.innerHTML = "";
    history.forEach(e => s3HistoryList.appendChild(buildHistoryItem(e)));
  }

  async function saveToHistory(entry) {
    const data = await chrome.storage.local.get([S3_HISTORY_KEY]);
    const history = data[S3_HISTORY_KEY] || [];
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
    await chrome.storage.local.set({ [S3_HISTORY_KEY]: history });
    renderS3History(history);
  }

  chrome.storage.local.get([S3_HISTORY_KEY]).then(data => renderS3History(data[S3_HISTORY_KEY] || []));

  if (s3HistoryList) {
    s3HistoryList.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.classList.contains("s3-hist-copy")) {
        await navigator.clipboard.writeText(btn.dataset.url).catch(() => {});
        const orig = btn.textContent; btn.textContent = "Copiado!";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }
      if (btn.classList.contains("s3-hist-expand")) {
        const target = document.getElementById(btn.dataset.target);
        if (!target) return;
        const shown = target.style.display !== "none";
        target.style.display = shown ? "none" : "";
        btn.textContent = shown ? `Ver links (${target.children.length}) ▾` : "Ocultar ▴";
      }
    });
  }

  if (s3HistoryClearBtn) {
    s3HistoryClearBtn.addEventListener("click", async () => {
      await chrome.storage.local.remove(S3_HISTORY_KEY);
      renderS3History([]);
    });
  }

  // ---- Seleção de arquivo / pasta ----
  function setMode(mode) {
    s3Mode = mode;
    s3SelectedFiles = [];
    if (s3FileNameEl) s3FileNameEl.textContent = "Nenhum selecionado";
    if (s3ResultDiv) s3ResultDiv.style.display = "none";
    if (s3ResultMultiDiv) s3ResultMultiDiv.style.display = "none";
    if (s3UploadStatus) s3UploadStatus.textContent = "";
    if (s3SubfolderEl) s3SubfolderEl.style.display = mode === "folder" ? "none" : "";
    const activeStyle = "background:#3b9eff;color:#fff;border:1.5px solid #3b9eff;";
    const idleStyle   = "background:#fff;color:#1c1c1c;border:1.5px solid #ddd;";
    if (s3FileSelectBtn)   s3FileSelectBtn.style.cssText   += mode === "file"   ? activeStyle : idleStyle;
    if (s3FolderSelectBtn) s3FolderSelectBtn.style.cssText += mode === "folder" ? activeStyle : idleStyle;
  }

  if (s3FileSelectBtn)   s3FileSelectBtn.addEventListener("click",   () => { setMode("file");   s3FileInput?.click(); });
  if (s3FolderSelectBtn) s3FolderSelectBtn.addEventListener("click", () => { setMode("folder"); s3FolderInput?.click(); });

  if (s3FileInput) {
    s3FileInput.addEventListener("change", () => {
      s3SelectedFiles = s3FileInput.files?.[0] ? [s3FileInput.files[0]] : [];
      if (s3FileNameEl) s3FileNameEl.textContent = s3SelectedFiles[0]?.name || "Nenhum selecionado";
      if (s3ResultDiv) s3ResultDiv.style.display = "none";
      if (s3UploadStatus) s3UploadStatus.textContent = "";
    });
  }

  if (s3FolderInput) {
    s3FolderInput.addEventListener("change", () => {
      s3SelectedFiles = Array.from(s3FolderInput.files || []);
      if (s3FileNameEl) {
        if (s3SelectedFiles.length) {
          const folderName = s3SelectedFiles[0].webkitRelativePath.split("/")[0];
          s3FileNameEl.textContent = `📁 ${folderName} (${s3SelectedFiles.length} arquivo${s3SelectedFiles.length > 1 ? "s" : ""})`;
        } else {
          s3FileNameEl.textContent = "Nenhum selecionado";
        }
      }
      if (s3ResultMultiDiv) s3ResultMultiDiv.style.display = "none";
      if (s3UploadStatus) s3UploadStatus.textContent = "";
    });
  }

  // ---- Upload ----
  if (s3UploadBtn) {
    s3UploadBtn.addEventListener("click", async () => {
      const courseFolder = s3CourseFolderEl?.value.trim();
      if (!courseFolder) {
        if (s3UploadStatus) s3UploadStatus.textContent = "Informe a pasta do curso.";
        return;
      }
      if (!/^\d{4,5}-/.test(courseFolder)) {
        if (s3UploadStatus) s3UploadStatus.textContent = "A pasta deve começar com o ID do curso (4-5 números), ex: 4247-excel-rh";
        return;
      }
      if (!s3SelectedFiles.length) {
        if (s3UploadStatus) s3UploadStatus.textContent = `Selecione ${s3Mode === "folder" ? "uma pasta" : "um arquivo"} antes.`;
        return;
      }
      const tooBig = s3SelectedFiles.find(f => f.size > 50 * 1024 * 1024);
      if (tooBig) {
        if (s3UploadStatus) s3UploadStatus.textContent = `"${tooBig.name}" é muito grande (máx. ~50 MB por arquivo).`;
        return;
      }

      s3UploadBtn.disabled = true;
      if (s3ResultDiv) s3ResultDiv.style.display = "none";
      if (s3ResultMultiDiv) s3ResultMultiDiv.style.display = "none";
      const collectedLinks = [];

      try {
        for (let i = 0; i < s3SelectedFiles.length; i++) {
          const file = s3SelectedFiles[i];
          if (s3UploadStatus) {
            s3UploadStatus.textContent = s3SelectedFiles.length > 1
              ? `Enviando ${i + 1} de ${s3SelectedFiles.length}: ${file.name}`
              : "Enviando para o hub…";
          }

          const fd = new FormData();
          fd.append("file", file);
          fd.append("courseFolder", courseFolder);
          if (s3Mode === "folder" && file.webkitRelativePath) {
            fd.append("relativePath", file.webkitRelativePath);
          } else {
            fd.append("subFolder", s3SubfolderEl?.value.trim() || "");
          }

          const resp = await fetch(
            "https://hub-producao-conteudo.vercel.app/api/revisor/upload",
            { method: "POST", credentials: "include", body: fd }
          );

          if (resp.status === 401) {
            if (s3UploadStatus) s3UploadStatus.textContent = "Você precisa estar logado em hub-producao-conteudo.vercel.app para fazer upload.";
            return;
          }

          const result = await resp.json();
          if (!resp.ok || !result?.ok) {
            if (s3UploadStatus) s3UploadStatus.textContent = `Erro em "${file.name}": ${result?.error || "desconhecido"}`;
            return;
          }
          collectedLinks.push({ name: file.name, url: result.cdnUrl });
        }

        if (s3UploadStatus) s3UploadStatus.textContent = collectedLinks.length > 1 ? `${collectedLinks.length} arquivos enviados!` : "Upload concluído!";

        // Exibir resultado
        if (s3Mode === "file" && collectedLinks.length === 1) {
          if (s3ResultUrlEl) s3ResultUrlEl.value = collectedLinks[0].url;
          if (s3ResultDiv) s3ResultDiv.style.display = "";
        } else if (s3ResultMultiDiv && s3ResultMultiList) {
          s3ResultMultiList.innerHTML = "";
          collectedLinks.forEach(link => {
            const row = document.createElement("div");
            row.style.cssText = "padding:4px 0;border-bottom:1px solid #e8f4ff;";
            row.innerHTML = `<div style="font-size:11px;color:#444;font-weight:500;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${link.url}">${link.name}</div><div style="display:flex;gap:4px;"><button class="s3-multi-copy" data-url="${link.url}" style="font-size:10px;padding:3px 8px;background:#fff;border:1px solid #3b9eff;color:#067ada;border-radius:4px;cursor:pointer;white-space:nowrap;">Copiar</button><a href="${link.url}" target="_blank" style="font-size:10px;padding:3px 8px;background:#fff;border:1px solid #ddd;color:#555;border-radius:4px;text-decoration:none;white-space:nowrap;">Abrir</a></div>`;
            s3ResultMultiList.appendChild(row);
          });
          s3ResultMultiDiv.style.display = "";
        }

        // Salvar no histórico
        const folderName = s3Mode === "folder" && s3SelectedFiles.length
          ? s3SelectedFiles[0].webkitRelativePath.split("/")[0] : null;
        await saveToHistory({
          id: Date.now(),
          type: s3Mode === "folder" ? "folder" : "file",
          date: new Date().toISOString(),
          label: folderName ? `${folderName} (${collectedLinks.length} arquivo${collectedLinks.length > 1 ? "s" : ""})` : collectedLinks[0].name,
          courseFolder,
          links: collectedLinks,
        });

      } catch (e) {
        if (s3UploadStatus) s3UploadStatus.textContent = `Erro: ${e.message}`;
      } finally {
        s3UploadBtn.disabled = false;
      }
    });
  }

  if (s3ResultMultiList) {
    s3ResultMultiList.addEventListener("click", async (e) => {
      if (e.target.classList.contains("s3-multi-copy")) {
        await navigator.clipboard.writeText(e.target.dataset.url).catch(() => {});
        const orig = e.target.textContent; e.target.textContent = "Copiado!";
        setTimeout(() => { e.target.textContent = orig; }, 1500);
      }
    });
  }

  if (s3CopyBtn) {
    s3CopyBtn.addEventListener("click", async () => {
      const url = s3ResultUrlEl?.value;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        s3CopyBtn.textContent = "Copiado!";
        setTimeout(() => { s3CopyBtn.textContent = "Copiar link"; }, 2000);
      } catch {
        s3ResultUrlEl?.select();
      }
    });
  }
}

// ---------- Upload ícone Start ----------
const startIconBtn = document.getElementById("start-icon-btn");
const startIconStatus = document.getElementById("start-icon-status");

if (startIconBtn) {
  startIconBtn.addEventListener("click", async () => {
    startIconBtn.disabled = true;
    if (startIconStatus) startIconStatus.textContent = "Iniciando…";
    try {
      const tab = await getActiveTab();
      const ack = await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_UPLOAD_START_ICON" });
      if (ack?.ok) {
        if (startIconStatus) startIconStatus.textContent = "";
      } else {
        if (startIconStatus) startIconStatus.textContent = `Erro: ${ack?.error || "desconhecido"}`;
      }
    } catch (e) {
      if (startIconStatus) startIconStatus.textContent = `Erro: ${e.message}`;
    } finally {
      startIconBtn.disabled = false;
    }
  });
}
