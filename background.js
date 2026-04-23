// ---------- AWS SigV4 signing ----------
async function sha256Hex(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function getSigningKey(secretKey, dateStamp, region, service) {
  let key = new TextEncoder().encode("AWS4" + secretKey);
  for (const msg of [dateStamp, region, service, "aws4_request"]) {
    key = await hmacSha256(key, msg);
  }
  return key;
}

async function signAwsRequest({ method, url, body, accessKeyId, secretAccessKey, region, service, contentType, binaryBody }) {
  const parsedUrl = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  // SigV4: cada segmento do path deve ser URI-encoded (RFC 3986)
  const canonicalUri = parsedUrl.pathname
    .split("/")
    .map(seg => encodeURIComponent(seg))
    .join("/");

  const payloadHash = binaryBody !== undefined ? await sha256Hex(binaryBody) : await sha256Hex(body || "");

  const headers = {
    "content-type": contentType ?? "application/json",
    "host": parsedUrl.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  if (binaryBody !== undefined) {
    headers["content-length"] = String(binaryBody.byteLength);
  }

  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join("");

  const canonicalRequest = [
    method,
    canonicalUri,
    "", // query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region, service);
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = [...signatureBytes].map(b => b.toString(16).padStart(2, "0")).join("");

  return {
    ...headers,
    "authorization": `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// Cache in-memory para evitar chamadas repetidas ao hub na mesma sessão do service worker
let _githubTokenCache = null;

async function getGithubToken() {
  if (_githubTokenCache) return _githubTokenCache;
  try {
    const res = await fetch("https://hub-producao-conteudo.vercel.app/api/revisor/config", {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return "";
    const data = await res.json();
    const token = data?.github || "";
    if (token) _githubTokenCache = token;
    return token;
  } catch {
    return "";
  }
}

function isValidSender(sender) {
  const origin = sender?.url ? new URL(sender.url).origin : "";
  return (
    origin === "https://cursos.alura.com.br" ||
    origin === "https://app.aluracursos.com" ||
    origin === "https://hub-producao-conteudo.vercel.app"
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CAIXAVERSO_DONE") return;

  const { successCount, errorCount, total } = msg;
  const allOk = errorCount === 0;
  chrome.notifications.create(String(Date.now()), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon48.png"),
    title: allOk ? `Caixaverso ✅ ${total} cursos criados` : `Caixaverso ⚠️ ${successCount}/${total} cursos criados`,
    message: allOk
      ? `Todos os ${total} cursos foram criados com sucesso.`
      : `${errorCount} erro(s). Abra o relatório no popup para ver detalhes.`,
  });
  sendResponse({ ok: true });
});

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
    console.log(`[Catalog] courseId=${msg.courseId}, label="${msg.catalogLabel}"`);

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

            if (label && label.textContent.trim().includes(catalogLabel)) {
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

      // Após submit a página navega — não é possível verificar #target. Considera OK.
      console.log(`[Catalog] resultado: OK`);
      sendResponse({ ok: true });
    } catch (e) {
      console.error("[Catalog] erro:", e.message);
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
  if (msg?.type !== "ALURA_REVISOR_REMOVE_FROM_CATALOG") return;

  (async () => {
    let tabId;
    const baseUrl = new URL(sender.url).origin;

    try {
      tabId = await openCatalogTab(msg.courseId, baseUrl);

      const step1 = await chrome.scripting.executeScript({
        target: { tabId },
        func: (catalogLabel) => {
          const targetEl = document.querySelector("#target");
          if (!targetEl) {
            return { ok: false, error: "Seletor #target não encontrado" };
          }

          const items = targetEl.querySelectorAll(".connectedSortable_v2-item");

          for (const item of items) {
            const label = item.querySelector(".connectedSortable_v2-item-label");

            if (label && label.textContent.trim().includes(catalogLabel)) {
              const checkbox = item.querySelector(".connectedSortable_v2-item-checkbox");

              if (!checkbox) {
                return { ok: false, error: `Checkbox de "${catalogLabel}" não encontrado` };
              }

              checkbox.click();
              return { ok: true };
            }
          }

          return {
            ok: false,
            error: `Catálogo "${catalogLabel}" não encontrado em #target`
          };
        },
        args: [msg.catalogLabel]
      });

      if (!step1?.[0]?.result?.ok) {
        sendResponse({
          ok: false,
          error: step1?.[0]?.result?.error || "Falha ao selecionar catálogo em #target"
        });
        return;
      }

      await new Promise(r => setTimeout(r, 400));

      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          document.querySelector(".connectedSortable_v2-moveLeft")?.click();
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

      const verify = await chrome.scripting.executeScript({
        target: { tabId },
        func: (catalogLabel) => {
          const targetEl = document.querySelector("#target");
          if (!targetEl) return true;
          const items = [...targetEl.querySelectorAll(".connectedSortable_v2-item")];
          return !items.some(item =>
            item.querySelector(".connectedSortable_v2-item-label")?.textContent?.trim() === catalogLabel
          );
        },
        args: [msg.catalogLabel]
      });

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
        world: "MAIN",
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

          if (!texts) return { hasEspanhol: false, hasPortugues: false, trackUrls: {} };

          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const vjsEl = document.querySelector(".video-js");
          const player = vjsEl?.player
            || (window.videojs && Object.values(window.videojs.players || {})[0]);

          const trackUrls = {};

          if (player) {
            const menuItems = [...document.querySelectorAll("li.vjs-subtitles-menu-item")];
            for (const item of menuItems) {
              const labelText = item.querySelector("span.vjs-menu-item-text")?.textContent?.trim().toLowerCase() || "";
              if (!labelText || labelText === "subtitles off") continue;

              item.click();

              // Espera até a track aparecer em player.textTracks() com src preenchido
              const trackSrc = await new Promise(resolve => {
                const start = Date.now();
                const check = () => {
                  const tl = player.textTracks();
                  for (let i = 0; i < tl.length; i++) {
                    const t = tl[i];
                    if (t.kind === "subtitles" && t.mode === "showing" && t.src) {
                      return resolve({ src: t.src, language: t.language });
                    }
                  }
                  if (Date.now() - start > 5000) return resolve(null);
                  setTimeout(check, 200);
                };
                check();
              });

              if (trackSrc) {
                const lang = trackSrc.language || "";
                if (lang.startsWith("pt") || labelText.includes("portugu")) {
                  trackUrls.pt = trackSrc.src;
                } else if (lang.startsWith("es") || labelText.includes("espanhol")) {
                  trackUrls.es = trackSrc.src;
                }
              }

              // Desativa antes da próxima
              item.click();
              await sleep(300);
            }
          }

          return {
            hasEspanhol: texts.some(t => t.includes("espanhol")),
            hasPortugues: texts.some(t => t.includes("portugu")),
            trackUrls,
          };
        },
      });
      const scriptResult = result?.[0]?.result ?? { hasEspanhol: false, hasPortugues: false, trackUrls: {} };

      let vttPt = null, vttEsp = null;
      if (msg.downloadPt && scriptResult.trackUrls?.pt) {
        try { vttPt = await fetch(scriptResult.trackUrls.pt).then(r => r.text()); } catch {}
      }
      if (msg.downloadEsp && scriptResult.trackUrls?.es) {
        try { vttEsp = await fetch(scriptResult.trackUrls.es).then(r => r.text()); } catch {}
      }

      sendResponse({ ok: true, hasEspanhol: scriptResult.hasEspanhol, hasPortugues: scriptResult.hasPortugues, vttPt, vttEsp });
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
              const opinionInput = alt.querySelector("input.hackeditor-sync[name*='.opinionHighlighted']");
              const correctInput = alt.querySelector("input.fieldGroup-alternative-actions-correct");
              return { body: textInput?.value || "", justification: opinionInput?.value || "", correct: correctInput?.checked === true };
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

            const luriOqueAprendemos = document.querySelector("input[name='hqExplanationCanUseAsOpenTask']")?.checked === true;
            const luriExercicio = document.querySelector("input[name='singleChoiceCanUseAsOpenTask']")?.checked === true;

            return { videoUrl, htmlContents, alternatives, transcriptionText, luriOqueAprendemos, luriExercicio };
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
  if (msg?.type !== "ALURA_REVISOR_GENERATE_SUBTITLES") return;

  sendResponse({ ok: true }); // fire-and-forget

  (async () => {
    const { courseId, baseUrl } = msg;
    const token = await getUploaderToken();

    if (!token) {
      chrome.notifications.create(String(Date.now()), {
        type: "basic", iconUrl: chrome.runtime.getURL("icon48.png"),
        title: "Legendas — Token ausente",
        message: "Configure o Token do video-uploader em Credenciais antes de gerar legendas.",
      });
      return;
    }

    // 1. Busca seções ativas
    let sections = [];
    { let tabId;
      try {
        tabId = await openTab(`${baseUrl}/admin/courses/v2/${encodeURIComponent(courseId)}/sections`);
        const r = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const rows = document.querySelectorAll("#sectionIds tbody tr");
            return [...rows].map(tr => ({
              id: tr.id,
              active: !tr.classList.contains("danger") && (tr.cells[3]?.textContent ?? "").includes("Ativo")
            })).filter(s => s.id);
          }
        });
        sections = (r?.[0]?.result ?? []).filter(s => s.active);
      } catch (e) {
        chrome.notifications.create(String(Date.now()), {
          type: "basic", iconUrl: chrome.runtime.getURL("icon48.png"),
          title: "Legendas — Erro", message: `Erro ao buscar seções: ${e?.message}`,
        });
        return;
      } finally { if (tabId != null) chrome.tabs.remove(tabId).catch(() => {}); }
    }

    // 2. Coleta tarefas de vídeo de todas as seções
    const videoTasks = [];
    for (const section of sections) {
      let tabId;
      try {
        tabId = await openTab(`${baseUrl}/admin/course/v2/${encodeURIComponent(courseId)}/section/${encodeURIComponent(section.id)}/tasks`);
        const r = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => [...document.querySelectorAll("#tasks-table tbody tr")]
            .map(tr => ({
              type: tr.cells[1]?.textContent?.trim() ?? "",
              active: !tr.classList.contains("danger"),
              editUrl: tr.querySelector("a[href*='/task/edit/']")?.href ?? "",
            }))
            .filter(t => t.active && t.type === "Vídeo" && t.editUrl)
        });
        for (const t of (r?.[0]?.result ?? [])) videoTasks.push(t);
      } catch {}
      finally { if (tabId != null) chrome.tabs.remove(tabId).catch(() => {}); }
    }

    if (videoTasks.length === 0) {
      chrome.notifications.create(String(Date.now()), {
        type: "basic", iconUrl: chrome.runtime.getURL("icon48.png"),
        title: "Legendas", message: "Nenhuma tarefa de vídeo ativa encontrada.",
      });
      await chrome.storage.local.set({ aluraRevisorRunState: { running: false, mode: "subtitles", total: 0, done: 0, errors: 0 } });
      return;
    }

    await chrome.storage.local.set({
      aluraRevisorRunState: { running: true, mode: "subtitles", total: videoTasks.length, done: 0, errors: 0 }
    });

    // 3. Lê URI de cada tarefa → detecção Vimeo → extrai UUID
    const uuids = [];
    for (const task of videoTasks) {
      let tabId;
      try {
        tabId = await openTab(task.editUrl);
        const r = await chrome.scripting.executeScript({
          target: { tabId }, world: "MAIN",
          func: () => document.querySelector("input[name='uri']")?.value ?? null
        });
        const uri = r?.[0]?.result ?? null;
        if (!uri) continue;

        if (uri.includes("vimeo.com") || uri.startsWith("https://")) {
          await chrome.storage.local.set({
            aluraRevisorRunState: { running: false, mode: "subtitles", total: videoTasks.length, done: 0, errors: 1, fatalError: "Vídeos no Vimeo detectados" }
          });
          chrome.notifications.create(String(Date.now()), {
            type: "basic", iconUrl: chrome.runtime.getURL("icon48.png"),
            title: "Legendas — Vimeo detectado",
            message: "Há vídeos no Vimeo. Remova-os antes de gerar legendas.",
          });
          return;
        }

        const slashIdx = uri.indexOf("/");
        const uuid = slashIdx >= 0 ? uri.slice(slashIdx + 1) : uri;
        if (uuid) uuids.push(uuid);
      } catch {}
      finally { if (tabId != null) chrome.tabs.remove(tabId).catch(() => {}); }
    }

    // 4. Gera legendas via batch API — fetch feito de dentro de uma aba do uploader (same-origin, sem CORS)
    let done = 0, errors = uuids.length;
    if (uuids.length > 0) {
      let subtitleTabId;
      try {
        subtitleTabId = await openTab(`${UPLOADER_BASE}/video/upload`, 20000);
        const r = await chrome.scripting.executeScript({
          target: { tabId: subtitleTabId },
          func: async (videoUuids, apiToken) => {
            try {
              const resp = await fetch("/api/video/subtitle/batch-enqueue", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-API-TOKEN": apiToken },
                body: JSON.stringify({ videoUuids, environment: "production" }),
              });
              const body = await resp.text().catch(() => "");
              return { ok: resp.ok, status: resp.status, body };
            } catch (e) {
              return { ok: false, status: 0, body: e.message };
            }
          },
          args: [uuids, token],
        });
        const result = r?.[0]?.result;
        console.log(`[Legendas] batch status=${result?.status} body=${result?.body}`);
        if (result?.ok) { done = uuids.length; errors = 0; }
      } catch (e) {
        console.log(`[Legendas] batch erro: ${e.message}`);
      } finally {
        if (subtitleTabId != null) chrome.tabs.remove(subtitleTabId).catch(() => {});
      }
    }

    // 5. Estado final + notificação
    await chrome.storage.local.set({
      aluraRevisorRunState: { running: false, mode: "subtitles", total: uuids.length, done, errors }
    });
    chrome.notifications.create(String(Date.now()), {
      type: "basic", iconUrl: chrome.runtime.getURL("icon48.png"),
      title: errors === 0 ? "Legendas enviadas ✅" : `Legendas ⚠️ ${done}/${uuids.length}`,
      message: errors === 0
        ? `${done} legenda(s) gerada(s) com sucesso.`
        : `${done} sucesso(s), ${errors} erro(s).`,
    });
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_DOWNLOAD_BLOB") return;

  const { content, filename, mimeType = "application/json" } = msg;
  const dataUrl = `data:${mimeType};charset=utf-8,` + encodeURIComponent(content);
  chrome.downloads.download({ url: dataUrl, filename, conflictAction: "uniquify", saveAs: false }, (downloadId) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
    } else {
      sendResponse({ ok: true, downloadId });
    }
  });
  return true;
});

// ---------- Injetar JSON traduzido no Hub ----------
// Usa storage.onChanged (acorda o SW) + tabs.onUpdated (injeta quando a página carregou)

const HUB_UPLOAD_URL = "https://hub-producao-conteudo.vercel.app/seletor-de-atividades/upload";

async function injectJsonIntoHubTab(tabId, pending) {
  if (!pending) return;
  const { jsonStr, filename } = pending;

  // Remover antes de injetar para evitar duplo disparo
  await chrome.storage.local.remove("aluraRevisorPendingHubInject");

  // Aguardar React hidratar o input (até 20s)
  const inputReady = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 20000);
    function poll() {
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!document.querySelector('input[type="file"][accept*=".json"]'),
      }).then(([res]) => {
        if (res?.result) { clearTimeout(timeout); resolve(true); }
        else setTimeout(poll, 400);
      }).catch(() => setTimeout(poll, 400));
    }
    poll();
  });

  if (!inputReady) {
    await chrome.storage.local.set({ aluraRevisorHubInjectStatus: { ok: false, error: "Tempo esgotado aguardando o Hub carregar." } });
    return;
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [jsonStr, filename],
    func: (jsonStr, filename) => {
      try {
        const file = new File([jsonStr], filename, { type: "application/json" });
        const input = document.querySelector('input[type="file"][accept*=".json"]');
        if (!input) return { ok: false, error: "Input não encontrado na página de upload." };
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
  }).catch((e) => [{ result: { ok: false, error: e.message } }]);

  await chrome.storage.local.set({
    aluraRevisorHubInjectStatus: result?.result ?? { ok: false, error: "Sem resposta do script." },
  });
}

// 1. OPEN_HUB_FOR_INJECT — mensagem direta do popup acorda o SW de forma confiável
let _hubInjectRunning = false;
async function openHubForInject() {
  if (_hubInjectRunning) { console.log("[HubInject] já em execução — ignorando duplo disparo"); return; }
  _hubInjectRunning = true;
  console.log("[HubInject] openHubForInject chamado");
  try {
    const stored = await chrome.storage.local.get("aluraRevisorPendingHubInject");
    const pending = stored?.aluraRevisorPendingHubInject;
    if (!pending) {
      console.log("[HubInject] sem pending no storage");
      return;
    }
    const hubTabs = await chrome.tabs.query({ url: "https://hub-producao-conteudo.vercel.app/*" });
    console.log("[HubInject] abas do Hub encontradas:", hubTabs.length);

    if (!hubTabs.length) {
      console.log("[HubInject] abrindo nova aba");
      await chrome.tabs.create({ url: HUB_UPLOAD_URL });
    } else if (hubTabs[0].url?.includes("/seletor-de-atividades/upload")) {
      console.log("[HubInject] já na página de upload — injetando direto");
      await injectJsonIntoHubTab(hubTabs[0].id, pending);
    } else {
      console.log("[HubInject] navegando aba existente para upload");
      await chrome.tabs.update(hubTabs[0].id, { url: HUB_UPLOAD_URL });
    }
  } catch (e) {
    console.error("[HubInject] erro em openHubForInject:", e.message);
  } finally {
    _hubInjectRunning = false;
  }
}

// 2. tabs.onUpdated injeta quando a página de upload do Hub termina de carregar
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url?.includes("hub-producao-conteudo.vercel.app/seletor-de-atividades/upload")) return;
  console.log("[HubInject] tabs.onUpdated — hub upload carregou, verificando pending");

  chrome.storage.local.get("aluraRevisorPendingHubInject", (stored) => {
    const pending = stored?.aluraRevisorPendingHubInject;
    if (!pending) { console.log("[HubInject] sem pending — nada a injetar"); return; }
    console.log("[HubInject] injetando JSON:", pending.filename);
    injectJsonIntoHubTab(tabId, pending);
  });
});

// ---------- Abrir Hub para injetar JSON ----------
// Gatilho 1: mensagem direta do popup (mais confiável para SW quente)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "OPEN_HUB_FOR_INJECT") return;
  console.log("[HubInject] mensagem OPEN_HUB_FOR_INJECT recebida");
  openHubForInject().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

// Gatilho 2: storage.onChanged como fallback (acorda SW quando sendMessage falha no startup)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.aluraRevisorPendingHubInject?.newValue) return;
  console.log("[HubInject] storage.onChanged disparado — chamando openHubForInject (fallback)");
  openHubForInject();
});

// ---------- Captura de ZIP do ferramentas-ia.alura.dev ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "FERRAMENTAS_IA_ZIP_CAPTURED") return;

  chrome.storage.local.set({
    aluraRevisorCapturedZip: {
      base64: msg.base64,
      mimeType: msg.mimeType || "application/zip",
      capturedAt: new Date().toISOString(),
      size: msg.size,
    },
  }, () => {
    sendResponse({ ok: true });
  });
  return true;
});

const UPLOADER_BASE = "https://video-uploader.alura.com.br";

let _uploaderTokenCache = null;

async function getUploaderToken() {
  if (_uploaderTokenCache) return _uploaderTokenCache;
  try {
    const res = await fetch("https://hub-producao-conteudo.vercel.app/api/revisor/config", {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return "";
    const data = await res.json();
    const token = data?.video_uploader || "";
    if (token) _uploaderTokenCache = token;
    return token;
  } catch {
    return "";
  }
}

const uploadQueue = [];
let uploadQueueRunning = false;

// Converte ArrayBuffer para string base64 em chunks para evitar stack overflow
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

async function resolveShowcaseId(courseId, token) {
  try {
    const listResp = await fetch(
      `${UPLOADER_BASE}/api/showcase/list?title=${encodeURIComponent(String(courseId))}`,
      { headers: { "X-API-TOKEN": token } }
    );
    if (listResp.ok) {
      const data = await listResp.json();
      const arr = Array.isArray(data) ? data : [data];
      const exact = arr.find(s => String(s.title) === String(courseId));
      if (exact?.id != null) return exact.id;
    }
  } catch (e) { console.log(`[Upload] showcase list erro: ${e.message}`); }

  const cr = await fetch(`${UPLOADER_BASE}/api/showcase/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-TOKEN": token },
    body: JSON.stringify({ title: String(courseId) }),
  });
  return (await cr.json())?.id ?? null;
}

async function runUploadQueue() {
  if (uploadQueueRunning) return;
  uploadQueueRunning = true;
  let uploadedCount = 0;
  let totalCount = 0;
  while (uploadQueue.length > 0) {
    const { url, filename, courseId, token, editUrl, showcaseId: fixedShowcaseId } = uploadQueue.shift();
    totalCount++;
    console.log(`[Upload] Iniciando: filename="${filename}", courseId=${courseId}, url=${url}`);
    let tabId;

    try {
      // 1. Resolve showcase no service worker (sem abrir aba)
      let showcaseId = fixedShowcaseId;
      if (showcaseId == null) showcaseId = await resolveShowcaseId(courseId, token);
      console.log(`[Upload] showcaseId resolvido: ${showcaseId}`);

      // 2. Busca blob no service worker — bypassa CORS da CDN (host_permissions "https://*/*")
      console.log(`[Upload] Fetch CDN: ${url}`);
      const blobResp = await fetch(url);
      console.log(`[Upload] Fetch CDN: HTTP ${blobResp.status}`);
      if (!blobResp.ok) throw new Error(`Fetch do vídeo falhou: HTTP ${blobResp.status}`);
      const arrayBuffer = await blobResp.arrayBuffer();
      console.log(`[Upload] ArrayBuffer: ${arrayBuffer.byteLength} bytes`);

      // 3. Converter para base64 e dividir em chunks de 8MB para passar via IPC (executeScript)
      const base64Full = arrayBufferToBase64(arrayBuffer);
      const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB por chunk (base64)
      const chunks = [];
      for (let i = 0; i < base64Full.length; i += CHUNK_SIZE) {
        chunks.push(base64Full.slice(i, i + CHUNK_SIZE));
      }
      console.log(`[Upload] base64: ${base64Full.length} chars, ${chunks.length} chunk(s)`);

      // 4. Abrir aba do video-uploader e fazer upload same-origin (resolve CORS da API)
      tabId = await openTab(`${UPLOADER_BASE}/video/upload`, 20000);
      console.log(`[Upload] Aba aberta (tabId=${tabId})`);

      // Inicializar buffer de chunks na aba
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { window._uploadChunks = []; }
      });

      // Enviar cada chunk para a aba via executeScript
      for (let i = 0; i < chunks.length; i++) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (chunk) => { window._uploadChunks.push(chunk); },
          args: [chunks[i]]
        });
      }

      // Executar upload na aba (same-origin → sem 403 CORS)
      const scriptResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (videoFilename, showcaseIdArg, apiToken, baseUrl) => {
          try {
            // Reconstruir Blob a partir dos chunks base64
            const base64 = window._uploadChunks.join("");
            window._uploadChunks = null;
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
            const blob = new Blob([bytes], { type: "video/mp4" });

            // Upload same-origin
            const fd = new FormData();
            fd.append("file", blob, videoFilename);
            if (showcaseIdArg != null) fd.append("showcase", String(showcaseIdArg));
            const uploadResp = await fetch(`${baseUrl}/api/video/upload`, {
              method: "POST",
              headers: { "X-API-TOKEN": apiToken },
              body: fd,
            });
            if (!uploadResp.ok) {
              const text = await uploadResp.text();
              return { ok: false, error: `Upload HTTP ${uploadResp.status}: ${text.slice(0, 200)}` };
            }
            const uploadData = await uploadResp.json();
            if (!uploadData?.successful) return { ok: false, error: JSON.stringify(uploadData).slice(0, 150) };
            return { ok: true, uuid: uploadData.uuid || null };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        },
        args: [filename, showcaseId, token, UPLOADER_BASE]
      });

      const scriptErr = scriptResult?.[0]?.error;
      if (scriptErr) throw new Error(`Script: ${scriptErr.message || JSON.stringify(scriptErr)}`);
      const result = scriptResult?.[0]?.result;
      if (result?.logs) result.logs.forEach(l => console.log(`[Upload/tab]`, l));
      if (!result?.ok) throw new Error(result?.error || "Script retornou erro desconhecido");

      const uuid = result.uuid;
      console.log(`[Upload] uuid: ${uuid}`);
      if (uuid) {
        uploadedCount++;
        console.log(`[Upload] ✅ Sucesso: ${filename} → uuid=${uuid}`);
        if (editUrl) {
          const KEY_RESULTS = "aluraRevisorUploadResults";
          const stored = (await chrome.storage.local.get(KEY_RESULTS))[KEY_RESULTS] || [];
          stored.push({ uuid, editUrl, filename, courseId });
          await chrome.storage.local.set({ [KEY_RESULTS]: stored });
        }
      }
    } catch (err) {
      console.error(`[Upload] ❌ Erro em "${filename}":`, err?.message);
      chrome.notifications.create(String(Date.now()), {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon48.png"),
        title: "Erro no upload",
        message: `${filename.slice(0, 50)}: ${(err?.message || "erro desconhecido").slice(0, 100)}`,
      });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  }
  uploadQueueRunning = false;
  chrome.notifications.create(String(Date.now()), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon48.png"),
    title: "Upload concluído",
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
          const btn = await new Promise(resolve => {
            const start = Date.now();
            const check = () => {
              const found = [...document.querySelectorAll("button")].find(b =>
                b.textContent.trim().toLowerCase().includes("gerar legenda")
              );
              if (found) return resolve(found);
              if (Date.now() - start > 8000) return resolve(null);
              setTimeout(check, 300);
            };
            check();
          });
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
    uploadQueue.push({ url: msg.url, filename: msg.filename, courseId: msg.courseId, token, editUrl: msg.editUrl || null, showcaseId: msg.showcaseId ?? null });
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
    console.log(`[Subcategory] subcategoryId=${msg.subcategoryId}, courseId=${msg.courseId}`);
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

      // Após submit a página navega — não é possível verificar #target. Considera OK.
      console.log(`[Subcategory] resultado: OK`);
      sendResponse({ ok: true });
    } catch (e) {
      console.error("[Subcategory] erro:", e.message);
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
        func: (correctedHours, needsHours, generatedEmenta) => {
          if (needsHours && correctedHours) {
            const el = document.querySelector("input[name='estimatedTimeToFinish']");
            if (el) { el.value = correctedHours; el.dispatchEvent(new Event("change", { bubbles: true })); }
          }
          if (generatedEmenta) {
            const ta = document.querySelector("textarea[name='ementa.raw']");
            if (ta) {
              ta.value = generatedEmenta;
              ta.dispatchEvent(new Event("input", { bubbles: true }));
              ta.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
        },
        args: [msg.correctedHours, msg.needsHours, msg.generatedEmenta || ""]
      });

      if (msg.needsEmenta && !msg.generatedEmenta) await new Promise(r => setTimeout(r, 4000));

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
          const courseCode = document.querySelector("input[name='code']")?.value?.trim() ?? "";
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

          return { courseName, courseCode, estimatedHours, systemEstimatedHours,
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

// ========== Transferência para LATAM ==========

// Helper: aguarda tab completar carregamento (sem fechar)
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    chrome.tabs.onUpdated.addListener(function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// Handler 1: Busca tipo e subtipo de uma task no admin da Alura
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_ALURA_TASK_META") return;

  (async () => {
    let tabId;
    try {
      tabId = await openTab(msg.editUrl);

      // Polling até o select#chooseTask aparecer
      let result = { taskEnum: null, dataTag: null };
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const select = document.querySelector("#chooseTask");
            if (!select) return null;
            const selected = select.options[select.selectedIndex];
            return {
              taskEnum: selected?.dataset?.taskEnum ?? null,
              dataTag: selected?.dataset?.tag ?? null,
            };
          }
        });
        const r = res?.[0]?.result;
        if (r?.taskEnum) { result = r; break; }
        if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 500));
      }

      sendResponse({ ok: true, ...result });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e), taskEnum: null, dataTag: null });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// Handler 2: Busca tradução em espanhol de uma task da Alura
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_FETCH_TRANSLATION") return;

  (async () => {
    let tabId;
    try {
      const taskId = msg.taskId;
      // Tentativa 1: fetch direto do service worker
      try {
        const resp = await fetch(
          `https://cursos.alura.com.br/translate/task/${encodeURIComponent(taskId)}/es`,
          { method: "GET", credentials: "include", cache: "no-store" }
        );
        if (resp.ok) {
          return sendResponse({ ok: true, markdown: await resp.text() });
        }
      } catch (_) { /* fallback */ }

      // Fallback: abrir tab em cursos.alura.com.br e fazer fetch de lá
      tabId = await openTab("https://cursos.alura.com.br/dashboard", 20000);
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (tid) => {
          try {
            const r = await fetch(
              `/translate/task/${encodeURIComponent(tid)}/es`,
              { method: "GET", credentials: "include", cache: "no-store" }
            );
            return { ok: r.ok, markdown: await r.text(), status: r.status };
          } catch (e) {
            return { ok: false, markdown: "", error: e.message };
          }
        },
        args: [taskId],
      });
      const result = res?.[0]?.result ?? { ok: false, markdown: "", error: "executeScript falhou" };
      sendResponse(result);
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// Handler: Busca seções existentes no curso LATAM
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_LATAM_SECTIONS") return;

  (async () => {
    const LATAM_BASE = "https://app.aluracursos.com";
    let tabId;
    try {
      const url = `${LATAM_BASE}/admin/courses/v2/${encodeURIComponent(msg.latamCourseId)}/sections`;
      tabId = await openTab(url, 25000);

      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const rows = document.querySelectorAll("#sectionIds tbody tr");
          return Array.from(rows).map(row => {
            const cells = row.querySelectorAll("td");
            return {
              id: row.id,
              number: parseInt(cells[1]?.textContent?.trim(), 10)
            };
          }).filter(s => s.id && !isNaN(s.number));
        }
      });

      sendResponse({ ok: true, sections: result?.[0]?.result ?? [] });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// Handler 3: Cria nova seção no curso LATAM
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CREATE_LATAM_SECTION") return;

  (async () => {
    const LATAM_BASE = "https://app.aluracursos.com";
    let tabId;
    try {
      const url = `${LATAM_BASE}/admin/courses/v2/${encodeURIComponent(msg.latamCourseId)}/newSection`;
      tabId = await openTab(url, 25000);

      // Preenche sectionName
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (name) => {
          const input = document.querySelector("input[name='sectionName']");
          if (input) {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
              .set.call(input, name);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        args: [msg.sectionName],
      });

      await new Promise(r => setTimeout(r, 300));

      // Submit e aguarda redirect
      const navDone = waitForTabComplete(tabId, 20000);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const btn = document.querySelector("#submit-form__button") ||
                      document.querySelector("button[type='submit']") ||
                      document.querySelector("input[type='submit']");
          if (btn) btn.click();
        },
      });
      await navDone;

      // Extrai sectionId da URL de redirect
      // Formatos esperados:
      //   /admin/course/v2/{courseId}/section/{sectionId}/tasks
      //   /admin/courses/v2/{courseId}/sections
      const finalUrl = (await chrome.tabs.get(tabId)).url;
      const sectionIdMatch = finalUrl.match(/\/section\/(\d+)/);

      // Se redirecionar para lista de seções, busca o ID da última seção da tabela
      if (!sectionIdMatch) {
        const sectionListResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const rows = document.querySelectorAll("#sectionIds tbody tr");
            const lastRow = rows[rows.length - 1];
            return lastRow?.id ?? null;
          }
        });
        const sectionId = sectionListResults?.[0]?.result ?? null;
        if (!sectionId) {
          sendResponse({ ok: false, error: "Seção criada mas não consegui extrair o ID. URL: " + finalUrl });
          return;
        }
        sendResponse({ ok: true, sectionId });
        return;
      }

      sendResponse({ ok: true, sectionId: sectionIdMatch[1] });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// Handler 4: Cria nova task no curso LATAM e preenche todo o conteúdo em uma única tab
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CREATE_LATAM_TASK") return;

  (async () => {
    const LATAM_BASE = "https://app.aluracursos.com";
    let tabId;
    try {
      const url = `${LATAM_BASE}/admin/course/v2/${encodeURIComponent(msg.latamCourseId)}/section/${encodeURIComponent(msg.latamSectionId)}/task/create`;
      console.log(`[Revisor LATAM] CREATE_TASK "${msg.title}" | taskEnum=${msg.taskEnum} | url=${url}`);
      tabId = await openTab(url, 25000);

      // 1. Seleciona o tipo de task e força o campo hidden #taskKind
      const selectResult = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (taskEnum, dataTag) => {
          const select = document.querySelector("#chooseTask");
          if (!select || !taskEnum) return { found: !!select, taskEnum, selected: false };
          // Prioridade: option com dataTag exato → option com value preenchido → fallback header (MULTIPLE_CHOICE não tem sub-options)
          const opts = [...select.options];
          const opt = opts.find(o => o.dataset.taskEnum === taskEnum && (dataTag ? o.dataset.tag === dataTag : true) && o.value)
                   ?? opts.find(o => o.dataset.taskEnum === taskEnum && o.value)
                   ?? opts.find(o => o.dataset.taskEnum === taskEnum);
          if (opt) {
            // Usa selectedIndex para garantir a seleção mesmo quando value="" (ex: MULTIPLE_CHOICE sem sub-options)
            select.selectedIndex = opts.indexOf(opt);
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
          // Força o campo hidden 'kind' diretamente (o JS da página pode não disparar via programático)
          const kindInput = document.querySelector("#taskKind");
          if (kindInput && taskEnum) kindInput.value = taskEnum;
          return { found: true, taskEnum, selected: !!opt, optValue: opt?.value ?? null, optIdx: opt ? opts.indexOf(opt) : -1 };
        },
        args: [msg.taskEnum || null, msg.dataTag || null],
      });
      console.log(`[Revisor LATAM] #chooseTask:`, selectResult?.[0]?.result);

      // 2. Aguarda JS da página processar a mudança de tipo (mostrar campos de conteúdo)
      await new Promise(r => setTimeout(r, 1000));

      // 2b. Para exercícios, cria as alternativas clicando "Add alternative" N vezes
      if ((msg.alternatives || []).length > 0) {
        const needed = msg.alternatives.length;
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (count) => {
            // O botão é <input type="button" class="add-alternative"> — dentro de #taskSpecificFields
            const addBtn = document.querySelector("#taskSpecificFields .add-alternative")
                        || document.querySelector(".add-alternative");
            if (!addBtn) return { addBtn: false };
            const existing = document.querySelectorAll("#taskSpecificFields .fieldGroup-alternative").length;
            const toClick = Math.max(0, count - existing);
            for (let i = 0; i < toClick; i++) addBtn.click();
            return { addBtn: true, existing, toClick };
          },
          args: [needed],
        }).then(r => console.log(`[Revisor LATAM] Add alternative clicks:`, r?.[0]?.result));
        // Aguarda DOM renderizar os novos grupos de alternativa
        await new Promise(r => setTimeout(r, 800));
      }

      // 3. Preenche campos via CodeMirror.setValue() para que o EasyMDE sincronize o
      //    conteúdo ao handler de submit (form.submit() bypassa o handler).
      const fillResult = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (title, body, alternatives, opinion) => {
          const diag = { titleEl: false, cm: false, opinionCm: false, altGroups: 0, form: false, btn: false };

          // Título
          const titleEl = document.querySelector("input[name='title']");
          diag.titleEl = !!titleEl;
          if (titleEl && title) {
            titleEl.value = title;
            titleEl.dispatchEvent(new Event("input", { bubbles: true }));
            titleEl.dispatchEvent(new Event("change", { bubbles: true }));
          }

          // Corpo: usa CodeMirror.setValue() — assim o EasyMDE sincroniza para
          // textHighlighted via seus próprios event listeners (onChange).
          // Busca dentro de #taskSpecificFields para não pegar editors dos templates ocultos.
          if (body) {
            const cmEl = document.querySelector("#taskSpecificFields #text .CodeMirror") ||
                         document.querySelector("#text .CodeMirror") ||
                         document.querySelector(".markdownEditor .CodeMirror");
            const cm = cmEl?.CodeMirror;
            diag.cm = !!cm;
            if (cm) {
              cm.setValue(body);
            } else {
              // Fallback: seta o textarea source + o hidden sync diretamente
              const textarea = document.querySelector("textarea[name='text']");
              if (textarea) {
                textarea.value = body;
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
              }
              const syncInput = document.querySelector("input.hackeditor-sync[name='textHighlighted']");
              if (syncInput) syncInput.value = body;
            }
          }

          // Opinião do instrutor (campo #opinion — presente em TEXT_CONTENT / DO_AFTER_ME)
          if (opinion) {
            const opCmEl = document.querySelector("#taskSpecificFields #opinion .CodeMirror") ||
                           document.querySelector("#opinion .CodeMirror");
            const opCm = opCmEl?.CodeMirror;
            diag.opinionCm = !!opCm;
            if (opCm) {
              opCm.setValue(opinion);
            } else {
              const opTextarea = document.querySelector("textarea[name='opinion']");
              if (opTextarea) { opTextarea.value = opinion; opTextarea.dispatchEvent(new Event("input", { bubbles: true })); }
              const opSync = document.querySelector("input.hackeditor-sync[name='opinionHighlighted']");
              if (opSync) opSync.value = opinion;
            }
          }

          // Alternativas (SINGLE_CHOICE / MULTIPLE_CHOICE)
          // Busca dentro de #taskSpecificFields para evitar pegar os templates ocultos em .taskForms
          if (alternatives && alternatives.length > 0) {
            const altGroups = [...document.querySelectorAll("#taskSpecificFields .fieldGroup-alternative")];
            diag.altGroups = altGroups.length;
            alternatives.forEach((alt, i) => {
              if (!altGroups[i]) return;
              // Cada alternativa tem DOIS CodeMirror: [0]=texto, [1]=opinião — ambos obrigatórios
              const allCmEls = [...altGroups[i].querySelectorAll(".CodeMirror")];
              const textCm = allCmEls[0]?.CodeMirror;
              const opinionCm = allCmEls[1]?.CodeMirror;
              const opinionText = alt.justification || (alt.correct ? "Respuesta correcta." : "Respuesta incorrecta.");

              if (textCm) {
                if (alt.body) textCm.setValue(alt.body);
              } else {
                // Fallback textarea para texto
                const altTextarea = altGroups[i].querySelector("textarea[name*='.text']");
                const altSync = altGroups[i].querySelector("input.hackeditor-sync[name*='.textHighlighted']");
                if (altTextarea && alt.body) { altTextarea.value = alt.body; altTextarea.dispatchEvent(new Event("input", { bubbles: true })); }
                if (altSync && alt.body) altSync.value = alt.body;
              }

              if (opinionCm) {
                opinionCm.setValue(opinionText);
              } else {
                // Fallback textarea para opinião
                const opTextarea = altGroups[i].querySelector("textarea[name*='.opinion']");
                const opSync = altGroups[i].querySelector("input.hackeditor-sync[name*='.opinionHighlighted']");
                if (opTextarea) { opTextarea.value = opinionText; opTextarea.dispatchEvent(new Event("input", { bubbles: true })); }
                if (opSync) opSync.value = opinionText;
              }

              if (alt.correct) {
                const correctEl = altGroups[i].querySelector("input.fieldGroup-alternative-actions-correct");
                if (correctEl && !correctEl.checked) correctEl.click();
              }
            });
          }

          return diag;
        },
        args: [msg.title || "", msg.body || "", msg.alternatives || [], msg.opinion || ""],
      });
      console.log(`[Revisor LATAM] Form fill diag:`, fillResult?.[0]?.result);

      // Luri: marcar checkbox singleChoiceCanUseAsOpenTask quando enhancedByLuri=true
      if (msg.enhancedByLuri) {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const cb = document.querySelector("input[name='singleChoiceCanUseAsOpenTask']");
            if (cb && !cb.checked) { cb.click(); cb.dispatchEvent(new Event("change", { bubbles: true })); }
            return { found: !!cb, checked: cb?.checked };
          },
        }).then(r => console.log(`[Revisor LATAM] singleChoiceCanUseAsOpenTask:`, r?.[0]?.result));
      }

      // 4. Aguarda o EasyMDE sincronizar o valor do CM para textHighlighted via onChange
      await new Promise(r => setTimeout(r, 500));

      // 5. Clica no botão de submit (aciona o handler da página que faz o sync final
      //    CM → textHighlighted antes de enviar o formulário)
      const navDone = waitForTabComplete(tabId, 25000);
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const btn = document.querySelector("#submitTask") ||
                      document.querySelector("button[type='submit']") ||
                      document.querySelector("input[type='submit']");
          if (btn) {
            btn.click();
          } else {
            // Último recurso: form.submit() direto
            const form = document.querySelector("#taskForm") || document.querySelector("form");
            if (form) form.submit();
          }
        },
      });
      await navDone;

      sendResponse({ ok: true });
    } catch (e) {
      console.error("[Revisor LATAM] CREATE_LATAM_TASK erro:", e?.message);
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// ---------- Chamar Claude API (Anthropic) ----------
let _claudeApiKeyCache = null;

async function getClaudeApiKey() {
  if (_claudeApiKeyCache) return _claudeApiKeyCache;
  try {
    const res = await fetch("https://hub-producao-conteudo.vercel.app/api/revisor/config", {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return "";
    const data = await res.json();
    const key = data?.claude_api_key || "";
    if (key) _claudeApiKeyCache = key;
    return key;
  } catch {
    return "";
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CALL_CLAUDE") return;

  (async () => {
    try {
      const { prompt } = msg;
      if (!prompt) return sendResponse({ ok: false, error: "Prompt ausente." });

      const apiKey = await getClaudeApiKey();
      if (!apiKey) return sendResponse({ ok: false, error: "Claude API Key não configurada no hub." });

      const body = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      });

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return sendResponse({ ok: false, error: `Claude API HTTP ${resp.status}: ${errText.slice(0, 300)}` });
      }

      const data = await resp.json();
      const outputText = data?.content?.[0]?.text?.trim() || "";
      sendResponse({ ok: true, outputText });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true;
});

// ---------- Renomear seção no admin ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_RENAME_SECTION") return;

  (async () => {
    let tabId;
    try {
      const baseUrl = new URL(sender.url).origin;
      const url = `${baseUrl}/admin/courses/v2/${encodeURIComponent(msg.courseId)}/sections/${encodeURIComponent(msg.sectionId)}`;
      tabId = await openTab(url);

      // Preenche o campo de nome da seção
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (newName) => {
          const input =
            document.querySelector("input[name='sectionName']") ||
            document.querySelector("input[name='name']") ||
            document.querySelector("input[name='title']") ||
            document.querySelector("input[name='nome']") ||
            document.querySelector("form input[type='text']");

          if (!input) throw new Error("Campo de nome da seção não encontrado.");

          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
            .set.call(input, newName);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        args: [msg.newName],
      });

      await new Promise(r => setTimeout(r, 300));

      // Clica em Salvar e aguarda redirect
      const navDone = waitForTabComplete(tabId, 15000);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const btn =
            document.querySelector("#submit-form__button") ||
            document.querySelector("button[type='submit']") ||
            document.querySelector("input[type='submit']") ||
            [...document.querySelectorAll("button")].find(b => b.textContent.trim().toLowerCase() === "salvar");
          if (btn) btn.click();
        },
      });
      await navDone;

      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// ================================================================
// ---------- Criação de Cursos Caixaverso ----------
// ================================================================

async function waitForTabNavigation(tabId, urlPattern, timeoutMs = 30000, excludeUrl = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("timeout aguardando navegação"));
    }, timeoutMs);

    function listener(id, info, tab) {
      if (id !== tabId || info.status !== "complete") return;
      const url = tab.url || "";
      if (excludeUrl && url === excludeUrl) return; // ainda na mesma página
      if (urlPattern.test(url)) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Cria um curso no admin e retorna o ID e slug
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CREATE_CAIXAVERSO_COURSE") return;

  (async () => {
    let tabId;
    console.log(`[Caixaverso] Criando curso: "${msg.fullName}" (slug: ${msg.slug})`);
    try {
      const baseUrl = new URL(sender.url).origin;
      tabId = await openTab(`${baseUrl}/admin/v2/newCourse`);

      // Aguardar o React renderizar o formulário (pode demorar após o status "complete")
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => new Promise(resolve => {
          const deadline = Date.now() + 10000;
          (function check() {
            // Aguardar pelo menos um input de texto no formulário
            if (document.querySelector('form input[type="text"], form input:not([type]), form textarea')) {
              resolve();
            } else if (Date.now() < deadline) {
              setTimeout(check, 300);
            } else {
              resolve(); // continua mesmo assim para capturar o diagnóstico
            }
          })();
        }),
      });

      // Preencher campos de texto (dispara eventos que podem causar re-render)
      const fillResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: ({ fullName, slug }) => {
          function setVal(el, val) {
            if (!el) return;
            try {
              const nativeSetter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value");
              if (nativeSetter?.set) nativeSetter.set.call(el, val);
              else el.value = val;
            } catch (_) { el.value = val; }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }

          const nameInput = document.querySelector('[name="name"]');
          setVal(nameInput, fullName);

          const codeInput = document.querySelector('[name="code"]');
          setVal(codeInput, slug);

          const workloadInput = document.querySelector('[name="estimatedTimeToFinish"]');
          setVal(workloadInput, "4");

          const metaInput = document.querySelector('[name="metadescription"]');
          setVal(metaInput, "Assista à gravação da aula ao vivo e revise o conteúdo quando quiser, dentro do seu prazo de acesso.");

          const authorSelect = document.querySelector('[name="authors"]');
          if (authorSelect) {
            const opt = authorSelect.querySelector('option[value="1412583"]');
            if (opt) {
              opt.selected = true;
              authorSelect.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }

          return {
            nameFound: !!nameInput,
            codeFound: !!codeInput,
            workloadFound: !!workloadInput,
            metaFound: !!metaInput,
          };
        },
        args: [{ fullName: msg.fullName, slug: msg.slug }]
      });

      const diag = fillResult?.[0]?.result;
      console.log("[Caixaverso] Campos de texto:", diag);
      if (diag && (!diag.nameFound || !diag.codeFound)) {
        throw new Error(`Campos não encontrados. nome=${diag.nameFound}, código=${diag.codeFound}`);
      }

      console.log("[Caixaverso] Submetendo formulário de criação…");

      // Trazer a aba para frente — React pode não processar submit em abas em background
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(r => setTimeout(r, 300));

      // Registrar listener ANTES de submeter — exclui a URL atual para não resolver antes de navegar
      const currentTabUrl = `${baseUrl}/admin/v2/newCourse`;
      const navDone = waitForTabNavigation(tabId, /\/admin\//, 45000, currentTabUrl);

      // Submeter o formulário
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
          if (submitBtn) submitBtn.click();
        }
      });

      // Aguardar redirect para /admin/courses (listagem ou edição)
      await navDone;

      // Scrape do ID e slug do curso recém criado.
      // O admin pode redirecionar para a listagem (/admin/courses) ou para a página
      // de edição (/admin/courses/v2/{id}). Tratamos os dois casos.
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const url = location.href;
          const pathname = location.pathname;

          // Caso 1: redirecionou para a listagem — pega a primeira linha da tabela
          const firstRow = document.querySelector("table tbody tr");
          if (firstRow) {
            return {
              courseId: firstRow.cells[0]?.textContent?.trim() ?? "",
              courseSlug: firstRow.cells[1]?.textContent?.trim() ?? "",
              _via: "table",
              _url: url,
            };
          }
          // Caso 2: /admin/courses/v2/{id}
          const m2 = pathname.match(/\/admin\/courses\/v2\/(\d+)/);
          if (m2) {
            const slugInput = document.querySelector('[name="code"]');
            return { courseId: m2[1], courseSlug: slugInput?.value?.trim() ?? "", _via: "v2", _url: url };
          }
          // Caso 3: /admin/v2/courses/{id} (URL alternativa)
          const m3 = pathname.match(/\/admin\/(?:v2\/)?courses?\/(\d+)/);
          if (m3) {
            const slugInput = document.querySelector('[name="code"]');
            return { courseId: m3[1], courseSlug: slugInput?.value?.trim() ?? "", _via: "v2alt", _url: url };
          }
          // Caso 4: ID no query string (?id=XXX ou ?courseId=XXX)
          const qs = new URLSearchParams(location.search);
          const qsId = qs.get("id") || qs.get("courseId");
          if (qsId) {
            return { courseId: qsId, courseSlug: "", _via: "qs", _url: url };
          }
          return { courseId: null, _url: url, _html: document.title };
        }
      });

      const data = results?.[0]?.result;
      console.log("[Caixaverso] Scrape resultado:", data);
      if (!data?.courseId) throw new Error(`Não foi possível obter o ID do curso criado. URL pós-redirect: ${data?._url ?? "desconhecida"}`);

      // Marcar "Exclusivo" na página de edição (form HTML tradicional, sem React)
      console.log(`[Caixaverso] Marcando Exclusivo para o curso ${data.courseId}…`);
      const baseUrl2 = new URL(sender.url).origin;
      const editTabId = await openTab(`${baseUrl2}/admin/courses/v2/${data.courseId}`, 15000);
      try {
        const chkResult = await chrome.scripting.executeScript({
          target: { tabId: editTabId },
          func: () => {
            const exclusive = document.querySelector("#courseExclusive");
            if (exclusive && !exclusive.checked) exclusive.click();
            return {
              exclusive: document.querySelector("#courseExclusive")?.checked,
              blockForum: document.querySelector("#isToBlockForum")?.checked,
              forumExclusive: document.querySelector("#hasExclusiveForum")?.checked,
            };
          },
        });
        console.log("[Caixaverso] Checkboxes após click Exclusivo:", chkResult?.[0]?.result);

        // Aguardar e desmarcar qualquer checkbox de fórum que foi auto-marcado
        await new Promise(r => setTimeout(r, 400));
        const chkResult2 = await chrome.scripting.executeScript({
          target: { tabId: editTabId },
          func: () => {
            const blockForum = document.querySelector("#isToBlockForum");
            if (blockForum?.checked) blockForum.click();
            const forumExclusive = document.querySelector("#hasExclusiveForum");
            if (forumExclusive?.checked) forumExclusive.click();
            return {
              exclusive: document.querySelector("#courseExclusive")?.checked,
              blockForum: document.querySelector("#isToBlockForum")?.checked,
              forumExclusive: document.querySelector("#hasExclusiveForum")?.checked,
            };
          },
        });
        console.log("[Caixaverso] Checkboxes finais:", chkResult2?.[0]?.result);

        await new Promise(r => setTimeout(r, 300));

        const editNavDone = waitForTabNavigation(editTabId, /\/admin\/courses/, 15000);
        await chrome.scripting.executeScript({
          target: { tabId: editTabId },
          func: () => {
            const btn = document.querySelector('input[type="submit"], button[type="submit"], #submitForm');
            if (btn) btn.click();
          },
        });
        await editNavDone;
        console.log("[Caixaverso] Exclusivo salvo.");
      } catch (e) {
        console.warn("[Caixaverso] Aviso ao salvar Exclusivo:", e.message);
      } finally {
        chrome.tabs.remove(editTabId).catch(() => {});
      }

      console.log(`[Caixaverso] Curso criado: ID=${data.courseId}, slug=${data.courseSlug}`);
      sendResponse({ ok: true, courseId: data.courseId, courseSlug: data.courseSlug });
    } catch (e) {
      console.error("[Caixaverso] Erro ao criar curso:", e.message);
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// Define subcategoria e catálogo Caixa Econômica Federal no curso
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_SET_CAIXAVERSO_COURSE_DETAILS") return;

  (async () => {
    const baseUrl = new URL(sender.url).origin;
    let subcatTabId, catalogTabId;
    let subcatOk = false, catalogOk = false;

    try {
      // 1. Subcategoria — mesmo padrão do ALURA_REVISOR_ADD_TO_SUBCATEGORY:
      //    abre /admin/subcategories/{id}/edit, busca o courseId no #source, move para #target, salva
      subcatTabId = await openTab(`${baseUrl}/admin/subcategories/${msg.subcategoryId}/edit`, 15000);

      const subcatStep = await chrome.scripting.executeScript({
        target: { tabId: subcatTabId },
        func: async (courseId) => {
          const search = document.querySelector("#searchSource");
          if (search) {
            search.value = String(courseId);
            search.dispatchEvent(new Event("input", { bubbles: true }));
            await new Promise(r => setTimeout(r, 1200));
          }
          const item = document.querySelector(`#source .connectedSortable_v2-item[title="${courseId}"]`);
          if (!item) return { ok: false, error: `Curso ${courseId} não encontrado na subcategoria` };
          item.querySelector(".connectedSortable_v2-item-checkbox")?.click();
          return { ok: true };
        },
        args: [msg.courseId],
      });

      if (subcatStep?.[0]?.result?.ok) {
        await new Promise(r => setTimeout(r, 400));
        await chrome.scripting.executeScript({
          target: { tabId: subcatTabId },
          func: () => { document.querySelector(".connectedSortable_v2-moveRight")?.click(); },
        });
        await new Promise(r => setTimeout(r, 400));

        const navDone = new Promise(resolve => {
          const timer = setTimeout(resolve, 10000);
          chrome.tabs.onUpdated.addListener(function listener(id, info) {
            if (id === subcatTabId && info.status === "complete") {
              clearTimeout(timer);
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          });
        });
        chrome.scripting.executeScript({
          target: { tabId: subcatTabId },
          func: () => { document.querySelector("#submitForm")?.click(); },
        }).catch(() => {});
        await navDone;

        // Após submit a página navega — não é possível verificar #target. Considera OK.
        subcatOk = true;
      }

      chrome.tabs.remove(subcatTabId).catch(() => {});
      subcatTabId = null;

      // 2. Catálogo — mesmo padrão do ALURA_REVISOR_ADD_TO_CATALOG:
      //    abre /admin/catalogs/contents/course/{id}, encontra "Caixa Econômica Federal" em #source, move, salva
      catalogTabId = await openCatalogTab(msg.courseId, baseUrl);

      const catStep = await chrome.scripting.executeScript({
        target: { tabId: catalogTabId },
        func: (catalogLabel) => {
          const sourceEl = document.querySelector("#source");
          if (!sourceEl) return { ok: false, error: "Seletor de catálogos não encontrado" };
          for (const item of sourceEl.querySelectorAll(".connectedSortable_v2-item")) {
            const label = item.querySelector(".connectedSortable_v2-item-label");
            // label.textContent pode ter sufixo como "(75)", então usa includes
            if (label && label.textContent.trim().includes(catalogLabel)) {
              const checkbox = item.querySelector(".connectedSortable_v2-item-checkbox");
              if (!checkbox) return { ok: false, error: `Checkbox de "${catalogLabel}" não encontrado` };
              checkbox.click();
              return { ok: true };
            }
          }
          return { ok: false, error: `Catálogo "${catalogLabel}" não encontrado` };
        },
        args: ["Caixa Econômica Federal"],
      });

      if (catStep?.[0]?.result?.ok) {
        await new Promise(r => setTimeout(r, 400));
        await chrome.scripting.executeScript({
          target: { tabId: catalogTabId },
          func: () => { document.querySelector(".connectedSortable_v2-moveRight")?.click(); },
        });
        await new Promise(r => setTimeout(r, 400));

        const navDone = new Promise(resolve => {
          const timer = setTimeout(resolve, 10000);
          chrome.tabs.onUpdated.addListener(function listener(id, info) {
            if (id === catalogTabId && info.status === "complete") {
              clearTimeout(timer);
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          });
        });
        chrome.scripting.executeScript({
          target: { tabId: catalogTabId },
          func: () => { document.querySelector("#submitForm")?.click(); },
        }).catch(() => {});
        await navDone;

        // Após submit a página navega — não é possível verificar #target. Considera OK.
        catalogOk = true;
      }

      sendResponse({ ok: true, subcatOk, catalogOk });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e), subcatOk, catalogOk });
    } finally {
      if (subcatTabId != null) chrome.tabs.remove(subcatTabId).catch(() => {});
      if (catalogTabId != null) chrome.tabs.remove(catalogTabId).catch(() => {});
    }
  })();

  return true;
});

// Sobe todos os ícones Caixaverso em um único commit via GitHub Trees API
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_UPLOAD_ICONS_BATCH") return;

  (async () => {
    const { courseSlugList, categorySlug } = msg;
    const pat = await getGithubToken();
    const repo = "caelum/gnarus-api-assets";
    const branch = "master";
    const basePath = "alura/assets/api/cursos";

    try {
      // SVG template
      const svgResp = await fetch(chrome.runtime.getURL(`icons/${categorySlug}.svg`));
      if (!svgResp.ok) throw new Error(`SVG ${categorySlug}.svg não encontrado`);
      const svgText = await svgResp.text();
      const base64 = btoa(unescape(encodeURIComponent(svgText)));

      const headers = {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      };

      // SHA do branch atual
      const refResp = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, { headers });
      const refData = await refResp.json();
      const latestCommitSha = refData.object.sha;

      // tree SHA do commit atual
      const commitResp = await fetch(`https://api.github.com/repos/${repo}/git/commits/${latestCommitSha}`, { headers });
      const commitData = await commitResp.json();
      const baseTreeSha = commitData.tree.sha;

      // Criar blob único (mesmo conteúdo para todos os cursos)
      const blobResp = await fetch(`https://api.github.com/repos/${repo}/git/blobs`, {
        method: "POST", headers,
        body: JSON.stringify({ content: base64, encoding: "base64" }),
      });
      const blobData = await blobResp.json();
      const blobSha = blobData.sha;

      // Nova tree com todos os arquivos
      const treeEntries = courseSlugList.map(slug => ({
        path: `${basePath}/${slug}.svg`,
        mode: "100644",
        type: "blob",
        sha: blobSha,
      }));

      const newTreeResp = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
        method: "POST", headers,
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      });
      const newTreeData = await newTreeResp.json();

      // Criar commit
      const slugsSummary = courseSlugList.slice(0, 3).join(", ") + (courseSlugList.length > 3 ? "…" : "");
      const newCommitResp = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
        method: "POST", headers,
        body: JSON.stringify({
          message: `Add icons for Caixaverso courses: ${slugsSummary}`,
          tree: newTreeData.sha,
          parents: [latestCommitSha],
        }),
      });
      const newCommitData = await newCommitResp.json();

      // Atualizar branch reference
      const updateRefResp = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ sha: newCommitData.sha }),
      });

      sendResponse({ ok: updateRefResp.status === 200 });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true;
});

// ========== Upload de vídeos do Dropbox para VideoUploader ==========

const DROPBOX_UPLOAD_QUEUE = [];
let dropboxUploadRunning = false;

const KEY_DROPBOX_UPLOAD = "aluraRevisorDropboxUploadState";

async function getDropboxToken() {
  const data = await chrome.storage.local.get([
    "aluraRevisorDropboxToken", "aluraRevisorDropboxRefreshToken",
    "aluraRevisorDropboxTokenExpiry", "aluraRevisorDropboxClientId",
  ]);
  if (!data?.aluraRevisorDropboxRefreshToken) {
    return data?.aluraRevisorDropboxToken || "";
  }
  // Renovar se expirado ou faltam menos de 5 minutos
  if (Date.now() < (data.aluraRevisorDropboxTokenExpiry || 0) - 5 * 60 * 1000) {
    return data.aluraRevisorDropboxToken;
  }
  console.log("[Dropbox] Renovando access token…");
  const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: data.aluraRevisorDropboxRefreshToken,
      client_id: data.aluraRevisorDropboxClientId,
    }),
  });
  if (!resp.ok) {
    console.warn("[Dropbox] Falha ao renovar token:", resp.status);
    return data?.aluraRevisorDropboxToken || "";
  }
  const tokens = await resp.json();
  await chrome.storage.local.set({
    aluraRevisorDropboxToken: tokens.access_token,
    aluraRevisorDropboxTokenExpiry: Date.now() + (tokens.expires_in ?? 14400) * 1000,
  });
  console.log("[Dropbox] Token renovado.");
  return tokens.access_token;
}

async function getDropboxTempLink(previewUrl, dropboxToken) {
  // Extrai o caminho do arquivo da preview URL
  // Formato: https://www.dropbox.com/preview/Pasta/SubPasta/arquivo.mp4?...
  const url = new URL(previewUrl);
  const m = url.pathname.match(/^\/preview\/(.+)$/);
  if (!m) throw new Error(`Não foi possível extrair o caminho do arquivo da URL: ${previewUrl}`);
  const filePath = "/" + decodeURIComponent(m[1]);
  console.log(`[DropboxUpload] filePath para API: ${filePath}`);

  const resp = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${dropboxToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: filePath }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dropbox API HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.link; // URL CDN temporária (válida por 4h)
}

async function saveDropboxUploadHistory(results, grandTotal) {
  const KEY_HISTORY = "aluraRevisorHistory";
  const errors = results.filter(r => !r.ok).length;
  const entry = {
    type: "dropboxUpload",
    runAt: Date.now(),
    total: grandTotal,
    errors,
    ok: grandTotal - errors,
    results,
  };
  const data = await chrome.storage.local.get(KEY_HISTORY);
  const history = data?.[KEY_HISTORY] || [];
  history.unshift(entry);
  if (history.length > 50) history.splice(50);
  await chrome.storage.local.set({ [KEY_HISTORY]: history });
}

async function runDropboxUploadQueue() {
  if (dropboxUploadRunning) return;
  dropboxUploadRunning = true;
  let ok = 0, total = 0;
  const grandTotal = DROPBOX_UPLOAD_QUEUE.length;
  const uploadResults = [];

  console.log(`[DropboxUpload] iniciando fila: ${grandTotal} arquivo(s)`);
  console.log(`[DropboxUpload] token uploader presente: ${!!DROPBOX_UPLOAD_QUEUE[0]?.token?.uploader}`);
  console.log(`[DropboxUpload] token dropbox presente: ${!!DROPBOX_UPLOAD_QUEUE[0]?.token?.dropbox}`);

  await chrome.storage.local.set({
    [KEY_DROPBOX_UPLOAD]: { running: true, done: 0, total: grandTotal, currentFile: "", errors: 0 }
  });

  while (DROPBOX_UPLOAD_QUEUE.length > 0) {
    const { filename, previewUrl, token } = DROPBOX_UPLOAD_QUEUE.shift();
    total++;

    console.log(`[DropboxUpload] [${total}/${grandTotal}] iniciando: "${filename}"`);
    console.log(`[DropboxUpload] previewUrl: ${previewUrl}`);

    await chrome.storage.local.set({
      [KEY_DROPBOX_UPLOAD]: { running: true, done: ok, total: grandTotal, currentFile: filename, errors: total - 1 - ok }
    });

    try {
      // 1. Obter URL CDN temporária via Dropbox API
      console.log(`[DropboxUpload] chamando Dropbox API get_temporary_link...`);
      const tempLink = await getDropboxTempLink(previewUrl, token.dropbox);
      console.log(`[DropboxUpload] tempLink: ${tempLink}`);

      // 2. Abrir aba do video-uploader e executar fetch+upload de lá (same-origin para a API,
      //    sem precisar de sessão — o X-API-TOKEN é a autenticação)
      let uploaderTabId = await openTab(`${UPLOADER_BASE}/video/upload`, 20000);
      try {
        console.log(`[DropboxUpload] aba uploader aberta (tabId=${uploaderTabId}), executando upload...`);
        const upResult = await chrome.scripting.executeScript({
          target: { tabId: uploaderTabId },
          func: async (videoUrl, videoFilename, apiToken, baseUrl) => {
            try {
              console.log(`[DropboxUpload/tab] fetch vídeo: ${videoUrl.slice(0, 80)}...`);
              const blobResp = await fetch(videoUrl);
              console.log(`[DropboxUpload/tab] fetch vídeo: HTTP ${blobResp.status}`);
              if (!blobResp.ok) return { ok: false, error: `Fetch vídeo HTTP ${blobResp.status}` };
              const blob = await blobResp.blob();
              console.log(`[DropboxUpload/tab] blob: ${blob.size} bytes, type="${blob.type}"`);
              const fd = new FormData();
              fd.append("file", blob, videoFilename);
              fd.append("showcase", "1123");
              console.log(`[DropboxUpload/tab] enviando para VideoUploader...`);
              const up = await fetch(`${baseUrl}/api/video/upload`, {
                method: "POST",
                headers: { "X-API-TOKEN": apiToken },
                body: fd,
              });
              console.log(`[DropboxUpload/tab] upload HTTP ${up.status}`);
              if (!up.ok) {
                const errText = await up.text();
                return { ok: false, error: `Upload HTTP ${up.status}: ${errText.slice(0, 200)}` };
              }
              const data = await up.json();
              console.log(`[DropboxUpload/tab] JSON:`, JSON.stringify(data).slice(0, 300));
              return data?.successful
                ? { ok: true, uuid: data.uuid }
                : { ok: false, error: JSON.stringify(data).slice(0, 150) };
            } catch (e) {
              return { ok: false, error: e.message };
            }
          },
          args: [tempLink, filename, token.uploader, UPLOADER_BASE],
        });

        const r = upResult?.[0]?.result;
        console.log(`[DropboxUpload] resultado:`, r);
        if (r?.ok) {
          ok++;
          console.log(`[DropboxUpload] ✅ ${filename} → uuid=${r.uuid}`);
          uploadResults.push({ filename, ok: true });
        } else {
          throw new Error(r?.error || "Upload falhou sem erro específico");
        }
      } finally {
        chrome.tabs.remove(uploaderTabId).catch(() => {});
      }
    } catch (err) {
      console.error(`[DropboxUpload] ❌ ${filename}:`, err.message);
      uploadResults.push({ filename, ok: false, error: err.message });
    }
  }

  dropboxUploadRunning = false;
  const errors = grandTotal - ok;
  await chrome.storage.local.set({
    [KEY_DROPBOX_UPLOAD]: { running: false, done: ok, total: grandTotal, errors }
  });
  await saveDropboxUploadHistory(uploadResults, grandTotal);
  chrome.notifications.create(String(Date.now()), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon48.png"),
    title: errors === 0 ? `Upload Caixaverso ✅` : `Upload Caixaverso ⚠️`,
    message: errors === 0
      ? `${grandTotal} vídeo(s) enviados com sucesso.`
      : `${ok}/${grandTotal} enviados · ${errors} erro(s). Veja o relatório no popup.`,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type !== "ALURA_REVISOR_DROPBOX_UPLOAD") return;

  (async () => {
    const uploaderToken = await getUploaderToken();
    const dropboxToken = await getDropboxToken();
    console.log(`[DropboxUpload] mensagem recebida: ${(msg.files || []).length} arquivo(s)`);
    console.log(`[DropboxUpload] uploader token: ${uploaderToken ? uploaderToken.slice(0,8) + "..." : "VAZIO"}`);
    console.log(`[DropboxUpload] dropbox token: ${dropboxToken ? dropboxToken.slice(0,8) + "..." : "VAZIO"}`);
    const token = { uploader: uploaderToken, dropbox: dropboxToken };
    for (const f of (msg.files || [])) {
      DROPBOX_UPLOAD_QUEUE.push({ ...f, token });
    }
    runDropboxUploadQueue();
    sendResponse({ ok: true });
  })();

  return true;
});

// Handler: Busca seções existentes no curso Alura (BR)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_GET_ALURA_SECTIONS") return;

  (async () => {
    const ALURA_BASE = "https://cursos.alura.com.br";
    let tabId;
    try {
      const url = `${ALURA_BASE}/admin/courses/v2/${encodeURIComponent(msg.aluraCourseId)}/sections`;
      tabId = await openTab(url, 25000);

      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const rows = document.querySelectorAll("#sectionIds tbody tr");
          return Array.from(rows).map(row => {
            const cells = row.querySelectorAll("td");
            return {
              id: row.id,
              number: parseInt(cells[1]?.textContent?.trim(), 10)
            };
          }).filter(s => s.id && !isNaN(s.number));
        }
      });

      sendResponse({ ok: true, sections: result?.[0]?.result ?? [] });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// ── Alura (BR) section creation — mesma lógica do LATAM, base URL diferente ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CREATE_ALURA_SECTION") return;

  (async () => {
    const ALURA_BASE = "https://cursos.alura.com.br";
    let tabId;
    try {
      const url = `${ALURA_BASE}/admin/courses/v2/${encodeURIComponent(msg.aluraCourseId)}/newSection`;
      tabId = await openTab(url, 25000);

      await chrome.scripting.executeScript({
        target: { tabId },
        func: (name) => {
          const input = document.querySelector("input[name='sectionName']");
          if (input) {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
              .set.call(input, name);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        args: [msg.sectionName],
      });

      await new Promise(r => setTimeout(r, 300));

      const navDone = waitForTabComplete(tabId, 20000);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const btn = document.querySelector("#submit-form__button") ||
                      document.querySelector("button[type='submit']") ||
                      document.querySelector("input[type='submit']");
          if (btn) btn.click();
        },
      });
      await navDone;

      const finalUrl = (await chrome.tabs.get(tabId)).url;
      const sectionIdMatch = finalUrl.match(/\/section\/(\d+)/);

      if (!sectionIdMatch) {
        const sectionListResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const rows = document.querySelectorAll("#sectionIds tbody tr");
            const lastRow = rows[rows.length - 1];
            return lastRow?.id ?? null;
          }
        });
        const sectionId = sectionListResults?.[0]?.result ?? null;
        if (!sectionId) {
          sendResponse({ ok: false, error: "Seção criada mas não consegui extrair o ID. URL: " + finalUrl });
          return;
        }
        sendResponse({ ok: true, sectionId });
        return;
      }

      sendResponse({ ok: true, sectionId: sectionIdMatch[1] });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// ── Alura (BR) task creation — mesma lógica do LATAM, base URL diferente ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidSender(sender)) return;
  if (msg?.type !== "ALURA_REVISOR_CREATE_ALURA_TASK") return;

  (async () => {
    const ALURA_BASE = "https://cursos.alura.com.br";
    let tabId;
    try {
      const url = `${ALURA_BASE}/admin/course/v2/${encodeURIComponent(msg.aluraCourseId)}/section/${encodeURIComponent(msg.aluraSectionId)}/task/create`;
      console.log(`[Revisor Alura] CREATE_TASK "${msg.title}" | taskEnum=${msg.taskEnum} | url=${url}`);
      tabId = await openTab(url, 25000);

      const selectResult = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (taskEnum, dataTag) => {
          const select = document.querySelector("#chooseTask");
          if (!select || !taskEnum) return { found: !!select, taskEnum, selected: false };
          const opts = [...select.options];
          const opt = opts.find(o => o.dataset.taskEnum === taskEnum && (dataTag ? o.dataset.tag === dataTag : true) && o.value)
                   ?? opts.find(o => o.dataset.taskEnum === taskEnum && o.value)
                   ?? opts.find(o => o.dataset.taskEnum === taskEnum);
          if (opt) {
            select.selectedIndex = opts.indexOf(opt);
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const kindInput = document.querySelector("#taskKind");
          if (kindInput && taskEnum) kindInput.value = taskEnum;
          return { found: true, taskEnum, selected: !!opt, optValue: opt?.value ?? null, optIdx: opt ? opts.indexOf(opt) : -1 };
        },
        args: [msg.taskEnum || null, msg.dataTag || null],
      });
      console.log(`[Revisor Alura] #chooseTask:`, selectResult?.[0]?.result);

      await new Promise(r => setTimeout(r, 1000));

      if ((msg.alternatives || []).length > 0) {
        const needed = msg.alternatives.length;
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (count) => {
            const addBtn = document.querySelector("#taskSpecificFields .add-alternative")
                        || document.querySelector(".add-alternative");
            if (!addBtn) return { addBtn: false };
            const existing = document.querySelectorAll("#taskSpecificFields .fieldGroup-alternative").length;
            const toClick = Math.max(0, count - existing);
            for (let i = 0; i < toClick; i++) addBtn.click();
            return { addBtn: true, existing, toClick };
          },
          args: [needed],
        }).then(r => console.log(`[Revisor Alura] Add alternative clicks:`, r?.[0]?.result));
        await new Promise(r => setTimeout(r, 800));
      }

      const fillResult = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (title, body, alternatives, opinion) => {
          const diag = { titleEl: false, cm: false, opinionCm: false, altGroups: 0, form: false, btn: false };

          const titleEl = document.querySelector("input[name='title']");
          diag.titleEl = !!titleEl;
          if (titleEl && title) {
            titleEl.value = title;
            titleEl.dispatchEvent(new Event("input", { bubbles: true }));
            titleEl.dispatchEvent(new Event("change", { bubbles: true }));
          }

          if (body) {
            const cmEl = document.querySelector("#taskSpecificFields #text .CodeMirror") ||
                         document.querySelector("#text .CodeMirror") ||
                         document.querySelector(".markdownEditor .CodeMirror");
            const cm = cmEl?.CodeMirror;
            diag.cm = !!cm;
            if (cm) {
              cm.setValue(body);
            } else {
              const textarea = document.querySelector("textarea[name='text']");
              if (textarea) {
                textarea.value = body;
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
              }
              const syncInput = document.querySelector("input.hackeditor-sync[name='textHighlighted']");
              if (syncInput) syncInput.value = body;
            }
          }

          if (opinion) {
            const opCmEl = document.querySelector("#taskSpecificFields #opinion .CodeMirror") ||
                           document.querySelector("#opinion .CodeMirror");
            const opCm = opCmEl?.CodeMirror;
            diag.opinionCm = !!opCm;
            if (opCm) {
              opCm.setValue(opinion);
            } else {
              const opTextarea = document.querySelector("textarea[name='opinion']");
              if (opTextarea) { opTextarea.value = opinion; opTextarea.dispatchEvent(new Event("input", { bubbles: true })); }
              const opSync = document.querySelector("input.hackeditor-sync[name='opinionHighlighted']");
              if (opSync) opSync.value = opinion;
            }
          }

          if (alternatives && alternatives.length > 0) {
            const altGroups = [...document.querySelectorAll("#taskSpecificFields .fieldGroup-alternative")];
            diag.altGroups = altGroups.length;
            alternatives.forEach((alt, i) => {
              if (!altGroups[i]) return;
              const allCmEls = [...altGroups[i].querySelectorAll(".CodeMirror")];
              const textCm = allCmEls[0]?.CodeMirror;
              const opinionCm = allCmEls[1]?.CodeMirror;
              const opinionText = alt.justification || (alt.correct ? "Resposta correta." : "Resposta incorreta.");

              if (textCm) {
                if (alt.body) textCm.setValue(alt.body);
              } else {
                const altTextarea = altGroups[i].querySelector("textarea[name*='.text']");
                const altSync = altGroups[i].querySelector("input.hackeditor-sync[name*='.textHighlighted']");
                if (altTextarea && alt.body) { altTextarea.value = alt.body; altTextarea.dispatchEvent(new Event("input", { bubbles: true })); }
                if (altSync && alt.body) altSync.value = alt.body;
              }

              if (opinionCm) {
                opinionCm.setValue(opinionText);
              } else {
                const opTextarea = altGroups[i].querySelector("textarea[name*='.opinion']");
                const opSync = altGroups[i].querySelector("input.hackeditor-sync[name*='.opinionHighlighted']");
                if (opTextarea) { opTextarea.value = opinionText; opTextarea.dispatchEvent(new Event("input", { bubbles: true })); }
                if (opSync) opSync.value = opinionText;
              }

              if (alt.correct) {
                const correctEl = altGroups[i].querySelector("input.fieldGroup-alternative-actions-correct");
                if (correctEl && !correctEl.checked) correctEl.click();
              }
            });
          }

          return diag;
        },
        args: [msg.title || "", msg.body || "", msg.alternatives || [], msg.opinion || ""],
      });
      console.log(`[Revisor Alura] Form fill diag:`, fillResult?.[0]?.result);

      // Luri: marcar checkbox singleChoiceCanUseAsOpenTask quando enhancedByLuri=true
      if (msg.enhancedByLuri) {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const cb = document.querySelector("input[name='singleChoiceCanUseAsOpenTask']");
            if (cb && !cb.checked) { cb.click(); cb.dispatchEvent(new Event("change", { bubbles: true })); }
            return { found: !!cb, checked: cb?.checked };
          },
        }).then(r => console.log(`[Revisor Alura] singleChoiceCanUseAsOpenTask:`, r?.[0]?.result));
      }

      await new Promise(r => setTimeout(r, 500));

      const navDone = waitForTabComplete(tabId, 25000);
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const btn = document.querySelector("#submitTask") ||
                      document.querySelector("button[type='submit']") ||
                      document.querySelector("input[type='submit']");
          if (btn) {
            btn.click();
          } else {
            const form = document.querySelector("#taskForm") || document.querySelector("form");
            if (form) form.submit();
          }
        },
      });
      await navDone;

      sendResponse({ ok: true });
    } catch (e) {
      console.error("[Revisor Alura] CREATE_ALURA_TASK erro:", e?.message);
      sendResponse({ ok: false, error: e?.message || String(e) });
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  })();

  return true;
});

// ---------- Upload de Material para S3 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "ALURA_REVISOR_UPLOAD_S3") return false;

  (async () => {
    const { fileData, fileName, mimeType, courseFolder, subFolder, accessKeyId, secretAccessKey, endpoint, region, bucket, cdnBaseUrl } = msg;

    if (!fileData || !fileName || !courseFolder || !accessKeyId || !secretAccessKey || !endpoint || !region || !bucket || !cdnBaseUrl) {
      sendResponse({ ok: false, error: "Parâmetros obrigatórios ausentes." });
      return;
    }

    const objectKey = `${courseFolder}/${subFolder ? subFolder + "/" : ""}${fileName}`;
    const s3Url = `https://${endpoint}/${bucket}/${objectKey}`;

    try {
      const headers = await signAwsRequest({
        method: "PUT",
        url: s3Url,
        binaryBody: fileData,
        contentType: mimeType || "application/octet-stream",
        accessKeyId,
        secretAccessKey,
        region,
        service: "s3",
      });

      const resp = await fetch(s3Url, { method: "PUT", headers, body: fileData });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        sendResponse({ ok: false, error: `S3 HTTP ${resp.status}: ${text}` });
        return;
      }

      const cdnUrl = `${cdnBaseUrl.replace(/\/$/, "")}/${objectKey}`;
      sendResponse({ ok: true, cdnUrl });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true;
});

// ---------- Verificação de atualização ----------
async function verificarAtualizacao() {
  try {
    const resp = await fetch("https://hub-producao-conteudo.vercel.app/update.xml");
    const text = await resp.text();
    const match = text.match(/<updatecheck[^>]+version='([\d.]+)'/);
    if (!match) return;

    const versaoHub = match[1];
    const versaoAtual = chrome.runtime.getManifest().version;

    const desatualizada = versaoHub !== versaoAtual &&
      versaoHub.localeCompare(versaoAtual, undefined, { numeric: true }) > 0;

    await chrome.storage.local.set({ atualizacaoDisponivel: desatualizada, versaoHub });

    if (desatualizada) {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {
    console.warn("[Revisor] Falha ao verificar atualização:", e?.message);
  }
}

chrome.runtime.onInstalled.addListener(verificarAtualizacao);
chrome.runtime.onStartup.addListener(verificarAtualizacao);
