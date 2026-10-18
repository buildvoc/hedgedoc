# Roadmap

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
- Do not require slot 0 to remain active between chat turns.
- Treat `idle` with resident KV as the normal desired state.
- Do not depend on disk slot save/restore for normal Wiki Chat prefix reuse.
- Consider llama.cpp chunk/cache-reuse features only after the deterministic common-prefix path has been maximised and measured.

### Observability

- Surface per-request cached-token count for Wiki Chat.
- Surface newly evaluated prompt-token count.
- Surface prompt evaluation time and cache-reuse percentage.
- Distinguish resident KV size from the number of tokens actually reusable as a common prefix.

### Later

- Add automatic context-budget accounting before a Wiki Chat request is sent.
- Consider token-based prompt budgeting in addition to the existing character limit.
- Preserve streaming behaviour for read-only Wiki Chat while keeping mutation/maintenance operations buffered and validated.
