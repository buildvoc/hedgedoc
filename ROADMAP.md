# Roadmap

## Wiki Chat rate-limit / reference fan-out — Priority (2026-11-03)

### Confirmed status

- Deterministic retrieval was tightened so aliases no longer influence exact concept or lexical scoring, lexical matches are preserved alongside exact concept seeds, and common `use`/`used`/`uses`/`using` terms are ignored.
- HedgeDoc is stable while Wiki Chat is idle; after recovery the combined service was `active`, the external proxy returned HTTP 200, and the idle rate-limit error count was zero.
- One Wiki Chat request reproduced a same-second burst of roughly 9–10 HedgeDoc HTTP 429 responses.
- The request amplification was traced to `loadReferencePages()` in `/memex-wiki-query`, which hydrated selected `source-summary` references in parallel through `/memex-wiki-maintain?alias=...`.
- The live query callsite now maps selected aliases directly from the already-loaded catalogue instead of invoking `loadReferencePages()` for every selected reference.
- The corrected frontend build completed successfully and the combined service restarted cleanly.
- `Retry-After` ceiling experiments were abandoned; do not solve this regression by increasing retry waits, changing HedgeDoc rate-limit thresholds, or adding a bypass.
- Successful remote `staging` push of the final callsite fix is not yet confirmed in this record.

### Next

- Run one controlled Wiki Chat request while watching for `Rate limit exceeded` and `/memex-wiki-query` in the service journal.
- Confirm that the query no longer produces the same-second request burst and that the chat returns successfully.
- If 429s remain, capture the exact request count/path before making any further retry or rate-limit change.
- After runtime validation, confirm the final source commit is present on remote `staging`.
- Decide separately whether page-aware `sourcePages` / `sourceAnchor` metadata should be restored through a non-fan-out design, for example by carrying the metadata in the maintained catalogue rather than issuing per-reference HedgeDoc reads.

## Repository status — staging review (2026-10-24)

### Confirmed remote state

- Reviewed GitHub `buildvoc/hedgedoc` branch `staging` through commit **`c1f56a7a4`**.
- Remote staging contains:
  - Wiki Summary Quality Gold/run/judge/precision tooling;
  - Wiki Chat prompt-budget/catalogue-overflow fixes;
  - deterministic source-summary identity audit and cleanup;
  - HedgeDoc cleanup request pacing / 429 backoff;
  - deterministic Memex Index refresh.
- The newer `/memex-trail-refresh` sequential trail-review and KV-cache optimisation work remains **local-only** at this review point and should not be described as deployed from GitHub staging until it is intentionally pushed.

## Memex Index / Trail Refresh — Priority (2026-10-24)

### Confirmed status

- Deterministic Memex Index reconciliation is present on staging in **`c1f56a7a4`** and completed successfully in the live environment: **89 → 419 index entries**, with **19 existing trails preserved** during the reconciliation pass.
- The local `memex/index.md` and HedgeDoc `memex-index` mirror were synchronised and verified after refresh.
- The local `/memex-trail-refresh` flow provides LLM-backed Preview / Apply with snapshots and source-section preservation, but it is not yet represented in reviewed staging commits.
- The one-shot trail catalogue approach is no longer the target design; it covered only **130/419** entries in the first valid preview.
- Local trail review now processes source content one source at a time and keeps exact aliases outside the model.
- The cache-validation run was intentionally restarted from **1/419** with a stable llama.cpp prompt prefix and live slot-0 KV reuse.
- No frozen batches are used.
- Gemma 4 partial-prefix KV reuse is now **validated** on the G5 2× Tesla P100 host. The root cause of the prior near-zero reuse was the Gemma 4 hybrid/SWA runtime path rather than the Memex prompt ordering.
- Synthetic divergent-tail validation with llama.cpp build **10925 / `f3a33dff2`** produced **9,646 cached tokens from a 15,154-token second prompt (63.7% reuse)**.
- Real trail-refresh Preview then reused approximately **8,400–8,686 cached tokens per source** after the cold first request, with typical reuse around **92–97%** on smaller source prompts.

### Validated Gemma 4 KV runtime — make permanent

Use this runtime recipe on the G5 host:

```text
model: google_gemma-4-26B-A4B-it-Q4_K_M.gguf
--no-mmproj
-fa on
--swa-full
--gpu-layers auto
--fit on
--fit-target 2048,2048
--split-mode layer
-ctk q8_0
-ctv q8_0
--ctx-size 98304
--parallel 1
```

- Do **not** force `-ngl 999` or `--tensor-split 1,1` for this 98K full-SWA setup; both prevented auto-fit from reserving adequate VRAM.
- Q8 K/V cache is required for practical 98K full-SWA operation on the 2×16 GB P100 host; F16 full-SWA KV exhausted VRAM.
- Keep `cache_prompt: true` and `id_slot: 0` in the Memex llama.cpp requests.
- Keep the cache-oriented prompt layout deterministic: invariant catalogue/instructions first, volatile trail state and current source later.
- Keep live evolving trail state; do **not** introduce frozen batches.
- **Next runtime action:** update `memex-llamacpp.service` to the validated model/flags, restart through systemd, and rerun the divergent-prefix smoke test after the service-owned server returns.
- Do not change `memex/refresh_trails.py` to solve this cache issue; the application prompt/request path has been validated.

### Next — resolve review unit before final Apply

- Audit why the reconciled index contains **419 entries** and distinguish true logical source documents from `docling-batch-*` fragments/chunks.
- Produce a logical-source grouping report before treating `419/419` as the final semantic review target.
- Preserve every exact index alias for final trail rendering even if multiple aliases are grouped into one logical source document for LLM review.
- Decide whether sequential review should operate on:
  - every raw index alias; or
  - grouped logical documents with deterministic alias membership.
- Do not apply regenerated trails until the review unit is explicit and the intended source set has been fully reviewed.

### Apply safety

- Keep Preview non-mutating.
- Require an exact preview hash plus explicit `APPLY` confirmation.
- Snapshot local `memex/index.md`, HedgeDoc `memex-index` and the preview plan before mutation.
- Replace only the `## Trails` section.
- Verify the `## Sources` section hash/count is unchanged after Apply.
- Keep user-created trails outside automatic system-trail replacement.
- Roll back local and mirror state if any Apply step fails.

## Source-summary identity / cleanup — staging status (2026-10-23)

### Confirmed status

- Deterministic source-summary alias generation and read-only identity audit are present on staging (`fb011c50e5`, `675992a90a`).
- Deterministic cleanup Preview / Apply is present on staging (`6842e9f640`) with preview hash, explicit `APPLY` confirmation and snapshots.
- `MULTI_SOURCE`, `NO_SOURCE`, ownership conflicts and other ambiguous identities are excluded from automatic cleanup.
- Target-existence checks were moved out of Preview to avoid unnecessary HedgeDoc traffic (`53767fe709`).
- HedgeDoc cleanup traffic is paced by default at **2 seconds between requests** with `Retry-After` / HTTP 429 backoff (`e9559ccbde`).

### Next

- Run the read-only identity audit before any future cleanup pass.
- Review all excluded `MULTI_SOURCE`, `NO_SOURCE`, ownership-conflict and collision cases manually.
- Keep Preview free of target-existence request amplification.
- Preserve the pacing/backoff defaults unless measured production limits justify a different request gap.
- After Apply, verify canonical note ownership, wiki-index entries and source-summary link integrity.

## Wiki Summary Quality benchmarks — staging status (2026-10-20)

### Confirmed status

- Gold review and frozen model-run framework is present on staging (`2055d9567b`).
- Gold references/facts are never supplied to the model during benchmark summary generation.
- Gold fact judging records coverage/strict recall separately from claim-level precision.
- Independent precision audit of generated claims against the frozen original is present (`84cedfd090`).
- Benchmark source-summary YAML records the Gold-generator model while declaring the generated source-summary itself to have `memex_benchmark_role: "none"` (`70d8389659`).

### Next

- Keep recall/Gold coverage and claim-level precision as separate measurements; do not label Gold coverage alone as factual F1.
- Complete human-approved Gold sets for representative source types before comparing models.
- Preserve frozen source/reference revision IDs for every benchmark run.
- Add aggregate reporting only after the underlying Gold and precision records are independently auditable.
- Keep generated benchmark result files out of Git history unless a deliberate frozen fixture is required.

## Wiki Chat — staging status (reviewed through 2026-11-03)

### Confirmed improvements

- Read-only Wiki Chat now has an explicit **80,000-character** prompt budget (`5af7103fe4`).
- The full wiki catalogue remains available to lexical retrieval, while only loaded page aliases are included in the LLM catalogue text.
- This resolves the previously identified catalogue-overflow path without reducing deterministic retrieval scope.

### Next

- Continue increasing the reusable Wiki Chat prefix beyond the current stable portion.
- Keep all invariant Wiki Chat instructions at the beginning of the prompt.
- Make wiki page/context ordering deterministic so identical pages produce an identical token prefix.
- Keep conversation history, current question and other volatile material after the stable prefix.
- Measure `cache_n`, `prompt_n` and prompt evaluation time for every optimisation.
- Target reuse of most of the resident Wiki Chat KV state on conversational follow-ups where the underlying wiki context has not changed.
- Add token-based context-budget accounting in addition to the existing character limits.

## Repository/build hygiene — staging status (2026-10-22)

- Historical `frontend/.next-before-rebuild-*` snapshots were removed from repository history/state and ignored going forward (`7287619847`).
- Keep build artefacts and deployment snapshots under `/backups/builds`, not in the source tree.
- Continue to deploy only from a successful frontend build and verify the standalone runtime contents before restarting the combined service.

## Memex Source-Summary Recovery — Priority (2026-10-16)

### Confirmed status

- **82** current derived wiki pages contain the exact heading `## Extracted source passages (automatic fallback)` and are **Pending** via the rerun API (**81 newly queued; one already pending**).
- No processing was launched by the inventory/requeue operation. The dedicated next-96 runner STOP flag remains set; it does **not** block manual/all-pending runs.
- The preceding controlled six-source recovery produced **6/6 non-extractive thematic summaries**; a separate live `163_PAS_9980_FINAL` rebuild verified source-page **147** citation attribution, with **two uncited blocks** remaining. Neither result proves factual accuracy.

### Next — controlled recovery

- Keep processing paused until a deliberate, supervised restart. Avoid `all-pending` while unrelated Pending records could be present; select **only the verified 82 aliases**, in small scoped batches (three or four sources per batch).
- After each batch, verify the **published wiki page**, not just HTTP 200 or lint: updated revision, thematic synthesis, absence of the exact fallback heading, correct source-to-wiki linkage and `queue status: processed`.
- Check `memex_source_pages` against verified *printed/source* page mapping (never substitute Docling extraction-local numbers); accept incomplete inline citations with a review flag, never fabricated page numbers.
- Check that `memex_source_anchor` targets the first **substantive** heading, skipping generic headings such as `Overview` and `Introduction`. Preserve synthesized content and verified inline citations during metadata fixes.
- Investigate the previously unchanged/extractive `164_PAS_9980_FINAL` page before declaring it recovered. Track successes, failures and unresolved citations independently.
- Use the rate-safe scanner to audit remaining *current* exact fallback pages after processing; account for HTTP 429 and stale/non-derived wiki-index entries, and ensure the inventory completes before concluding that no fallback pages remain.
- Confirm whether the footer-only cleanup patch has been deployed; if needed, remove the visible `Citation review: Incomplete` footer without suppressing log-level citation diagnostics.


## Memex Wiki Chat

### Next

- Increase the reusable Wiki Chat prefix beyond the current stable portion.
- Keep all invariant Wiki Chat instructions at the beginning of the prompt.
- Make wiki page/context ordering deterministic so identical pages produce an identical token prefix.
- Keep conversation history, current question and other volatile material after the stable prefix.
- Measure `cache_n`, `prompt_n` and prompt evaluation time for every optimisation.
- Target reuse of most of the resident Wiki Chat KV state on conversational follow-ups where the underlying wiki context has not changed.

### Retrieval and context

- Keep normal Wiki Chat retrieval free of an intermediate llama.cpp call so slot 0 remains dedicated to the answer conversation.
- Improve deterministic lexical/wiki retrieval ranking where useful.
- Avoid changing selected-page order when the selected page set is unchanged.
- Investigate pinning stable page/context material across related follow-up questions.
- Keep retrieved context within the 98,304-token runtime context budget.

### KV cache

- Continue using live slot-0 prefix reuse with:
  - `cache_prompt: true`
  - `id_slot: 0`
  - `--parallel 1`
- The validated Gemma 4 server runtime now additionally requires `--swa-full --no-mmproj` on this host, with Q8 K/V cache (`-ctk q8_0 -ctv q8_0`) and auto-fit at the 98,304-token context.
- Do not force `-ngl 999` or `--tensor-split 1,1` on the 2× P100 full-SWA runtime.
- Do not require slot 0 to remain active between chat turns.
- Treat `idle` with resident KV as the normal desired state.
- Do not depend on disk slot save/restore for normal Wiki Chat prefix reuse.
- Re-run the divergent-prefix smoke test after any llama.cpp build, model, KV-type, context-size or service-command change.

### Observability

- Surface per-request cached-token count for Wiki Chat.
- Surface newly evaluated prompt-token count.
- Surface prompt evaluation time and cache-reuse percentage.
- Distinguish resident KV size from the number of tokens actually reusable as a common prefix.

### Later

- Add automatic context-budget accounting before a Wiki Chat request is sent.
- Consider token-based prompt budgeting in addition to the existing character limit.
- Preserve streaming behaviour for read-only Wiki Chat while keeping mutation/maintenance operations buffered and validated.
