(function () {
  const KEY = "aluraRevisorRunState";

  // 5s para considerar que não abriu a primeira aula
  const FIRST_TASK_TIMEOUT_MS = 5000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ERROR_FIRST_TASK_INACTIVE =
    "Atenção: Primeira atividade do curso está inativa. Entre no admin e altere a ordem.";

  function normalizeText(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function stripHash(url) {
    return (url || "").split("#")[0];
  }

  function normalizeUrlBase(url) {
    return stripHash(url).replace(/\/$/, "");
  }

  async function waitFor(fn, timeoutMs = 15000, intervalMs = 250) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(intervalMs);
    }
    return null;
  }

  async function getState() {
    const data = await chrome.storage.local.get(KEY);
    return data?.[KEY] || null;
  }

  async function setState(state) {
    await chrome.storage.local.set({ [KEY]: state });
  }

  async function clearState() {
    await chrome.storage.local.remove(KEY);
  }

  const KEY_HISTORY = "aluraRevisorHistory";

  async function saveToHistory(entry) {
    const data = await chrome.storage.local.get(KEY_HISTORY);
    const history = data?.[KEY_HISTORY] || [];

    if (entry.courseId && entry.courseId !== "?") {
      const idx = history.findIndex((e) => e.courseId === entry.courseId);
      if (idx >= 0) history.splice(idx, 1);
    }

    history.unshift(entry);
    if (history.length > 20) history.splice(20);
    await chrome.storage.local.set({ [KEY_HISTORY]: history });
  }

  // ---------- Detecção de páginas ----------
  function isHomePage() {
    return (
      !!document.querySelector("p.course-header-summary__text") ||
      !!document.querySelector("a.courseSectionList-section") ||
      !!document.querySelector(".course-header-banner")
    );
  }

  function isTaskPage() {
    return /\/task\/\d+/.test(window.location.href) || !!document.querySelector(".task-body");
  }

  function isVideoTask() {
    return !!document.querySelector(".video-js") || !!document.querySelector("video.vjs-tech");
  }

  function hasTranscriptionText() {
    const section = document.querySelector("section#transcription");
    if (!section) return false;
    return (section.textContent || "").replace(/\s+/g, " ").trim().length > 100;
  }

  // ---------- Ícone ----------
  const VALID_CATEGORY_SLUGS = new Set([
    "programacao", "front-end", "data-science", "inteligencia-artificial",
    "devops", "design-ux", "mobile", "inovacao-gestao"
  ]);

  function getCategorySlugFromBreadcrumb() {
    const breadcrumb = document.querySelector(".container.course-header-banner-breadcrumb");
    if (!breadcrumb) return null;
    const links = breadcrumb.querySelectorAll("a[href]");
    for (const link of links) {
      const parts = (link.getAttribute("href") || "").split("/").filter(Boolean);
      for (const part of parts) {
        if (VALID_CATEGORY_SLUGS.has(part.toLowerCase())) return part.toLowerCase();
      }
    }
    return null;
  }

  function getCourseSlugFromUrl() {
    const m = window.location.pathname.match(/\/course\/([^/]+)/);
    return m ? m[1] : null;
  }

  async function checkIcon(courseSlug) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_CHECK_ICON", courseSlug }, (resp) => {
        resolve({ exists: resp?.exists === true, notFound: resp?.notFound === true });
      });
    });
  }

  async function uploadIcon(categorySlug, courseSlug) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_UPLOAD_ICON", categorySlug, courseSlug }, (resp) => {
        resolve(resp?.ok === true);
      });
    });
  }

  function askUploadIcon(categorySlug) {
    return new Promise((resolve) => {
      const { modal, overlay } = createOverlayModal("420px");
      modal.innerHTML = `
        <h3 style="margin:0 0 14px 0; font-family:system-ui,Arial;">Ícone do Curso</h3>
        <p style="margin:0 0 20px 0; font-size:15px; line-height:1.5;">
          O ícone do curso não existe no repositório.<br>
          Deseja subir o ícone de <strong>${categorySlug}</strong>?
        </p>
        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button id="iconNo" style="padding:8px 20px; border:0; border-radius:8px; cursor:pointer; background:#eee; color:#333; font-size:14px;">Não, pular</button>
          <button id="iconYes" style="padding:8px 20px; border:0; border-radius:8px; cursor:pointer; background:#1a73e8; color:#fff; font-size:14px;">Sim, enviar</button>
        </div>
      `;
      document.getElementById("iconNo").onclick = () => { overlay.remove(); resolve(false); };
      document.getElementById("iconYes").onclick = () => { overlay.remove(); resolve(true); };
    });
  }

  function showIconWaiting() {
    const { modal, overlay } = createOverlayModal("380px");
    modal.innerHTML = `
      <p style="margin:0; text-align:center; font-size:15px; font-family:system-ui,Arial;">
        Enviando ícone para o GitHub…
      </p>
    `;
    return overlay;
  }

  // ---------- Subcategoria ----------
  function breadcrumbHasSubcategory(container) {
    if (!container) return false;
    // Sem subcategoria: href="/category/#" (fragment vazio)
    // Com subcategoria: href="/category/data-science#sql" (fragment real)
    const subcatLink = container.querySelector(".course-header-banner-breadcrumb__subcategory");
    if (!subcatLink) return false;
    const href = subcatLink.getAttribute("href") || "";
    const hashIdx = href.indexOf("#");
    if (hashIdx === -1) return false;
    return href.slice(hashIdx + 1).length > 0;
  }

  function hasSubcategoryBreadcrumb() {
    return breadcrumbHasSubcategory(
      document.querySelector(".container.course-header-banner-breadcrumb")
    );
  }

  async function fetchSubcategoryCheck() {
    try {
      const resp = await fetch(window.location.href, { credentials: "include", cache: "no-store" });
      if (!resp.ok) return null;
      const text = await resp.text();
      const doc = new DOMParser().parseFromString(text, "text/html");
      return breadcrumbHasSubcategory(
        doc.querySelector(".container.course-header-banner-breadcrumb")
      );
    } catch {
      return null; // null = não foi possível verificar
    }
  }

  // ---------- Catálogo ----------
  function findAdminCourseIdInDOM() {
    const links = document.querySelectorAll("a[href*='/admin/courses/v2/']");
    for (const a of links) {
      const m = (a.href || "").match(/\/admin\/courses\/v2\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  async function resolveCourseId() {
    // First try: link already in DOM (not lazy)
    const direct = findAdminCourseIdInDOM();
    if (direct) return direct;

    // Second try: open "Outras ações" dropdown to force rendering
    const toggle =
      document.querySelector(".course-header-button-menu__toggle") ||
      Array.from(document.querySelectorAll("button")).find((b) =>
        normalizeText(b.textContent).toLowerCase().includes("outras")
      ) ||
      null;

    if (!toggle) return null;

    toggle.click();
    await sleep(500);

    const courseId = findAdminCourseIdInDOM();

    toggle.click(); // close dropdown
    return courseId;
  }

  async function checkCatalog(courseId) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_CHECK_CATALOG", courseId }, (resp) => {
        resolve(resp?.catalogOk === true);
      });
    });
  }

  async function addToCatalog(courseId) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_ADD_TO_CATALOG", courseId }, (resp) => {
        resolve(resp?.ok === true);
      });
    });
  }

  // ---------- Transcrição ----------
  function readTranscriptionRawOnce() {
    const labels = Array.from(document.querySelectorAll("p.course-header-summary__text"));
    const label = labels.find((p) => normalizeText(p.textContent).toLowerCase() === "transcrição");
    if (!label) return null;

    const wrapper = label.closest(".course-header-summary__info__wrapper") || label.parentElement;
    const valueEl = wrapper ? wrapper.querySelector("p.course-header-summary__title") : null;

    const raw = normalizeText(valueEl?.textContent || "");
    return raw || null;
  }

  function parseTranscription(raw) {
    const rawText = raw || null;
    if (!rawText) return { rawText: null, percentNumber: null, is100: false };

    const m = rawText.match(/(\d{1,3})\s*%/);
    if (m) {
      const n = Number(m[1]);
      return { rawText, percentNumber: Number.isFinite(n) ? n : null, is100: n === 100 };
    }

    // caso especial: "Em andamento" = 0%
    if (rawText.toLowerCase() === "em andamento") {
      return { rawText, percentNumber: 0, is100: false };
    }

    return { rawText, percentNumber: null, is100: false };
  }

  async function readTranscriptionStableParsed() {
    const firstRaw = await waitFor(() => readTranscriptionRawOnce(), 20000);
    if (!firstRaw) return parseTranscription(null);

    await sleep(350);
    const secondRaw = readTranscriptionRawOnce();

    const chosen = secondRaw && secondRaw === firstRaw ? secondRaw : firstRaw;
    return parseTranscription(chosen);
  }

  function getFirstLessonHref() {
    const a =
      document.querySelector("li.courseSection-listItem a.courseSectionList-section") ||
      document.querySelector("a.courseSectionList-section");
    return a?.href || null;
  }

  function isCourseListLoaded() {
    return (
      !!document.querySelector(".course-content-sectionList") ||
      !!document.querySelector("ul.courseSection-list") ||
      !!document.querySelector(".courseSectionList")
    );
  }

  // ---------- Próxima atividade ----------
  function findNextActivityLink() {
    const a = document.querySelector("a.task-actions-button-next");
    if (a?.href) return a;

    const nodes = Array.from(document.querySelectorAll("a,button"));
    const byText = nodes.find((el) => normalizeText(el.textContent).toLowerCase() === "próxima atividade");
    if (byText && byText.tagName.toLowerCase() === "a" && byText.href) return byText;

    return null;
  }

  // ---------- Validação: href vazio ----------
  function isEmptyHrefValue(href) {
    const h = (href ?? "").trim();
    if (!h) return true;
    if (h === "#") return true;
    return false;
  }

  function getFormattedTextRoot() {
    return (
      document.querySelector("#task-content .formattedText") ||
      document.querySelector(".task-body-main .formattedText") ||
      document.querySelector(".formattedText")
    );
  }

  function collectEmptyHrefLinksInCurrentTask() {
    const formatted = getFormattedTextRoot();
    if (!formatted) return { hasIssue: false, count: 0 };

    const anchors = Array.from(formatted.querySelectorAll("a"));
    let count = 0;

    for (const a of anchors) {
      if (!a.hasAttribute("href")) continue;
      const rawHref = a.getAttribute("href");
      if (isEmptyHrefValue(rawHref)) count++;
    }

    return { hasIssue: count > 0, count };
  }

  // ---------- Validação: GitHub fora do padrão ----------
  function isNonStandardGithubUrl(href) {
    if (!href) return false;

    let u;
    try {
      u = new URL(href, window.location.href);
    } catch {
      return false;
    }

    const host = (u.hostname || "").toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return false;

    const parts = (u.pathname || "").split("/").filter(Boolean);
    if (parts.length === 0) return false;

    const first = (parts[0] || "").toLowerCase();
    return first !== "alura-cursos";
  }

  function collectNonStandardGithubLinksInCurrentTask() {
    const formatted = getFormattedTextRoot();
    if (!formatted) return { hasIssue: false, links: [] };

    const anchors = Array.from(formatted.querySelectorAll("a"));
    const bad = [];

    for (const a of anchors) {
      const href = a.href || a.getAttribute("href") || "";
      if (isNonStandardGithubUrl(href)) bad.push(stripHash(href));
    }

    const uniq = Array.from(new Set(bad));
    return { hasIssue: uniq.length > 0, links: uniq };
  }

  // ---------- Validação: repositórios não oficiais ----------
  function isNonOfficialCloudUrl(href) {
    if (!href) return false;

    let u;
    try {
      u = new URL(href, window.location.href);
    } catch {
      return false;
    }

    const host = (u.hostname || "").toLowerCase();
    return host.includes("fiapcom.sharepoint.com") || host.includes("docs.google.com");
  }

  function collectNonOfficialCloudLinksInCurrentTask() {
    const formatted = getFormattedTextRoot();
    if (!formatted) return { hasIssue: false, links: [] };

    const anchors = Array.from(formatted.querySelectorAll("a"));
    const bad = [];

    for (const a of anchors) {
      const href = a.href || a.getAttribute("href") || "";
      if (isNonOfficialCloudUrl(href)) bad.push(stripHash(href));
    }

    const uniq = Array.from(new Set(bad));
    return { hasIssue: uniq.length > 0, links: uniq };
  }

  // ---------- NOVO: Coletar todos os links HTTP(S) ----------
  function isHttpUrlLike(href) {
    if (!href) return false;
    const h = String(href).trim();
    if (!h) return false;
    if (h.startsWith("#")) return false;
    if (h.startsWith("mailto:") || h.startsWith("tel:")) return false;
    if (h.startsWith("javascript:")) return false;

    let u;
    try {
      u = new URL(h, window.location.href);
    } catch {
      return false;
    }
    return u.protocol === "http:" || u.protocol === "https:";
  }

  function collectAllHttpLinksInCurrentTask() {
    const formatted = getFormattedTextRoot();
    if (!formatted) return [];

    const anchors = Array.from(formatted.querySelectorAll("a"));
    const urls = [];

    for (const a of anchors) {
      const href = a.href || a.getAttribute("href") || "";
      if (!isHttpUrlLike(href)) continue;
      urls.push(stripHash(href));
    }

    return Array.from(new Set(urls));
  }

  async function check404ViaBackground(urls) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_CHECK_404", urls }, (resp) => {
        if (!resp?.ok) return resolve([]);
        resolve(resp.bad404 || []);
      });
    });
  }

  function addIssue(state, key, activityUrl) {
    state.issues = state.issues || {};
    state.issues[key] = state.issues[key] || [];
    if (!state.issues[key].includes(activityUrl)) state.issues[key].push(activityUrl);
  }

  function addIssueDetails(state, key, activityUrl, detailsArray) {
    state.issues = state.issues || {};
    state.issues[key] = state.issues[key] || {};
    state.issues[key][activityUrl] = state.issues[key][activityUrl] || [];

    for (const item of detailsArray || []) {
      if (!state.issues[key][activityUrl].includes(item)) state.issues[key][activityUrl].push(item);
    }
  }

  // ---------- Popup ----------
  function removeExistingModal() {
    const el = document.getElementById("alura-revisor-modal");
    if (el) el.remove();
  }

  function createOverlayModal(width = "620px") {
    removeExistingModal();

    const overlay = document.createElement("div");
    overlay.id = "alura-revisor-modal";
    overlay.style.position = "fixed";
    overlay.style.top = 0;
    overlay.style.left = 0;
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.background = "rgba(0,0,0,0.5)";
    overlay.style.zIndex = 999999;
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    const modal = document.createElement("div");
    modal.style.background = "#fff";
    modal.style.padding = "22px";
    modal.style.borderRadius = "10px";
    modal.style.width = width;
    modal.style.fontFamily = "system-ui, Arial";
    modal.style.boxShadow = "0 10px 30px rgba(0,0,0,0.25)";
    modal.style.textAlign = "left";

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    return { overlay, modal };
  }

  // ---------- Alerta: curso sem aulas ----------
  function showNoLessonsAlert() {
    const { modal, overlay } = createOverlayModal("380px");
    modal.innerHTML = `
      <h3 style="margin:0 0 14px 0; font-family:system-ui,Arial;">⚠️ Curso sem aulas</h3>
      <p style="margin:0 0 20px 0; font-size:15px; line-height:1.5;">
        Este curso não possui aulas ativas. Revisão finalizada.
      </p>
      <div style="display:flex; justify-content:flex-end;">
        <button id="aluraNoLessonsClose" style="padding:8px 20px; border:0; border-radius:8px; cursor:pointer; background:#111; color:#fff; font-size:14px;">Fechar</button>
      </div>
    `;
    document.getElementById("aluraNoLessonsClose").onclick = () => overlay.remove();
  }

  // ---------- Diálogo: adicionar ao catálogo ----------
  function askAddToCatalog() {
    return new Promise((resolve) => {
      const { modal, overlay } = createOverlayModal("420px");
      modal.innerHTML = `
        <h3 style="margin:0 0 14px 0; font-family:system-ui,Arial;">Catálogo Alura</h3>
        <p style="margin:0 0 20px 0; font-size:15px; line-height:1.5;">
          O curso não está no catálogo Alura.<br>Deseja adicionar agora?
        </p>
        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button id="aluraCatalogNo" style="padding:8px 20px; border:0; border-radius:8px; cursor:pointer; background:#eee; color:#333; font-size:14px;">Não, pular</button>
          <button id="aluraCatalogYes" style="padding:8px 20px; border:0; border-radius:8px; cursor:pointer; background:#1a73e8; color:#fff; font-size:14px;">Sim, adicionar</button>
        </div>
      `;
      document.getElementById("aluraCatalogNo").onclick = () => { overlay.remove(); resolve(false); };
      document.getElementById("aluraCatalogYes").onclick = () => { overlay.remove(); resolve(true); };
    });
  }

  function showCatalogWaiting() {
    const { modal, overlay } = createOverlayModal("380px");
    modal.innerHTML = `
      <p style="margin:0; text-align:center; font-size:15px; font-family:system-ui,Arial;">
        Adicionando ao catálogo Alura…
      </p>
    `;
    return overlay;
  }

  function showFinalPopup(state, { persistHistory = true } = {}) {
    const { modal, overlay } = createOverlayModal("720px");

    const subLine = state.hasSubcategory ? "✅ Subcategoria Adicionada" : "❌ Sem Subcategoria";
    const trLine = state.transcriptionIs100 ? "✅ Transcrição Completa" : "❌ Transcrição Incompleta";
    const catalogLine = state.catalogCode === null
      ? "⚠️ Catálogo não verificado"
      : state.catalogOk
        ? "✅ Catálogo OK"
        : "❌ Adicionar curso no catálogo";

    const emptyHrefIssues = state.issues?.emptyHref || [];
    const githubIssuesMap = state.issues?.githubNonStandard || {};
    const cloudIssuesMap = state.issues?.nonOfficialCloud || {};
    const link404Map = state.issues?.link404 || {};

    const hasEmptyHrefIssues = emptyHrefIssues.length > 0;

    const githubActivities = Object.keys(githubIssuesMap);
    const hasGithubIssues = githubActivities.length > 0;

    const cloudActivities = Object.keys(cloudIssuesMap);
    const hasCloudIssues = cloudActivities.length > 0;

    const link404Activities = Object.keys(link404Map);
    const has404Issues = link404Activities.length > 0;

    const hasContentIssues = hasEmptyHrefIssues || hasGithubIssues || hasCloudIssues || has404Issues;

    const iconLine = state.iconStatus === "exists"   ? "✅ Ícone OK"
      : state.iconStatus === "uploaded" ? "✅ Ícone enviado"
      : state.iconStatus === "skipped"  ? "⚠️ Ícone não enviado"
      : state.iconStatus === "error"    ? "❌ Erro ao enviar ícone"
      : null;

    const iconOk = !state.iconStatus || state.iconStatus === "exists" || state.iconStatus === "uploaded";
    const okAllBase = state.transcriptionIs100 && state.hasSubcategory && (state.catalogCode === null || state.catalogOk) && iconOk && !state.error;
    const title = okAllBase && !hasContentIssues ? "Checklist final: TUDO OK ✅" : "Checklist final: atenção ⚠️";

    if (persistHistory) {
      saveToHistory({
        courseId: state.courseId || "?",
        runAt: Date.now(),
        ok: okAllBase && !hasContentIssues,
        state
      }).catch(() => {});
    }

    const emptyHrefBlock = hasEmptyHrefIssues
      ? `
        <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff7e6; border:1px solid #ffe0b2;">
          <div style="font-weight:700; margin-bottom:6px;">⚠️ Links vazios nas atividades:</div>
          <ul style="margin:6px 0 0 18px; padding:0; color:#333;">
            ${emptyHrefIssues.map((u) => `<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`).join("")}
          </ul>
        </div>
      `
      : "";

    const githubBlock = hasGithubIssues
      ? `
        <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff7e6; border:1px solid #ffe0b2;">
          <div style="font-weight:700; margin-bottom:6px;">⚠️ Link do GitHub fora do padrão (o correto é github.com/alura-cursos) nas atividades:</div>
          <ul style="margin:6px 0 0 18px; padding:0; color:#333;">
            ${githubActivities
              .map((activityUrl) => {
                const links = githubIssuesMap[activityUrl] || [];
                const linksHtml = links
                  .map((l) => `<li style="margin-left:18px;"><a href="${l}" target="_blank" rel="noreferrer">${l}</a></li>`)
                  .join("");
                return `
                  <li style="margin-bottom:8px;">
                    <a href="${activityUrl}" target="_blank" rel="noreferrer">${activityUrl}</a>
                    <ul style="margin:6px 0 0 0; padding-left:0; list-style:disc;">
                      ${linksHtml}
                    </ul>
                  </li>
                `;
              })
              .join("")}
          </ul>
        </div>
      `
      : "";

    const cloudBlock = hasCloudIssues
      ? `
        <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff7e6; border:1px solid #ffe0b2;">
          <div style="font-weight:700; margin-bottom:6px;">
            ⚠️ Link em repositório interno (SharePoint / Google Docs). Subir arquivo na Nuvem da Alura:
          </div>
          <ul style="margin:6px 0 0 18px; padding:0; color:#333;">
            ${cloudActivities
              .map((activityUrl) => {
                const links = cloudIssuesMap[activityUrl] || [];
                const linksHtml = links
                  .map((l) => `<li style="margin-left:18px;"><a href="${l}" target="_blank" rel="noreferrer">${l}</a></li>`)
                  .join("");
                return `
                  <li style="margin-bottom:8px;">
                    <a href="${activityUrl}" target="_blank" rel="noreferrer">${activityUrl}</a>
                    <ul style="margin:6px 0 0 0; padding-left:0; list-style:disc;">
                      ${linksHtml}
                    </ul>
                  </li>
                `;
              })
              .join("")}
          </ul>
        </div>
      `
      : "";

    const link404Block = has404Issues
      ? `
        <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff5f5; border:1px solid #ffd2d2;">
          <div style="font-weight:700; margin-bottom:6px; color:#b00020;">
            ⚠️ Links retornando 404 (não encontrado) nas atividades:
          </div>
          <ul style="margin:6px 0 0 18px; padding:0; color:#333;">
            ${link404Activities
              .map((activityUrl) => {
                const links = link404Map[activityUrl] || [];
                const linksHtml = links
                  .map((l) => `<li style="margin-left:18px;"><a href="${l}" target="_blank" rel="noreferrer">${l}</a></li>`)
                  .join("");
                return `
                  <li style="margin-bottom:8px;">
                    <a href="${activityUrl}" target="_blank" rel="noreferrer">${activityUrl}</a>
                    <ul style="margin:6px 0 0 0; padding-left:0; list-style:disc;">
                      ${linksHtml}
                    </ul>
                  </li>
                `;
              })
              .join("")}
          </ul>
        </div>
      `
      : "";

    const missingTranscriptionUrls = state.issues?.missingTranscription || [];
    const pct = state.transcriptionPercentNumber;
    const missingTranscriptionBlock =
      missingTranscriptionUrls.length > 0 && pct != null && pct >= 70 && pct < 100
        ? `
          <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff7e6; border:1px solid #ffe0b2;">
            <div style="font-weight:700; margin-bottom:6px;">⚠️ Vídeos sem texto de transcrição (${missingTranscriptionUrls.length}):</div>
            <ul style="margin:6px 0 0 18px; padding:0; color:#333;">
              ${missingTranscriptionUrls.map((u) => `<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`).join("")}
            </ul>
          </div>
        `
        : "";

    const errorBlock = state.error
      ? `<div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff5f5; border:1px solid #ffd2d2; color:#b00020;">
           <strong>${state.error}</strong>
         </div>`
      : "";

    modal.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
        <h2 style="margin:0;">${title}</h2>
      </div>

      <div style="margin-top:16px; font-size:16px; line-height:1.6;">
        <div style="margin:8px 0;">${subLine}</div>
        <div style="margin:8px 0;">${trLine}</div>
        <div style="margin:8px 0;">${catalogLine}</div>
        ${iconLine ? `<div style="margin:8px 0;">${iconLine}</div>` : ""}
        ${missingTranscriptionBlock}
        ${emptyHrefBlock}
        ${githubBlock}
        ${cloudBlock}
        ${link404Block}
        ${errorBlock}
      </div>

      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:18px;">
        <button id="aluraRevisorClose" style="
          padding:8px 14px; border:0; border-radius:8px; cursor:pointer;
          background:#111; color:#fff;
        ">Fechar</button>
      </div>
    `;

    document.getElementById("aluraRevisorClose").onclick = () => overlay.remove();
  }

  async function finalize(state, error = null) {
    // Verificação de ícone adiada: curso foi adicionado ao catálogo durante a revisão.
    // A home recarregou, então o breadcrumb agora deve exibir a categoria.
    if (state.pendingIconCheck && state.courseSlug && isHomePage()) {
      const categorySlug = getCategorySlugFromBreadcrumb();
      if (categorySlug) {
        const iconResult = await checkIcon(state.courseSlug);
        if (iconResult.exists) {
          state.iconStatus = "exists";
        } else if (iconResult.notFound) {
          const wantsUpload = await askUploadIcon(categorySlug);
          if (wantsUpload) {
            const iconWaitOverlay = showIconWaiting();
            const uploaded = await uploadIcon(categorySlug, state.courseSlug);
            iconWaitOverlay.remove();
            state.iconStatus = uploaded ? "uploaded" : "error";
          } else {
            state.iconStatus = "skipped";
          }
        }
        state.categorySlug = categorySlug;
      }
      // sem categoria mesmo após revisão → iconStatus permanece null
      state.pendingIconCheck = false;
    }

    state.running = false;
    state.finished = !error;
    state.error = error || null;
    await setState(state);
    showFinalPopup(state);
  }

  // ---------- Inativa primeira atividade ----------
  function isFirstTaskInactiveCase(state) {
    if (state.enteredTask) return false;

    const elapsed = Date.now() - (state.firstTaskAttemptedAt || 0);
    if (elapsed < FIRST_TASK_TIMEOUT_MS) return false;

    if (isTaskPage()) return false;

    return true;
  }

  // ---------- Fluxo principal ----------
  async function startFromHome() {
    await waitFor(() => isHomePage(), 20000);

    // Detecta cursos "em breve" (sem aulas ativas) antes de qualquer verificação
    await waitFor(() => isCourseListLoaded(), 10000);
    if (isCourseListLoaded() && !getFirstLessonHref()) {
      showNoLessonsAlert();
      return;
    }

    const t = await readTranscriptionStableParsed();
    let hasSubcategory = hasSubcategoryBreadcrumb();

    const courseId = await resolveCourseId();
    let catalogOk = false;
    let catalogCode = null;
    let addedToCatalog = false;

    if (courseId) {
      catalogOk = await checkCatalog(courseId);
      catalogCode = catalogOk ? "alura" : "not_alura";

      if (!catalogOk) {
        const wantsToAdd = await askAddToCatalog();
        if (wantsToAdd) {
          const waitingOverlay = showCatalogWaiting();
          const added = await addToCatalog(courseId);
          waitingOverlay.remove();
          if (added) {
            catalogOk = true;
            catalogCode = "alura";
            addedToCatalog = true;
            const recheck = await fetchSubcategoryCheck();
            if (recheck !== null) hasSubcategory = recheck;
          }
        }
      }
    }

    // ---------- Ícone ----------
    const categorySlug = getCategorySlugFromBreadcrumb();
    const courseSlug = getCourseSlugFromUrl();
    let iconStatus = null;
    let pendingIconCheck = false;

    if (courseSlug) {
      if (categorySlug) {
        // Categoria visível — verifica/sobe ícone agora
        const iconResult = await checkIcon(courseSlug);
        if (iconResult.exists) {
          iconStatus = "exists";
        } else if (iconResult.notFound) {
          // Ícone definitivamente não existe (404) — perguntar ao usuário
          const wantsUpload = await askUploadIcon(categorySlug);
          if (wantsUpload) {
            const iconWaitOverlay = showIconWaiting();
            const uploaded = await uploadIcon(categorySlug, courseSlug);
            iconWaitOverlay.remove();
            iconStatus = uploaded ? "uploaded" : "error";
          } else {
            iconStatus = "skipped";
          }
        }
        // Se notFound=false (erro de auth/rede), iconStatus fica null — pula silenciosamente
      } else if (addedToCatalog) {
        // Curso recém-adicionado ao catálogo: categoria ainda não aparece no breadcrumb.
        // Adia verificação do ícone para o final da revisão (quando a home recarregar).
        pendingIconCheck = true;
      }
      // else: sem categoria e não foi adicionado ao catálogo → não é possível subir ícone
    }

    const firstHref = await waitFor(() => getFirstLessonHref(), 20000);
    if (!firstHref) {
      const st = {
        running: false,
        transcriptionRawText: t.rawText,
        transcriptionIs100: t.is100,
        transcriptionPercentNumber: t.percentNumber,
        hasSubcategory,
        catalogOk,
        catalogCode,
        courseId: courseId || null,
        iconStatus,
        categorySlug: categorySlug || null,
        courseSlug: courseSlug || null,
        pendingIconCheck,
        enteredTask: false,
        homeBaseUrl: normalizeUrlBase(window.location.href),
        issues: { emptyHref: [], githubNonStandard: {}, nonOfficialCloud: {}, link404: {}, missingTranscription: [] },
        error: "Não encontrei a primeira aula na lista."
      };
      await setState(st);
      showFinalPopup(st);
      return;
    }

    const state = {
      running: true,
      finished: false,
      startedAt: Date.now(),

      transcriptionRawText: t.rawText,
      transcriptionIs100: t.is100,
      transcriptionPercentNumber: t.percentNumber,
      hasSubcategory,
      catalogOk,
      catalogCode,
      courseId: courseId || null,
      iconStatus,
      categorySlug: categorySlug || null,
      courseSlug: courseSlug || null,
      pendingIconCheck,

      steps: 0,
      enteredTask: false,

      homeBaseUrl: normalizeUrlBase(window.location.href),

      firstTaskAttemptedAt: Date.now(),
      expectedFirstTaskHref: firstHref,

      issues: { emptyHref: [], githubNonStandard: {}, nonOfficialCloud: {}, link404: {}, missingTranscription: [] },
      error: null,

      // evita checar 404 mais de uma vez na mesma activity (se tick rodar novamente)
      checked404ByActivity: {}
    };

    await setState(state);
    window.location.assign(firstHref);
  }

  // ---------- Tick central ----------
  async function tick() {
    const state = await getState();
    if (!state?.running) return;

    if (isFirstTaskInactiveCase(state)) {
      await finalize(state, ERROR_FIRST_TASK_INACTIVE);
      return;
    }

    // terminou o curso e caiu na home
    if (state.enteredTask && isHomePage()) {
      const currentBase = normalizeUrlBase(window.location.href);
      const homeBase = normalizeUrlBase(state.homeBaseUrl || "");
      if (homeBase && (currentBase === homeBase || currentBase.startsWith(homeBase))) {
        await finalize(state, null);
        return;
      }
    }

    if (isTaskPage()) {
      if (!state.enteredTask) {
        state.enteredTask = true;
        state.firstTaskAttemptedAt = null;
        state.expectedFirstTaskHref = null;
        await setState(state);
      }

      await waitFor(
        () =>
          document.querySelector("#task-content .formattedText") ||
          document.querySelector(".task-body-main .formattedText") ||
          document.querySelector(".task-body"),
        20000
      );

      // 1) href vazio
      const check = collectEmptyHrefLinksInCurrentTask();
      if (check.hasIssue) {
        addIssue(state, "emptyHref", window.location.href);
        await setState(state);
      }

      // 2) GitHub fora do padrão (não alura-cursos)
      const gh = collectNonStandardGithubLinksInCurrentTask();
      if (gh.hasIssue) {
        addIssueDetails(state, "githubNonStandard", window.location.href, gh.links);
        await setState(state);
      }

      // 3) Repositórios não oficiais (fiapcom.sharepoint.com / docs.google.com)
      const cloud = collectNonOfficialCloudLinksInCurrentTask();
      if (cloud.hasIssue) {
        addIssueDetails(state, "nonOfficialCloud", window.location.href, cloud.links);
        await setState(state);
      }

      // 4) Links 404 (via background)
      state.checked404ByActivity = state.checked404ByActivity || {};
      if (!state.checked404ByActivity[window.location.href]) {
        state.checked404ByActivity[window.location.href] = true;
        await setState(state);

        const allLinks = collectAllHttpLinksInCurrentTask();
        if (allLinks.length > 0) {
          const bad404 = await check404ViaBackground(allLinks);
          if (bad404.length > 0) {
            addIssueDetails(state, "link404", window.location.href, bad404);
            await setState(state);
          }
        }
      }

      // 5) Vídeo sem texto de transcrição
      if (isVideoTask() && !hasTranscriptionText()) {
        addIssue(state, "missingTranscription", window.location.href);
        await setState(state);
      }

      const next = findNextActivityLink();
      if (!next) {
        await finalize(state, null);
        return;
      }

      state.steps = (state.steps || 0) + 1;
      await setState(state);

      window.location.assign(next.href);
    }
  }

  // ---------- Heartbeat ----------
  let heartbeatStarted = false;
  function startHeartbeat() {
    if (heartbeatStarted) return;
    heartbeatStarted = true;

    const loop = async () => {
      try {
        await tick();
      } catch (e) {
        const st = await getState();
        if (st?.running) await finalize(st, e?.message || String(e));
      } finally {
        const st = await getState();
        if (st?.running) setTimeout(loop, 800);
        else heartbeatStarted = false;
      }
    };

    loop();
  }

  // ---------- Start via popup ----------
  let starting = false;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_START") return;

    (async () => {
      try {
        if (starting) return sendResponse({ ok: false, error: "Já estou iniciando uma execução." });
        starting = true;

        await clearState();
        if (!isHomePage()) return sendResponse({ ok: false, error: "Abra a Home do curso antes de clicar Start." });

        sendResponse({ ok: true });
        await startFromHome();
        startHeartbeat();
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      } finally {
        starting = false;
      }
    })();

    return true;
  });

  // ---------- Show report via popup ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_SHOW_REPORT") return;
    showFinalPopup(msg.state, { persistHistory: false });
    sendResponse({ ok: true });
    return true;
  });

  // ---------- Stop via popup ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_STOP") return;

    (async () => {
      await clearState();
      sendResponse({ ok: true });
    })();

    return true;
  });

  // ---------- Boot: se ficou rodando, continua ----------
  (async () => {
    const st = await getState();
    if (st?.running && (isHomePage() || isTaskPage())) startHeartbeat();
  })();
})();