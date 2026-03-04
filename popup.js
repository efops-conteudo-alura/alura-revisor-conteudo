const KEY = "aluraRevisorRunState";
const KEY_HISTORY = "aluraRevisorHistory";

const statusEl = document.getElementById("status");
const btn = document.getElementById("start");
const historyEl = document.getElementById("history");

let isRunning = false;
let currentHistory = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function setRunningUI(running) {
  isRunning = running;
  btn.textContent = running ? "Parar revisão" : "Start revisão";
  btn.style.background = running ? "#c0392b" : "";
  btn.style.color = running ? "#fff" : "";
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

  const items = currentHistory.map((entry, i) => {
    const dateStr = formatDate(entry.runAt);
    const statusPart = entry.ok
      ? `<span class="hist-ok">Tudo OK</span>`
      : `<button class="hist-report" data-i="${i}">abrir relatório</button>`;
    return `<div class="hist-item"><span class="hist-id">${entry.courseId || "?"}</span> · ${dateStr} · ${statusPart}</div>`;
  });

  historyEl.innerHTML = `<div class="hist-title">Histórico</div>` + items.join("");

  historyEl.querySelectorAll(".hist-report").forEach((reportBtn) => {
    reportBtn.addEventListener("click", async () => {
      try {
        const i = Number(reportBtn.dataset.i);
        const entry = currentHistory[i];
        if (!entry) return;
        const tab = await getActiveTab();
        await chrome.tabs.sendMessage(tab.id, { type: "ALURA_REVISOR_SHOW_REPORT", state: entry.state });
      } catch (e) {
        setStatus(`Erro ao abrir relatório: ${e.message}`);
      }
    });
  });
}

// Sync button state and history on popup open
(async () => {
  const data = await chrome.storage.local.get([KEY, KEY_HISTORY]);
  const state = data?.[KEY];
  if (state?.running) {
    setRunningUI(true);
    setStatus("Rodando ✅\nO resultado final aparecerá como notificação do Chrome.");
  }
  renderHistory(data?.[KEY_HISTORY] || []);
})();

// Sync button and history when storage changes while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEY]) {
    const newValue = changes[KEY].newValue;
    setRunningUI(!!newValue?.running);
  }
  if (changes[KEY_HISTORY]) {
    renderHistory(changes[KEY_HISTORY].newValue || []);
  }
});

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
