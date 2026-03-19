async function getGithubToken() {
  const data = await chrome.storage.local.get(["aluraRevisorGithubToken"]);
  return data?.aluraRevisorGithubToken || "";
}

function isValidSender(sender) {
  const origin = sender?.url ? new URL(sender.url).origin : "";
  return origin === "https://cursos.alura.com.br" || origin === "https://app.aluracursos.com";
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_NOTIFY") return;

  const r = msg.result || {};
  const okAll = !!r.transcriptionIs100 && !!r.finished && !r.error;

  const title = okAll ? "Revisão finalizada ✅" : "Revisão finalizada ⚠️";

  const lines = [
    `${r.transcriptionIs100 ? "✅" : "❌"} Transcrição 100% (atual: ${r.transcriptionPercentText || "?"})`,
    `📌 Cliques em "Próxima atividade": ${typeof r.steps === "number" ? r.steps : "?"}`,
    r.finished ? "🏁 Chegou ao fim do curso (voltou pra Home)" : "⏸️ Execução interrompida"
  ];

  if (r.error) lines.push(`Erro: ${r.error}`);

  chrome.notifications.create({
    type: "basic",
    title,
    message: lines.join("\n")
  });

  sendResponse({ ok: true });
});

const LINK_CHECK_TIMEOUT_MS = 10000;
const CONCURRENCY = 8;

const SKIP_404_HOSTNAMES = new Set([
  "figma.com",
  "www.figma.com",
]);

function shouldSkip404Check(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SKIP_404_HOSTNAMES.has(host);
  } catch {
    return false;
  }
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = LINK_CHECK_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store"
    });
  } finally {
    clearTimeout(t);
  }
}

async function check404(url) {
  try {
    const res = await fetchWithTimeout(url, { method: "HEAD" });
    if (res.status === 404) return true;
    if (res.status !== 405) return false;
  } catch {}

  try {
    const res = await fetchWithTimeout(url, { method: "GET" });
    return res.status === 404;
  } catch {
    return false;
  }
}

async function runWithConcurrency(items, worker, concurrency = CONCURRENCY) {
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

async function openTab(url, timeoutMs = 20000) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    chrome.tabs.onUpdated.addListener(function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });

  return tabId;
}

function openCatalogTab(courseId, baseUrl) {
  const url = `${baseUrl}/admin/catalogs/contents/course/${encodeURIComponent(courseId)}`;
  return openTab(url, 15000);
}

function checkAnyInTarget(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const targetEl = document.querySelector("#target");
      if (!targetEl) return false;
      return targetEl.querySelectorAll(".connectedSortable_v2-item").length > 0;
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CHECK_CATALOG") return;

  (async () => {
    let tabId;
    const baseUrl = new URL(sender.url).origin;

    try {
      tabId = await openCatalogTab(msg.courseId, baseUrl);
      const results = await checkAnyInTarget(tabId);

      sendResponse({
        ok: true,
        catalogOk: results?.[0]?.result === true
      });
    } catch {
      sendResponse({ ok: false, catalogOk: false });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_ADD_TO_CATALOG") return;

  (async () => {
    let tabId;
    const baseUrl = new URL(sender.url).origin;

    try {
      tabId = await openCatalogTab(msg.courseId, baseUrl);

      const step1 = await chrome.scripting.executeScript({
        target: { tabId },
        func: (catalogLabel) => {
          const sourceEl = document.querySelector("#source");
          if (!sourceEl) {
            return { ok: false, error: "Seletor de catálogos não encontrado" };
          }

          const items = sourceEl.querySelectorAll(".connectedSortable_v2-item");

          for (const item of items) {
            const label = item.querySelector(".connectedSortable_v2-item-label");

            if (label && label.textContent.trim() === catalogLabel) {
              const checkbox = item.querySelector(
                ".connectedSortable_v2-item-checkbox"
              );

              if (!checkbox) {
                return { ok: false, error: `Checkbox de "${catalogLabel}" não encontrado` };
              }

              checkbox.click();
              return { ok: true };
            }
          }

          return {
            ok: false,
            error: `Catálogo "${catalogLabel}" não encontrado na lista`
          };
        },
        args: [msg.catalogLabel]
      });

      if (!step1?.[0]?.result?.ok) {
        sendResponse({
          ok: false,
          error: step1?.[0]?.result?.error || "Falha ao selecionar catálogo"
        });
        return;
      }

      await new Promise(r => setTimeout(r, 400));

      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          document
            .querySelector(".connectedSortable_v2-moveRight")
            ?.click();
        }
      });

      await new Promise(r => setTimeout(r, 400));

      const navDone = new Promise(resolve => {
        const timer = setTimeout(resolve, 10000);

        chrome.tabs.onUpdated.addListener(function listener(id, info) {
          if (id === tabId && info.status === "complete") {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        });
      });

      chrome.scripting
        .executeScript({
          target: { tabId },
          func: () => {
            document.querySelector("#submitForm")?.click();
          }
        })
        .catch(() => {});

      await navDone;

      const verify = await checkAnyInTarget(tabId);

      sendResponse({
        ok: verify?.[0]?.result === true
      });
    } catch (e) {
      sendResponse({
        ok: false,
        error: e?.message || String(e)
      });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CHECK_ICON") return;

  (async () => {
    const { courseSlug } = msg;
    const pat = await getGithubToken();

    const url = `https://api.github.com/repos/caelum/gnarus-api-assets/contents/alura/assets/api/cursos/${encodeURIComponent(courseSlug)}.svg`;

    try {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json"
        }
      });

      sendResponse({
        exists: resp.status === 200,
        notFound: resp.status === 404
      });
    } catch {
      sendResponse({ exists: false, notFound: false });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_UPLOAD_ICON") return;

  (async () => {
    const { categorySlug, courseSlug } = msg;
    const pat = await getGithubToken();

    try {
      const svgResp = await fetch(
        chrome.runtime.getURL(`icons/${categorySlug}.svg`)
      );

      if (!svgResp.ok) {
        sendResponse({
          ok: false,
          error: `SVG template não encontrado: ${categorySlug}.svg`
        });
        return;
      }

      const svgText = await svgResp.text();
      const base64 = btoa(unescape(encodeURIComponent(svgText)));

      const url = `https://api.github.com/repos/caelum/gnarus-api-assets/contents/alura/assets/api/cursos/${encodeURIComponent(courseSlug)}.svg`;

      const resp = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: `Add icon for ${courseSlug}`,
          content: base64,
          branch: "master"
        })
      });

      sendResponse({ ok: resp.status === 201 });
    } catch (e) {
      sendResponse({
        ok: false,
        error: e?.message || String(e)
      });
    }
  })();

  return true;
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type !== "ALURA_REVISOR_FORK_REPO") return;

  (async () => {
    const { owner, repo } = msg;
    const pat = await getGithubToken();
    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    };

    try {
      // Verifica se já existe um fork da alura-cursos com o mesmo nome
      const r = await fetch(`https://api.github.com/repos/alura-cursos/${encodeURIComponent(repo)}`, { headers });
      if (r.status === 200) {
        const data = await r.json();
        // Confirma que é fork do repositório original
        if (data.fork && data.parent?.full_name === `${owner}/${repo}`) {
          sendResponse({ ok: true, forkUrl: data.html_url });
          return;
        }
      }
      // Fork não existe ou não é do repo esperado — cria um novo
      const r2 = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks`, {
        method: "POST",
        headers,
        body: JSON.stringify({ organization: "alura-cursos" })
      });
      if (r2.status === 202) {
        const data = await r2.json();
        sendResponse({ ok: true, forkUrl: data.html_url });
      } else {
        const data = await r2.json().catch(() => ({}));
        sendResponse({ ok: false, error: data.message || `HTTP ${r2.status}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_SECTIONS") return;

  (async () => {
    let tabId;
    try {
      const baseUrl = new URL(sender.url).origin;
      const url = `${baseUrl}/admin/courses/v2/${encodeURIComponent(msg.courseId)}/sections`;
      tabId = await openTab(url);

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const rows = document.querySelectorAll("#sectionIds tbody tr");
          return [...rows].map(tr => ({
            id: tr.id,
            title: tr.cells[2]?.textContent?.trim() ?? "",
            active: !tr.classList.contains("danger") && (tr.cells[3]?.textContent ?? "").includes("Ativo")
          })).filter(s => s.id);
        }
      });

      sendResponse({ ok: true, sections: results?.[0]?.result ?? [] });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e), sections: [] });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_SECTION_TASKS") return;

  (async () => {
    let tabId;
    try {
      const baseUrl = new URL(sender.url).origin;
      const url = `${baseUrl}/admin/course/v2/${encodeURIComponent(msg.courseId)}/section/${encodeURIComponent(msg.sectionId)}/tasks`;
      tabId = await openTab(url);

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (includeInactive) => {
          const rows = [...document.querySelectorAll("#tasks-table tbody tr")];
          const allTasks = rows.map(tr => ({
            id: tr.querySelector("input[name='sectionIds']")?.value ?? "",
            type: tr.cells[1]?.textContent?.trim() ?? "",
            title: tr.cells[2]?.textContent?.trim() ?? "",
            active: !tr.classList.contains("danger"),
            editUrl: tr.querySelector("a[href*='/task/edit/']")?.href ?? "",
            activityUrl: tr.querySelector("a[href*='/course/']:not([href*='/admin/'])")?.href ?? ""
          })).filter(t => t.id);

          const hasActive = allTasks.some(t => t.active);
          const hasInactive = allTasks.some(t => !t.active);
          let reordered = false;

          if (hasActive && hasInactive) {
            const firstActiveIndex = allTasks.findIndex(t => t.active);
            const hasInactiveBeforeActive = allTasks.slice(0, firstActiveIndex).some(t => !t.active);
            if (hasInactiveBeforeActive) {
              const btn = document.querySelector("#button__submit");
              if (btn) { btn.click(); reordered = true; }
            }
          }

          return { tasks: allTasks.filter(t => includeInactive ? !!t.editUrl : (t.active && t.editUrl)), reordered };
        },
        args: [msg.includeInactive || false]
      });

      const result = results?.[0]?.result ?? { tasks: [], reordered: false };
      if (result.reordered) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      sendResponse({ ok: true, tasks: result.tasks, reordered: result.reordered });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e), tasks: [] });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CHECK_VIDEO_SUBTITLES") return;

  (async () => {
    let tabId;
    try {
      tabId = await openTab(msg.activityUrl, 20000);
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const waitFor = (fn, timeout = 8000) => new Promise(resolve => {
            const start = Date.now();
            const check = () => {
              const r = fn();
              if (r !== null && r !== undefined) return resolve(r);
              if (Date.now() - start > timeout) return resolve(null);
              setTimeout(check, 300);
            };
            check();
          });

          const texts = await waitFor(() => {
            const items = [...document.querySelectorAll(
              "li.vjs-subtitles-menu-item span.vjs-menu-item-text"
            )];
            return items.length ? items.map(el => el.textContent.trim().toLowerCase()) : null;
          }, 700);

          if (!texts) return { hasEspanhol: false, hasPortugues: false };
          return {
            hasEspanhol: texts.some(t => t.includes("espanhol")),
            hasPortugues: texts.some(t => t.includes("portugu")),
          };
        },
      });
      sendResponse({ ok: true, ...(result?.[0]?.result ?? { hasEspanhol: false, hasPortugues: false }) });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_LOAD_VIDEO_DURATION") return;

  (async () => {
    let tabId;
    try {
      tabId = await openTab(msg.activityUrl, 20000);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const start = Date.now();
          await new Promise(resolve => {
            const check = () => {
              if (document.querySelector("video.vjs-tech") || Date.now() - start > 8000) {
                resolve();
              } else {
                setTimeout(check, 300);
              }
            };
            check();
          });
        },
      });
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_TASK_CONTENT") return;

  (async () => {
    let tabId;
    try {
      tabId = await openTab(msg.editUrl);

      // Loop externo no service worker: executeScript com função SÍNCRONA no MAIN world.
      // Funções async no MAIN world podem não ter o resultado capturado corretamente pelo
      // Chrome (a Promise não é esperada), fazendo results[0].result ficar undefined.
      // Solução: polling fora do executeScript, injetando função síncrona a cada tentativa.
      let contentResult = { videoUrl: null, htmlContents: [], transcriptionText: "" };

      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          // MAIN world: acessa expando cmEl.CodeMirror setado pelo script da página.
          // No isolated world padrão essa propriedade é invisível.
          world: "MAIN",
          func: () => {
            const videoUrl = document.querySelector("input[name='uri']")?.value ?? null;

            const htmlContents = [...document.querySelectorAll("input.hackeditor-sync")]
              .map(el => el.value)
              .filter(Boolean);

            // Alternativas: cada .fieldGroup-alternative dentro de #alternatives
            const alternatives = [...document.querySelectorAll("#alternatives .fieldGroup-alternative")].map(alt => {
              const textInput = alt.querySelector("input.hackeditor-sync[name*='.textHighlighted']");
              const correctInput = alt.querySelector("input.fieldGroup-alternative-actions-correct");
              return { body: textInput?.value || "", correct: correctInput?.checked === true };
            }).filter(a => a.body);

            // cm.getValue() retorna o texto completo do CodeMirror sem virtual scrolling.
            // Só acessível via MAIN world (expando no elemento .CodeMirror).
            const transcriptionText = [...document.querySelectorAll("textarea.markdownEditor-source")]
              .map(ta => {
                const cmEl = ta.closest(".hackeditor")?.querySelector(".CodeMirror");
                return cmEl?.CodeMirror?.getValue()?.trim() || (ta.value || "").trim();
              })
              .filter(Boolean)
              .join(" ");

            return { videoUrl, htmlContents, alternatives, transcriptionText };
          }
        });

        const r = res?.[0]?.result;
        if (r) {
          contentResult = r;
          if (r.transcriptionText.length > 0 || r.htmlContents.length > 0) break;
        }

        if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 500));
      }

      sendResponse({ ok: true, ...contentResult });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e), videoUrl: null, htmlContents: [], transcriptionText: "" });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_VIDEO_NAME") return;

  (async () => {
    let tabId;
    try {
      const url = `https://video-uploader.alura.com.br/video/${msg.sequence}`;
      tabId = await openTab(url);
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.querySelector("h1")?.textContent?.trim() ?? ""
      });
      const videoName = res?.[0]?.result ?? "";
      sendResponse({ ok: true, videoName });
    } catch (e) {
      sendResponse({ ok: false, videoName: "", error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_DOWNLOAD_VIDEO") return;

  const { url, filename } = msg;
  chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
  sendResponse({ ok: true });
  return true;
});

const UPLOADER_BASE = "https://video-uploader.alura.com.br";

async function getUploaderToken() {
  const data = await chrome.storage.local.get(["aluraRevisorUploaderToken"]);
  return data?.aluraRevisorUploaderToken || "";
}

const uploadQueue = [];
let uploadQueueRunning = false;

async function runUploadQueue() {
  if (uploadQueueRunning) return;
  uploadQueueRunning = true;
  let uploadedCount = 0;
  let totalCount = 0;
  while (uploadQueue.length > 0) {
    const { url, filename, courseId, token, editUrl } = uploadQueue.shift();
    totalCount++;
    let tabId;
    try {
      tabId = await openTab(`${UPLOADER_BASE}/video/upload`, 20000);
      const scriptResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (videoUrl, videoFilename, videoCourseId, apiToken, baseUrl) => {
          // 1. Resolve showcase (busca ou cria)
          let showcaseId = null;
          try {
            const listResp = await fetch(
              `${baseUrl}/api/showcase/list?title=${encodeURIComponent(String(videoCourseId))}`,
              { headers: { "X-API-TOKEN": apiToken } }
            );
            if (listResp.ok) {
              const data = await listResp.json();
              const arr = Array.isArray(data) ? data : [data];
              const exact = arr.find(s => String(s.title) === String(videoCourseId));
              if (exact?.id != null) showcaseId = exact.id;
            }
          } catch {}
          if (showcaseId == null) {
            const cr = await fetch(`${baseUrl}/api/showcase/create`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-API-TOKEN": apiToken },
              body: JSON.stringify({ title: String(videoCourseId) }),
            });
            showcaseId = (await cr.json())?.id ?? null;
          }

          // 2. Busca blob na CDN e faz upload (same-origin, sem CORS)
          const blob = await (await fetch(videoUrl)).blob();
          const fd = new FormData();
          fd.append("file", blob, videoFilename);
          if (showcaseId != null) fd.append("showcase", String(showcaseId));
          const uploadResp = await fetch(`${baseUrl}/api/video/upload`, {
            method: "POST",
            headers: { "X-API-TOKEN": apiToken },
            body: fd,
          });
          if (!uploadResp.ok) {
            const text = await uploadResp.text();
            throw new Error(`Upload HTTP ${uploadResp.status}: ${text.slice(0, 150)}`);
          }
          const uploadData = await uploadResp.json();
          if (!uploadData?.successful) {
            throw new Error(`Upload falhou (successful=false): ${JSON.stringify(uploadData).slice(0, 150)}`);
          }
          return uploadData?.uuid || null;
        },
        args: [url, filename, courseId, token, UPLOADER_BASE],
      });

      const uuid = scriptResult?.[0]?.result || null;
      if (uuid) {
        uploadedCount++;
        if (editUrl) {
          const KEY_RESULTS = "aluraRevisorUploadResults";
          const stored = (await chrome.storage.local.get(KEY_RESULTS))[KEY_RESULTS] || [];
          stored.push({ uuid, editUrl, filename, courseId });
          await chrome.storage.local.set({ [KEY_RESULTS]: stored });
        }
      }
    } catch (err) {
      chrome.notifications.create({
        type: "basic",
        title: "Erro no upload ❌",
        message: `${filename}: ${err?.message || "erro desconhecido"}`,
      });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  }
  uploadQueueRunning = false;
  chrome.notifications.create({
    type: "basic",
    title: "Upload concluído ✅",
    message: `${uploadedCount} de ${totalCount} vídeo(s) enviado(s) com sucesso.`,
  });
  await runAdminLinkUpdate();
}

async function runAdminLinkUpdate() {
  const KEY_RESULTS = "aluraRevisorUploadResults";
  const stored = (await chrome.storage.local.get(KEY_RESULTS))[KEY_RESULTS] || [];
  if (stored.length === 0) return;

  await chrome.storage.local.set({
    aluraRevisorRunState: { running: true, mode: "adminUpdate", total: stored.length, done: 0 }
  });

  let done = 0;
  for (const entry of stored) {
    const { uuid, editUrl } = entry;
    if (!uuid || !editUrl) continue;
    const link = `${uuid.slice(0, 3)}/${uuid}`;

    // Passo A: video-uploader → clicar "Gerar legenda"
    let uploaderTabId;
    try {
      uploaderTabId = await openTab(`${UPLOADER_BASE}/video/${uuid}`, 20000);
      await chrome.scripting.executeScript({
        target: { tabId: uploaderTabId },
        func: async () => {
          const btn = [...document.querySelectorAll("button")].find(b =>
            b.textContent.trim().toLowerCase().includes("gerar legenda")
          );
          if (btn) btn.click();
          await new Promise(r => setTimeout(r, 1500));
        },
      });
    } catch {}
    finally { if (uploaderTabId != null) chrome.tabs.remove(uploaderTabId).catch(() => {}); }

    // Passo B: admin → preenche input[name="uri"] → clica #submitTask
    let adminTabId;
    try {
      adminTabId = await openTab(editUrl, 20000);
      await chrome.scripting.executeScript({
        target: { tabId: adminTabId },
        func: (videoLink) => {
          const input = document.querySelector("input[name='uri']");
          if (input) {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
              .set.call(input, videoLink);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        args: [link],
      });
      await new Promise(r => setTimeout(r, 500));

      const navDone = new Promise(resolve => {
        const timer = setTimeout(resolve, 10000);
        chrome.tabs.onUpdated.addListener(function listener(id, info) {
          if (id === adminTabId && info.status === "complete") {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        });
      });
      await chrome.scripting.executeScript({
        target: { tabId: adminTabId },
        func: () => { document.querySelector("#submitTask")?.click(); },
      });
      await navDone;
      done++;
    } catch {}
    finally { if (adminTabId != null) chrome.tabs.remove(adminTabId).catch(() => {}); }

    await chrome.storage.local.set({
      aluraRevisorRunState: { running: true, mode: "adminUpdate", total: stored.length, done }
    });
  }

  await chrome.storage.local.remove(KEY_RESULTS);
  await chrome.storage.local.set({ aluraRevisorRunState: { running: false } });

  chrome.notifications.create({
    type: "basic",
    title: "Links atualizados ✅",
    message: `${done} vídeo(s) com legenda gerada e URI atualizada no admin.`,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_UPLOAD_VIDEO") return;

  (async () => {
    const token = await getUploaderToken();
    uploadQueue.push({ url: msg.url, filename: msg.filename, courseId: msg.courseId, token, editUrl: msg.editUrl || null });
    runUploadQueue();
    sendResponse({ ok: true, queued: true });
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CHECK_404") return;

  (async () => {
    const urls = Array.isArray(msg.urls)
      ? msg.urls.filter(isHttpUrl).filter(u => !shouldSkip404Check(u))
      : [];

    const uniq = Array.from(new Set(urls));

    const res = await runWithConcurrency(
      uniq,
      async u => ((await check404(u)) ? u : null)
    );

    const bad = res.filter(Boolean);

    sendResponse({ ok: true, bad404: bad });
  })().catch(e => {
    sendResponse({
      ok: false,
      error: e?.message || String(e),
      bad404: []
    });
  });

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_CATALOGS") return;

  (async () => {
    let tabId;
    const baseUrl = new URL(sender.url).origin;
    try {
      tabId = await openCatalogTab(msg.courseId, baseUrl);
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const items = document.querySelectorAll("#source .connectedSortable_v2-item");
          return [...items].map(item => ({
            label: item.querySelector(".connectedSortable_v2-item-label")?.textContent?.trim() ?? ""
          })).filter(c => c.label);
        }
      });
      sendResponse({ ok: true, catalogs: results?.[0]?.result ?? [] });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e), catalogs: [] });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_SUBCATEGORIES") return;

  (async () => {
    let tabId;
    const baseUrl = new URL(sender.url).origin;
    try {
      tabId = await openTab(`${baseUrl}/admin/categories`, 15000);
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const rows = [...document.querySelectorAll("table tbody tr")];
          return rows
            .filter(tr =>
              !tr.classList.contains("danger") &&
              tr.querySelector("a[href*='/admin/subcategories/']")
            )
            .map(tr => ({
              name: tr.cells[0]?.textContent?.trim() ?? "",
              urlSlug: tr.cells[1]?.textContent?.trim() ?? "",
              category: tr.cells[2]?.textContent?.trim() ?? "",
              id: tr.cells[3]?.textContent?.trim() ?? "",
            }))
            .filter(sub =>
              sub.id &&
              sub.category !== "Cursos proprietários" &&
              !sub.urlSlug.includes("escolas")
            );
        },
      });
      sendResponse({ ok: true, subcategories: result?.[0]?.result ?? [] });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message, subcategories: [] });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_ADD_TO_SUBCATEGORY") return;

  (async () => {
    let tabId;
    const baseUrl = new URL(sender.url).origin;
    try {
      tabId = await openTab(`${baseUrl}/admin/subcategories/${msg.subcategoryId}/edit`, 15000);

      const step1 = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (courseId) => {
          const search = document.querySelector("#searchSource");
          if (search) {
            search.value = String(courseId);
            search.dispatchEvent(new Event("input", { bubbles: true }));
            await new Promise(r => setTimeout(r, 600));
          }
          const item = document.querySelector(`#source .connectedSortable_v2-item[title="${courseId}"]`);
          if (!item) return { ok: false, error: `Curso ${courseId} não encontrado` };
          item.querySelector(".connectedSortable_v2-item-checkbox")?.click();
          return { ok: true };
        },
        args: [msg.courseId],
      });

      if (!step1?.[0]?.result?.ok) {
        sendResponse({ ok: false, error: step1?.[0]?.result?.error });
        return;
      }

      await new Promise(r => setTimeout(r, 400));
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { document.querySelector(".connectedSortable_v2-moveRight")?.click(); },
      });
      await new Promise(r => setTimeout(r, 400));

      const navDone = new Promise(resolve => {
        const timer = setTimeout(resolve, 10000);
        chrome.tabs.onUpdated.addListener(function listener(id, info) {
          if (id === tabId && info.status === "complete") {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        });
      });
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => { document.querySelector("#submitForm")?.click(); },
      }).catch(() => {});
      await navDone;

      const verify = await chrome.scripting.executeScript({
        target: { tabId },
        func: (courseId) => !!document.querySelector(`#target .connectedSortable_v2-item[title="${courseId}"]`),
        args: [msg.courseId],
      });
      sendResponse({ ok: verify?.[0]?.result === true });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_FIX_ADMIN_FIELDS") return;

  (async () => {
    let tabId;
    try {
      const baseUrl = new URL(sender.url).origin;
      const url = `${baseUrl}/admin/courses/v2/${encodeURIComponent(msg.courseId)}`;
      tabId = await openTab(url);

      await chrome.scripting.executeScript({
        target: { tabId },
        func: (courseName, correctedHours, needsMetaTitle, needsHours, needsEmenta) => {
          if (needsMetaTitle) {
            const el = document.querySelector("input[name='metaTitle']");
            if (el) { el.value = `${courseName} | Alura`; el.dispatchEvent(new Event("change", { bubbles: true })); }
          }
          if (needsHours && correctedHours) {
            const el = document.querySelector("input[name='estimatedTimeToFinish']");
            if (el) { el.value = correctedHours; el.dispatchEvent(new Event("change", { bubbles: true })); }
          }
          if (needsEmenta) {
            document.querySelector("button.gerar-ementa")?.click();
          }
        },
        args: [msg.courseName, msg.correctedHours, msg.needsMetaTitle, msg.needsHours, msg.needsEmenta]
      });

      if (msg.needsEmenta) await new Promise(r => setTimeout(r, 4000));

      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { document.querySelector("#submit-form__button")?.click(); }
      });

      await new Promise(r => setTimeout(r, 2000));
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_COURSE_TEXTUAL") return;

  (async () => {
    let tabId;
    try {
      const baseUrl = new URL(sender.url).origin;
      const url = `${baseUrl}/admin/courses/v2/${encodeURIComponent(msg.courseId)}`;
      tabId = await openTab(url);

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const courseName = document.querySelector("input[name='name']")?.value?.trim() ?? "";
          const nameInEnglish = document.querySelector("input[name='nameInEnglish']")?.value?.trim() ?? "";
          const nameInSpanish = document.querySelector("input[name='nameInSpanish']")?.value?.trim() ?? "";
          const courseCode = document.querySelector("input[name='code']")?.value?.trim() ?? "";
          const estimatedHours = document.querySelector("input[name='estimatedTimeToFinish']")?.value?.trim() ?? "";
          const metaDescription = document.querySelector("input[name='metadescription']")?.value?.trim() ?? "";
          const courseExclusive = document.querySelector("#courseExclusive")?.checked ?? false;
          const coursePrivate = document.querySelector("#course-private-toggle")?.checked ?? false;
          const targetPublic = document.querySelector("input[name='targetPublic']")?.value?.trim() ?? "";
          const authors = Array.from(document.querySelectorAll("select[name='authors'] option:checked"))
            .map(o => o.textContent.trim()).join(", ");
          const highlightedInformation = document.querySelector("textarea[name='highlightedInformation']")?.value?.trim() ?? "";
          const ementa = document.querySelector("textarea[name='ementa.raw']")?.value?.trim() ?? "";

          return { courseName, nameInEnglish, nameInSpanish, courseCode, estimatedHours,
                   metaDescription, courseExclusive, coursePrivate, targetPublic,
                   authors, highlightedInformation, ementa };
        }
      });

      sendResponse({ ok: true, ...(results?.[0]?.result ?? {}) });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_ADMIN_FIELDS") return;

  (async () => {
    let tabId;
    try {
      const baseUrl = new URL(sender.url).origin;
      const url = `${baseUrl}/admin/courses/v2/${encodeURIComponent(msg.courseId)}`;
      tabId = await openTab(url);

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const courseName = document.querySelector("input[name='name']")?.value?.trim() ?? "";
          const metaTitle = document.querySelector("input[name='metaTitle']")?.value?.trim() ?? "";
          const estimatedHours = document.querySelector("input[name='estimatedTimeToFinish']")?.value?.trim() ?? "";
          const metaDescription = document.querySelector("input[name='metadescription']")?.value?.trim() ?? "";
          const targetPublic = document.querySelector("input[name='targetPublic']")?.value?.trim() ?? "";
          const highlightedInformation = document.querySelector("textarea[name='highlightedInformation']")?.value?.trim() ?? "";
          const ementa = document.querySelector("textarea[name='ementa.raw']")?.value?.trim() ?? "";

          let systemEstimatedHours = null;
          for (const el of document.querySelectorAll("strong")) {
            const m = el.textContent.match(/estimado pelo sistema é de (\d+)/i);
            if (m) { systemEstimatedHours = m[1]; break; }
          }

          return { courseName, metaTitle, estimatedHours, systemEstimatedHours,
                   metaDescription, targetPublic, highlightedInformation, ementa };
        }
      });

      sendResponse({ ok: true, ...(results?.[0]?.result ?? {}) });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});