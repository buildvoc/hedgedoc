Memex /trails complete all-pairs overlap review fix — 2026-08-25

Fixes the observed case where 5 selected trails produced only 3 pairwise reviews.

Behavior:
- N selected trails must produce N*(N-1)/2 pairwise reviews.
- 5 selected trails therefore require exactly 10 pairwise reviews.
- Initial LLM prompt explicitly enumerates every required pair.
- Missing pairs trigger focused repair LLM calls for only the missing pairs.
- Up to 3 repair calls are allowed for LLM formatting/completeness recovery.
- If any required pair is still missing, the API returns an error instead of silently showing a partial review.
- Pairwise output is reordered to the deterministic all-pairs order.
- UI shows "pairs to review" before review and "reviewed X/Y pairs" after review.
- Existing human-readable names, confidence normalization, single-pair fallback, and auto-selection remain intact.
- Review remains read-only; no trail state changes are made.
