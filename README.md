# ZoStats

ZoStats adds a **Metrics** section to Zotero's item pane. Select a
paper to see its citation history and the works that cite it.

## Features

- Citation counts by year in an interactive bar chart
- Total and influential citation counts
- Citation rate, recent three-year pace, reference count, and peak year
- Up to 100 citing articles with authors, venue, year, and citation count
- Top citing venues and fields of study
- Links to Semantic Scholar and an open-access PDF when available
- DOI, PMID, and arXiv matching, with exact-title matching as a fallback
- Optional Semantic Scholar API-key support with anonymous access as the fallback
- Seven-day persistent cache (up to 100 papers) and a manual refresh button

Citation data comes from the Semantic Scholar Academic Graph API. ZoStats
paginates through up to 10,000 citing records so the yearly graph covers the
full citation history of most papers. For papers above that limit, the total
count remains authoritative and the interface clearly marks the graph as
partial.

Cached results are stored locally as `zostats-cache.json` in the Zotero data
directory. Entries expire after seven days, and the cache retains at most 100
papers. The refresh button bypasses the cache and replaces the stored result.

## Optional API key

ZoStats works without an account or API key. For more predictable access to
Semantic Scholar, request a key from the
[Semantic Scholar API page](https://www.semanticscholar.org/product/api#api-key-form),
then open **Zotero Settings → ZoStats** and save it there.

The key is stored only in your local Zotero preferences. It is sent in the
`x-api-key` header directly to Semantic Scholar and is never written to the
ZoStats metrics cache or repository. Clear the field at any time to return to
anonymous access.

## Install

1. Build the package with `make` or download `zostats-1.2.0.xpi`.
2. In Zotero, open **Tools → Plugins**.
3. Choose **Install Plugin From File…** from the gear menu.
4. Select the `.xpi` file.

ZoStats supports Zotero 7 through Zotero 10.

## Build and test

```sh
make test
make package
```

The package is written to `dist/zostats-1.2.0.xpi`.

## Privacy

When the Metrics section loads, ZoStats sends the selected item's DOI,
PMID, arXiv ID, or title to Semantic Scholar. It does not transmit notes,
attachments, collections, tags, or other library data. If configured, the API
key is included only as an authentication header on those Semantic Scholar
requests.
