(function () {
  // ---------- Transferência para LATAM ----------
  function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  function markdownToHtml(md) {
    if (!md) return "";
    const lines = md.split("\n");
    const result = [];
    let i = 0;
    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (!trimmed) { i++; continue; }
      // Heading
      const hm = trimmed.match(/^(#{1,4})\s+(.+)/);
      if (hm) {
        result.push(`<h${hm[1].length}>${hm[2]}</h${hm[1].length}>`);
        i++; continue;
      }
      // Code block
      if (trimmed.startsWith("```")) {
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("```")) { codeLines.push(lines[i]); i++; }
        result.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
        i++; continue;
      }
      // Unordered list
      if (/^[-*+]\s/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s/.test(lines[i].trim())) {
          items.push(`<li>${lines[i].trim().replace(/^[-*+]\s+/, "")}</li>`);
          i++;
        }
        result.push(`<ul>${items.join("")}</ul>`);
        continue;
      }
      // Ordered list
      if (/^\d+\.\s/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
          items.push(`<li>${lines[i].trim().replace(/^\d+\.\s+/, "")}</li>`);
          i++;
        }
        result.push(`<ol>${items.join("")}</ol>`);
        continue;
      }
      // Paragraph
      const paraLines = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t || /^#{1,4}\s/.test(t) || /^[-*+]\s/.test(t) || /^\d+\.\s/.test(t) || t.startsWith("```")) break;
        paraLines.push(t);
        i++;
      }
      const paraText = paraLines.join(" ")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`(.+?)`/g, "<code>$1</code>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      result.push(`<p>${paraText}</p>`);
    }
    return result.join("\n");
  }

  function _splitH2Sections(lines) {
    const sections = [];
    let current = null;
    for (const line of lines) {
      const h2 = line.match(/^##\s+(.+)/);
      if (h2) {
        if (current) sections.push(current);
        current = { heading: h2[1].trim(), body: "" };
      } else if (current) {
        current.body += (current.body ? "\n" : "") + line;
      }
    }
    if (current) sections.push(current);
    return sections;
  }

  // Extrai texto de uma seção cujo heading começa com o prefixo dado.
  // O texto pode estar na mesma linha do heading ("## Título Texto aqui")
  // ou nas linhas seguintes (body da seção).
  function _secText(sec, prefixRegex) {
    if (!sec) return "";
    const fromHeading = sec.heading.replace(prefixRegex, "").trim();
    return fromHeading || sec.body.trim();
  }

  function _parseTareaFormat(lines) {
    const sections = _splitH2Sections(lines.slice(1));
    const tituloSec    = sections.find(s => /^t[ií]tulo\b/i.test(s.heading));
    const contenidoSec = sections.find(s => /^contenido\b/i.test(s.heading));
    const opinionSec   = sections.find(s => /^opini[oó]n\b/i.test(s.heading));

    if (tituloSec && contenidoSec) {
      // Formato C: tem "## Título" e "## Contenido" (texto pode estar na mesma linha ou nas seções seguintes)
      const title = _secText(tituloSec, /^t[ií]tulo\s*/i);
      let body = _secText(contenidoSec, /^contenido:?\s*/i);
      // Se o corpo de Contenido é vazio, acumula as seções seguintes até Opinión
      if (!body) {
        const contenidoIdx = sections.indexOf(contenidoSec);
        const opinionIdx = opinionSec ? sections.indexOf(opinionSec) : sections.length;
        body = sections.slice(contenidoIdx + 1, opinionIdx).map(s => {
          const parts = [`## ${s.heading}`];
          if (s.body.trim()) parts.push(s.body.trim());
          return parts.join("\n");
        }).join("\n\n").trim();
      }
      const opinion = _secText(opinionSec, /^opini[oó]n\s*/i);
      return { title, body, opinion, alternatives: [] };
    }

    // Formato A: a primeira seção H2 é o título (ex: "## Para saber más: texto aqui")
    const firstSec = sections[0];
    if (firstSec) {
      const title = firstSec.heading; // o heading inteiro é o título
      const bodyLines = [];
      let opinion;
      for (const sec of sections.slice(1)) { // pula o primeiro (é o título)
        // Opinión vai para campo separado (não para o body)
        if (/^opini[oó]n\b/i.test(sec.heading)) {
          const opinionText = _secText(sec, /^opini[oó]n\s*/i);
          if (opinionText) opinion = opinionText;
          continue;
        }
        bodyLines.push(`## ${sec.heading}`);
        if (sec.body.trim()) bodyLines.push(sec.body.trim());
      }
      return { title, body: bodyLines.join("\n").trim(), opinion, alternatives: [] };
    }
    return { title: "", body: lines.slice(1).join("\n").trim(), alternatives: [] };
  }

  // Determina o dataTag de HQ_EXPLANATION com base no título:
  // Se o título for uma variante de "O que aprendemos?" / "¿Qué aprendimos?" → WHAT_WE_LEARNED
  // Caso contrário → COMPLEMENTARY_INFORMATION
  function _hqDataTag(title) {
    if (/qu[eé]\s+aprendimos|que\s+aprendemos|o\s+que\s+aprendemos/i.test(title || "")) return "WHAT_WE_LEARNED";
    return "COMPLEMENTARY_INFORMATION";
  }

  function _parseTipoFormat(lines) {
    // Parser linha a linha para: # Tarea Tipo Única elección / Opción múltiple
    // Suporta dois formatos de heading:
    //   Formato A: ## Alternativa N / ### Opinión N
    //   Formato B: ### Alternativa N / #### Opinión N
    let title = "";
    const bodyLines = [];
    const alternatives = [];
    let currentAlt = null;
    let opinionLines = [];
    let mode = ""; // "title_body" | "body" | "alt" | "opinion"

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^#\s/.test(trimmed)) continue; // pula o H1

      // H2: ## Título / ## Enunciado / ## Alternativa N
      const h2m = trimmed.match(/^##\s+(.+)/);
      if (h2m) {
        const h2text = h2m[1].trim();

        if (/^t[ií]tulo\b/i.test(h2text)) {
          const inline = h2text.replace(/^t[ií]tulo\s*/i, "").trim();
          title = inline;
          mode = inline ? "" : "title_body";
          continue;
        }

        if (/^enunciado\b/i.test(h2text)) {
          const inline = h2text.replace(/^enunciado\s*/i, "").trim();
          if (inline) bodyLines.push(inline);
          mode = "body";
          continue;
        }

        const altM = h2text.match(/^Alternativa\s+\d+\s*(.*)/i);
        if (altM) {
          if (currentAlt) { currentAlt.justification = opinionLines.join("\n").trim(); alternatives.push(currentAlt); }
          opinionLines = [];
          currentAlt = { body: altM[1].trim(), justification: "", correct: false };
          mode = "alt";
          continue;
        }

        if (mode === "body") bodyLines.push(`## ${h2text}`);
        continue;
      }

      // H3: ### Alternativa N (Formato B) ou ### Opinión N (Formato A)
      const h3m = trimmed.match(/^###\s+(.+)/);
      if (h3m) {
        const h3text = h3m[1].trim();
        const altM3 = h3text.match(/^(?:Alternativa|Opci[oó]n)\s+\d+\s*(.*)/i);
        if (altM3) {
          if (currentAlt) { currentAlt.justification = opinionLines.join("\n").trim(); alternatives.push(currentAlt); }
          opinionLines = [];
          currentAlt = { body: altM3[1].trim(), justification: "", correct: false };
          mode = "alt";
          continue;
        }
        if (/^Opini[oó]n\s+\d+/i.test(h3text)) { mode = "opinion"; continue; }
        if (mode === "body") bodyLines.push(`### ${h3text}`);
        continue;
      }

      // H4: #### Opinión N (Formato B)
      const h4m = trimmed.match(/^####\s+(.+)/);
      if (h4m) {
        if (/^Opini[oó]n\s+\d+/i.test(h4m[1].trim())) { mode = "opinion"; continue; }
        if (mode === "body") bodyLines.push(`#### ${h4m[1]}`);
        continue;
      }

      // Labels de texto puro (formato hard-break: "Título  \n", "Alternativa 1  \n")
      if (/^t[ií]tulo\s*$/i.test(trimmed)) { mode = "title_body"; continue; }
      if (/^enunciado\s*$/i.test(trimmed)) { mode = "body"; continue; }
      const altPlain = trimmed.match(/^Alternativa\s+\d+\s*$/i);
      if (altPlain) {
        if (currentAlt) { currentAlt.justification = opinionLines.join("\n").trim(); alternatives.push(currentAlt); }
        opinionLines = [];
        currentAlt = { body: "", justification: "", correct: false };
        mode = "alt";
        continue;
      }
      if (/^Opini[oó]n\s+\d+\s*$/i.test(trimmed)) { mode = "opinion"; continue; }
      // Bold inline format: **Opinión N** (sem heading #)
      if (/^\*\*Opini[oó]n\s+\d+\*\*\s*$/i.test(trimmed)) { mode = "opinion"; continue; }

      // Correcta:/Correcto: (cobre feminino, masculino e formato bold **Correcto:**)
      if (/^\**Correct[oa]:\**\s*(s[ií]|yes|true)/i.test(trimmed)) {
        if (currentAlt) currentAlt.correct = true;
        continue;
      }
      if (/^\**Correct[oa]:\**/i.test(trimmed)) continue;

      if (mode === "title_body" && !title) { title = trimmed; mode = ""; }
      else if (mode === "body") bodyLines.push(line);
      else if (mode === "alt" && currentAlt) { currentAlt.body += (currentAlt.body ? "\n" : "") + trimmed; }
      else if (mode === "opinion") { opinionLines.push(trimmed); }
    }

    if (currentAlt) { currentAlt.justification = opinionLines.join("\n").trim(); alternatives.push(currentAlt); }

    return {
      title,
      body: bodyLines.join("\n").trim(),
      alternatives: alternatives.filter(a => a.body.trim()),
    };
  }

  function _parseFlatSinRespuestaFormat(text) {
    // Task Kind Sin Respuesta del Estudiante — flat challenge/desafio
    // Labels: Title / Content / Opinion (sem número, sem ##)
    const lines = text.split("\n");
    let title = "", contentLines = [], opinionLines = [], mode = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^Task Kind\s/i.test(trimmed)) continue;
      if (/^Tarea\s+Sin\s+Respuesta/i.test(trimmed)) continue;
      if (/^T[ií]tulo:?\s*$/i.test(trimmed) || /^Title:?\s*$/i.test(trimmed)) { mode = "title"; continue; }
      if (/^Contenido:?\s*$/i.test(trimmed) || /^Content:?\s*$/i.test(trimmed)) { mode = "content"; continue; }
      if (/^Opini[oó]n:?\s*$/i.test(trimmed) || /^Opinion:?\s*$/i.test(trimmed)) { mode = "opinion"; continue; }
      if (mode === "title" && !title && trimmed) { title = trimmed; mode = ""; continue; }
      if (mode === "content") contentLines.push(line);
      else if (mode === "opinion") opinionLines.push(line);
    }
    const opinion = opinionLines.join("\n").trim();
    const dataTag = /desaf[íi]o|reto|challenge/i.test(title) ? "CHALLENGE" : "DO_AFTER_ME";
    return {
      title,
      body: contentLines.join("\n").trim(),
      opinion: opinion || undefined,
      alternatives: [],
      taskEnum: "TEXT_CONTENT",
      dataTag,
    };
  }

  function _parseFlatFormat(text) {
    const lines = text.split("\n");
    let title = "", enunciationLines = [], alternatives = [], mode = "", currentAlt = null;
    let opinionLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^Task Kind\s/i.test(trimmed)) continue;
      if (/^Tarea\s+Tipo\s/i.test(trimmed) && !title && mode === "") continue;

      // "Title"/"Título" sozinho na linha (label separado do valor) ou "Title <texto>" na mesma linha
      if (/^Title\s+/i.test(trimmed)) { title = trimmed.replace(/^Title\s+/i, "").trim(); mode = ""; continue; }
      if (/^Title\s*$/i.test(trimmed) || /^T[ií]tulo\s*$/i.test(trimmed)) { mode = "title"; continue; }
      if (mode === "title" && !title && trimmed) { title = trimmed; mode = ""; continue; }

      // Enunciação: inglês "Enunciation" ou espanhol "Enunciado"
      if (/^Enunci(ation|ado)\s*$/i.test(trimmed)) { mode = "enunciation"; continue; }

      // Alternativa: inglês "Alternative N" ou espanhol "Alternativa N"
      if (/^Alternati(?:ve|va)\s+\d+\s*$/i.test(trimmed)) {
        if (currentAlt) { currentAlt.justification = opinionLines.join("\n").trim(); alternatives.push(currentAlt); }
        currentAlt = { body: "", correct: false, justification: "" };
        opinionLines = [];
        mode = "alternative"; continue;
      }

      // Opinión: inglês "Opinion N" ou espanhol "Opinión N"
      if (/^Opini[oó]n\s+\d+\s*$/i.test(trimmed)) { mode = "opinion"; continue; }

      // Correcto/Correct
      if (/^Correct[oa]?:\s*(s[ií]|yes|true)/i.test(trimmed)) { if (currentAlt) currentAlt.correct = true; continue; }
      if (/^Correct[oa]?:/i.test(trimmed)) continue;

      if (mode === "enunciation" && trimmed) enunciationLines.push(line);
      else if (mode === "alternative" && currentAlt && trimmed) currentAlt.body += (currentAlt.body ? "\n" : "") + trimmed;
      else if (mode === "opinion" && trimmed) opinionLines.push(trimmed);
    }
    if (currentAlt) { currentAlt.justification = opinionLines.join("\n").trim(); alternatives.push(currentAlt); }
    return {
      title,
      body: enunciationLines.join("\n").trim(),
      alternatives: alternatives.filter(a => a.body.trim()),
    };
  }

  function parseTranslationMarkdown(md) {
    const result = _parseTranslationMarkdownRaw(md);
    // Filtro geral: remove label "## Contenido:" ou "## Content:" que possa ter vazado para o body
    if (result.body) {
      result.body = result.body
        .replace(/^##\s+(?:contenido|content):?\s*\n?/i, "")
        .trim();
    }
    // Post-processo: se o body contém estrutura inline "Título / Contenido / Opinión"
    // (ex: task cuja tradução embute o texto estruturado em vez de preencher os campos separados)
    if (result.body && /^T[ií]tulo\s*$/im.test(result.body)) {
      const re = _parseFlatSinRespuestaFormat(result.body);
      if (re.title) result.title = re.title;
      if (re.body) result.body = re.body;
      if (re.opinion && !result.opinion) result.opinion = re.opinion;
    }
    return result;
  }

  function _parseTranslationMarkdownRaw(md) {
    if (!md) return { title: "", body: "", alternatives: [], taskEnum: null, dataTag: null };
    const text = md.trim();

    // Formato flat sem "#" — "Tarea Sin Respuesta del Estudiante" como texto plano
    if (/^Tarea\s+Sin\s+Respuesta/i.test(text.split("\n")[0])) {
      return _parseFlatSinRespuestaFormat(text);
    }

    // Formato flat sem "#" — "Tarea Tipo Única elección" / "Tarea Tipo Opción múltiple" como texto plano
    if (/^Tarea\s+Tipo\s+[Úú]nica/i.test(text.split("\n")[0])) {
      const r = _parseFlatFormat(text);
      const correctCount = r.alternatives.filter(a => a.correct).length;
      const taskEnum = correctCount > 1 ? "MULTIPLE_CHOICE" : "SINGLE_CHOICE";
      return { ...r, taskEnum, dataTag: "PRACTICE_CLASS_CONTENT" };
    }
    if (/^Tarea\s+Tipo\s+Opci[oó]n\s+m[uú]ltiple/i.test(text.split("\n")[0])) {
      const r = _parseFlatFormat(text);
      return { ...r, taskEnum: "MULTIPLE_CHOICE", dataTag: "PRACTICE_CLASS_CONTENT" };
    }

    // Formato E — flat (Task Kind ...)
    if (/^Task Kind\s/i.test(text)) {
      const firstLine = text.split("\n")[0];
      // "Sin Respuesta del Estudiante" = desafio/faça como eu fiz (sem quiz)
      if (/^Task Kind\s+Sin\s+Respuesta/i.test(firstLine)) {
        return _parseFlatSinRespuestaFormat(text);
      }
      // "Explicación" = Para saber mais (HQ_EXPLANATION)
      if (/^Task Kind\s+Explicaci[oó]n/i.test(firstLine)) {
        const r = _parseFlatSinRespuestaFormat(text);
        return { ...r, taskEnum: "HQ_EXPLANATION", dataTag: _hqDataTag(r.title) };
      }
      const r = _parseFlatFormat(text);
      const correctCount = r.alternatives.filter(a => a.correct).length;
      const taskEnum = correctCount > 1 ? "MULTIPLE_CHOICE" : "SINGLE_CHOICE";
      return { ...r, taskEnum, dataTag: "PRACTICE_CLASS_CONTENT" };
    }

    const lines = text.split("\n");
    const h1 = lines[0]?.trim() || "";

    // "# Tarea Sin Respuesta del Estudiante" com H1
    if (/^#\s+Tarea\s+Sin\s+Respuesta/i.test(h1)) {
      // Se o conteúdo usa "## Título / ## Contenido / ## Opinión" → _parseTareaFormat
      // Se usa labels de texto plano ("Título\nValor\n") → _parseFlatSinRespuestaFormat
      const hasH2Sections = lines.slice(1).some(l => /^##\s+(?:t[ií]tulo|contenido|opini[oó]n)\s*$/i.test(l.trim()));
      if (hasH2Sections) {
        const r = _parseTareaFormat(lines);
        const dataTag = /desaf[íi]o|reto|challenge/i.test(r.title) ? "CHALLENGE" : "DO_AFTER_ME";
        return { ...r, taskEnum: "TEXT_CONTENT", dataTag };
      }
      // Formato: primeiro conteúdo após H1 é "## <título>" (não label estrutural) → título + corpo
      const restLines = lines.slice(1);
      const firstNonEmptyIdx = restLines.findIndex(l => l.trim() !== "");
      if (firstNonEmptyIdx >= 0 && /^##\s+/.test(restLines[firstNonEmptyIdx].trim())) {
        const title = restLines[firstNonEmptyIdx].replace(/^##\s+/, "").trim();
        const bodyLines = restLines.slice(firstNonEmptyIdx + 1);
        const dataTag = /desaf[íi]o|reto|challenge/i.test(title) ? "CHALLENGE" : "DO_AFTER_ME";
        return { title, body: bodyLines.join("\n").trim(), alternatives: [], taskEnum: "TEXT_CONTENT", dataTag };
      }
      return _parseFlatSinRespuestaFormat(lines.slice(1).join("\n"));
    }

    // Formato B — ¿Qué aprendimos? → WHAT_WE_LEARNED
    if (/^#\s+[¿¡]?Qu[eé]\s+aprendimos/i.test(h1)) {
      let bodyLines = lines.slice(1);
      const cIdx = bodyLines.findIndex(l => /^(?:contenido|content):?\s*$/i.test(l.trim()));
      if (cIdx >= 0) bodyLines.splice(cIdx, 1);
      return {
        title: h1.replace(/^#+\s*/, "").trim(),
        body: bodyLines.join("\n").trim(),
        alternatives: [],
        taskEnum: "HQ_EXPLANATION",
        dataTag: "WHAT_WE_LEARNED",
      };
    }

    // Formato D — "# Tarea Tipo Única elección", "# Tarea Kind Única elección" ou "# Tarea Única" → SINGLE_CHOICE
    if (/^#\s+Tarea\s+(Tipo|Kind)\s+[Úú]nica(\s+elecci[oó]n)?/i.test(h1) || /^#\s+Tarea\s+[Úú]nica(\s+elecci[oó]n)?/i.test(h1)) {
      const r = _parseTipoFormat(lines);
      return { ...r, taskEnum: "SINGLE_CHOICE", dataTag: "PRACTICE_CLASS_CONTENT" };
    }

    // "# Tarea Múltiple" → MULTIPLE_CHOICE
    if (/^#\s+Tarea\s+M[uú]ltiple/i.test(h1)) {
      const r = _parseTipoFormat(lines);
      return { ...r, taskEnum: "MULTIPLE_CHOICE", dataTag: "PRACTICE_CLASS_CONTENT" };
    }

    // Outros "# Tarea Tipo X" — detecta pelo nome
    if (/^#\s+Tarea\s+Tipo/i.test(h1)) {
      const tipoName = h1.replace(/^#\s+Tarea\s+Tipo\s+/i, "").trim();
      // Opción múltiple
      if (/opci[oó]n\s+m[uú]ltiple/i.test(tipoName)) {
        const r = _parseTipoFormat(lines);
        return { ...r, taskEnum: "MULTIPLE_CHOICE", dataTag: "PRACTICE_CLASS_CONTENT" };
      }
      // Explicación — suporta "Título\n<real title>" (plain) e "## Título\n<real title>" (H2) + "Contenido:"
      const restLines = lines.slice(1);
      const tituloIdx = restLines.findIndex(l => /^(?:##\s+)?t[ií]tulo\s*$/i.test(l.trim()));
      const contenidoIdx = restLines.findIndex(l => /^(?:##\s+)?contenido:?\s*$/i.test(l.trim()) || /^contenido:/i.test(l.trim()));
      if (tituloIdx >= 0 && contenidoIdx >= 0 && contenidoIdx > tituloIdx) {
        const titleStr = (restLines.slice(tituloIdx + 1).find(l => l.trim()) || "").trim();
        let bodyLines = restLines.slice(contenidoIdx + 1);
        const cRest = restLines[contenidoIdx].trim().replace(/^contenido:\s*/i, "").trim();
        if (cRest) bodyLines = [cRest, ...bodyLines];
        return { title: titleStr, body: bodyLines.join("\n").trim(), alternatives: [], taskEnum: "HQ_EXPLANATION", dataTag: _hqDataTag(titleStr) };
      }
      const r = _parseTareaFormat(lines);
      return { ...r, taskEnum: "HQ_EXPLANATION", dataTag: _hqDataTag(r.title) };
    }

    // "# Tarea Explicación" (sem "Tipo") — Para saber mais com formato flat
    if (/^#\s+Tarea\s+Explicaci[oó]n/i.test(h1)) {
      const restLines = lines.slice(1);
      const tituloIdx = restLines.findIndex(l => /^t[ií]tulo\s*$/i.test(l.trim()));
      const contenidoIdx = restLines.findIndex(l => /^contenido:/i.test(l.trim()));
      if (tituloIdx >= 0 && contenidoIdx >= 0 && contenidoIdx > tituloIdx) {
        const titleStr = (restLines.slice(tituloIdx + 1).find(l => l.trim()) || "").trim();
        let bodyLines = restLines.slice(contenidoIdx + 1);
        const cRest = restLines[contenidoIdx].trim().replace(/^contenido:\s*/i, "").trim();
        if (cRest) bodyLines = [cRest, ...bodyLines];
        return { title: titleStr, body: bodyLines.join("\n").trim(), alternatives: [], taskEnum: "HQ_EXPLANATION", dataTag: _hqDataTag(titleStr) };
      }
      const r = _parseTareaFormat(lines);
      return { ...r, taskEnum: "HQ_EXPLANATION", dataTag: _hqDataTag(r.title) };
    }

    // Formato "Para saber más" com título direto no H1 (ex: "# Material del curso")
    // H1 que não começa com "# Tarea" → título = H1, corpo = resto sem "Contenido:"
    if (!/^#\s+Tarea\b/i.test(h1)) {
      // Se o conteúdo tem alternativas (### Alternativa N ou ## Alternativa N), é quiz
      if (/^#{2,3}\s+Alternativa\s+\d+/im.test(text)) {
        const r = _parseTipoFormat(lines);
        const correctCount = r.alternatives.filter(a => a.correct).length;
        const taskEnum = correctCount > 1 ? "MULTIPLE_CHOICE" : "SINGLE_CHOICE";
        return { ...r, taskEnum, dataTag: "PRACTICE_CLASS_CONTENT" };
      }

      let titleStr = h1.replace(/^#+\s*/, "").trim();
      let bodyLines = lines.slice(1);

      // Se H1 é literalmente "Título" (espanhol) ou "Title" (inglês), a primeira linha não-vazia é o título real
      if (/^t[ií]tulo\s*$/i.test(titleStr) || /^title\s*$/i.test(titleStr)) {
        const firstNonEmpty = bodyLines.findIndex(l => l.trim());
        if (firstNonEmpty >= 0) {
          titleStr = bodyLines[firstNonEmpty].trim();
          bodyLines = bodyLines.slice(firstNonEmpty + 1);
        }
      }

      // Remove o marcador "Contenido:" / "## Contenido:" (espanhol) ou "Content:" (inglês)
      const cIdx = bodyLines.findIndex(l => /^(?:##\s+)?(?:contenido|content):?\s*$/i.test(l.trim()));
      if (cIdx >= 0) {
        const rest = bodyLines[cIdx].trim().replace(/^(?:##\s+)?(?:contenido|content):?\s*/i, "").trim();
        if (rest) {
          bodyLines[cIdx] = rest; // mantém texto após "Contenido:"
        } else {
          bodyLines.splice(cIdx, 1); // remove linha vazia
        }
      }

      return {
        title: titleStr,
        body: bodyLines.join("\n").trim(),
        alternatives: [],
        taskEnum: "HQ_EXPLANATION",
        dataTag: _hqDataTag(titleStr),
      };
    }

    // Formato A ou C — "# Tarea Sin Respuesta del Estudiante"
    const r = _parseTareaFormat(lines);
    // Determina taskEnum/dataTag pelo conteúdo
    const sections = _splitH2Sections(lines.slice(1));
    const tituloSec = sections.find(s => /^t[ií]tulo$/i.test(s.heading));
    const firstSec = sections[0];

    if (tituloSec) {
      // Tem seção "Título" → verifica o conteúdo do título para determinar o tipo
      const tituloText = (tituloSec.body || tituloSec.heading || "");
      // "Para saber más" → HQ_EXPLANATION
      if (/para\s+saber\s+m[aá]s/i.test(tituloText)) {
        return { ...r, taskEnum: "HQ_EXPLANATION", dataTag: _hqDataTag(r.title) };
      }
      const dataTag = /desaf[íi]o|reto|challenge/i.test(tituloText)
        ? "CHALLENGE"
        : "DO_AFTER_ME";
      return { ...r, taskEnum: "TEXT_CONTENT", dataTag };
    }

    if (firstSec) {
      const heading = firstSec.heading;
      if (/preparando|configurando|ambiente|setup/i.test(heading)) {
        return { ...r, taskEnum: "HQ_EXPLANATION", dataTag: "SETUP_EXPLANATION" };
      }
    }

    // Default: HQ_EXPLANATION → Para saber mais
    return { ...r, taskEnum: "HQ_EXPLANATION", dataTag: _hqDataTag(r.title) };
  }

  let latamTransferRunning = false;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_TRANSFER_TO_LATAM") return;

    (async () => {
      if (latamTransferRunning)
        return sendResponse({ ok: false, error: "Transferência já em andamento." });
      if (downloadTranslatedRunning)
        return sendResponse({ ok: false, error: "Download já em andamento." });
      if (!isHomePage() || window.location.origin !== "https://cursos.alura.com.br")
        return sendResponse({ ok: false, error: "Abra a Home do curso em cursos.alura.com.br." });

      const courseId = await resolveCourseId();
      if (!courseId)
        return sendResponse({ ok: false, error: "Não consegui identificar o ID do curso." });

      sendResponse({ ok: true });
      latamTransferRunning = true;

      try {
        const latamCourseId = msg.latamCourseId;

        // Fase 1: baixar e parsear as traduções (reutiliza a lógica do "Baixar")
        const { output: jsonData, done: dlDone, errors: dlErrors, totalTasks: dlTotal } =
          await downloadTranslatedCore(courseId);

        // Salva no storage (sem disparar download de arquivo)
        await chrome.storage.local.set({ aluraRevisorTranslatedJson: jsonData });

        // Conta atividades válidas para a fase de envio
        const totalTasks = jsonData.sections.reduce((sum, s) =>
          sum + s.activities.filter(a => !a.skipped && !a.error).length, 0);

        await setState({ running: true, mode: "latamTransfer", done: 0, total: totalTasks, errors: 0 });

        let done = 0, errors = 0;

        // Busca seções já existentes na LATAM para reaproveitar os IDs
        let existingSectionMap = {}; // { [número]: sectionId }
        try {
          const sectionsResp = await sendToBackground({
            type: "ALURA_REVISOR_GET_LATAM_SECTIONS",
            latamCourseId,
          });
          if (sectionsResp?.ok && sectionsResp.sections?.length) {
            for (const s of sectionsResp.sections) {
              existingSectionMap[s.number] = s.id;
            }
          }
        } catch (e) {
          console.warn("[Revisor LATAM] Não foi possível buscar seções existentes:", e.message);
        }

        for (let si = 0; si < jsonData.sections.length; si++) {
          const section = jsonData.sections[si];
          const sectionNumber = si + 1;
          const existingSectionId = existingSectionMap[sectionNumber] ?? null;

          // 1. Reutilizar seção existente ou criar nova na LATAM
          let sectionResp;
          if (existingSectionId) {
            sectionResp = { ok: true, sectionId: existingSectionId };
          } else {
            sectionResp = await sendToBackground({
              type: "ALURA_REVISOR_CREATE_LATAM_SECTION",
              latamCourseId,
              sectionName: section.title,
            });
          }

          if (!sectionResp?.ok) {
            const skippable = section.activities.filter(a => !a.skipped && !a.error).length;
            errors += skippable;
            console.warn(`[Revisor LATAM] Falha ao criar seção "${section.title}":`, sectionResp?.error);
            continue;
          }

          const latamSectionId = sectionResp.sectionId;

          // 2. Para cada atividade da seção (pula vídeos e erros)
          for (const activity of section.activities) {
            if (activity.skipped || activity.error) continue;

            await setState({
              running: true, mode: "latamTransfer", done, total: totalTasks, errors,
              currentTask: `"${section.title}" → ${activity.title}`,
            });

            try {
              const createResp = await sendToBackground({
                type: "ALURA_REVISOR_CREATE_LATAM_TASK",
                latamCourseId,
                latamSectionId,
                taskEnum: activity.taskEnum,
                dataTag: activity.dataTag,
                title: activity.title,
                body: activity.body,
                opinion: activity.opinion || "",
                alternatives: activity.alternatives || [],
              });
              createResp?.ok ? done++ : errors++;
            } catch (e) {
              errors++;
              console.warn(`[Revisor LATAM] Erro na atividade "${activity.title}":`, e.message);
            }
          }
        }

        await setState({ running: false, mode: "latamTransfer", done, total: totalTasks, errors });
      } catch (e) {
        await setState({ running: false, mode: "latamTransfer", done: 0, total: 0, errors: 1, fatalError: e.message });
      } finally {
        latamTransferRunning = false;
      }
    })();

    return true;
  });

  // ---------- Download de atividades traduzidas ----------
  // Lógica de download compartilhada entre "Baixar" e "Enviar"
  async function downloadTranslatedCore(courseId) {
    console.log("[Revisor Download] Iniciando download de atividades traduzidas…");
    await setState({ running: true, mode: "downloadTranslated", done: 0, total: 0, errors: 0 });

    const allSections = (await getAdminSections(courseId)).filter(s => s.active);
    console.log(`[Revisor Download] ${allSections.length} seção(ões) ativa(s)`);

    let totalTasks = 0;
    const sectionTaskMap = [];
    for (const section of allSections) {
      const { tasks } = await getAdminSectionTasks(courseId, section.id, { includeInactive: false });
      const nonVideo = tasks.filter(t => t.type !== "Vídeo");
      sectionTaskMap.push({ section, tasks, nonVideoCount: nonVideo.length });
      totalTasks += nonVideo.length;
      console.log(`[Revisor Download] Seção "${section.title}": ${tasks.length} task(s), ${nonVideo.length} não-vídeo(s)`);
    }

    console.log(`[Revisor Download] Total de atividades: ${totalTasks}`);
    await setState({ running: true, mode: "downloadTranslated", done: 0, total: totalTasks, errors: 0 });

    let done = 0, errors = 0;
    const output = { courseId, exportedAt: new Date().toISOString(), sections: [] };

    for (const { section, tasks } of sectionTaskMap) {
      const sectionEntry = { id: section.id, title: section.title, activities: [] };

      for (const task of tasks) {
        if (task.type === "Vídeo") {
          sectionEntry.activities.push({ id: task.id, type: "VIDEO", title: task.title, skipped: true });
          continue;
        }

        await setState({
          running: true, mode: "downloadTranslated", done, total: totalTasks, errors,
          currentTask: `"${section.title}" → ${task.title}`,
        });

        try {
          const result = await sendToBackground({ type: "ALURA_REVISOR_FETCH_TRANSLATION", taskId: task.id });
          if (!result?.ok || !result?.markdown) throw new Error("Tradução não disponível");

          const parsed = parseTranslationMarkdown(result.markdown);
          sectionEntry.activities.push({
            id: task.id,
            taskEnum: parsed.taskEnum,
            dataTag: parsed.dataTag,
            title: parsed.title || task.title,
            body: parsed.body || "",
            ...(parsed.opinion ? { opinion: parsed.opinion } : {}),
            alternatives: parsed.alternatives || [],
          });
          done++;
        } catch (e) {
          errors++;
          sectionEntry.activities.push({ id: task.id, title: task.title, error: e.message });
        }
      }

      output.sections.push(sectionEntry);
    }

    return { output, done, errors, totalTasks };
  }

  let downloadTranslatedRunning = false;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_DOWNLOAD_TRANSLATED") return;

    (async () => {
      if (downloadTranslatedRunning)
        return sendResponse({ ok: false, error: "Download já em andamento." });
      if (!isHomePage() || window.location.origin !== "https://cursos.alura.com.br")
        return sendResponse({ ok: false, error: "Abra a Home do curso em cursos.alura.com.br." });

      const courseId = await resolveCourseId();
      if (!courseId)
        return sendResponse({ ok: false, error: "Não consegui identificar o ID do curso." });

      sendResponse({ ok: true });
      downloadTranslatedRunning = true;

      try {
        const { output, done, errors, totalTasks } = await downloadTranslatedCore(courseId);

        // Dispara download de arquivo (apenas se não foi pedido noDownload)
        if (!msg.noDownload) {
          const jsonStr = JSON.stringify(output, null, 2);
          console.log(`[Revisor Download] Enviando JSON (${jsonStr.length} bytes) para download…`);
          const dlResult = await sendToBackground({
            type: "ALURA_REVISOR_DOWNLOAD_BLOB",
            content: jsonStr,
            filename: `atividades-traduzidas-${courseId}.json`,
            mimeType: "application/json",
          });
          if (!dlResult?.ok) console.error("[Revisor Download] Erro no download:", dlResult?.error);
          else console.log("[Revisor Download] Download iniciado, downloadId:", dlResult.downloadId);
        }

        // Salva no storage
        await chrome.storage.local.set({ aluraRevisorTranslatedJson: output });
        console.log("[Revisor Download] JSON salvo no storage local.");

        await setState({ running: false, mode: "downloadTranslated", done, total: totalTasks, errors });
      } catch (e) {
        console.error("[Revisor Download] Erro fatal:", e);
        await setState({ running: false, mode: "downloadTranslated", fatalError: e.message });
      } finally {
        downloadTranslatedRunning = false;
      }
    })();

    return true;
  });

  // ---------- Renomear seções com IA (Bedrock Titan) ----------
  const GENERIC_SECTION_RE = /^(aula|classe)\s+\d+$/i;

  function buildRenameSectionPrompt(transcriptions) {
    const parts = transcriptions.map((t, i) => `Aula ${i + 1}:\n${t.slice(0, 800)}`).join("\n---\n");
    return (
      "Você é um especialista em educação e tecnologia. Analise as transcrições das aulas de vídeo abaixo, " +
      "que pertencem a uma mesma seção de um curso online de tecnologia. " +
      "Sugira um título curto (máximo 6 palavras) e descritivo para esta seção. " +
      "O título deve resumir o tema principal abordado nas aulas. " +
      "Responda APENAS com o título sugerido, sem aspas, sem explicações, sem pontuação final.\n\n" +
      "Transcrições:\n---\n" + parts
    );
  }

  function showRenameSectionsOverlay(sections) {
    // Remove overlay anterior se existir
    document.getElementById("revisor-rename-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "revisor-rename-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:'Inter',system-ui,sans-serif;";

    const card = document.createElement("div");
    card.style.cssText =
      "background:#fff;border-radius:12px;padding:24px;max-width:700px;width:95%;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.25);";

    card.innerHTML = `
      <h2 style="margin:0 0 4px;font-size:18px;color:#1c1c1c;">Renomear Seções</h2>
      <p style="margin:0 0 16px;font-size:13px;color:#777;">Revise os títulos sugeridos pela IA. Edite se necessário e marque as seções que deseja renomear.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="text-align:left;border-bottom:2px solid #e0e0e0;">
            <th style="padding:8px 6px;width:30px;"></th>
            <th style="padding:8px 6px;">Nome Atual</th>
            <th style="padding:8px 6px;">Sugestão</th>
          </tr>
        </thead>
        <tbody id="revisor-rename-tbody"></tbody>
      </table>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button id="revisor-rename-save" style="flex:1;padding:10px;background:#00c86f;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px;">Salvar selecionadas</button>
        <button id="revisor-rename-cancel" style="flex:1;padding:10px;background:#e0e0e0;color:#1c1c1c;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px;">Cancelar</button>
      </div>
      <div id="revisor-rename-progress" style="margin-top:10px;font-size:12px;color:#555;"></div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const tbody = document.getElementById("revisor-rename-tbody");
    sections.forEach((s, i) => {
      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid #f0f0f0";
      tr.innerHTML = `
        <td style="padding:8px 6px;text-align:center;"><input type="checkbox" checked data-idx="${i}"></td>
        <td style="padding:8px 6px;color:#888;">${s.currentName}</td>
        <td style="padding:8px 6px;"><input type="text" value="${s.suggestedName.replace(/"/g, '&quot;')}" data-idx="${i}" style="width:100%;padding:6px 8px;border:1.5px solid #e0e0e0;border-radius:6px;font-size:13px;font-family:inherit;"></td>
      `;
      tbody.appendChild(tr);
    });

    return new Promise((resolve) => {
      document.getElementById("revisor-rename-cancel").addEventListener("click", () => {
        overlay.remove();
        resolve(null);
      });

      document.getElementById("revisor-rename-save").addEventListener("click", () => {
        const selected = [];
        tbody.querySelectorAll("input[type='checkbox']").forEach((cb) => {
          if (!cb.checked) return;
          const idx = Number(cb.dataset.idx);
          const nameInput = tbody.querySelector(`input[type='text'][data-idx='${idx}']`);
          const newName = nameInput?.value?.trim();
          if (newName && newName !== sections[idx].currentName) {
            selected.push({ ...sections[idx], newName });
          }
        });
        resolve(selected);
      });
    });
  }

  let renameSectionsRunning = false;

  async function runRenameSectionsCore(courseId) {
    renameSectionsRunning = true;
    try {
      await setState({ running: true, mode: "renameSections", done: 0, total: 0, currentTask: "Buscando seções..." });

      // Ler API key do session storage (escrito pelo popup ao abrir, que tem acesso aos cookies do hub)
      const sessionData = await chrome.storage.session.get(["claudeApiKey"]).catch(() => ({}));
      const claudeApiKey = sessionData?.claudeApiKey || "";

      if (!claudeApiKey) {
        await setState({ running: false, mode: "renameSections", done: 0, total: 0, suggestions: 0,
          fatalError: "Abra o popup da extensão antes de usar (necessário para carregar credenciais)." });
        renameSectionsRunning = false;
        return;
      }

      const allSections = await getAdminSections(courseId);

      const genericSections = allSections.filter(s => s.active && GENERIC_SECTION_RE.test(s.title));

      if (genericSections.length === 0) {
        await setState({ running: false, mode: "renameSections", done: 0, total: 0, suggestions: 0 });
        renameSectionsRunning = false;
        return;
      }

      await setState({ running: true, mode: "renameSections", done: 0, total: genericSections.length, currentTask: "Extraindo transcrições..." });

      // Para cada seção genérica, buscar vídeos e transcrições
      const sectionSuggestions = [];
      let done = 0;

      for (const section of genericSections) {
        await setState({
          running: true, mode: "renameSections", done, total: genericSections.length,
          currentTask: `Processando "${section.title}"...`,
        });

        const { tasks } = await getAdminSectionTasks(courseId, section.id, { includeInactive: false });
        const videoTasks = tasks.filter(t => t.type === "Vídeo");

        if (videoTasks.length === 0) {
          done++;
          continue;
        }

        // Extrair transcrições dos vídeos
        const transcriptions = [];
        for (const task of videoTasks) {
          if (!task.editUrl) continue;
          const content = await getAdminTaskContent(task.editUrl);
          if (content.transcriptionText) {
            transcriptions.push(content.transcriptionText);
          }
        }

        if (transcriptions.length === 0) {
          done++;
          continue;
        }

        // Chamar Claude para sugestão
        await setState({
          running: true, mode: "renameSections", done, total: genericSections.length,
          currentTask: `Gerando sugestão para "${section.title}"...`,
        });

        const prompt = buildRenameSectionPrompt(transcriptions);
        const claudeResp = await sendToBackground({
          type: "ALURA_REVISOR_CALL_CLAUDE",
          prompt,
          apiKey: claudeApiKey,
        });

        if (claudeResp?.ok && claudeResp.outputText) {
          sectionSuggestions.push({
            sectionId: section.id,
            currentName: section.title,
            suggestedName: claudeResp.outputText.replace(/["\n]/g, "").trim(),
          });
        }

        done++;
      }

      await setState({ running: false, mode: "renameSections", done, total: genericSections.length, suggestions: sectionSuggestions.length });

      if (sectionSuggestions.length === 0) {
        renameSectionsRunning = false;
        return;
      }

      // Mostrar overlay de aprovação
      const selected = await showRenameSectionsOverlay(sectionSuggestions);
      if (!selected || selected.length === 0) {
        renameSectionsRunning = false;
        return;
      }

      // Salvar nomes aprovados
      const progressEl = document.getElementById("revisor-rename-progress");
      for (let i = 0; i < selected.length; i++) {
        const s = selected[i];
        if (progressEl) progressEl.textContent = `Salvando ${i + 1}/${selected.length}: "${s.newName}"...`;

        await sendToBackground({
          type: "ALURA_REVISOR_RENAME_SECTION",
          courseId,
          sectionId: s.sectionId,
          newName: s.newName,
        });
      }

      if (progressEl) progressEl.textContent = `Concluído! ${selected.length} seção(ões) renomeada(s).`;
      setTimeout(() => document.getElementById("revisor-rename-overlay")?.remove(), 3000);

    } catch (e) {
      await setState({ running: false, mode: "renameSections", fatalError: e.message });
      console.error("[Revisor] Erro ao renomear seções:", e);
    } finally {
      renameSectionsRunning = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_RENAME_SECTIONS") return;

    (async () => {
      if (renameSectionsRunning)
        return sendResponse({ ok: false, error: "Renomeação já em andamento." });
      if (!isHomePage())
        return sendResponse({ ok: false, error: "Abra a Home do curso antes de usar." });

      const courseId = await resolveCourseId();
      if (!courseId)
        return sendResponse({ ok: false, error: "Não consegui identificar o ID do curso." });

      sendResponse({ ok: true });
      runRenameSectionsCore(courseId);
    })();

    return true;
  });

  // ================================================================
  // ---------- Criação de Cursos Caixaverso ----------
  // ================================================================

  // Cada entrada tem palavras-chave (lowercase, sem acento) que identificam o tópico.
  // A primeira que tiver TODAS as keywords presentes no tópico normalizado vence.
  const CAIXAVERSO_SUBCATEGORY_RULES = [
    { keywords: ["dev", "c#"],                   id: 18,  name: "C#" },
    { keywords: ["devc#"],                        id: 18,  name: "C#" },
    { keywords: ["dev", "front"],                 id: 3,   name: "HTML e CSS" },
    { keywords: ["devfront"],                     id: 3,   name: "HTML e CSS" },
    { keywords: ["back", "java"],                 id: 1,   name: "Java" },
    { keywords: ["backend", "java"],              id: 1,   name: "Java" },
    { keywords: ["dados"],                        id: 158, name: "Análise de Dados" },
    { keywords: ["ia"],                           id: 155, name: "IA para Programação" },
    { keywords: ["seguranca"],                    id: 118, name: "Segurança" },
    { keywords: ["ux"],                           id: 44,  name: "UX Design" },
  ];

  function normalizeCaixaversoText(str) {
    return str
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
      .replace(/[^a-z0-9#\s-]/g, "")
      .trim();
  }

  function buildCaixaversoSlug(topic, datePart) {
    // datePart: "DD-MM" ou "DD-MM-YY" — pegar só "DD-MM"
    const dateOnly = datePart.split("-").slice(0, 2).join("-");
    const topicSlug = normalizeCaixaversoText(topic)
      .replace(/#/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return `${topicSlug}-${dateOnly}`;
  }

  function parseCaixaversoName(rawName) {
    const match = rawName.trim().match(/^(.*?)\s+(\d{2}-\d{2}(?:-\d{2})?)$/);
    if (!match) return null;
    const topic = match[1].trim();
    const datePart = match[2];
    const slug = buildCaixaversoSlug(topic, datePart);
    return { topic, datePart, fullName: rawName.trim(), slug };
  }

  function mapTopicToSubcategory(topic) {
    const normalized = normalizeCaixaversoText(topic);
    // Remove espaços para testar variações coladas como "devc#", "devfront", "backendjava"
    const compact = normalized.replace(/[\s-]+/g, "");
    for (const rule of CAIXAVERSO_SUBCATEGORY_RULES) {
      const allMatch = rule.keywords.every(kw => normalized.includes(kw) || compact.includes(kw));
      if (allMatch) return { id: rule.id, name: rule.name };
    }
    return null;
  }

  async function createCaixaversoCourseViaAdmin(fullName, slug) {
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "ALURA_REVISOR_CREATE_CAIXAVERSO_COURSE", fullName, slug },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp?.ok) return reject(new Error(resp?.error || "Erro ao criar curso"));
          resolve({ courseId: resp.courseId, courseSlug: resp.courseSlug });
        }
      );
    });
  }

  async function setCaixaversoCourseDetails(courseId, subcategoryId) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "ALURA_REVISOR_SET_CAIXAVERSO_COURSE_DETAILS", courseId, subcategoryId },
        (resp) => {
          if (chrome.runtime.lastError) return resolve({ subcatOk: false, catalogOk: false });
          resolve({ subcatOk: resp?.subcatOk === true, catalogOk: resp?.catalogOk === true });
        }
      );
    });
  }

  async function uploadIconsBatch(courseSlugList) {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "ALURA_REVISOR_UPLOAD_ICONS_BATCH", courseSlugList, categorySlug: "caixa" },
        (resp) => {
          if (chrome.runtime.lastError) return resolve(false);
          resolve(resp?.ok === true);
        }
      );
    });
  }

  async function runCaixaversoCreate(names) {
    const { modal, overlay } = createOverlayModal("440px");

    const titleEl = document.createElement("h3");
    titleEl.style.cssText = "margin:0 0 14px;font-weight:700;font-size:16px;";
    titleEl.textContent = "Criando cursos Caixaverso…";
    modal.appendChild(titleEl);

    const progressEl = document.createElement("p");
    progressEl.style.cssText = "margin:0;font-size:14px;color:#555;";
    modal.appendChild(progressEl);

    const courseResults = [];
    const KEY_PROGRESS = "aluraRevisorCaixaversoProgress";

    const setProgress = (done, currentName) =>
      chrome.storage.local.set({ [KEY_PROGRESS]: { running: true, done, total: names.length, currentName } });

    await setProgress(0, "");

    for (let i = 0; i < names.length; i++) {
      const raw = names[i];
      progressEl.textContent = `Curso ${i + 1}/${names.length} — ${raw}…`;
      await setProgress(i, raw);

      const parsed = parseCaixaversoName(raw);
      if (!parsed) {
        courseResults.push({ name: raw, error: "Nome não reconhecido (esperado: Tema DD-MM ou Tema DD-MM-AA)" });
        continue;
      }

      const fullCourseName = `Gravação Caixaverso: ${parsed.fullName}`;
      const subcatInfo = mapTopicToSubcategory(parsed.topic);

      let courseId, courseSlug;
      try {
        const result = await createCaixaversoCourseViaAdmin(fullCourseName, parsed.slug);
        courseId = result.courseId;
        courseSlug = result.courseSlug;
      } catch (e) {
        courseResults.push({ name: raw, fullName: fullCourseName, slug: parsed.slug, error: `Erro ao criar curso: ${e.message}` });
        continue;
      }

      let subcatSet = false, catalogSet = false;

      // Catálogo — reutiliza o mesmo fluxo da revisão de curso
      progressEl.textContent = `Curso ${i + 1}/${names.length} — ${raw} — catálogo…`;
      console.log(`[Caixaverso] Curso ${courseId}: adicionando ao catálogo "Caixa Econômica Federal"…`);
      try {
        catalogSet = await addToCatalog(courseId, "Caixa Econômica Federal");
        console.log(`[Caixaverso] Catálogo: ${catalogSet ? "OK" : "FALHOU"}`);
      } catch (e) {
        console.warn(`[Caixaverso] Catálogo erro:`, e.message);
      }

      // Subcategoria — reutiliza o mesmo fluxo da revisão de curso
      if (subcatInfo) {
        progressEl.textContent = `Curso ${i + 1}/${names.length} — ${raw} — subcategoria…`;
        console.log(`[Caixaverso] Curso ${courseId}: adicionando à subcategoria ${subcatInfo.id} (${subcatInfo.name})…`);
        try {
          subcatSet = await addToSubcategory(subcatInfo.id, courseId);
          console.log(`[Caixaverso] Subcategoria: ${subcatSet ? "OK" : "FALHOU"}`);
        } catch (e) {
          console.warn(`[Caixaverso] Subcategoria erro:`, e.message);
        }
      }

      courseResults.push({
        name: raw,
        fullName: fullCourseName,
        slug: courseSlug,
        courseId,
        courseUrl: `https://cursos.alura.com.br/course/${courseSlug}`,
        subcategory: subcatInfo ? subcatInfo.name : "—",
        subcatSet,
        catalogSet,
        iconUploaded: false,
      });
    }

    const validCourses = courseResults.filter(r => r.courseId && !r.error);
    if (validCourses.length > 0) {
      progressEl.textContent = `Subindo ${validCourses.length} ícone(s) no GitHub…`;
      try {
        const slugs = validCourses.map(r => r.slug);
        const ok = await uploadIconsBatch(slugs);
        if (ok) validCourses.forEach(r => { r.iconUploaded = true; });
      } catch (_) { /* registrar falha sem parar */ }
    }

    overlay.remove();

    const successCount = courseResults.filter(r => r.courseId && !r.error).length;
    const errorCount = courseResults.filter(r => r.error).length;

    // Atualizar progresso como concluído
    await new Promise(resolve => chrome.storage.local.set({
      [KEY_PROGRESS]: { running: false, done: successCount, total: names.length, errors: errorCount }
    }, resolve));

    // Notificação Chrome com resumo
    chrome.runtime.sendMessage({
      type: "ALURA_REVISOR_CAIXAVERSO_DONE",
      successCount,
      errorCount,
      total: names.length,
    });

    // Salvar resultados e navegar para a home antes de mostrar o relatório,
    // para não mostrar sobre a página de redirect do admin
    const KEY_PENDING = "aluraRevisorPendingCaixaversoReport";
    await new Promise(resolve => chrome.storage.local.set({ [KEY_PENDING]: courseResults }, resolve));
    window.location.href = "https://cursos.alura.com.br";
  }

  function showCaixaversoReport(courseResults, opts = {}) {
    const persistHistory = opts.persistHistory !== false;
    const { modal, overlay } = createOverlayModal("700px");

    const successCourses = courseResults.filter(r => r.courseId && !r.error);
    const failedCourses = courseResults.filter(r => r.error);

    // Título
    const title = document.createElement("h3");
    title.style.cssText = "margin:0 0 16px 0;color:#1c1c1c;font-weight:700;font-size:16px;";
    title.textContent = successCourses.length > 0
      ? `Cursos Caixaverso criados ✅ (${successCourses.length} curso${successCourses.length !== 1 ? "s" : ""}${failedCourses.length > 0 ? `, ${failedCourses.length} erro${failedCourses.length !== 1 ? "s" : ""}` : ""})`
      : `Criação Caixaverso: ${failedCourses.length} erro(s) ❌`;
    modal.appendChild(title);

    const scrollBox = document.createElement("div");
    scrollBox.style.cssText = "max-height:400px;overflow-y:auto;margin-bottom:16px;";

    // Tabela de cursos criados
    if (successCourses.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px;";

      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="background:#f5f5f5;text-align:left;">
        <th style="padding:6px 8px;border-bottom:1px solid #e0e0e0;">ID - Nome</th>
        <th style="padding:6px 8px;border-bottom:1px solid #e0e0e0;">Link</th>
      </tr>`;
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      successCourses.forEach((r, idx) => {
        const tr = document.createElement("tr");
        tr.style.cssText = idx % 2 === 0 ? "background:#fff;" : "background:#fafafa;";
        tr.innerHTML = `
          <td style="padding:5px 8px;border-bottom:1px solid #f0f0f0;font-weight:500;">${r.courseId} - ${r.fullName}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f0f0f0;"><a href="${r.courseUrl}" target="_blank" style="color:#067ada;font-size:11px;">${r.courseUrl}</a></td>
        `;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      scrollBox.appendChild(table);
    }

    // Erros
    if (failedCourses.length > 0) {
      const errTitle = document.createElement("p");
      errTitle.style.cssText = "margin:8px 0 4px;font-weight:600;font-size:13px;color:#c62828;";
      errTitle.textContent = `Erros (${failedCourses.length}):`;
      scrollBox.appendChild(errTitle);

      failedCourses.forEach(r => {
        const errEl = document.createElement("div");
        errEl.style.cssText = "padding:5px 8px;margin:2px 0;background:#fff3f3;border-radius:4px;font-size:12px;color:#c62828;";
        errEl.textContent = `❌ ${r.name}: ${r.error}`;
        scrollBox.appendChild(errEl);
      });
    }

    modal.appendChild(scrollBox);

    // Listagem final formatada — tab-separada para colar no Sheets/Excel
    const listingLines = successCourses.map(r => `${r.courseId} - ${r.fullName}\t${r.courseUrl}`);
    const listingText = listingLines.join("\n");

    // Agrupamento por data (DD-MM extraído do slug)
    function extractDateFromResult(r) {
      const m = (r.slug || "").match(/(\d{2}-\d{2})$/);
      return m ? m[1] : null;
    }
    const dayMap = new Map();
    successCourses.forEach(r => {
      const date = extractDateFromResult(r) || "??";
      if (!dayMap.has(date)) dayMap.set(date, []);
      dayMap.get(date).push(r);
    });

    if (successCourses.length > 0) {
      const listLabel = document.createElement("p");
      listLabel.style.cssText = "margin:0 0 4px;font-weight:600;font-size:13px;color:#1c1c1c;";
      listLabel.textContent = "Copiar para planilha:";
      modal.appendChild(listLabel);

      const listHint = document.createElement("p");
      listHint.style.cssText = "margin:0 0 8px;font-size:11px;color:#888;";
      listHint.textContent = "Cole diretamente no Sheets/Excel — Coluna A: ID - Nome · Coluna B: Link";
      modal.appendChild(listHint);

      // Botões por dia
      if (dayMap.size > 1) {
        const dayBtnRow = document.createElement("div");
        dayBtnRow.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;";

        dayMap.forEach((courses, date) => {
          const dayBtn = document.createElement("button");
          dayBtn.style.cssText = "padding:6px 12px;border:1.5px solid #00c86f;border-radius:6px;cursor:pointer;background:#fff;color:#1c1c1c;font-size:12px;font-weight:500;";
          dayBtn.textContent = `Dia ${date} (${courses.length})`;
          dayBtn.onclick = () => {
            const text = courses.map(r => `${r.courseId} - ${r.fullName}\t${r.courseUrl}`).join("\n");
            navigator.clipboard.writeText(text).then(() => {
              const orig = dayBtn.textContent;
              dayBtn.textContent = "Copiado ✅";
              setTimeout(() => { dayBtn.textContent = orig; }, 2000);
            });
          };
          dayBtnRow.appendChild(dayBtn);
        });

        modal.appendChild(dayBtnRow);
      }
    }

    // Botões
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";

    if (successCourses.length > 0) {
      const copyBtn = document.createElement("button");
      copyBtn.style.cssText = "padding:8px 16px;border:0;border-radius:8px;cursor:pointer;background:#1c1c1c;color:#fff;font-size:13px;font-weight:600;";
      copyBtn.textContent = dayMap.size > 1 ? "Copiar tudo" : "Copiar lista";
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(listingText).then(() => {
          const orig = copyBtn.textContent;
          copyBtn.textContent = "Copiado ✅";
          setTimeout(() => { copyBtn.textContent = orig; }, 2000);
        });
      };
      btnRow.appendChild(copyBtn);

      const downloadBtn = document.createElement("button");
      downloadBtn.style.cssText = "padding:8px 16px;border:1.5px solid #ddd;border-radius:8px;cursor:pointer;background:#fff;color:#1c1c1c;font-size:13px;font-weight:500;";
      downloadBtn.textContent = "Baixar .txt";
      downloadBtn.onclick = () => {
        const blob = new Blob([listingText], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `caixaverso-cursos-${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      };
      btnRow.appendChild(downloadBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.style.cssText = "padding:8px 16px;border:1.5px solid #ddd;border-radius:8px;cursor:pointer;background:#fff;color:#1c1c1c;font-size:13px;font-weight:500;";
    closeBtn.textContent = "Fechar";
    closeBtn.onclick = () => overlay.remove();
    btnRow.appendChild(closeBtn);

    modal.appendChild(btnRow);

    // Salvar no histórico
    if (persistHistory) {
      saveToHistory({
        type: "caixaversoCreate",
        runAt: Date.now(),
        totalCourses: courseResults.length,
        ok: failedCourses.length === 0 && successCourses.length > 0,
        courseResults,
      });
    }
  }

  // Listener: iniciar criação Caixaverso
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_CAIXAVERSO_CREATE") return;
    sendResponse({ ok: true });
    runCaixaversoCreate(msg.names || []);
    return true;
  });

  // Listener: reabrir relatório Caixaverso do histórico
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "ALURA_REVISOR_SHOW_CAIXAVERSO_REPORT") return;
    showCaixaversoReport(msg.courseResults || [], { persistHistory: false });
    sendResponse({ ok: true });
    return true;
  });

  // ---------- Boot: exibir relatório Caixaverso pendente ----------
  (async () => {
    const KEY_PENDING = "aluraRevisorPendingCaixaversoReport";
    const data = await new Promise(resolve => chrome.storage.local.get(KEY_PENDING, resolve));
    const pending = data?.[KEY_PENDING];
    if (pending && Array.isArray(pending) && pending.length > 0) {
      await new Promise(resolve => chrome.storage.local.remove(KEY_PENDING, resolve));
      showCaixaversoReport(pending);
    }
  })();
})();
