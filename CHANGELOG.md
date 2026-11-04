# Changelog

## 2026-11-03

### Wiki Chat deterministic retrieval corrections

- Removed derived-page aliases from exact concept matching so concept selection is based on title/description content rather than alias text.
- Merged lexical matches into the exact-concept retrieval path so an exact concept seed no longer suppresses otherwise relevant lexical results.
- Removed aliases from lexical matching/scoring to prevent opaque alias tokens from influencing retrieval.
- Added `use`, `used`, `uses` and `using` to the Wiki Chat retrieval stopword set while retaining `running`.
- These changes remain deterministic and do not add an intermediate LLM retrieval call.

### Wiki Chat HedgeDoc 429 regression diagnosis

- Reproduced a Wiki Chat failure where one `/memex-wiki-query` request immediately drove HedgeDoc Public API requests into HTTP 429 responses.
- Confirmed HedgeDoc was stable while Wiki Chat was idle: the combined service remained active, the external proxy returned HTTP 200, and no rate-limit errors were recorded during the idle verification window.
- A single Wiki Chat request then produced a same-second burst of roughly 9–10 HedgeDoc rate-limit failures and returned HTTP 500 from `/memex-wiki-query`.
- Traced the amplification to the page-aware reference hydration path added after the earlier Wiki Chat implementation:
  - `loadReferencePages()` used `Promise.all(...)`;
  - each selected `source-summary` triggered `/memex-wiki-maintain?alias=...`;
  - each maintain request re-read `memex-wiki-index` before reading the requested derived page;
  - the default Wiki Chat selection can include up to eight pages, creating a request fan-out before the answer call.
- Historical source comparison confirmed that the 5 October Wiki Chat path returned selected catalogue entries directly, while the 18 October sync introduced `loadReferencePages()` hydration.
- The attempted `Retry-After` ceiling increases (`30 → 60 → 300` seconds) were rejected as a mitigation because they only masked the request amplification and could stall chat for minutes. No HedgeDoc rate-limit threshold or bypass change was retained.

### Wiki Chat reference fan-out fix — live deployment

- Restored direct reference-page construction at the `/memex-wiki-query` callsite:
  - selected aliases are mapped directly from the already-loaded catalogue;
  - Wiki Chat no longer calls `loadReferencePages()` for every selected reference during the query path.
- Kept the existing retrieval, streaming and conversation behaviour otherwise unchanged.
- A production frontend build completed successfully after the corrected callsite-only patch.
- Restarted `hedgedoc-nodebook.service` once after the successful build and verified:
  - service: `active`;
  - frontend port `3101`: HTTP 308 redirect;
  - external proxy `/login`: HTTP 200;
  - idle rate-limit errors after restart: `0`.
- Post-fix validation of a fresh Wiki Chat request was still pending at the end of this session, so the fix should not yet be described as fully runtime-validated under chat load.
- Remote `staging` push of this final fan-out fix was requested, but successful push confirmation was not captured in this session.

## 2026-10-24

### GitHub staging review

- Reviewed the `staging` branch commit history through **`c1f56a7a4`** (`memex: add deterministic index refresh workflow`).
- Confirmed the current remote staging head includes the deterministic Memex Index refresh workflow plus the source-summary identity/cleanup work merged on 24 October.
- The LLM trail-refresh and trail-review KV-cache work described below is **local-only at the time of this review**; it is not present in the reviewed GitHub `staging` history.

### Memex Index reconciliation — staging commit `c1f56a7a4`

- Added a deterministic Memex Index refresh workflow to reconcile `/data/projects/hedgedoc/memex/index.md` from the current source-summary catalogue without using an LLM.
- Added Preview / Apply controls with preview hashing, explicit `APPLY` confirmation, streamed terminal output and Stop-preview support.
- Added `frontend/src/app/memex-index-refresh/route.ts` and queue-manager UI integration.
- Updated source parsing so Memex Index / Queue Manager accept `/n/`, `/p/` and `/s/` note links.
- Apply preserves the entire Trails section byte-for-byte, updates the HedgeDoc `memex-index` mirror and verifies source/trail counts.
- Live reconciliation completed from **89** indexed sources to **419** index entries:
  - **342** source-summary entries inspected;
  - **336** raw sources resolved;
  - **330** missing sources added;
  - **83** existing non-wiki sources preserved;
  - **19** existing trails preserved during index reconciliation.
- Verified the resulting local index and HedgeDoc mirror at **419 source entries / 19 trails**.
- Kept trail regeneration separate from deterministic source-index reconciliation.

### LLM trail refresh workflow — local-only

- Added a local `/memex-trail-refresh` operator flow for regenerating system trails while preserving the `## Sources` section and user-created trails.
- Added Preview / Apply separation, preview hashes, safety snapshots, local `memex/index.md` updates and HedgeDoc `memex-index` mirror updates.
- Rejected the initial one-shot catalogue synthesis approach after it produced **18 trails covering 130/419 index entries**; the intended objective is to review source material individually rather than infer trails from one compact catalogue prompt.
- Reworked trail synthesis into a sequential LLM review path:
  - one source-content review per LLM call;
  - exact aliases kept outside the model;
  - resumable checkpoint state;
  - malformed per-source model output can be deferred/retried instead of aborting the whole run;
  - final Apply remains blocked until the configured review set is complete.
- Replaced model-generated long aliases with deterministic numeric IDs during validation to prevent alias corruption.
- Added tolerant response validation so malformed JSON or invalid trail proposals do not unnecessarily terminate a long review run.

### llama.cpp / Gemma 4 KV-prefix reuse for trail review — local-only runtime validation

- Diagnosed the sequential trail review as prompt-processing bound when changed source suffixes caused llama.cpp to re-evaluate almost the entire prompt instead of restoring the stable prefix.
- Controlled tests established that the Memex prompt ordering was already correct: stable instructions/catalogue anchor precede the live trail shortlist and current source. The remaining failure was **server-side Gemma 4 hybrid/SWA KV-cache handling**, not `refresh_trails.py`.
- With the previous Gemma 4 runtime, exact or nearly identical prompts could reuse very large KV state, but prompts sharing a long stable prefix and then diverging reused only about **9 / 26 / 43 tokens**.
- Reviewed llama.cpp issue **#21468** and its fixes, including heterogeneous iSWA cache support and the corrected `--swa-full` server path.
- Validated the fix on the G5 host with **2× Tesla P100 16 GB**, llama.cpp **build 10925 / commit `f3a33dff2`**, and:
  - model: `/data/projects/llama.cpp/models/google_gemma-4-26B-A4B-it-Q4_K_M.gguf`;
  - `--no-mmproj`;
  - `-fa on`;
  - `--swa-full`;
  - `--gpu-layers auto`;
  - `--fit on`;
  - `--fit-target 2048,2048`;
  - `--split-mode layer`;
  - `-ctk q8_0`;
  - `-ctv q8_0`;
  - `--ctx-size 98304`;
  - `--parallel 1`.
- Do **not** force `-ngl 999` or `--tensor-split 1,1` for this 98K full-SWA configuration. Those explicit settings prevented llama.cpp auto-fit from reserving enough VRAM for the full SWA KV cache and runtime compute buffers.
- F16 full-SWA KV at 98,304 context attempted an approximately **10.75 GiB** KV allocation and exhausted VRAM. Q8 K/V cache plus auto-fit left roughly **2 GiB headroom per P100** while keeping the model GPU-resident across both devices.
- Synthetic divergent-tail validation passed:
  - warm request: **21,654 prompt / 0 cached**;
  - divergent reuse request: **15,154 prompt / 9,646 cached = 63.7% reuse**;
  - elapsed time fell from **69.17 s** to **18.69 s**.
- Real Memex sequential Preview then restored the intended stable-prefix behaviour immediately:
  - source 1 cold start: **8,720 prompt / 4 cached**;
  - subsequent calls reused approximately **8,400–8,686 cached tokens**;
  - typical reuse was about **92–97%** on smaller source prompts, while large source suffixes reduced only the percentage, not the stable cached-prefix size.
- This reproduces and slightly exceeds the historical approximately **8,399-token** Memex prefix reuse.
- Kept the application request contract unchanged:
  - `cache_prompt: true`;
  - `id_slot: 0`;
  - no frozen batching;
  - resident live KV prefix reuse rather than disk slot save/restore.
- No corrective change is required in `memex/refresh_trails.py` for this issue.
- The validated runtime was launched manually for testing; the permanent `memex-llamacpp.service` command still needs to be updated to carry the validated flags/model before the change is considered durable across service restarts.
- The current `/419` count is the Memex Index entry count, not necessarily the final count of logical source documents; many `docling-batch-*` entries may represent fragments/chunks that need logical-source grouping before final trail generation is considered complete.

### Deployment / runtime notes — local environment

- Built the frontend successfully and restored `hedgedoc-nodebook.service` with backend and frontend health checks returning HTTP 200.
- Diagnosed a standalone frontend runtime failure caused by a missing `frontend/dist/frontend/.next/server/middleware-manifest.json`; restored the packaged `.next/server` contents and returned `/memex-trail-refresh` to HTTP 200.
- Retained the operational rule to keep long build output and long-running logs under `/backups/builds` rather than streaming them through the terminal.

## 2026-10-23

### Source-summary identity audit and deterministic cleanup

- Commit **`fb011c50e5`** / follow-up **`675992a90a`** stabilised derived source-summary identity and added a read-only audit UI in `/memex-queue/manage`.
- Added `frontend/src/app/memex-source-summary-audit/route.ts` and updated `memex/process_queue_once.py` / `memex-wiki-maintain` so source-summary aliases derive deterministically from raw source aliases.
- Commit **`6842e9f640`** added the deterministic source-summary cleanup workflow with Preview / Apply separation, preview hashing, explicit `APPLY` confirmation and safety snapshots.
- Cleanup classifies source-summary identities including `CANONICAL`, `MULTI_SOURCE` and `NO_SOURCE`; ambiguous identities are excluded from automatic mutation.
- Commit **`13ba5ebf3f`** added ownership-conflict protection so cleanup does not claim a canonical target already owned by a different source.
- Commit **`53767fe709`** deferred target-existence checks from Preview to Apply to avoid rate-limit amplification.
- Commit **`e9559ccbde`** added paced HedgeDoc requests (default **2000 ms** gap), `Retry-After` handling and explicit HTTP 429 backoff/retry for GET/POST/PUT/DELETE operations.
- Merge commit **`2499824263`** reconciled remote staging with the source-summary cleanup work.

## 2026-10-22

### Repository/build hygiene

- Commit **`7287619847`** moved historical `frontend/.next-before-rebuild-*` build snapshots out of the repository and updated `.gitignore`.
- This keeps generated frontend build artefacts out of source history and aligns with the existing `/backups/builds` operational convention.

## 2026-10-21

### Wiki Chat prompt budgeting and catalogue overflow

- Commit **`5af7103fe4`** fixed Wiki Chat prompt-budget failures and catalogue overflow.
- Added an explicit **80,000-character** read-only Wiki Chat prompt limit while keeping mutation/maintenance flows on the configured shared `maxPromptChars`.
- Kept the complete wiki catalogue available to deterministic lexical retrieval, but restricted the catalogue sent to the LLM to aliases whose pages were actually loaded into the current context.
- This prevents a large global catalogue from consuming prompt budget without removing pages from retrieval eligibility.

## 2026-10-20

### Wiki Summary Quality precision / recall / F1 evaluation

- Commit **`84cedfd090`** integrated the Wiki Summary Quality judging and precision-audit workflow.
- Added Gold-fact coverage evaluation that records supported / missing / partial / incorrect rows and strict recall.
- Explicitly treats Gold coverage as **recall/coverage only**, not claim-level precision or overall factual F1.
- Added a separate precision audit of generated claims against the frozen original source, with results persisted separately from Gold coverage.
- Added benchmark UI/result integration in `wiki-association-results.tsx` and `wiki-gold-review.tsx`.
- Commit **`70d8389659`** added source-summary benchmark model provenance to generated YAML:
  - `memex_benchmark_gold_generator_model`;
  - `memex_benchmark_role: "none"`.
- Benchmark model metadata is restricted to `source-summary` pages.

## 2026-10-18

### Wiki Summary Quality benchmark framework

- Commit **`2055d9567b`** added the Wiki Summary Quality benchmark UI and routes.
- Added frozen snapshot-based Gold review with one original source, one Gold reference and a human-approved fact set.
- Gold facts are saved independently under `memex/benchmarks/summary/gold`; benchmark model runs are saved under `memex/benchmarks/summary/runs`.
- Benchmark model generation receives the frozen original source but deliberately does **not** receive the Gold reference/facts.
- Runs enforce the configured model provider, timeout and prompt-size limits and reject truncated model output rather than saving an incomplete benchmark result.
- Commit **`e5b0499f21`** synchronised the wider validated Memex development changes to staging, including Wiki Chat streaming/references/KV reuse, queue progress/recovery, Docling ingestion, snapshot lifecycle, association benchmark model summaries and Wiki Summary Quality tooling.
- Runtime queues, logs, generated benchmark results and secrets were intentionally excluded from the staging sync.

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
