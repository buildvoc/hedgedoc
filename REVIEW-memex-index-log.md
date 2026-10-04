# Memex indexing/logging review — 2026-08-24

## Reference contract

The LLM Wiki indexing/logging pattern separates:

- `index.md`: content-oriented navigation, maintained on ingest, with links and
  one-line summaries; the LLM reads it first to locate relevant knowledge.
- `log.md`: chronological append-only history of ingests, queries and lint
  passes, with consistent grep-friendly headings; it gives the LLM recent
  operational context.

## Supplied `index.md`

Observed:

- 55 source entries.
- 15 trail headings.
- About 23 KB.
- Most source entries have a title, HedgeDoc link and one-line summary.
- Two entries have empty display titles:
  - `pgx9j16mp807wbrsqhvhznteyw`
  - `basx9qgp1341hmmzwxnzbh1kwc`

The source/trail grouping is a reasonable domain-specific category structure.

## Supplied `log.md`

Observed:

- 148 parseable `## [` entries.
- 62 ingests.
- 54 lint passes.
- 32 revision checks.
- 0 query entries.
- About 50 KB.
- The newest 12 complete entries are about 4 KB.

The existing heading convention is already grep-friendly.

## Gaps closed

Before:
- `index.md` was supplied to Gemma.
- `log.md` was append-only but was not supplied to Gemma.
- there was no explicit knowledge-query logging hook.

After:
- Gemma receives index.md plus a bounded recent log tail;
- log history is explicitly marked non-evidentiary;
- ingest records prove index/log context was supplied;
- query workflows have a reusable append-only logger;
- future index rebuilds cannot emit a blank source label.

## Deliberate non-change

Graph search/filter keystrokes are not logged as `query` events. The reference
pattern's query operation is a knowledge question against the wiki, not every
UI search-box edit.
