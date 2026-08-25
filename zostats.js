var ZoStats = (() => {
  "use strict";

  const API_ROOT = "https://api.semanticscholar.org/graph/v1";
  const CACHE_SCHEMA_VERSION = 1;
  const CACHE_LIFETIME = 7 * 24 * 60 * 60 * 1000;
  const MAX_CACHE_ENTRIES = 100;
  const CITATION_FETCH_LIMIT = 1000;
  const CITING_LIST_LIMIT = 100;
  const PAPER_FIELDS = [
    "title",
    "year",
    "authors",
    "venue",
    "citationCount",
    "influentialCitationCount",
    "referenceCount",
    "url",
    "externalIds",
    "fieldsOfStudy",
    "publicationTypes",
    "openAccessPdf"
  ].join(",");
  const CITATION_FIELDS = [
    "title",
    "year",
    "authors",
    "venue",
    "url",
    "citationCount",
    "isInfluential"
  ].join(",");

  let pluginID;
  let rootURI;
  let registeredPaneID;
  let cachePath;
  let cacheLoadPromise = Promise.resolve();
  let cacheWritePromise = Promise.resolve();
  const cache = new Map();
  const renderTokens = new WeakMap();

  function debug(message) {
    if (typeof Zotero !== "undefined") {
      Zotero.debug(`ZoStats: ${message}`);
    }
  }

  function normalizeDOI(value) {
    return String(value || "")
      .trim()
      .replace(/^doi:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/[\s.,;]+$/, "")
      .toLowerCase();
  }

  function normalizeTitle(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function safeField(item, field) {
    try {
      return item?.getField?.(field) || "";
    }
    catch (_) {
      return "";
    }
  }

  function extractIdentifiers(item) {
    const extra = safeField(item, "extra");
    const doi = normalizeDOI(
      safeField(item, "DOI") || extra.match(/^DOI:\s*(.+)$/im)?.[1]
    );
    if (doi) return { apiID: `DOI:${doi}`, cacheKey: `doi:${doi}`, source: "DOI" };

    const pmid = extra.match(/^PMID:\s*(\d+)\s*$/im)?.[1];
    if (pmid) return { apiID: `PMID:${pmid}`, cacheKey: `pmid:${pmid}`, source: "PMID" };

    const arxiv = (
      extra.match(/^arXiv:\s*([^\s]+)\s*$/im)?.[1]
      || (safeField(item, "archive").toLowerCase() === "arxiv"
        ? safeField(item, "archiveLocation")
        : "")
    ).replace(/^arxiv:/i, "");
    if (arxiv) return { apiID: `ARXIV:${arxiv}`, cacheKey: `arxiv:${arxiv}`, source: "arXiv" };

    const title = safeField(item, "title").trim();
    if (title) {
      return {
        apiID: null,
        cacheKey: `title:${normalizeTitle(title)}`,
        source: "title",
        title
      };
    }
    return null;
  }

  function isSupportedItem(item) {
    return Boolean(item?.isRegularItem?.() && safeField(item, "title"));
  }

  function selectCacheEntries(entries, now = Date.now(), maximum = MAX_CACHE_ENTRIES) {
    return entries
      .filter(([, entry]) => entry?.expires > now && entry?.value)
      .sort((a, b) => (b[1].lastAccessed || 0) - (a[1].lastAccessed || 0))
      .slice(0, maximum);
  }

  function pruneCache(now = Date.now(), maximum = MAX_CACHE_ENTRIES) {
    const retained = selectCacheEntries([...cache.entries()], now, maximum);
    cache.clear();
    for (const [key, entry] of retained) cache.set(key, entry);
    return retained.length;
  }

  async function loadPersistentCache() {
    try {
      if (!cachePath || !(await IOUtils.exists(cachePath))) return;
      const stored = await IOUtils.readJSON(cachePath);
      if (stored?.version !== CACHE_SCHEMA_VERSION || !Array.isArray(stored.entries)) return;
      for (const entry of stored.entries) {
        if (typeof entry?.key !== "string") continue;
        cache.set(entry.key, {
          expires: entry.expires,
          lastAccessed: entry.lastAccessed,
          value: entry.value
        });
      }
      const count = pruneCache();
      debug(`Loaded ${count} cached paper metric${count === 1 ? "" : "s"}`);
    }
    catch (error) {
      debug(`Could not read persistent cache: ${error}`);
    }
  }

  function savePersistentCache() {
    cacheWritePromise = cacheWritePromise.then(async () => {
      try {
        if (!cachePath) return;
        pruneCache();
        const entries = [...cache.entries()].map(([key, entry]) => ({ key, ...entry }));
        const tmpPath = `${cachePath}.tmp`;
        await IOUtils.remove(tmpPath, { ignoreAbsent: true });
        await IOUtils.writeJSON(
          cachePath,
          { version: CACHE_SCHEMA_VERSION, entries },
          { tmpPath }
        );
      }
      catch (error) {
        // A cache write must never prevent fresh metrics from being displayed.
        debug(`Could not write persistent cache: ${error}`);
      }
    });
    return cacheWritePromise;
  }

  async function requestJSON(url) {
    let timeoutID;
    try {
      const response = await Promise.race([
        Zotero.HTTP.request("GET", url, {
          responseType: "json",
          timeout: 30000,
          headers: { Accept: "application/json" }
        }),
        new Promise((_, reject) => {
          timeoutID = setTimeout(
            () => reject(new Error("Citation service request timed out.")),
            35000
          );
        })
      ]);
      return response.response;
    }
    catch (error) {
      if (error?.message === "Citation service request timed out.") throw error;
      const status = error?.status || error?.xmlhttp?.status;
      if (status === 404) throw new Error("No matching paper was found in Semantic Scholar.");
      if (status === 429) throw new Error("Semantic Scholar is rate-limiting requests. Try again in a minute.");
      if (status) throw new Error(`Citation service returned HTTP ${status}.`);
      throw new Error("Could not contact Semantic Scholar. Check your internet connection.");
    }
    finally {
      if (timeoutID) clearTimeout(timeoutID);
    }
  }

  async function findPaper(identifier) {
    if (identifier.apiID) {
      const url = `${API_ROOT}/paper/${encodeURIComponent(identifier.apiID)}?fields=${encodeURIComponent(PAPER_FIELDS)}`;
      return requestJSON(url);
    }

    const url = `${API_ROOT}/paper/search?query=${encodeURIComponent(identifier.title)}&limit=5&fields=${encodeURIComponent(PAPER_FIELDS)}`;
    const result = await requestJSON(url);
    const wanted = normalizeTitle(identifier.title);
    const paper = (result?.data || []).find(candidate => normalizeTitle(candidate.title) === wanted);
    if (!paper) {
      throw new Error("No exact title match was found. Add a DOI, PMID, or arXiv ID for reliable matching.");
    }
    return paper;
  }

  async function fetchCitations(paperID) {
    const url = `${API_ROOT}/paper/${encodeURIComponent(paperID)}/citations?limit=${CITATION_FETCH_LIMIT}&fields=${encodeURIComponent(CITATION_FIELDS)}`;
    const result = await requestJSON(url);
    return {
      citations: result?.data || [],
      next: result?.next ?? null
    };
  }

  function summarize(paper, citationResult) {
    const records = citationResult.citations
      .map(citation => ({
        ...(citation.citingPaper || {}),
        isInfluential: Boolean(citation.isInfluential)
      }))
      .filter(work => work.paperId && work.title);

    const byYear = new Map();
    let unknownYear = 0;
    for (const work of records) {
      if (Number.isInteger(work.year)) {
        byYear.set(work.year, (byYear.get(work.year) || 0) + 1);
      }
      else {
        unknownYear++;
      }
    }

    const knownYears = [...byYear.keys()].sort((a, b) => a - b);
    let firstYear = knownYears[0];
    let lastYear = knownYears.at(-1);
    if (Number.isInteger(paper.year)) firstYear = Math.min(firstYear ?? paper.year, paper.year);
    if (firstYear !== undefined) lastYear = Math.max(lastYear ?? firstYear, new Date().getFullYear());

    const yearly = [];
    if (firstYear !== undefined && lastYear !== undefined) {
      for (let year = firstYear; year <= lastYear; year++) {
        yearly.push({ year, count: byYear.get(year) || 0 });
      }
    }

    const peak = yearly.reduce(
      (best, point) => point.count > best.count ? point : best,
      { year: null, count: 0 }
    );
    const currentYear = new Date().getFullYear();
    const recentYears = [currentYear - 2, currentYear - 1, currentYear];
    const recentAverage = recentYears.reduce((sum, year) => sum + (byYear.get(year) || 0), 0) / recentYears.length;
    const activeYears = Number.isInteger(paper.year) ? Math.max(1, currentYear - paper.year + 1) : Math.max(1, knownYears.length);

    records.sort((a, b) =>
      (b.year || 0) - (a.year || 0)
      || (b.citationCount || 0) - (a.citationCount || 0)
      || a.title.localeCompare(b.title)
    );

    const venueCounts = new Map();
    for (const work of records) {
      if (work.venue) venueCounts.set(work.venue, (venueCounts.get(work.venue) || 0) + 1);
    }
    const topVenues = [...venueCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([venue, count]) => ({ venue, count }));

    return {
      paper,
      records,
      yearly,
      unknownYear,
      peak,
      recentAverage,
      citationsPerYear: (paper.citationCount || 0) / activeYears,
      topVenues,
      truncated: citationResult.next !== null || (paper.citationCount || 0) > records.length
    };
  }

  async function getStats(item, force = false) {
    await cacheLoadPromise;
    const identifier = extractIdentifiers(item);
    if (!identifier) throw new Error("This item needs a title or scholarly identifier.");
    const cached = cache.get(identifier.cacheKey);
    if (!force && cached && cached.expires > Date.now()) {
      cached.lastAccessed = Date.now();
      return cached.value;
    }

    const paper = await findPaper(identifier);
    const citations = await fetchCitations(paper.paperId);
    const value = summarize(paper, citations);
    value.matchSource = identifier.source;
    value.fetchedAt = Date.now();
    cache.set(identifier.cacheKey, {
      expires: Date.now() + CACHE_LIFETIME,
      lastAccessed: Date.now(),
      value
    });
    await savePersistentCache();
    return value;
  }

  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function formatNumber(value, digits = 0) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value || 0);
  }

  function addOpenHandler(node, url) {
    if (!url) return;
    node.classList.add("zostats-link");
    node.setAttribute("href", url);
    node.addEventListener("click", event => {
      event.preventDefault();
      Zotero.launchURL(url);
    });
  }

  function appendStyles(doc, root) {
    const style = element(doc, "style");
    style.textContent = `
      .zostats-root { color: var(--fill-primary); font: menu; padding: 2px 0 10px; }
      .zostats-loading, .zostats-message { color: var(--fill-secondary); padding: 14px 8px; text-align: center; }
      .zostats-error { color: var(--fill-primary); background: color-mix(in srgb, #d33 10%, transparent); border-radius: 6px; padding: 10px; }
      .zostats-paper-title { font-size: 14px; font-weight: 650; line-height: 1.35; margin: 4px 0 2px; }
      .zostats-paper-meta, .zostats-coverage { color: var(--fill-secondary); font-size: 11px; line-height: 1.4; }
      .zostats-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin: 11px 0; }
      .zostats-card { background: var(--material-sidepane); border: 1px solid var(--material-border); border-radius: 7px; padding: 8px; min-width: 0; }
      .zostats-card-value { font-size: 20px; font-weight: 700; line-height: 1.1; }
      .zostats-card-label { color: var(--fill-secondary); font-size: 10px; margin-top: 3px; }
      .zostats-subheading { font-size: 12px; font-weight: 650; margin: 14px 0 6px; }
      .zostats-chart-wrap { overflow-x: auto; padding-bottom: 2px; }
      .zostats-chart { display: block; min-width: 470px; width: 100%; height: auto; }
      .zostats-axis { stroke: var(--material-border); stroke-width: 1; }
      .zostats-bar { fill: #5b8def; }
      .zostats-bar:hover { fill: #3f73dc; }
      .zostats-chart-label { fill: var(--fill-secondary); font: 9px sans-serif; }
      .zostats-list { display: grid; gap: 7px; }
      .zostats-work { border-top: 1px solid var(--material-border); padding-top: 7px; }
      .zostats-work:first-child { border-top: 0; padding-top: 0; }
      .zostats-work-title { color: var(--fill-primary); font-size: 12px; font-weight: 600; line-height: 1.35; text-decoration: none; }
      .zostats-work-meta { color: var(--fill-secondary); font-size: 10px; line-height: 1.4; margin-top: 2px; }
      .zostats-badge { background: color-mix(in srgb, #5b8def 18%, transparent); border-radius: 10px; display: inline-block; font-size: 9px; margin-left: 5px; padding: 1px 5px; }
      .zostats-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
      .zostats-chip { background: var(--material-sidepane); border: 1px solid var(--material-border); border-radius: 10px; font-size: 9px; padding: 2px 6px; }
      .zostats-venues { color: var(--fill-secondary); font-size: 10px; line-height: 1.6; }
      .zostats-actions { display: flex; gap: 8px; margin-top: 9px; }
      .zostats-button { background: var(--material-button); border: 1px solid var(--material-border); border-radius: 5px; color: var(--fill-primary); cursor: pointer; font: inherit; font-size: 10px; padding: 4px 8px; }
      .zostats-link { cursor: pointer; }
    `;
    root.append(style);
  }

  function renderLoading(doc, body) {
    body.replaceChildren();
    const root = element(doc, "div", "zostats-root");
    appendStyles(doc, root);
    root.append(element(doc, "div", "zostats-loading", "Loading citation statistics…"));
    body.append(root);
  }

  function renderError(doc, body, message, item) {
    body.replaceChildren();
    const root = element(doc, "div", "zostats-root");
    appendStyles(doc, root);
    root.append(element(doc, "div", "zostats-error", message));
    const actions = element(doc, "div", "zostats-actions");
    const retry = element(doc, "button", "zostats-button", "Try again");
    retry.addEventListener("click", () => loadAndRender({ doc, body, item }, true));
    actions.append(retry);
    root.append(actions);
    body.append(root);
  }

  function renderChart(doc, yearly) {
    const NS = "http://www.w3.org/2000/svg";
    const width = 660;
    const height = 220;
    const margin = { top: 15, right: 12, bottom: 34, left: 32 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("class", "zostats-chart");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Citations by year");

    const max = Math.max(1, ...yearly.map(point => point.count));
    const barSlot = plotWidth / Math.max(1, yearly.length);
    const barWidth = Math.max(1, Math.min(18, barSlot * 0.72));
    const labelEvery = Math.max(1, Math.ceil(yearly.length / 9));

    const axis = doc.createElementNS(NS, "line");
    axis.setAttribute("class", "zostats-axis");
    axis.setAttribute("x1", margin.left);
    axis.setAttribute("x2", width - margin.right);
    axis.setAttribute("y1", margin.top + plotHeight);
    axis.setAttribute("y2", margin.top + plotHeight);
    svg.append(axis);

    yearly.forEach((point, index) => {
      const barHeight = (point.count / max) * plotHeight;
      const x = margin.left + index * barSlot + (barSlot - barWidth) / 2;
      const y = margin.top + plotHeight - barHeight;
      const rect = doc.createElementNS(NS, "rect");
      rect.setAttribute("class", "zostats-bar");
      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", barWidth);
      rect.setAttribute("height", Math.max(0.5, barHeight));
      rect.setAttribute("rx", Math.min(2, barWidth / 3));
      const title = doc.createElementNS(NS, "title");
      title.textContent = `${point.year}: ${formatNumber(point.count)} citation${point.count === 1 ? "" : "s"}`;
      rect.append(title);
      svg.append(rect);

      if (index % labelEvery === 0 || index === yearly.length - 1) {
        const label = doc.createElementNS(NS, "text");
        label.setAttribute("class", "zostats-chart-label");
        label.setAttribute("x", x + barWidth / 2);
        label.setAttribute("y", height - 13);
        label.setAttribute("text-anchor", "middle");
        label.textContent = point.year;
        svg.append(label);
      }
    });

    const maxLabel = doc.createElementNS(NS, "text");
    maxLabel.setAttribute("class", "zostats-chart-label");
    maxLabel.setAttribute("x", margin.left - 5);
    maxLabel.setAttribute("y", margin.top + 4);
    maxLabel.setAttribute("text-anchor", "end");
    maxLabel.textContent = formatNumber(max);
    svg.append(maxLabel);
    return svg;
  }

  function metricCard(doc, value, label) {
    const card = element(doc, "div", "zostats-card");
    card.append(element(doc, "div", "zostats-card-value", value));
    card.append(element(doc, "div", "zostats-card-label", label));
    return card;
  }

  function renderStats(doc, body, stats) {
    body.replaceChildren();
    const root = element(doc, "div", "zostats-root");
    appendStyles(doc, root);

    const title = element(doc, "a", "zostats-paper-title", stats.paper.title || "Untitled paper");
    addOpenHandler(title, stats.paper.url);
    root.append(title);
    const authors = (stats.paper.authors || []).slice(0, 4).map(author => author.name).join(", ");
    const meta = [authors, stats.paper.venue, stats.paper.year].filter(Boolean).join(" · ");
    if (meta) root.append(element(doc, "div", "zostats-paper-meta", meta));

    const grid = element(doc, "div", "zostats-grid");
    grid.append(metricCard(doc, formatNumber(stats.paper.citationCount), "Total citations"));
    grid.append(metricCard(doc, formatNumber(stats.paper.influentialCitationCount), "Influential citations"));
    grid.append(metricCard(doc, formatNumber(stats.citationsPerYear, 1), "Citations per year"));
    grid.append(metricCard(doc, formatNumber(stats.recentAverage, 1), "Recent 3-year pace"));
    grid.append(metricCard(doc, formatNumber(stats.paper.referenceCount), "References"));
    grid.append(metricCard(doc, stats.peak.year ? `${stats.peak.year} (${stats.peak.count})` : "—", "Peak citation year"));
    root.append(grid);

    root.append(element(doc, "div", "zostats-subheading", "Citations by year"));
    if (stats.yearly.length) {
      const chartWrap = element(doc, "div", "zostats-chart-wrap");
      chartWrap.append(renderChart(doc, stats.yearly));
      root.append(chartWrap);
    }
    else {
      root.append(element(doc, "div", "zostats-message", "No dated citing papers were returned."));
    }

    const fields = stats.paper.fieldsOfStudy || [];
    if (fields.length) {
      const chips = element(doc, "div", "zostats-chips");
      for (const field of fields.slice(0, 8)) chips.append(element(doc, "span", "zostats-chip", field));
      root.append(chips);
    }

    if (stats.topVenues.length) {
      root.append(element(doc, "div", "zostats-subheading", "Where citations appear"));
      const venues = element(doc, "div", "zostats-venues");
      venues.textContent = stats.topVenues.map(entry => `${entry.venue} (${entry.count})`).join(" · ");
      root.append(venues);
    }

    root.append(element(doc, "div", "zostats-subheading", "Citing articles"));
    const list = element(doc, "div", "zostats-list");
    const visible = stats.records.slice(0, CITING_LIST_LIMIT);
    for (const work of visible) {
      const row = element(doc, "div", "zostats-work");
      const workTitle = element(doc, "a", "zostats-work-title", work.title);
      addOpenHandler(workTitle, work.url);
      row.append(workTitle);
      if (work.isInfluential) row.append(element(doc, "span", "zostats-badge", "Influential"));
      const workAuthors = (work.authors || []).slice(0, 3).map(author => author.name).join(", ");
      const workMeta = [workAuthors, work.venue, work.year, `${formatNumber(work.citationCount)} citations`]
        .filter(Boolean)
        .join(" · ");
      row.append(element(doc, "div", "zostats-work-meta", workMeta));
      list.append(row);
    }
    if (!visible.length) list.append(element(doc, "div", "zostats-message", "No citing articles were returned."));
    root.append(list);

    const coverage = [];
    coverage.push(`Matched by ${stats.matchSource}`);
    if (stats.fetchedAt) coverage.push(`updated ${new Date(stats.fetchedAt).toLocaleString()}`);
    coverage.push(`${formatNumber(stats.records.length)} citing records retrieved`);
    if (stats.unknownYear) coverage.push(`${formatNumber(stats.unknownYear)} without a year`);
    if (stats.truncated) coverage.push(`yearly chart is limited to the first ${CITATION_FETCH_LIMIT} records`);
    root.append(element(doc, "div", "zostats-coverage", coverage.join(" · ")));

    const actions = element(doc, "div", "zostats-actions");
    if (stats.paper.url) {
      const semanticScholar = element(doc, "button", "zostats-button", "Open in Semantic Scholar");
      semanticScholar.addEventListener("click", () => Zotero.launchURL(stats.paper.url));
      actions.append(semanticScholar);
    }
    const pdfURL = stats.paper.openAccessPdf?.url;
    if (pdfURL) {
      const pdf = element(doc, "button", "zostats-button", "Open access PDF");
      pdf.addEventListener("click", () => Zotero.launchURL(pdfURL));
      actions.append(pdf);
    }
    root.append(actions);
    body.append(root);
  }

  async function loadAndRender(props, force = false) {
    const { doc, body, item, setSectionSummary } = props;
    const token = {};
    renderTokens.set(body, token);
    try {
      renderLoading(doc, body);
      setSectionSummary?.("Loading…");
      debug(`Loading metrics for item ${item?.id || "unknown"}`);
      const stats = await getStats(item, force);
      if (renderTokens.get(body) !== token) return;
      renderStats(doc, body, stats);
      setSectionSummary?.(`${formatNumber(stats.paper.citationCount)} citations`);
      debug(`Loaded metrics for item ${item?.id || "unknown"}`);
    }
    catch (error) {
      if (renderTokens.get(body) !== token) return;
      debug(error?.stack || error);
      renderError(doc, body, error.message || "Citation statistics could not be loaded.", item);
      setSectionSummary?.("Unavailable");
    }
  }

  function init(options) {
    pluginID = options.pluginID;
    rootURI = options.rootURI;
    cachePath = PathUtils.join(Zotero.DataDirectory.dir, "zostats-cache.json");
    cacheLoadPromise = loadPersistentCache();
    registeredPaneID = Zotero.ItemPaneManager.registerSection({
      paneID: "paper-statistics",
      pluginID,
      header: {
        l10nID: "zostats-item-pane-header",
        icon: rootURI + "icons/stats.svg"
      },
      sidenav: {
        l10nID: "zostats-item-pane-sidenav",
        icon: rootURI + "icons/stats.svg"
      },
      sectionButtons: [{
        type: "zostats-refresh",
        icon: rootURI + "icons/refresh.svg",
        l10nID: "zostats-refresh-button",
        onClick: props => loadAndRender(props, true)
      }],
      onItemChange: ({ item, setEnabled }) => setEnabled(isSupportedItem(item)),
      onRender: props => {
        // Zotero 10 may defer onAsyncRender indefinitely for custom sections
        // that begin outside the visible item-pane viewport. Starting the
        // promise here guarantees that an opened section cannot remain on its
        // synchronous placeholder.
        loadAndRender(props);
      }
    });
    if (!registeredPaneID) throw new Error("Could not register the ZoStats item-pane section");
  }

  function addToWindow(window) {
    window?.MozXULElement?.insertFTLIfNeeded("zostats.ftl");
  }

  function removeFromWindow(window) {
    window?.document
      ?.querySelectorAll?.('link[rel="localization"][href="zostats.ftl"]')
      ?.forEach(link => link.remove());
  }

  function addToAllWindows() {
    for (const window of Zotero.getMainWindows()) addToWindow(window);
  }

  function removeFromAllWindows() {
    for (const window of Zotero.getMainWindows()) removeFromWindow(window);
  }

  function shutdown() {
    if (registeredPaneID) {
      Zotero.ItemPaneManager.unregisterSection(registeredPaneID);
      registeredPaneID = undefined;
    }
    removeFromAllWindows();
    cache.clear();
  }

  return {
    init,
    shutdown,
    addToWindow,
    removeFromWindow,
    addToAllWindows,
    _test: {
      normalizeDOI,
      normalizeTitle,
      extractIdentifiers,
      summarize,
      isSupportedItem,
      selectCacheEntries
    }
  };
})();
