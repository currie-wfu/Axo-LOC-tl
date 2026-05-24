(() => {
  const NCBI_ESUMMARY =
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
  const NCBI_GENE_URL = "https://www.ncbi.nlm.nih.gov/gene/";
  const BATCH_SIZE = 200;
  const BATCH_DELAY_MS = 400;
  const LOC_RE = /\bLOC?(\d{4,})\b/gi;
  const DIGIT_RE = /^\d{4,}$/;

  const idInput = document.getElementById("idInput");
  const fileInput = document.getElementById("fileInput");
  const dropZone = document.getElementById("dropZone");
  const fileStatus = document.getElementById("fileStatus");
  const convertBtn = document.getElementById("convertBtn");
  const clearBtn = document.getElementById("clearBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const resultsSection = document.getElementById("resultsSection");
  const resultsBody = document.querySelector("#resultsTable tbody");
  const progressEl = document.getElementById("progress");
  const progressFill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");
  const summaryEl = document.getElementById("summary");

  let lastResults = [];

  function updateFileStatus() {
    const f = fileInput.files[0];
    if (!f) {
      fileStatus.textContent = "";
      dropZone.classList.remove("has-file");
      return;
    }
    fileStatus.textContent = `Loaded: ${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
    dropZone.classList.add("has-file");
  }

  fileInput.addEventListener("change", updateFileStatus);

  ["dragenter", "dragover"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "dragend"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (evt === "dragleave" && dropZone.contains(e.relatedTarget)) return;
      dropZone.classList.remove("dragover");
    });
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("dragover");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    try {
      const dt = new DataTransfer();
      dt.items.add(files[0]);
      fileInput.files = dt.files;
    } catch (_) {
      // Older browsers: fall back to reading the file directly later
    }
    updateFileStatus();
  });

  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  clearBtn.addEventListener("click", () => {
    idInput.value = "";
    fileInput.value = "";
    updateFileStatus();
    resultsSection.classList.add("hidden");
    resultsBody.innerHTML = "";
    summaryEl.textContent = "";
    lastResults = [];
  });

  convertBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];
    let rawText = idInput.value.trim();

    if (file) {
      try {
        rawText = await file.text();
      } catch (e) {
        alert("Could not read file: " + e.message);
        return;
      }
    }

    if (!rawText) {
      alert("Please paste some IDs or upload a file.");
      return;
    }

    const ids = extractGeneIds(rawText, file && file.name);
    if (ids.length === 0) {
      alert(
        "No LOC IDs (or numeric gene IDs) found in the input. " +
          "Expected values like 'LOC138567407' or '138567407'."
      );
      return;
    }

    resultsSection.classList.remove("hidden");
    resultsBody.innerHTML = "";
    summaryEl.textContent = "";
    lastResults = [];

    convertBtn.disabled = true;
    convertBtn.textContent = "Resolving…";
    progressEl.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressText.textContent = `Querying NCBI for ${ids.length} gene${ids.length === 1 ? "" : "s"}…`;

    try {
      const results = await resolveGeneNames(ids, (done, total) => {
        const pct = Math.round((done / total) * 100);
        progressFill.style.width = pct + "%";
        progressText.textContent = `Resolved ${done} of ${total}…`;
      });

      lastResults = results;
      renderResults(results);
    } catch (e) {
      alert("Error resolving gene names: " + e.message);
    } finally {
      convertBtn.disabled = false;
      convertBtn.textContent = "Resolve gene names";
      progressEl.classList.add("hidden");
    }
  });

  downloadBtn.addEventListener("click", () => {
    if (!lastResults.length) return;
    const csv = toCsv(lastResults);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "loc_gene_names.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  function extractGeneIds(text, filename) {
    const isCsv = filename && /\.csv$/i.test(filename);
    if (isCsv) {
      return extractFromCsv(text);
    }
    return extractByRegex(text);
  }

  function extractByRegex(text) {
    const found = new Set();
    let m;
    LOC_RE.lastIndex = 0;
    while ((m = LOC_RE.exec(text)) !== null) {
      found.add(m[1]);
    }
    if (found.size === 0) {
      const tokens = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
      for (const t of tokens) {
        if (DIGIT_RE.test(t)) found.add(t);
      }
    }
    return [...found];
  }

  function extractFromCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) return [];

    const colCounts = [];
    const colCandidates = [];
    const startRow = looksLikeHeader(rows[0]) ? 1 : 0;

    for (let r = startRow; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        const cell = (row[c] || "").trim();
        LOC_RE.lastIndex = 0;
        const m = LOC_RE.exec(cell);
        if (m) {
          colCounts[c] = (colCounts[c] || 0) + 1;
          if (!colCandidates[c]) colCandidates[c] = new Set();
          colCandidates[c].add(m[1]);
        }
      }
    }

    if (colCandidates.length === 0) {
      return extractByRegex(text);
    }

    let bestCol = 0;
    let bestCount = -1;
    for (let c = 0; c < colCandidates.length; c++) {
      const count = colCandidates[c] ? colCandidates[c].size : 0;
      if (count > bestCount) {
        bestCount = count;
        bestCol = c;
      }
    }

    return [...(colCandidates[bestCol] || [])];
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cell += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          row.push(cell);
          cell = "";
        } else if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && text[i + 1] === "\n") i++;
          row.push(cell);
          rows.push(row);
          row = [];
          cell = "";
        } else {
          cell += ch;
        }
      }
    }
    if (cell.length > 0 || row.length > 0) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c && c.trim() !== ""));
  }

  function looksLikeHeader(row) {
    if (!row || !row.length) return false;
    return row.every((cell) => {
      const c = (cell || "").trim();
      LOC_RE.lastIndex = 0;
      return !LOC_RE.test(c) && !DIGIT_RE.test(c);
    });
  }

  async function resolveGeneNames(ids, onProgress) {
    const batches = [];
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      batches.push(ids.slice(i, i + BATCH_SIZE));
    }

    const results = [];
    let done = 0;

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const url =
        NCBI_ESUMMARY +
        "?db=gene&retmode=json&id=" +
        encodeURIComponent(batch.join(","));

      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`NCBI request failed (HTTP ${resp.status})`);
      }
      const data = await resp.json();
      const recs = (data && data.result) || {};

      for (const id of batch) {
        const rec = recs[id];
        const name = rec && (rec.description || rec.otherdesignations || "");
        results.push({
          locId: "LOC" + id,
          rawId: id,
          name: name && name.trim() ? name.trim() : null,
        });
      }

      done += batch.length;
      onProgress(done, ids.length);

      if (b < batches.length - 1) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    return results;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function renderResults(results) {
    resultsBody.innerHTML = "";
    const found = results.filter((r) => r.name);
    const missing = results.length - found.length;

    summaryEl.textContent =
      `Resolved ${found.length} of ${results.length} gene ID${results.length === 1 ? "" : "s"}.` +
      (missing > 0 ? `  ${missing} not found.` : "");

    for (const r of results) {
      const tr = document.createElement("tr");
      if (!r.name) tr.classList.add("not-found");

      const tdId = document.createElement("td");
      tdId.textContent = r.locId;

      const tdName = document.createElement("td");
      tdName.textContent = r.name || "Not found";

      const tdLink = document.createElement("td");
      const url = NCBI_GENE_URL + r.rawId;
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = url;
      tdLink.appendChild(a);

      tr.appendChild(tdId);
      tr.appendChild(tdName);
      tr.appendChild(tdLink);
      resultsBody.appendChild(tr);
    }
  }

  function toCsv(results) {
    const lines = ["LOC Gene ID,Gene Name,NCBI Link"];
    for (const r of results) {
      lines.push(
        csvCell(r.locId) +
          "," +
          csvCell(r.name || "") +
          "," +
          csvCell(NCBI_GENE_URL + r.rawId)
      );
    }
    return lines.join("\n") + "\n";
  }

  function csvCell(s) {
    if (s == null) return "";
    const str = String(s);
    if (/[",\n\r]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }
})();
