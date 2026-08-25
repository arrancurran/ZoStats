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
- Thirty-minute in-memory cache and a manual refresh button

Citation data comes from the Semantic Scholar Academic Graph API. For papers
with more than 1,000 citations, the total count remains authoritative but the
yearly graph and citing-work analysis are limited to the first 1,000 records.

## Install

1. Build the package with `make` or download `zostats-1.0.3.xpi`.
2. In Zotero, open **Tools → Plugins**.
3. Choose **Install Plugin From File…** from the gear menu.
4. Select the `.xpi` file.

ZoStats supports Zotero 7 through Zotero 10.

## Build and test

```sh
make test
make package
```

The package is written to `dist/zostats-1.0.3.xpi`.

## Privacy

When the Metrics section loads, ZoStats sends the selected item's DOI,
PMID, arXiv ID, or title to Semantic Scholar. It does not transmit notes,
attachments, collections, tags, or other library data.
