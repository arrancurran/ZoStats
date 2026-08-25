const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadTestAPI() {
  const context = vm.createContext({ console, Intl, Map, Date, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync("zostats.js", "utf8"), context);
  return context.ZoStats._test;
}

function item(fields, regular = true) {
  return {
    isRegularItem: () => regular,
    getField: field => fields[field] || ""
  };
}

test("normalizes DOI URLs and punctuation", () => {
  const api = loadTestAPI();
  assert.equal(api.normalizeDOI(" https://doi.org/10.1000/ABC.123; "), "10.1000/abc.123");
});

test("prefers DOI and recognizes PMID, arXiv, and title fallbacks", () => {
  const api = loadTestAPI();
  assert.equal(api.extractIdentifiers(item({ DOI: "10.1/Test", title: "Paper" })).apiID, "DOI:10.1/test");
  assert.equal(api.extractIdentifiers(item({ extra: "PMID: 12345", title: "Paper" })).apiID, "PMID:12345");
  assert.equal(api.extractIdentifiers(item({ archive: "arXiv", archiveLocation: "2401.01234", title: "Paper" })).apiID, "ARXIV:2401.01234");
  assert.equal(api.extractIdentifiers(item({ title: "A  Useful—Paper!" })).cacheKey, "title:a useful paper");
});

test("summarizes yearly citations and sorts citing works", () => {
  const api = loadTestAPI();
  const summary = api.summarize(
    { year: 2022, citationCount: 4, referenceCount: 20 },
    {
      next: null,
      citations: [
        { isInfluential: false, citingPaper: { paperId: "a", title: "Older", year: 2023, venue: "A", citationCount: 1 } },
        { isInfluential: true, citingPaper: { paperId: "b", title: "Newer", year: 2024, venue: "A", citationCount: 8 } },
        { isInfluential: false, citingPaper: { paperId: "c", title: "Also newer", year: 2024, venue: "B", citationCount: 2 } },
        { isInfluential: false, citingPaper: { paperId: "d", title: "Unknown year", year: null, citationCount: 0 } }
      ]
    },
    2020
  );
  assert.equal(summary.yearly[0].year, 2020);
  assert.equal(summary.yearly.find(point => point.year === 2023).count, 1);
  assert.equal(summary.yearly.find(point => point.year === 2024).count, 2);
  assert.deepEqual({ ...summary.peak }, { year: 2024, count: 2 });
  assert.equal(summary.unknownYear, 1);
  assert.equal(summary.records[0].title, "Newer");
  assert.equal(summary.topVenues[0].venue, "A");
  assert.equal(summary.topVenues[0].count, 2);
  assert.equal(summary.retrievedCount, 4);
});

test("only enables statistics for titled regular items", () => {
  const api = loadTestAPI();
  assert.equal(api.isSupportedItem(item({ title: "Paper" })), true);
  assert.equal(api.isSupportedItem(item({ title: "" })), false);
  assert.equal(api.isSupportedItem(item({ title: "Attachment" }, false)), false);
});

test("uses the Zotero item publication year", () => {
  const api = loadTestAPI();
  assert.equal(api.extractPublicationYear(item({ date: "Spring 1940" })), 1940);
  assert.equal(api.extractPublicationYear(item({ date: "2021-08-12" })), 2021);
  assert.equal(api.extractPublicationYear(item({ date: "forthcoming" })), null);
});

test("paginates through the complete citation history", async () => {
  const requests = [];
  const pages = [
    { next: 2, data: [{ citingPaper: { paperId: "a", title: "A", year: 2024 } }, { citingPaper: { paperId: "b", title: "B", year: 2023 } }] },
    { next: 3, data: [{ citingPaper: { paperId: "c", title: "C", year: 2000 } }] },
    { next: null, data: [{ citingPaper: { paperId: "d", title: "D", year: 1980 } }] }
  ];
  const context = vm.createContext({
    console,
    Intl,
    Map,
    Date,
    setTimeout,
    clearTimeout,
    Zotero: {
      HTTP: {
        request: async (_method, url) => {
          requests.push(url);
          return { response: pages.shift() };
        }
      },
      Promise: { delay: async () => {} },
      debug() {}
    }
  });
  vm.runInContext(fs.readFileSync("zostats.js", "utf8"), context);
  const result = await context.ZoStats._test.fetchCitations("paper-id");
  assert.equal(result.citations.length, 4);
  assert.equal(result.next, null);
  assert.equal(requests.length, 3);
  assert.match(requests[1], /offset=2/);
  assert.match(requests[2], /offset=3/);
});

test("retries Semantic Scholar rate limits", async () => {
  let attempts = 0;
  const waits = [];
  const context = vm.createContext({
    console,
    Intl,
    Map,
    Date,
    setTimeout,
    clearTimeout,
    Zotero: {
      HTTP: {
        request: async () => {
          attempts++;
          if (attempts < 3) throw { status: 429 };
          return { response: { ok: true } };
        }
      },
      Promise: { delay: async milliseconds => waits.push(milliseconds) },
      debug() {}
    }
  });
  vm.runInContext(fs.readFileSync("zostats.js", "utf8"), context);
  const result = await context.ZoStats._test.requestJSON("https://example.test");
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1500, 3000]);
});

test("uses an optional Semantic Scholar API key without requiring one", () => {
  const preferences = new Map();
  const context = vm.createContext({
    console,
    Intl,
    Map,
    Date,
    setTimeout,
    clearTimeout,
    Services: {
      prefs: {
        getStringPref: (name, fallback) => preferences.get(name) ?? fallback
      }
    }
  });
  vm.runInContext(fs.readFileSync("zostats.js", "utf8"), context);
  assert.deepEqual({ ...context.ZoStats._test.requestHeaders() }, { Accept: "application/json" });

  preferences.set("extensions.zostats.semanticScholarApiKey", "  secret-key  ");
  assert.deepEqual(
    { ...context.ZoStats._test.requestHeaders() },
    { Accept: "application/json", "x-api-key": "secret-key" }
  );
});

test("registers a ZoStats preferences pane", () => {
  const source = fs.readFileSync("bootstrap.js", "utf8");
  assert.match(source, /Zotero\.PreferencePanes\?\.register/);
  assert.match(source, /id:\s*"zostats-preferences"/);
  assert.match(source, /src:\s*rootURI \+ "preferences\.xhtml"/);
  assert.match(source, /scripts:\s*\[rootURI \+ "preferences\.js"\]/);
});

test("injects and removes the Metrics localization resource", () => {
  const context = vm.createContext({ console, Intl, Map, Date });
  vm.runInContext(fs.readFileSync("zostats.js", "utf8"), context);
  let inserted;
  let removed = 0;
  const window = {
    MozXULElement: {
      insertFTLIfNeeded: name => { inserted = name; }
    },
    document: {
      querySelectorAll: selector => {
        assert.equal(selector, 'link[rel="localization"][href="zostats.ftl"]');
        return [{ remove: () => removed++ }];
      }
    }
  };

  context.ZoStats.addToWindow(window);
  context.ZoStats.removeFromWindow(window);
  assert.equal(inserted, "zostats.ftl");
  assert.equal(removed, 1);
});

test("localizes the collapsible header and sidenav through attributes", () => {
  const ftl = fs.readFileSync("locale/en-US/zostats.ftl", "utf8");
  assert.match(ftl, /zostats-item-pane-header\s*=\s*\n\s+\.label\s*=\s*Metrics/);
  assert.match(ftl, /zostats-item-pane-sidenav\s*=\s*\n\s+\.tooltiptext\s*=\s*Metrics/);
  assert.match(ftl, /zostats-refresh-button\s*=\s*\n\s+\.tooltiptext\s*=\s*Refresh citation statistics/);
  assert.doesNotMatch(ftl, /zostats-item-pane-header\s*=\s*Metrics/);
});

test("persistent cache pruning removes expired and least-recent entries", () => {
  const api = loadTestAPI();
  const entries = [
    ["expired", { expires: 999, lastAccessed: 999, value: { paper: {} } }],
    ["recent", { expires: 2000, lastAccessed: 900, value: { paper: {} } }],
    ["older", { expires: 2000, lastAccessed: 500, value: { paper: {} } }],
    ["oldest", { expires: 2000, lastAccessed: 100, value: { paper: {} } }]
  ];
  const retained = api.selectCacheEntries(entries, 1000, 2);
  assert.deepEqual(retained.map(([key]) => key), ["recent", "older"]);
});
