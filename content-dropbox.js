// content-dropbox.js — injetado apenas em www.dropbox.com
// Lê os arquivos selecionados na listagem do Dropbox e extrai nomes de cursos Caixaverso.

// Padrão: "{Instrutor} - Gravação Caixaverso - {Tema} {DD-MM[-YY]}[ -pt{N}| -único| -unico].mp4"
const DROPBOX_FILE_REGEX = /^.+?-\s*Grava[cç][aã]o\s+Caixaverso\s*-\s*(.+?)\s*(?:-\s*(?:pt\d+|[uú]nico))?\s*\.mp4$/i;

function parseDropboxFilename(filename) {
  const m = filename.match(DROPBOX_FILE_REGEX);
  if (!m) return null;
  return m[1].trim(); // Ex: "Dados 20-03" ou "Dev C# 09-02-26"
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "ALURA_REVISOR_DROPBOX_GET_SELECTED") return;

  // Seletor primário (classes geradas pelo Dropbox — podem mudar com atualizações da plataforma)
  let selectedRows = document.querySelectorAll("._selectedRow_1y0q7_110");

  // Fallback: atributo ARIA
  if (selectedRows.length === 0) {
    selectedRows = document.querySelectorAll('[aria-selected="true"]');
  }

  const namesSeen = new Set();
  const files = [];
  for (const row of selectedRows) {
    // Seletor primário do nome do arquivo
    let nameEl = row.querySelector("._fileNameText_1y0q7_440");
    // Fallbacks alternativos
    if (!nameEl) nameEl = row.querySelector('[data-testid="file-name"]');
    if (!nameEl) nameEl = row.querySelector(".dig-ListCell-content");
    if (!nameEl) continue;

    const filename = nameEl.textContent.trim();
    const parsed = parseDropboxFilename(filename);
    if (!parsed || namesSeen.has(parsed)) continue;
    namesSeen.add(parsed);

    files.push({ name: parsed, filename });
  }

  sendResponse({ ok: true, names: files.map(f => f.name), total: selectedRows.length });
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "ALURA_REVISOR_DROPBOX_GET_SELECTED_FOR_UPLOAD") return;

  let selectedRows = document.querySelectorAll("._selectedRow_1y0q7_110");
  if (selectedRows.length === 0)
    selectedRows = document.querySelectorAll('[aria-selected="true"]');

  const files = [];
  for (const row of selectedRows) {
    let nameEl = row.querySelector("._fileNameText_1y0q7_440")
      || row.querySelector('[data-testid="file-name"]')
      || row.querySelector(".dig-ListCell-content");
    if (!nameEl) continue;
    const filename = nameEl.textContent.trim();
    if (!filename.toLowerCase().endsWith(".mp4")) continue;

    const linkEl = row.querySelector('a[href*="/preview/"]')
      || row.querySelector('a[href*="dropbox.com"]');
    const previewUrl = linkEl?.href || null;

    if (previewUrl) files.push({ filename, previewUrl });
  }

  sendResponse({ ok: true, files, total: selectedRows.length });
  return true;
});
