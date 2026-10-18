# Changelog

## 2026-10-16

### Memex derived source-summary recovery

- Changed the recovery priority to **synthesized thematic summaries first**, with verified source-page citation enrichment handled separately. Citation gaps are advisory; summaries must not be replaced by extractive fallback passages to satisfy citation validation.
- Validated a controlled six-source rebuild: **6/6 processed with non-extractive thematic structure**. This was a format/processing result, not independent verification of factual accuracy; citation coverage remained incomplete.
- Improved citation attribution using verified Docling page provenance. Live scoped rebuild of `163_PAS_9980_FINAL` matched seven summary blocks to evidence, cited printed/source page **147** and left two blocks uncited; `memex_source_pages: [147]` was confirmed.
- Aligned `memex_source_anchor` with a substantive summary section rather than generic `Overview` headings. The verified `163_PAS_9980_FINAL` target is `test-methodology-and-apparatus`.
- Prepared removal of the visible `Citation review: Incomplete` footer and `<!-- memex-citation-status: incomplete -->` line while retaining citation status diagnostics in processor logs. The deployment status of this footer-only change is not established by the queue report.
- Flagged `164_PAS_9980_FINAL` for investigation: a rebuild reported success but verification found an unchanged, extractive wiki page. Do not count `HTTP 200` alone as summary-quality success.

### Exact automatic-fallback audit and API requeue

- Earlier 14 October recovery inventory listed **102 historical fallback candidates**; these are not equivalent to the current affected-page count.
- Scanned current registered derived wiki source-summary pages for the **exact heading** `## Extracted source passages (automatic fallback)`. An initial scan was incomplete due to HedgeDoc HTTP 429 rate limiting and a stale/non-derived entry; **no items were queued from that incomplete scan**.
- Re-ran the inventory with a rate-safe scanner (sequential reads, retry/backoff, stale-entry handling). **82 current pages** matched the exact fallback heading.
- Queued these **82 exact matches** through `/memex-rerun-batch` in **21 API batches** (20 batches of four and one batch of one): **81 newly queued, one already Pending**. The queue run reported success; it **did not start processing**.
- Preserved the existing `/backups/builds/memex-summary-next96.STOP` flag. This stops the dedicated 96-source runner, **not** arbitrary manual or `all-pending` processing.


## 2026-10-13

### Docling / HedgeDoc batch ingestion

- Extended `/memex-queue/manage` with a fixed four-stage operator flow: Docling PDF batch → HedgeDoc batch ingestion → add ingested notes to Pending → existing Process Pending runner.
- Added read-only terminal-style log panes and fixed Start / Resume / Stop controls for `/data/projects/docling/batch/docling-batch.sh`; no arbitrary shell command execution is exposed.
- Added resumable `memex/ingest_docling_batch.py` ingestion with an atomic manifest at `/data/projects/docling/batch/hedgedoc-ingest.json`.
- New HedgeDoc notes use the existing default document frontmatter shape, substituting the Docling JSON filename stem for `Untitled` while retaining `description: ""`, `tags: []`, `status: draft`, and `sources: []`.
- Stored note bodies keep compact DoclingDocument JSON intact below the title so the existing Docling renderer and Memex provenance path continue to receive Docling JSON rather than a Markdown conversion.
- HedgeDoc ingestion is idempotent through deterministic `docling-batch-*` aliases plus the manifest and refuses to overwrite an existing deterministic alias with different content.
- Added a queue handoff button that fills only the available Memex Pending slots (maximum four) and records the handoff in the ingestion manifest.

### Git changes

- Added: `frontend/src/app/memex-docling-batch/route.ts`
- Added: `frontend/src/app/memex-docling-ingest/route.ts`
- Added: `memex/ingest_docling_batch.py`
- Updated: `frontend/src/app/(editor)/memex-queue/manage/memex-queue-manager.tsx`
- Updated: `CHANGELOG.md`

## 2026-10-12

### Memex Wiki Chat references

- Added page-aware reference metadata to Wiki Chat with `sourcePages` and `sourceAnchor`.
- Added support for derived source-summary frontmatter:
  - `memex_source_pages`
  - `memex_source_anchor`
- Updated Wiki Chat reference links to use HedgeDoc heading/ToC anchors instead of introducing custom Docling page-navigation code.
- Confirmed the `8_A Heritage Impact Assessment` provenance mapping:
  - Docling local page `1` → printed page `4`
  - Docling local page `2` → printed page `5`
  - Docling local page `3` → printed page `6`
  - Docling local page `4` → printed page `7`
- Added the `geological-and-physical-features` anchor to the `8_A Heritage Impact Assessment` derived source-summary.
- Simplified the reference panel:
  - hides derived alias/source-summary metadata from the user;
  - strips source filename prefixes such as `8_A` from the displayed title;
  - uses one `Open source` link;
  - displays `Pages: …` on the same line;
  - keeps references collapsed by default.
- Added compact page-range formatting, e.g. `4–7`.

### Source page provenance

- Validated that production `process_queue_once.py` sends sanitized DoclingDocument JSON to the LLM rather than deterministically converting it to Markdown first.
- Confirmed `sanitize_llm_source()` preserves `prov[].page_no` and page-footer information.
- Confirmed Docling `prov.page_no` is extraction-local and must not be displayed directly as the printed source page number.
- Used numeric page footers as the validated mapping source for the tested heritage-impact-assessment documents.
- Added page provenance to several derived source-summary notes using inline markers such as:
  - `<!-- memex-source-pages: 4 -->`
  - `<!-- memex-source-pages: 5, 7 -->`
- Added aggregate `memex_source_pages` metadata to derived source-summary frontmatter.
- Prepared automatic provenance persistence so future derived source-summary processing can preserve page metadata rather than overwriting it.

### Validation and deployment

- Confirmed `@docling/docling-components@0.0.7` exposes page-number display via `pagenumbers` but no supported direct page-navigation API such as `goToPage` or `currentPage`.
- Chose HedgeDoc's existing heading/ToC anchor navigation for source references.
- Diagnosed a Wiki Chat deployment validation failure as backend readiness timing: Caddy/Next.js was probed before HedgeDoc backend port `3100` was ready.
- Updated deployment validation to wait for backend readiness before probing Wiki Chat/note routes.
- Recovered from a frontend source/build timestamp mismatch after rollback by rebuilding the current source before restarting the combined service.
- Cleaned obsolete September 2026 build directories from `/backups/builds`, recovering roughly 200 GB of free space.
- Retained the rule that production `frontend/dist` is replaced only after a successful detached frontend build.

### Git changes

- Added/updated Wiki Chat page-reference handling in:
  - `frontend/src/app/memex-wiki-query/route.ts`
  - `frontend/src/components/memex/memex-wiki-query-panel.tsx`
- Prepared source-provenance persistence changes involving:
  - `memex/process_queue_once.py`
  - `frontend/src/app/memex-wiki-maintain/route.ts`

## 2026-10-10

### Memex Wiki Chat

- Added streamed responses for `/memex-wiki/chat`.
- Added `Stream Wiki Chat responses` control to `/memex-settings`.
- Preserved buffered/validated behaviour for Wiki maintenance and mutation paths.
- Added configurable llama.cpp prompt/KV cache support.
- Kept Wiki Chat on llama.cpp slot `0` with `cache_prompt` enabled.
- Removed the extra LLM retrieval pass from the normal Wiki Chat path so it no longer destroys the live answer KV prefix between turns.
- Reworked the Wiki Chat prompt so stable system/wiki material is placed before changing conversation content.
- Confirmed llama.cpp live-slot prefix caching works while slot 0 is idle between requests.
- Confirmed direct llama.cpp prefix test reused 22,564 of 22,567 cached prompt tokens.
- Confirmed real Wiki Chat now reuses a substantial stable prefix between follow-up questions.
- Current real-chat observation: approximately 14k tokens may be reusable from a roughly 22k-token resident KV state, depending on retrieved page selection and prompt divergence.
- Slot 0 is expected to return to `idle` between requests; the KV state remains resident and can still be reused.
- Slot save/restore experiments were not used as the final Wiki Chat caching mechanism; live slot prefix reuse is used instead.

### Memex Model Settings

- Added Wiki Chat streaming control.
- Added llama.cpp cache/prompt-cache configuration support.
- Retained model context and prompt-size controls separately:
  - context window is token based;
  - maximum prompt size remains character based.

### Validation

- llama.cpp runtime context: 98,304 tokens.
- llama.cpp server runs with one slot (`--parallel 1`).
- Prefix caching verified directly through llama.cpp timings using `cache_n`.
- Wiki Chat verified with the zero-llama dashboard and llama.cpp journal timing output.


### Git changes

- Commit: `da6a61e4e` — memex: improve wiki chat streaming and KV prefix reuse
- Date: 2026-10-10
- Files changed:
- Added: `CHANGELOG.md`
- Added: `ROADMAP.md`
- Modified: `frontend/src/app/memex-model-settings/_settings.ts`
- Added: `frontend/src/app/memex-wiki-conversation/route.ts`
- Added: `frontend/src/app/memex-wiki-query/route.ts`
- Modified: `frontend/src/components/memex-settings/memex-model-settings-form.tsx`
- Added: `frontend/src/components/memex/memex-wiki-query-panel.tsx`

- Change summary:
   CHANGELOG.md                                       |   35 +
   ROADMAP.md                                         |   45 +
   frontend/src/app/memex-model-settings/_settings.ts |   30 +-
   frontend/src/app/memex-wiki-conversation/route.ts  | 1281 +++++++++++++++++++
   frontend/src/app/memex-wiki-query/route.ts         |  669 ++++++++++
   .../memex-settings/memex-model-settings-form.tsx   |  138 +-
   .../components/memex/memex-wiki-query-panel.tsx    | 1329 ++++++++++++++++++++
   7 files changed, 3506 insertions(+), 21 deletions(-)
