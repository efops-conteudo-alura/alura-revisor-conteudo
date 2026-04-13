// content-dropbox.js — injetado apenas em www.dropbox.com
// Lê os arquivos selecionados na listagem do Dropbox e extrai nomes de cursos Caixaverso.

// Padrão: "{Instrutor} - Gravação Caixaverso - {Tema} {DD-MM[-YY]}[ -pt{N}| -pt unica| -único| -unica].mp4"
const DROPBOX_FILE_REGEX = /^.+?-\s*Grava[cç][aã]o\s+Caixaverso\s*-\s*(.+?)\s*(?:[\s-]+(?:pt\s*(?:\d+|[uú]nic[ao])|[uú]nic[ao]))?\s*\.mp4$/i;

function parseDropboxFilename(filename) {
  const m = filename.match(DROPBOX_FILE_REGEX);
  if (!m) return null;
  return m[1].trim(); // Ex: "Dados 20-03" ou "Dev C# 09-02-26"
}

// Encontra o container com scroll que contém a listagem de arquivos
function findScrollContainer() {
  const row = document.querySelector("._selectedRow_1y0q7_110")
    || document.querySelector('[aria-selected="true"]');
  if (row) {
    let el = row.parentElement;
    while (el && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      const ov = style.overflowY || style.overflow;
      if ((ov === "auto" || ov === "scroll") && el.scrollHeight > el.clientHeight + 10) {
        return el;
      }
      el = el.parentElement;
    }
  }
  return document.documentElement;
}

// Coleta linhas selecionadas visíveis agora e extrai dados conforme o modo
function collectVisibleSelected(seenFilenames, seenParsedNames, forUpload) {
  let rows = [...document.querySelectorAll("._selectedRow_1y0q7_110")];
  if (rows.length === 0) rows = [...document.querySelectorAll('[aria-selected="true"]')];

  const results = [];
  for (const row of rows) {
    const nameEl = row.querySelector("._fileNameText_1y0q7_440")
      || row.querySelector('[data-testid="file-name"]')
      || row.querySelector(".dig-ListCell-content");
    if (!nameEl) continue;

    const filename = nameEl.textContent.trim();
    if (seenFilenames.has(filename)) continue;
    seenFilenames.add(filename);

    if (forUpload) {
      if (!filename.toLowerCase().endsWith(".mp4")) continue;
      const linkEl = row.querySelector('a[href*="/preview/"]')
        || row.querySelector('a[href*="dropbox.com"]');
      if (linkEl?.href) results.push({ filename, previewUrl: linkEl.href });
    } else {
      const parsed = parseDropboxFilename(filename);
      // Deduplica por nome parseado: pt1, pt2 do mesmo tema viram um único curso
      if (parsed && !seenParsedNames.has(parsed)) {
        seenParsedNames.add(parsed);
        results.push({ name: parsed, filename });
      }
    }
  }
  return results;
}

// Rola a lista do topo ao fim coletando todos os itens selecionados (virtual scroll)
async function scrollAndCollect(forUpload) {
  const container = findScrollContainer();
  const originalScroll = container.scrollTop;

  container.scrollTop = 0;
  await new Promise(r => setTimeout(r, 300));

  const seenFilenames = new Set();
  const seenParsedNames = new Set();
  const allResults = [];
  let prevScrollTop = -1;

  while (true) {
    const batch = collectVisibleSelected(seenFilenames, seenParsedNames, forUpload);
    allResults.push(...batch);

    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 5;
    if (atBottom || container.scrollTop === prevScrollTop) break;

    prevScrollTop = container.scrollTop;
    container.scrollTop += Math.max(container.clientHeight * 0.7, 200);
    await new Promise(r => setTimeout(r, 250));
  }

  container.scrollTop = originalScroll;
  return allResults;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "ALURA_REVISOR_DROPBOX_GET_SELECTED") return;

  scrollAndCollect(false).then(files => {
    sendResponse({ ok: true, names: files.map(f => f.name), total: files.length });
  });
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "ALURA_REVISOR_DROPBOX_GET_SELECTED_FOR_UPLOAD") return;

  scrollAndCollect(true).then(files => {
    sendResponse({ ok: true, files, total: files.length });
  });
  return true;
});
