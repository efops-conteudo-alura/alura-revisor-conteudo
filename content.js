(function () {
  const KEY = "aluraRevisorRunState";

  // 5s para considerar que não abriu a primeira aula
  const FIRST_TASK_TIMEOUT_MS = 5000;
  const MAX_HISTORY_SIZE = 5;
  const SECTION_CONCURRENCY = 4;

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
      const idx = history.findIndex((e) => e.courseId === entry.courseId && e.platform === entry.platform);
      if (idx >= 0) history.splice(idx, 1);
    }

    history.unshift(entry);
    if (history.length > MAX_HISTORY_SIZE) history.splice(MAX_HISTORY_SIZE);
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

  // ---------- Download mode helpers ----------
  async function waitForVideoSrc(timeoutMs = 10000) {
    return waitFor(() => {
      const el = document.querySelector("video.vjs-tech");
      if (!el) return null;
      let src = el.currentSrc || el.src;
      // Se blob URL (HLS via MSE), busca URL original no player Video.js
      if (src && src.startsWith("blob:")) {
        const playerEl = el.closest(".video-js");
        if (playerEl?.id && window.videojs?.players?.[playerEl.id]) {
          src = window.videojs.players[playerEl.id].currentSrc() || null;
        } else {
          src = null;
        }
      }
      return src || null;
    }, timeoutMs);
  }

  function parseActivityFromTitle() {
    const raw = document.title || "";
    const withoutSuffix = raw.split("|")[0].trim();

    // Extrai número da seção de "Aula X"
    const aulaMatch = withoutSuffix.match(/Aula\s+(\d+)/i);
    const sectionFromTitle = aulaMatch ? parseInt(aulaMatch[1], 10) : null;

    // Extrai nome curto da atividade de "Atividade X {nome}"
    const atividadeMatch = withoutSuffix.match(/Atividade\s+\d+\s+(.+)$/i);
    const activityTitle = atividadeMatch ? atividadeMatch[1].trim() : withoutSuffix;

    return { sectionFromTitle, activityTitle };
  }

  function buildVideoFilename(courseId, sectionIdx, videoIdxInSection, title) {
    const safeTitle = title
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80);
    return `${courseId}-video${sectionIdx}.${videoIdxInSection}-alura-${safeTitle}.mp4`;
  }

  function buildCourseSectionMap() {
    const map = {};
    let sectionIdx = 0;

    const topList = document.querySelector(
      ".course-content-sectionList, ul.courseSection-list, .courseSectionList"
    );
    if (!topList) return map;

    for (const child of Array.from(topList.children)) {
      const nestedActivityLinks = child.querySelectorAll("a.courseSectionList-section");
      if (nestedActivityLinks.length > 0) {
        if (!child.matches("li.courseSection-listItem")) {
          sectionIdx++;
        } else {
          if (sectionIdx === 0) sectionIdx = 1;
        }
        nestedActivityLinks.forEach((a) => {
          if (a.href) map[normalizeUrlBase(a.href)] = sectionIdx;
        });
      } else if (child.textContent.trim().length > 3) {
        sectionIdx++;
      }
    }

    return map;
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

  function isCheckpointCourse(courseSlug) {
    return /checkpoint/i.test(courseSlug || "");
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
        <h3 style="margin:0 0 14px 0; color:#1c1c1c; font-weight:700;">Ícone do Curso</h3>
        <p style="margin:0 0 20px 0; font-size:15px; line-height:1.5; color:#555;">
          O ícone do curso não existe no repositório.<br>
          Deseja subir o ícone de <strong>${categorySlug}</strong>?
        </p>
        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button id="iconNo" style="padding:9px 20px; border:0; border-radius:8px; cursor:pointer; background:#f0f0f0; color:#333; font-size:14px; font-weight:500;">Não, pular</button>
          <button id="iconYes" style="padding:9px 20px; border:0; border-radius:8px; cursor:pointer; background:#00c86f; color:#fff; font-size:14px; font-weight:600;">Sim, enviar</button>
        </div>
      `;
      document.getElementById("iconNo").onclick = () => { overlay.remove(); resolve(false); };
      document.getElementById("iconYes").onclick = () => { overlay.remove(); resolve(true); };
    });
  }

  function showIconWaiting() {
    const { modal, overlay } = createOverlayModal("380px");
    modal.innerHTML = `
      <p style="margin:0; text-align:center; font-size:15px; color:#555;">
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

  async function fetchCategorySlug() {
    try {
      const resp = await fetch(window.location.href, { credentials: "include", cache: "no-store" });
      if (!resp.ok) return null;
      const text = await resp.text();
      const doc = new DOMParser().parseFromString(text, "text/html");
      const breadcrumb = doc.querySelector(".container.course-header-banner-breadcrumb");
      if (!breadcrumb) return null;
      const links = breadcrumb.querySelectorAll("a[href]");
      for (const link of links) {
        const parts = (link.getAttribute("href") || "").split("/").filter(Boolean);
        for (const part of parts) {
          if (VALID_CATEGORY_SLUGS.has(part.toLowerCase())) return part.toLowerCase();
        }
      }
      return null;
    } catch {
      return null;
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

    // Second try: open "Outras ações" / "Otras acciones" dropdown to force rendering
    const toggle =
      document.querySelector(".course-header-button-menu__toggle") ||
      Array.from(document.querySelectorAll("button")).find((b) => {
        const t = normalizeText(b.textContent).toLowerCase();
        return t.includes("outras") || t.includes("otras");
      }) ||
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

  async function getCatalogs(courseId) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_GET_CATALOGS", courseId }, (resp) => {
        resolve(resp?.catalogs ?? []);
      });
    });
  }

  async function addToCatalog(courseId, catalogLabel) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_ADD_TO_CATALOG", courseId, catalogLabel }, (resp) => {
        resolve(resp?.ok === true);
      });
    });
  }

  async function getSubcategories() {
    return await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_GET_SUBCATEGORIES" }, resp => {
        resolve(resp?.subcategories ?? []);
      });
    });
  }

  async function addToSubcategory(subcategoryId, courseId) {
    return await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_ADD_TO_SUBCATEGORY", subcategoryId, courseId }, resp => {
        resolve(resp?.ok === true);
      });
    });
  }

  async function getAdminFields(courseId) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_GET_ADMIN_FIELDS", courseId }, (resp) => {
        resolve(resp?.ok ? resp : null);
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

    // caso especial: "Em andamento" / "En curso" = 0%
    if (rawText.toLowerCase() === "em andamento" || rawText.toLowerCase() === "en curso") {
      return { rawText, percentNumber: 0, is100: false };
    }

    return { rawText, percentNumber: null, is100: false };
  }

  async function readTranscriptionStableParsed() {
    // Plataforma LATAM não exibe taxa de transcrição na home — pula a verificação
    if (window.location.origin === "https://app.aluracursos.com") {
      return parseTranscription(null);
    }

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

  function parseHtmlContent(htmlString) {
    const div = document.createElement("div");
    div.innerHTML = htmlString || "";
    return div;
  }

  function collectEmptyHrefLinksInCurrentTask(root) {
    const formatted = root ?? getFormattedTextRoot();
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
    return first !== "alura-cursos" && first !== "alura-es-cursos";
  }

  function collectNonStandardGithubLinksInCurrentTask(root) {
    const formatted = root ?? getFormattedTextRoot();
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
  const NON_OFFICIAL_CLOUD_HOSTS = [
    "sharepoint.com",
    "docs.google.com",
    "drive.google.com",
    "dropbox.com",
    "onedrive.live.com",
    "1drv.ms",
  ];

  function isNonOfficialCloudUrl(href) {
    if (!href) return false;

    let u;
    try {
      u = new URL(href, window.location.href);
    } catch {
      return false;
    }

    const host = (u.hostname || "").toLowerCase();
    return NON_OFFICIAL_CLOUD_HOSTS.some(
      (blocked) => host === blocked || host.endsWith("." + blocked)
    );
  }

  function collectNonOfficialCloudLinksInCurrentTask(root) {
    const formatted = root ?? getFormattedTextRoot();
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

  function collectAllHttpLinksInCurrentTask(root) {
    const formatted = root ?? getFormattedTextRoot();
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

  async function runWithConcurrency(items, worker, concurrency = 4) {
    const out = [];
    let i = 0;
    async function runner() {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx], idx);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, runner)
    );
    return out;
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
    modal.style.borderRadius = "12px";
    modal.style.width = width;
    modal.style.fontFamily = "'Inter', system-ui, -apple-system, Arial";
    modal.style.boxShadow = "0 20px 60px rgba(0,0,0,0.3)";
    modal.style.textAlign = "left";

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    return { overlay, modal };
  }

  // ---------- Alerta: curso sem aulas ----------
  function showNoLessonsAlert() {
    const { modal, overlay } = createOverlayModal("380px");
    modal.innerHTML = `
      <h3 style="margin:0 0 14px 0; color:#1c1c1c; font-weight:700;">⚠️ Curso sem aulas</h3>
      <p style="margin:0 0 20px 0; font-size:15px; line-height:1.5; color:#555;">
        Este curso não possui aulas ativas. Revisão finalizada.
      </p>
      <div style="display:flex; justify-content:flex-end;">
        <button id="aluraNoLessonsClose" style="padding:9px 20px; border:0; border-radius:8px; cursor:pointer; background:#1c1c1c; color:#fff; font-size:14px; font-weight:600;">Fechar</button>
      </div>
    `;
    document.getElementById("aluraNoLessonsClose").onclick = () => overlay.remove();
  }

  // ---------- Diálogo: selecionar catálogo ----------
  function askSelectCatalog(catalogs) {
    return new Promise((resolve) => {
      const { modal, overlay } = createOverlayModal("460px");

      const title = document.createElement("h3");
      title.style.cssText = "margin:0 0 14px 0; color:#1c1c1c; font-weight:700;";
      title.textContent = "Adicionar ao catálogo";
      modal.appendChild(title);

      const desc = document.createElement("p");
      desc.style.cssText = "margin:0 0 16px 0; font-size:15px; line-height:1.5; color:#555;";
      desc.textContent = "O curso não está em nenhum catálogo. Selecione o catálogo para adicionar:";
      modal.appendChild(desc);

      const select = document.createElement("select");
      select.style.cssText = "width:100%; padding:9px 12px; font-size:14px; border-radius:8px; border:1.5px solid #e0e0e0; margin-bottom:20px; outline:none;";

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— selecione um catálogo —";
      select.appendChild(placeholder);

      catalogs.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c.label;
        opt.textContent = c.label;
        select.appendChild(opt);
      });
      modal.appendChild(select);

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex; justify-content:flex-end; gap:10px;";

      const btnNo = document.createElement("button");
      btnNo.style.cssText = "padding:9px 20px; border:0; border-radius:8px; cursor:pointer; background:#f0f0f0; color:#333; font-size:14px; font-weight:500;";
      btnNo.textContent = "Pular";
      btnNo.onclick = () => { overlay.remove(); resolve(null); };

      const btnYes = document.createElement("button");
      btnYes.style.cssText = "padding:9px 20px; border:0; border-radius:8px; cursor:pointer; background:#00c86f; color:#fff; font-size:14px; font-weight:600;";
      btnYes.textContent = "Adicionar";
      btnYes.onclick = () => {
        const chosen = select.value;
        if (!chosen) return;
        overlay.remove();
        resolve(chosen);
      };

      actions.appendChild(btnNo);
      actions.appendChild(btnYes);
      modal.appendChild(actions);
    });
  }

  function showCatalogWaiting(catalogLabel) {
    const { modal, overlay } = createOverlayModal("380px");
    const p = document.createElement("p");
    p.style.cssText = "margin:0; text-align:center; font-size:15px; color:#555;";
    p.textContent = `Adicionando ao catálogo "${catalogLabel}"…`;
    modal.appendChild(p);
    return overlay;
  }

  function askSelectSubcategory(subcategories) {
    return new Promise((resolve) => {
      const { modal, overlay } = createOverlayModal("460px");

      const title = document.createElement("h3");
      title.style.cssText = "margin:0 0 14px 0; color:#1c1c1c; font-weight:700;";
      title.textContent = "Adicionar à subcategoria";
      modal.appendChild(title);

      const desc = document.createElement("p");
      desc.style.cssText = "margin:0 0 16px 0; font-size:15px; line-height:1.5; color:#555;";
      desc.textContent = "O curso não está em nenhuma subcategoria. Selecione a subcategoria para adicionar:";
      modal.appendChild(desc);

      const select = document.createElement("select");
      select.style.cssText = "width:100%; padding:9px 12px; font-size:14px; border-radius:8px; border:1.5px solid #e0e0e0; margin-bottom:20px; outline:none;";

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— selecione uma subcategoria —";
      select.appendChild(placeholder);

      const groups = {};
      subcategories.forEach(s => {
        if (!groups[s.category]) groups[s.category] = [];
        groups[s.category].push(s);
      });
      Object.keys(groups).sort().forEach(catName => {
        const optgroup = document.createElement("optgroup");
        optgroup.label = catName;
        groups[catName]
          .sort((a, b) => a.name.localeCompare(b.name, "pt"))
          .forEach(s => {
            const opt = document.createElement("option");
            opt.value = s.id;
            opt.textContent = s.name;
            optgroup.appendChild(opt);
          });
        select.appendChild(optgroup);
      });
      modal.appendChild(select);

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex; justify-content:flex-end; gap:10px;";

      const btnNo = document.createElement("button");
      btnNo.style.cssText = "padding:9px 20px; border:0; border-radius:8px; cursor:pointer; background:#f0f0f0; color:#333; font-size:14px; font-weight:500;";
      btnNo.textContent = "Pular";
      btnNo.onclick = () => { overlay.remove(); resolve(null); };

      const btnYes = document.createElement("button");
      btnYes.style.cssText = "padding:9px 20px; border:0; border-radius:8px; cursor:pointer; background:#00c86f; color:#fff; font-size:14px; font-weight:600;";
      btnYes.textContent = "Adicionar";
      btnYes.onclick = () => {
        const id = select.value;
        if (!id) return;
        const chosen = subcategories.find(s => String(s.id) === id);
        overlay.remove();
        resolve(chosen || null);
      };

      actions.appendChild(btnNo);
      actions.appendChild(btnYes);
      modal.appendChild(actions);
    });
  }

  function showSubcategoryWaiting(subName) {
    const { modal, overlay } = createOverlayModal("380px");
    const p = document.createElement("p");
    p.style.cssText = "margin:0; text-align:center; font-size:15px; color:#555;";
    p.textContent = `Adicionando à subcategoria "${subName}"…`;
    modal.appendChild(p);
    return overlay;
  }

  function showAdminReviewProgress(totalSections) {
    const { modal, overlay } = createOverlayModal("480px");
    modal.id = "alura-revisor-admin-progress";
    modal.innerHTML = `<h3 style="margin:0 0 12px 0; font-size:15px; color:#1c1c1c; font-weight:700;">Revisando o curso…</h3>`;
    for (let i = 0; i < totalSections; i++) {
      const p = document.createElement("p");
      p.id = `alura-revisor-section-progress-${i}`;
      p.style.cssText = "margin:2px 0; font-size:12px; color:#999;";
      p.textContent = `Seção ${i + 1}: aguardando…`;
      modal.appendChild(p);
    }
    return overlay;
  }

  function updateAdminReviewProgress(si, totalSections, section, ti, totalTasks, task) {
    const el = document.getElementById(`alura-revisor-section-progress-${si}`);
    if (!el) return;
    const taskLabel = task
      ? ` — Ativ. ${ti + 1}/${totalTasks}: ${task.type} — ${task.title}`
      : ` — Buscando atividades…`;
    el.textContent = `Seção ${si + 1}/${totalSections}: ${section.title}${taskLabel}`;
    el.style.color = "#555";
  }

  function generateReportText(state) {
    const lines = [];
    const now = new Date().toLocaleString("pt-BR");

    lines.push("RELATÓRIO DE REVISÃO — ALURA REVISOR");
    lines.push(`Gerado em: ${now}`);
    if (state.courseId) lines.push(`Curso ID: ${state.courseId}`);
    if (state.courseSlug) lines.push(`Slug: ${state.courseSlug}`);
    if (state.homeBaseUrl) lines.push(`URL: ${state.homeBaseUrl}`);
    lines.push("========================================");
    lines.push("");
    lines.push("CHECKLIST:");

    lines.push(`  ${state.hasSubcategory ? "✅" : "❌"} Subcategoria`);

    lines.push(`  ${state.transcriptionIs100 ? "✅ Transcrição Completa" : "⚠️ Tem vídeos sem transcrição, por favor gere as transcrições."}`);

    const catStr = state.catalogCode === null
      ? "⚠️ Catálogo não verificado"
      : state.catalogOk ? "✅ Catálogo OK" : "❌ Catálogo — curso não adicionado";
    lines.push(`  ${catStr}`);

    if (state.iconStatus) {
      const iconStr = state.iconStatus === "exists"   ? "✅ Ícone OK"
        : state.iconStatus === "uploaded" ? "✅ Ícone enviado"
        : state.iconStatus === "skipped"  ? "⚠️ Ícone não enviado"
        : "❌ Erro ao enviar ícone";
      lines.push(`  ${iconStr}`);
    }

    lines.push("");
    lines.push("========================================");
    lines.push("PROBLEMAS ENCONTRADOS:");
    lines.push("");

    const emptyHrefIssues = state.issues?.emptyHref || [];
    const githubIssuesMap = state.issues?.githubNonStandard || {};
    const cloudIssuesMap = state.issues?.nonOfficialCloud || {};
    const link404Map = state.issues?.link404 || {};
    let hasAnyIssue = false;

    if (emptyHrefIssues.length > 0) {
      hasAnyIssue = true;
      lines.push(`Links vazios (${emptyHrefIssues.length} atividade(s)):`);
      emptyHrefIssues.forEach((u) => lines.push(`  - ${u}`));
      lines.push("");
    }

    const githubActivities = Object.keys(githubIssuesMap);
    if (githubActivities.length > 0) {
      hasAnyIssue = true;
      lines.push(`GitHub fora do padrão (${githubActivities.length} atividade(s)):`);
      githubActivities.forEach((act) => {
        lines.push(`  Atividade: ${act}`);
        (githubIssuesMap[act] || []).forEach((l) => lines.push(`    - ${l}`));
      });
      lines.push("");
    }

    const cloudActivities = Object.keys(cloudIssuesMap);
    if (cloudActivities.length > 0) {
      hasAnyIssue = true;
      lines.push(`Repositórios não oficiais (${cloudActivities.length} atividade(s)):`);
      cloudActivities.forEach((act) => {
        lines.push(`  Atividade: ${act}`);
        (cloudIssuesMap[act] || []).forEach((l) => lines.push(`    - ${l}`));
      });
      lines.push("");
    }

    const link404Activities = Object.keys(link404Map);
    if (link404Activities.length > 0) {
      hasAnyIssue = true;
      lines.push(`Links com 404 (${link404Activities.length} atividade(s)):`);
      link404Activities.forEach((act) => {
        lines.push(`  Atividade: ${act}`);
        (link404Map[act] || []).forEach((l) => lines.push(`    - ${l}`));
      });
      lines.push("");
    }


    const adminFieldsIssues = state.issues?.adminFields || [];
    if (adminFieldsIssues.length > 0) {
      hasAnyIssue = true;
      lines.push("Erros no admin de vendas:");
      adminFieldsIssues.forEach(m => lines.push(`  - ${m}`));
      lines.push("");
    }

    const reorderedSections = state.issues?.reorderedSections || [];
    if (reorderedSections.length > 0) {
      lines.push("✅ Ordem ajustado, tinha atividades inativas fora de ordem.");
      lines.push("");
    }

    if (!hasAnyIssue) {
      lines.push("Nenhum problema encontrado.");
      lines.push("");
    }

    if (state.error) {
      lines.push("========================================");
      lines.push(`ERRO: ${state.error}`);
    }

    return lines.join("\n");
  }

  function downloadReport(state) {
    const text = generateReportText(state);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `revisao-${state.courseSlug || state.courseId || "curso"}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showFinalPopup(state, { persistHistory = true } = {}) {
    const { modal, overlay } = createOverlayModal("720px");

    const subLine = state.hasSubcategory ? "✅ Subcategoria Adicionada" : "❌ Sem Subcategoria";
    const trLine = state.transcriptionIs100 ? "✅ Transcrição Completa" : "⚠️ Tem vídeos sem transcrição, por favor gere as transcrições.";
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

    const adminFieldsIssues = state.issues?.adminFields || [];
    const hasAdminIssues = adminFieldsIssues.length > 0;

    const reorderedSections = state.issues?.reorderedSections || [];

    const hasContentIssues = hasEmptyHrefIssues || hasGithubIssues || hasCloudIssues || has404Issues || hasAdminIssues;

    const iconLine = state.iconStatus === "exists"   ? "✅ Ícone OK"
      : state.iconStatus === "uploaded" ? "✅ Ícone enviado"
      : state.iconStatus === "skipped"  ? "⚠️ Ícone não enviado"
      : state.iconStatus === "error"    ? "❌ Erro ao enviar ícone"
      : null;

    const iconOk = !state.iconStatus || state.iconStatus === "exists" || state.iconStatus === "uploaded";
    const okAllBase = state.transcriptionIs100 && state.hasSubcategory && (state.catalogCode === null || state.catalogOk) && iconOk && !state.error && !hasAdminIssues;
    const title = okAllBase && !hasContentIssues ? "Checklist final: TUDO OK ✅" : "Checklist final: atenção ⚠️";

    if (persistHistory) {
      saveToHistory({
        courseId: state.courseId || "?",
        platform: window.location.origin,
        runAt: Date.now(),
        ok: okAllBase && !hasContentIssues,
        state
      }).catch(() => {});
    }

    const emptyHrefBlock = hasEmptyHrefIssues
      ? `
        <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff8e1; border:1px solid #e9a800;">
          <div style="font-weight:700; margin-bottom:6px; color:#7c5700;">⚠️ Links vazios nas atividades:</div>
          <ul style="margin:6px 0 0 18px; padding:0; color:#333;">
            ${emptyHrefIssues.map((u) => `<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`).join("")}
          </ul>
        </div>
      `
      : "";

    const githubBlock = hasGithubIssues
      ? `
        <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff8e1; border:1px solid #e9a800;">
          <div style="font-weight:700; margin-bottom:6px; color:#7c5700;">⚠️ Link do GitHub fora do padrão (o recomendado é github.com/alura-cursos ou github.com/alura-es-cursos) nas atividades:</div>
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
        <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff8e1; border:1px solid #e9a800;">
          <div style="font-weight:700; margin-bottom:6px; color:#7c5700;">
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
        <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff0f0; border:1px solid #e53935;">
          <div style="font-weight:700; margin-bottom:6px; color:#c62828;">
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


    const adminFieldsBlock = hasAdminIssues
      ? `
        <div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff0f0; border:1px solid #e53935;">
          <div style="font-weight:700; margin-bottom:6px; color:#c62828;">⚠️ Há erros no admin de vendas:</div>
          <ul style="margin:6px 0 0 18px; padding:0; color:#333;">
            ${adminFieldsIssues.map(m => `<li>${m}</li>`).join("")}
          </ul>
        </div>
      `
      : "";

    const reorderedBlock = reorderedSections.length > 0
      ? `<div style="margin-top:14px; padding:12px; border-radius:8px; background:#f0fff5; border:1px solid #00c86f; font-weight:700; color:#007a42;">✅ Ordem ajustado, tinha atividades inativas fora de ordem.</div>`
      : "";

    const errorBlock = state.error
      ? `<div style="margin-top:14px; padding:12px; border-radius:8px; background:#fff0f0; border:1px solid #e53935; color:#c62828;">
           <strong>${state.error}</strong>
         </div>`
      : "";

    modal.innerHTML = `
      <div style="padding-bottom:16px; border-bottom:2px solid #f0f0f0; margin-bottom:4px;">
        <h2 style="margin:0; font-size:18px; font-weight:700; color:#1c1c1c;">${title}</h2>
      </div>

      <div style="margin-top:8px; font-size:15px; line-height:1.5;">
        <div style="display:flex; align-items:center; padding:8px 12px; border-radius:8px; background:#f9f9f9; margin-top:8px;">${subLine}</div>
        <div style="display:flex; align-items:center; padding:8px 12px; border-radius:8px; background:#f9f9f9; margin-top:8px;">${trLine}</div>
        <div style="display:flex; align-items:center; padding:8px 12px; border-radius:8px; background:#f9f9f9; margin-top:8px;">${catalogLine}</div>
        ${iconLine ? `<div style="display:flex; align-items:center; padding:8px 12px; border-radius:8px; background:#f9f9f9; margin-top:8px;">${iconLine}</div>` : ""}
        ${emptyHrefBlock}
        ${githubBlock}
        ${cloudBlock}
        ${link404Block}
        ${adminFieldsBlock}
        ${reorderedBlock}
        ${errorBlock}
      </div>

      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
        <button id="aluraRevisorDownload" style="
          padding:9px 18px; border:0; border-radius:8px; cursor:pointer;
          background:#00c86f; color:#fff; font-size:14px; font-weight:600;
        ">Baixar relatório</button>
        <button id="aluraRevisorClose" style="
          padding:9px 18px; border:0; border-radius:8px; cursor:pointer;
          background:#1c1c1c; color:#fff; font-size:14px; font-weight:600;
        ">Fechar</button>
      </div>
    `;

    document.getElementById("aluraRevisorDownload").onclick = () => downloadReport(state);
    document.getElementById("aluraRevisorClose").onclick = () => overlay.remove();
  }

  function showDownloadFinalPopup(state) {
    const { modal, overlay } = createOverlayModal("620px");
    const downloaded = state.downloadedVideos || [];
    const courseId = state.courseId || "curso";
    const title = `Download finalizado: ${downloaded.length} vídeo(s)`;

    const listHtml =
      downloaded.length > 0
        ? `<ul style="margin:10px 0 0 18px; padding:0; color:#333; font-size:13px; line-height:1.7;">
            ${downloaded.map((v) => `<li>${v.filename}</li>`).join("")}
           </ul>`
        : `<p style="color:#666; margin-top:10px;">Nenhum vídeo encontrado no curso.</p>`;

    modal.innerHTML = `
      <h2 style="margin:0 0 12px; font-size:18px; font-weight:700; color:#1c1c1c;">${title}</h2>
      <p style="margin:0 0 6px; font-size:14px; color:#555;">
        Arquivos salvos em: <strong>Downloads/${courseId}/</strong>
      </p>
      ${listHtml}
      <div style="display:flex; justify-content:flex-end; margin-top:18px;">
        <button id="aluraRevisorClose" style="padding:9px 18px; border:0; border-radius:8px; cursor:pointer; background:#1c1c1c; color:#fff; font-size:14px; font-weight:600;">Fechar</button>
      </div>
    `;

    document.getElementById("aluraRevisorClose").onclick = () => overlay.remove();
  }

  function showUploadFinalPopup(state) {
    const { modal, overlay } = createOverlayModal("620px");
    const uploaded = state.uploadedVideos || [];
    const courseId = state.courseId || "curso";
    const queued = uploaded.filter(v => !v.skipped).length;
    const skipped = uploaded.filter(v => v.skipped).length;
    const title = `Upload enfileirado: ${queued} vídeo(s)` + (skipped > 0 ? ` · ${skipped} pulado(s) ⚠️` : "");

    const listHtml =
      uploaded.length > 0
        ? `<ul style="margin:10px 0 0 18px; padding:0; color:#333; font-size:13px; line-height:1.7;">
            ${uploaded.map((v) => v.skipped
              ? `<li>⚠️ ${v.filename} <span style="color:#999;">(URL do vídeo não capturável)</span></li>`
              : `<li>⏳ ${v.filename}</li>`
            ).join("")}
           </ul>`
        : `<p style="color:#666; margin-top:10px;">Nenhum vídeo encontrado no curso.</p>`;

    modal.innerHTML = `
      <h2 style="margin:0 0 12px; font-size:18px; font-weight:700; color:#1c1c1c;">${title}</h2>
      <p style="margin:0 0 6px; font-size:14px; color:#555;">
        Showcase: <strong>${courseId}</strong>
      </p>
      <p style="margin:0 0 10px; font-size:13px; color:#888;">
        Os uploads acontecem em background (uma aba por vídeo). Verifique o video-uploader quando concluir.
      </p>
      ${listHtml}
      <div style="display:flex; justify-content:flex-end; margin-top:18px;">
        <button id="aluraRevisorClose" style="padding:9px 18px; border:0; border-radius:8px; cursor:pointer; background:#1c1c1c; color:#fff; font-size:14px; font-weight:600;">Fechar</button>
      </div>
    `;
    document.getElementById("aluraRevisorClose").onclick = () => overlay.remove();
  }

  async function startUploadMode() {
    const { aluraRevisorUploaderToken } = await new Promise(resolve =>
      chrome.storage.local.get(["aluraRevisorUploaderToken"], resolve)
    );
    if (!aluraRevisorUploaderToken) {
      alert("Token não configurado. Vá em Ferramentas → Token video-uploader e salve o token antes de subir vídeos.");
      return;
    }

    await waitFor(() => isCourseListLoaded(), 10000);

    if (isCourseListLoaded() && !getFirstLessonHref()) {
      showNoLessonsAlert();
      return;
    }

    const courseId = await resolveCourseId();
    const courseSectionMap = buildCourseSectionMap();

    // Pre-fetch mapa sectionIdx-videoIdx → editUrl para atualizar admin depois
    const videoTaskMap = {};
    try {
      const sectionsResp = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: "ALURA_REVISOR_GET_SECTIONS", courseId }, resolve)
      );
      const activeSections = (sectionsResp?.sections || []).filter(s => s.active);
      for (let si = 0; si < activeSections.length; si++) {
        const section = activeSections[si];
        const sectionIdx = si + 1;
        const tasksResp = await new Promise(resolve =>
          chrome.runtime.sendMessage({ type: "ALURA_REVISOR_GET_SECTION_TASKS", courseId, sectionId: section.id }, resolve)
        );
        let videoCount = 0;
        for (const task of (tasksResp?.tasks || [])) {
          if (task.type === "Vídeo" && task.editUrl) {
            videoCount++;
            videoTaskMap[`${sectionIdx}-${videoCount}`] = task.editUrl;
          }
        }
      }
    } catch {}

    const firstHref = await waitFor(() => getFirstLessonHref(), 20000);
    if (!firstHref) {
      const st = {
        running: false,
        mode: "upload",
        courseId: courseId || null,
        uploadedVideos: [],
        error: "Não encontrei a primeira aula na lista.",
      };
      await setState(st);
      showUploadFinalPopup(st);
      return;
    }

    const state = {
      running: true,
      finished: false,
      startedAt: Date.now(),
      mode: "upload",

      courseId: courseId || null,
      courseSectionMap,
      videoTaskMap,
      videoCountPerSection: {},
      uploadedVideos: [],

      steps: 0,
      enteredTask: false,
      homeBaseUrl: normalizeUrlBase(window.location.href),
      firstTaskAttemptedAt: Date.now(),
      expectedFirstTaskHref: firstHref,
      error: null,
    };

    await setState(state);
    window.location.assign(firstHref);
  }

  async function startDownloadMode() {
    await waitFor(() => isCourseListLoaded(), 10000);

    if (isCourseListLoaded() && !getFirstLessonHref()) {
      showNoLessonsAlert();
      return;
    }

    const courseId = await resolveCourseId();
    const courseSectionMap = buildCourseSectionMap();

    const firstHref = await waitFor(() => getFirstLessonHref(), 20000);
    if (!firstHref) {
      const st = {
        running: false,
        mode: "download",
        courseId: courseId || null,
        downloadedVideos: [],
        error: "Não encontrei a primeira aula na lista."
      };
      await setState(st);
      showDownloadFinalPopup(st);
      return;
    }

    const state = {
      running: true,
      finished: false,
      startedAt: Date.now(),
      mode: "download",

      courseId: courseId || null,
      courseSectionMap,
      videoCountPerSection: {},
      downloadedVideos: [],

      steps: 0,
      enteredTask: false,
      homeBaseUrl: normalizeUrlBase(window.location.href),
      firstTaskAttemptedAt: Date.now(),
      expectedFirstTaskHref: firstHref,
      error: null,
    };

    await setState(state);
    window.location.assign(firstHref);
  }

  async function finalize(state, error = null) {
    // Modo upload: finalização simplificada
    if (state.mode === "upload") {
      state.running = false;
      state.finished = !error;
      state.error = error || null;
      await setState(state);
      showUploadFinalPopup(state);
      return;
    }

    // Modo download: finalização simplificada
    if (state.mode === "download") {
      state.running = false;
      state.finished = !error;
      state.error = error || null;
      await setState(state);
      showDownloadFinalPopup(state);
      return;
    }

    // Verificação de ícone adiada: curso foi adicionado ao catálogo durante a revisão.
    // A home recarregou, então o breadcrumb agora deve exibir a categoria.
    if (state.pendingIconCheck && state.courseSlug && isHomePage()) {
      const categorySlug = getCategorySlugFromBreadcrumb();
      const iconSlug = isCheckpointCourse(state.courseSlug) ? "checkpoint" : categorySlug;
      if (iconSlug) {
        const iconResult = await checkIcon(state.courseSlug);
        if (iconResult.exists) {
          state.iconStatus = "exists";
        } else if (iconResult.notFound) {
          const wantsUpload = await askUploadIcon(iconSlug);
          if (wantsUpload) {
            const iconWaitOverlay = showIconWaiting();
            const uploaded = await uploadIcon(iconSlug, state.courseSlug);
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

  // ---------- Admin review helpers ----------
  async function getAdminSections(courseId) {
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_GET_SECTIONS", courseId }, (resp) => {
        if (!resp?.ok) return reject(new Error(resp?.error || "Falha ao buscar seções."));
        resolve(resp.sections || []);
      });
    });
  }

  async function getAdminSectionTasks(courseId, sectionId) {
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_GET_SECTION_TASKS", courseId, sectionId }, (resp) => {
        if (!resp?.ok) return reject(new Error(resp?.error || "Falha ao buscar atividades."));
        resolve({ tasks: resp.tasks || [], reordered: resp.reordered || false });
      });
    });
  }

  async function getAdminTaskContent(editUrl) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_GET_TASK_CONTENT", editUrl }, (resp) => {
        resolve({ videoUrl: resp?.videoUrl ?? null, htmlContents: resp?.htmlContents || [], transcriptionText: resp?.transcriptionText ?? "" });
      });
    });
  }

  function isInvalidTextField(value, courseName) {
    if (!value) return "está em branco";
    if (value === ".") return "contém apenas um ponto final";
    if (value === courseName) return "contém apenas o nome do curso";
    return null;
  }

  function loadVideoDuration(activityUrl) {
    chrome.runtime.sendMessage({ type: "ALURA_REVISOR_LOAD_VIDEO_DURATION", activityUrl });
  }

  // ---------- Revisão via admin ----------
  async function processSectionTasks(courseId, section, si, totalSections, state, updateProgress) {
    const sectionErrors = [];

    updateProgress(si, totalSections, section, null, null, null);

    let tasks;
    try {
      const result = await getAdminSectionTasks(courseId, section.id);
      tasks = result.tasks;
      if (result.reordered) state.issues.reorderedSections.push(section.title);
    } catch (e) {
      sectionErrors.push(`Erro ao buscar atividades da seção "${section.title}": ${e.message}`);
      return sectionErrors;
    }

    for (let ti = 0; ti < tasks.length; ti++) {
      const task = tasks[ti];
      updateProgress(si, totalSections, section, ti, tasks.length, task);

      const { videoUrl, htmlContents, transcriptionText } = await getAdminTaskContent(task.editUrl);

      // Verifica URL e transcrição para atividades de vídeo.
      // transcriptionText é lido após polling em background.js, que aguarda o EasyMDE
      // e o AJAX da página terminarem — evita falso positivo por leitura precoce.
      if (task.type === "Vídeo") {
        const hasUrl = videoUrl && videoUrl.trim() !== "0" && videoUrl.trim() !== "";
        const hasTranscription = (transcriptionText || "").replace(/\s+/g, "").length > 50;

        if (hasUrl && !hasTranscription) {
          addIssue(state, "missingTranscription", task.editUrl);
        }

        if (hasUrl && task.activityUrl) {
          loadVideoDuration(task.activityUrl);
        }
      }

      // Checks de links em todo o conteúdo HTML da atividade
      const allLinks = [];
      for (const html of htmlContents) {
        const root = parseHtmlContent(html);

        const emptyCheck = collectEmptyHrefLinksInCurrentTask(root);
        if (emptyCheck.hasIssue) addIssue(state, "emptyHref", task.editUrl);

        const ghCheck = collectNonStandardGithubLinksInCurrentTask(root);
        if (ghCheck.hasIssue) addIssueDetails(state, "githubNonStandard", task.editUrl, ghCheck.links);

        const cloudCheck = collectNonOfficialCloudLinksInCurrentTask(root);
        if (cloudCheck.hasIssue) addIssueDetails(state, "nonOfficialCloud", task.editUrl, cloudCheck.links);

        allLinks.push(...collectAllHttpLinksInCurrentTask(root));
      }

      if (allLinks.length > 0) {
        const bad404 = await check404ViaBackground(Array.from(new Set(allLinks)));
        if (bad404.length > 0) addIssueDetails(state, "link404", task.editUrl, bad404);
      }
    }

    return sectionErrors;
  }

  async function reviewViaAdmin(courseId, state) {
    let progressOverlay = null;

    try {
      // Verificação dos campos do admin de vendas
      const adminFields = await getAdminFields(courseId);
      if (adminFields) {
        const { courseName, metaTitle, estimatedHours, systemEstimatedHours,
                metaDescription, targetPublic, highlightedInformation, ementa } = adminFields;

        const expectedTitle = `${courseName} | Alura`;
        if (metaTitle !== expectedTitle) {
          state.issues.adminFields.push(`Meta Title incorreto. Correto: "${expectedTitle}"`);
        }

        if (systemEstimatedHours && Math.abs(estimatedHours - systemEstimatedHours) > 2) {
          state.issues.adminFields.push(`Carga horária incorreta. Correto: ${systemEstimatedHours} horas (tolerância de ±2h)`);
        }

        const textFields = [
          { value: metaDescription,        label: "Meta Description" },
          { value: targetPublic,           label: "Público-alvo" },
          { value: highlightedInformation, label: "Faça esse curso e..." },
          { value: ementa,                 label: "Ementa" }
        ];

        for (const { value, label } of textFields) {
          const reason = isInvalidTextField(value, courseName);
          if (reason) state.issues.adminFields.push(`${label} ${reason} — é obrigatório ser preenchido corretamente.`);
        }
      }

      const sections = await getAdminSections(courseId);
      const activeSections = sections.filter(s => s.active);

      if (activeSections.length === 0) {
        state.error = "Nenhuma seção ativa encontrada no curso.";
        return state;
      }

      // Overlay criado após saber o total de seções para renderizar uma linha por seção
      progressOverlay = showAdminReviewProgress(activeSections.length);

      const sectionErrorsNested = await runWithConcurrency(
        activeSections,
        (section, si) => processSectionTasks(
          courseId, section, si, activeSections.length, state, updateAdminReviewProgress
        ),
        SECTION_CONCURRENCY
      );

      const allErrors = sectionErrorsNested.flat().filter(Boolean);
      if (allErrors.length > 0) state.error = allErrors.join(" | ");

    } catch (e) {
      state.error = state.error || e?.message || String(e);
    } finally {
      progressOverlay?.remove();
    }

    return state;
  }

  // ---------- Fluxo principal ----------
  async function startFromHome() {
    await waitFor(() => isHomePage(), 20000);

    const t = await readTranscriptionStableParsed();
    let hasSubcategory = hasSubcategoryBreadcrumb();

    const courseId = await resolveCourseId();

    if (!courseId) {
      showFinalPopup({
        running: false,
        finished: false,
        transcriptionRawText: t.rawText,
        transcriptionIs100: t.is100,
        transcriptionPercentNumber: t.percentNumber,
        hasSubcategory,
        catalogOk: false,
        catalogCode: null,
        courseId: null,
        iconStatus: null,
        categorySlug: null,
        courseSlug: null,
        pendingIconCheck: false,
        issues: { emptyHref: [], githubNonStandard: {}, nonOfficialCloud: {}, link404: {}, missingTranscription: [], adminFields: [], reorderedSections: [] },
        error: "Não foi possível obter o ID do curso."
      });
      return;
    }

    let catalogOk = false;
    let catalogCode = null;
    let addedToCatalog = false;

    catalogOk = await checkCatalog(courseId);
    catalogCode = catalogOk ? "ok" : "not_in_catalog";

    if (!catalogOk) {
      const catalogs = await getCatalogs(courseId);
      const chosenLabel = await askSelectCatalog(catalogs);
      if (chosenLabel) {
        const waitingOverlay = showCatalogWaiting(chosenLabel);
        const added = await addToCatalog(courseId, chosenLabel);
        waitingOverlay.remove();
        if (added) {
          catalogOk = true;
          catalogCode = chosenLabel;
          addedToCatalog = true;
          const recheck = await fetchSubcategoryCheck();
          if (recheck !== null) hasSubcategory = recheck;
        }
      }
    }

    // ---------- Subcategoria ----------
    let addedToSubcategory = false;
    if (!hasSubcategory) {
      const subs = await getSubcategories();
      if (subs.length > 0) {
        const chosenSub = await askSelectSubcategory(subs);
        if (chosenSub) {
          const waitingOverlay = showSubcategoryWaiting(chosenSub.name);
          const added = await addToSubcategory(chosenSub.id, courseId);
          waitingOverlay.remove();
          if (added) {
            hasSubcategory = true;
            addedToSubcategory = true;
            const recheck = await fetchSubcategoryCheck();
            if (recheck !== null) hasSubcategory = recheck;
          }
        }
      }
    }

    // ---------- Ícone ----------
    let categorySlug = getCategorySlugFromBreadcrumb();
    const courseSlug = getCourseSlugFromUrl();

    // Se acabou de adicionar ao catálogo ou subcategoria, o breadcrumb do DOM ainda não atualizou.
    // Busca o slug via fetch do servidor para não precisar recarregar a página.
    if (!categorySlug && (addedToCatalog || addedToSubcategory)) {
      categorySlug = await fetchCategorySlug();
    }

    const iconSlug = isCheckpointCourse(courseSlug) ? "checkpoint" : categorySlug;
    let iconStatus = null;
    let pendingIconCheck = false;

    if (courseSlug) {
      if (iconSlug) {
        // Categoria visível (ou curso checkpoint detectado pelo slug) — verifica/sobe ícone agora
        const iconResult = await checkIcon(courseSlug);
        if (iconResult.exists) {
          iconStatus = "exists";
        } else if (iconResult.notFound) {
          // Ícone definitivamente não existe (404) — perguntar ao usuário
          const wantsUpload = await askUploadIcon(iconSlug);
          if (wantsUpload) {
            const iconWaitOverlay = showIconWaiting();
            const uploaded = await uploadIcon(iconSlug, courseSlug);
            iconWaitOverlay.remove();
            iconStatus = uploaded ? "uploaded" : "error";
          } else {
            iconStatus = "skipped";
          }
        }
        // Se notFound=false (erro de auth/rede), iconStatus fica null — pula silenciosamente
      }
      // else: sem categoria e não foi adicionado ao catálogo → não é possível subir ícone
    }

    // ---------- Revisão via admin ----------
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
      courseId,
      iconStatus,
      categorySlug: categorySlug || null,
      courseSlug: courseSlug || null,
      pendingIconCheck,
      issues: { emptyHref: [], githubNonStandard: {}, nonOfficialCloud: {}, link404: {}, missingTranscription: [], adminFields: [], reorderedSections: [] },
      error: null
    };

    await setState(state);
    const finalState = await reviewViaAdmin(courseId, state);

    // LATAM não tem % de transcrição no home — deriva do resultado da revisão admin
    if (window.location.origin === "https://app.aluracursos.com") {
      finalState.transcriptionIs100 = finalState.issues.missingTranscription.length === 0;
    }

    await finalize(finalState, finalState.error || null);
  }

  // ---------- Tick central ----------
  async function tick() {
    const state = await getState();
    if (!state?.running) return;

    // Modo download: navegação página a página para extrair src dos vídeos
    if (state.mode === "download") {
      if (isFirstTaskInactiveCase(state)) {
        await finalize(state, ERROR_FIRST_TASK_INACTIVE);
        return;
      }

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
          () => document.querySelector(".task-body") || document.querySelector("#task-content"),
          15000
        );

        const hasVideo = await waitFor(() => isVideoTask() || null, 300);
        if (hasVideo) {
          const videoSrc = await waitForVideoSrc(10000);
          if (videoSrc) {
            const { sectionFromTitle, activityTitle } = parseActivityFromTitle();
            const mapSectionIdx = (state.courseSectionMap || {})[normalizeUrlBase(window.location.href)];
            const sectionIdx = mapSectionIdx || sectionFromTitle || 1;

            state.videoCountPerSection = state.videoCountPerSection || {};
            state.videoCountPerSection[sectionIdx] = (state.videoCountPerSection[sectionIdx] || 0) + 1;
            const videoIdx = state.videoCountPerSection[sectionIdx];

            const filename = buildVideoFilename(state.courseId || "curso", sectionIdx, videoIdx, activityTitle);
            const folderFilename = `${state.courseId || "curso"}/${filename}`;

            chrome.runtime.sendMessage({
              type: "ALURA_REVISOR_DOWNLOAD_VIDEO",
              url: videoSrc,
              filename: folderFilename,
            });

            state.downloadedVideos = state.downloadedVideos || [];
            state.downloadedVideos.push({ pageUrl: window.location.href, filename, sectionIdx, videoIdx });
            await setState(state);
          }
        }

        const next = await waitFor(() => findNextActivityLink(), 5000);
        if (!next) {
          await finalize(state, null);
          return;
        }
        state.steps = (state.steps || 0) + 1;
        await setState(state);
        window.location.assign(next.href);
      }
      return;
    }

    // Modo upload: navegação página a página com upload direto para o video-uploader
    if (state.mode === "upload") {
      if (isFirstTaskInactiveCase(state)) {
        await finalize(state, ERROR_FIRST_TASK_INACTIVE);
        return;
      }

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
          () => document.querySelector(".task-body") || document.querySelector("#task-content"),
          15000
        );

        const hasVideo = await waitFor(() => isVideoTask() || null, 1000);
        if (hasVideo) {
          const { sectionFromTitle, activityTitle } = parseActivityFromTitle();
          const mapSectionIdx = (state.courseSectionMap || {})[normalizeUrlBase(window.location.href)];
          const sectionIdx = mapSectionIdx || sectionFromTitle || 1;

          state.videoCountPerSection = state.videoCountPerSection || {};
          state.videoCountPerSection[sectionIdx] = (state.videoCountPerSection[sectionIdx] || 0) + 1;
          const videoIdx = state.videoCountPerSection[sectionIdx];

          const filename = buildVideoFilename(state.courseId || "curso", sectionIdx, videoIdx, activityTitle);
          const editUrl = (state.videoTaskMap || {})[`${sectionIdx}-${videoIdx}`] || null;

          const videoSrc = await waitForVideoSrc(10000);
          if (videoSrc) {
            // Fire-and-forget: não bloqueia a navegação
            chrome.runtime.sendMessage({
              type: "ALURA_REVISOR_UPLOAD_VIDEO",
              url: videoSrc,
              filename,
              courseId: state.courseId,
              editUrl,
            });

            state.uploadedVideos = state.uploadedVideos || [];
            state.uploadedVideos.push({
              pageUrl: window.location.href,
              filename,
              sectionIdx,
              videoIdx,
              editUrl,
              queued: true,
            });
          } else {
            state.uploadedVideos = state.uploadedVideos || [];
            state.uploadedVideos.push({
              pageUrl: window.location.href,
              filename,
              sectionIdx,
              videoIdx,
              editUrl,
              queued: false,
              skipped: true,
            });
          }
          await setState(state);
        }

        const next = await waitFor(() => findNextActivityLink(), 5000);
        if (!next) {
          await finalize(state, null);
          return;
        }
        state.steps = (state.steps || 0) + 1;
        await setState(state);
        window.location.assign(next.href);
      }
      return;
    }

    // Modo revisão: só trata reload inesperado
    await finalize(state, "Revisão interrompida por reload da página.");
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

  // ---------- Revisão de transcrição ----------
  async function getVideoName(sequence) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "ALURA_REVISOR_GET_VIDEO_NAME", sequence }, (resp) => {
        resolve(resp?.videoName ?? "");
      });
    });
  }

  async function checkVideoSubtitles(activityUrl) {
    return await new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: "ALURA_REVISOR_CHECK_VIDEO_SUBTITLES", activityUrl },
        resp => resolve({ hasEspanhol: resp?.hasEspanhol ?? false, hasPortugues: resp?.hasPortugues ?? false })
      );
    });
  }

  async function auditCourseTranscription(courseId, checks) {
    const sections = await getAdminSections(courseId);
    const results = [];

    for (const section of sections.filter(s => s.active)) {
      const { tasks } = await getAdminSectionTasks(courseId, section.id);

      for (const task of tasks) {
        if (task.type !== "Vídeo") continue;

        const { videoUrl, transcriptionText } = await getAdminTaskContent(task.editUrl);
        const hasUrl = videoUrl && videoUrl.trim() !== "0" && videoUrl.trim() !== "";
        if (!hasUrl) continue;

        const hasTranscription = (transcriptionText || "").replace(/\s+/g, "").length > 50;

        let hasEspanhol = true, hasPortugues = true;
        if ((checks.pt || checks.esp) && task.activityUrl) {
          const sub = await checkVideoSubtitles(task.activityUrl);
          if (checks.esp) hasEspanhol = sub.hasEspanhol;
          if (checks.pt) hasPortugues = sub.hasPortugues;
        }

        const failed = (checks.transcription && !hasTranscription)
          || (checks.esp && !hasEspanhol)
          || (checks.pt && !hasPortugues);
        if (failed) {
          const taskId = task.editUrl.match(/\/task\/edit\/(\d+)/)?.[1] ?? "";
          let videoName;
          if (videoUrl.includes("player.vimeo.com")) {
            videoName = "vídeo no vimeo";
          } else {
            const sequence = videoUrl.includes("/") ? videoUrl.split("/")[1] : videoUrl;
            videoName = await getVideoName(sequence);
          }
          results.push({ taskId, title: task.title, videoName, hasTranscription, hasEspanhol, hasPortugues, checks });
        }
      }
    }

    return results;
  }

  async function runBatchTranscriptionAudit(courseIds, checks) {
    const { modal, overlay } = createOverlayModal("420px");
    const titleEl = document.createElement("h3");
    titleEl.style.cssText = "margin:0 0 14px;font-weight:700;font-size:16px;";
    titleEl.textContent = "Auditoria em lote";
    modal.appendChild(titleEl);
    const progressEl = document.createElement("p");
    progressEl.style.cssText = "margin:0;font-size:14px;color:#555;";
    modal.appendChild(progressEl);

    const allResults = [];

    for (let i = 0; i < courseIds.length; i++) {
      const courseId = courseIds[i];
      progressEl.textContent = `Curso ${i + 1}/${courseIds.length} — ID: ${courseId}…`;
      try {
        const results = await auditCourseTranscription(courseId, checks);
        for (const r of results) allResults.push({ courseId, ...r });
      } catch (e) {
        allResults.push({ courseId, taskId: "", videoUrl: "", videoName: `Erro: ${e?.message || String(e)}` });
      }
    }

    overlay.remove();
    showBatchTranscriptionReport(allResults, courseIds.length, courseIds);
  }

  function showBatchTranscriptionReport(allResults, totalCourses, courseIds, opts = {}) {
    const persistHistory = opts.persistHistory !== false;
    const { modal, overlay } = createOverlayModal("660px");

    // ---------- Título ----------
    const title = document.createElement("h3");
    title.style.cssText = "margin:0 0 16px 0;color:#1c1c1c;font-weight:700;font-size:16px;";
    title.textContent = allResults.length === 0
      ? `Auditoria em lote: Tudo OK ✅ (${totalCourses} curso(s))`
      : `Auditoria em lote: ${allResults.length} vídeo(s) com pendências ⚠️`;
    modal.appendChild(title);

    // Agrupar resultados por courseId (usado em resumo e detalhado)
    const byCourse = {};
    for (const r of allResults) {
      if (!byCourse[r.courseId]) byCourse[r.courseId] = [];
      byCourse[r.courseId].push(r);
    }

    // Cursos sem nenhuma pendência
    const allCourseIds = courseIds || Object.keys(byCourse);
    const coursesWithIssues = new Set(Object.keys(byCourse));
    const coursesOk = allCourseIds.filter(id => !coursesWithIssues.has(String(id)));

    // Datas para cabeçalho do texto
    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2,"0")}/${String(now.getMonth()+1).padStart(2,"0")}/${now.getFullYear()} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

    let reportText = `Auditoria em lote — ${dateStr}\n`;

    const scrollBox = document.createElement("div");
    scrollBox.style.cssText = "max-height:460px;overflow-y:auto;margin-bottom:16px;";

    if (allResults.length === 0) {
      const p = document.createElement("p");
      p.style.cssText = "margin:0 0 20px 0;font-size:14px;color:#555;";
      p.textContent = `Todos os ${totalCourses} curso(s) auditados estão com transcrição e legendas completas.`;
      scrollBox.appendChild(p);
      reportText += `\nTodos os ${totalCourses} curso(s) estão OK.\n`;
    } else {
      // ── Resumo ────────────────────────────────────────────
      const resumoTitle = document.createElement("div");
      resumoTitle.style.cssText = "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#aaa;margin-bottom:10px;";
      resumoTitle.textContent = "Resumo";
      scrollBox.appendChild(resumoTitle);

      reportText += `\n=== RESUMO ===\n`;

      // Cursos sem transcrição
      const semTranscricao = Object.entries(byCourse)
        .map(([id, items]) => ({ id, count: items.filter(v => v.checks?.transcription !== false && !v.hasTranscription).length }))
        .filter(x => x.count > 0);

      if (semTranscricao.length > 0) {
        const block = document.createElement("div");
        block.style.cssText = "margin-bottom:12px;";
        const lbl = document.createElement("div");
        lbl.style.cssText = "font-size:12px;font-weight:700;color:#1c1c1c;margin-bottom:4px;";
        lbl.textContent = "Sem transcrição:";
        block.appendChild(lbl);
        reportText += `\nSem transcrição:\n`;
        semTranscricao.forEach(({ id, count }) => {
          const row = document.createElement("div");
          row.style.cssText = "font-size:12px;color:#555;padding:2px 0 2px 12px;";
          row.textContent = `• Curso ${id} — ${count} vídeo${count > 1 ? "s" : ""}`;
          block.appendChild(row);
          reportText += `  • Curso ${id} — ${count} vídeo${count > 1 ? "s" : ""}\n`;
        });
        scrollBox.appendChild(block);
      }

      // Cursos com legendas incompletas
      const semLegendas = Object.entries(byCourse)
        .map(([id, items]) => ({
          id,
          count: items.filter(v => (v.checks?.esp !== false && !v.hasEspanhol) || (v.checks?.pt !== false && !v.hasPortugues)).length
        }))
        .filter(x => x.count > 0);

      if (semLegendas.length > 0) {
        const block = document.createElement("div");
        block.style.cssText = "margin-bottom:12px;";
        const lbl = document.createElement("div");
        lbl.style.cssText = "font-size:12px;font-weight:700;color:#1c1c1c;margin-bottom:4px;";
        lbl.textContent = "Legendas incompletas:";
        block.appendChild(lbl);
        reportText += `\nLegedas incompletas:\n`;
        semLegendas.forEach(({ id, count }) => {
          const row = document.createElement("div");
          row.style.cssText = "font-size:12px;color:#555;padding:2px 0 2px 12px;";
          row.textContent = `• Curso ${id} — ${count} vídeo${count > 1 ? "s" : ""}`;
          block.appendChild(row);
          reportText += `  • Curso ${id} — ${count} vídeo${count > 1 ? "s" : ""}\n`;
        });
        scrollBox.appendChild(block);
      }

      // Cursos OK
      if (coursesOk.length > 0) {
        const block = document.createElement("div");
        block.style.cssText = "margin-bottom:16px;";
        const lbl = document.createElement("div");
        lbl.style.cssText = "font-size:12px;font-weight:700;color:#1c1c1c;margin-bottom:4px;";
        lbl.textContent = "Cursos 100% corretos:";
        block.appendChild(lbl);
        const row = document.createElement("div");
        row.style.cssText = "font-size:12px;color:#00a857;padding:2px 0 2px 12px;";
        row.textContent = coursesOk.map(id => `Curso ${id} ✅`).join("   ");
        block.appendChild(row);
        scrollBox.appendChild(block);
        reportText += `\nCursos 100% corretos:\n  ${coursesOk.map(id => `Curso ${id}`).join(", ")}\n`;
      }

      // ── Divisor ───────────────────────────────────────────
      const hr = document.createElement("hr");
      hr.style.cssText = "border:none;border-top:1px solid #e0e0e0;margin:8px 0 14px;";
      scrollBox.appendChild(hr);

      // ── Detalhado ─────────────────────────────────────────
      const detalhadoTitle = document.createElement("div");
      detalhadoTitle.style.cssText = "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#aaa;margin-bottom:10px;";
      detalhadoTitle.textContent = "Detalhado";
      scrollBox.appendChild(detalhadoTitle);

      reportText += `\n=== DETALHADO ===\n`;

      for (const [courseId, items] of Object.entries(byCourse)) {
        reportText += `\nCurso ${courseId} (${items.length} vídeo${items.length > 1 ? "s" : ""}):\n`;

        const header = document.createElement("div");
        header.style.cssText = "font-weight:700;font-size:13px;margin:12px 0 6px;color:#1c1c1c;";
        header.textContent = `Curso ${courseId} (${items.length} vídeo${items.length > 1 ? "s" : ""})`;
        scrollBox.appendChild(header);

        items.forEach((item, i) => {
          const st = (ok) => ok ? "✅" : "❌";
          const c = item.checks || { transcription: true, pt: true, esp: true };
          let textLine = `${i + 1}. ${item.title || item.videoName} (ID: ${item.taskId})\n`;
          if (c.transcription) textLine += `   Transcrição: ${item.hasTranscription ? "OK" : "Falta"}\n`;
          if (c.esp) textLine += `   Legendas ESP: ${item.hasEspanhol ? "OK" : "Falta"}\n`;
          if (c.pt) textLine += `   Legendas PT: ${item.hasPortugues ? "OK" : "Falta"}\n`;
          reportText += textLine;

          let statusHtml = "";
          if (c.transcription) statusHtml += `${st(item.hasTranscription)} Transcrição &nbsp; `;
          if (c.esp) statusHtml += `${st(item.hasEspanhol)} Legendas ESP &nbsp; `;
          if (c.pt) statusHtml += `${st(item.hasPortugues)} Legendas PT`;

          const entry = document.createElement("div");
          entry.style.cssText = "padding:8px 10px;margin-bottom:6px;background:#f9f9f9;border-radius:8px;font-size:12px;line-height:1.6;border:1px solid #eee;";
          entry.innerHTML = `<strong>${item.title || item.videoName}</strong> <span style="color:#888">(ID: ${item.taskId})</span><br>${statusHtml}`;
          scrollBox.appendChild(entry);
        });
      }
    }

    modal.appendChild(scrollBox);

    // ---------- Botões ----------
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";

    if (allResults.length > 0 || coursesOk.length > 0) {
      const copyBtn = document.createElement("button");
      copyBtn.style.cssText = "padding:9px 18px;border:0;border-radius:8px;cursor:pointer;background:#00c86f;color:#fff;font-size:13px;font-weight:600;font-family:inherit;";
      copyBtn.textContent = "Copiar";
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(reportText.trim()).then(() => {
          copyBtn.textContent = "Copiado!";
          setTimeout(() => { copyBtn.textContent = "Copiar"; }, 1500);
        });
      };
      btnRow.appendChild(copyBtn);

      const dlBtn = document.createElement("button");
      dlBtn.style.cssText = "padding:9px 18px;border:1.5px solid #ddd;border-radius:8px;cursor:pointer;background:#fff;color:#1c1c1c;font-size:13px;font-weight:600;font-family:inherit;";
      dlBtn.textContent = "Baixar .txt";
      dlBtn.onclick = () => {
        const blob = new Blob([reportText.trim()], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `auditoria-lote-${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      };
      btnRow.appendChild(dlBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.style.cssText = "padding:9px 18px;border:1.5px solid #ddd;border-radius:8px;cursor:pointer;background:#fff;color:#1c1c1c;font-size:13px;font-weight:600;font-family:inherit;";
    closeBtn.textContent = "Fechar";
    closeBtn.onclick = () => overlay.remove();
    btnRow.appendChild(closeBtn);

    modal.appendChild(btnRow);

    // ---------- Salvar no histórico ----------
    if (persistHistory) {
      saveToHistory({
        type: "batchAudit",
        runAt: Date.now(),
        courseIds: allCourseIds,
        totalCourses,
        ok: allResults.length === 0,
        batchResults: allResults,
      });
    }
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

  // ---------- Start download via popup ----------
  let startingDownload = false;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_START_DOWNLOAD") return;

    (async () => {
      try {
        if (startingDownload) return sendResponse({ ok: false, error: "Já estou iniciando um download." });
        startingDownload = true;

        await clearState();
        if (!isHomePage()) return sendResponse({ ok: false, error: "Abra a Home do curso antes de iniciar o download." });

        sendResponse({ ok: true });
        await startDownloadMode();
        startHeartbeat();
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      } finally {
        startingDownload = false;
      }
    })();

    return true;
  });

  // ---------- Start upload via popup ----------
  let startingUpload = false;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_START_UPLOAD") return;

    (async () => {
      try {
        if (startingUpload) return sendResponse({ ok: false, error: "Já estou iniciando um upload." });
        startingUpload = true;

        await clearState();
        if (!isHomePage()) return sendResponse({ ok: false, error: "Abra a Home do curso antes de iniciar o upload." });

        sendResponse({ ok: true });
        await startUploadMode();
        startHeartbeat();
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      } finally {
        startingUpload = false;
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

  // ---------- Batch transcription audit via popup ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_BATCH_TRANSCRIPTION_AUDIT") return;
    sendResponse({ ok: true });
    runBatchTranscriptionAudit(msg.courseIds || [], msg.checks || { transcription: true, pt: true, esp: true });
    return true;
  });

  // ---------- Reabrir relatório de auditoria em lote (histórico) ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_SHOW_BATCH_REPORT") return;
    showBatchTranscriptionReport(msg.allResults || [], msg.totalCourses, msg.courseIds, { persistHistory: false });
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
    if (st?.running) startHeartbeat();
  })();
})();