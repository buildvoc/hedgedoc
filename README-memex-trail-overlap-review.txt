Memex /trails LLM Trail Overlap Review
=======================================

Purpose
-------
Adds a separate read-only LLM review to HedgeDoc /trails.

The motivating case is trail names such as:
- Exploring Architectural and Historical Landmarks
- Exploring Historic Landmarks

The review intentionally does NOT infer duplicate status from similar wording
alone. The LLM compares intent, scope, traversal purpose, context, outcome and
deterministic shared-member evidence.

Classifications:
- distinct
- partial_overlap
- strong_overlap
- duplicate

The review never auto-merges, renames, deletes or edits a trail.

Files
-----
- frontend/src/app/memex-trail-overlap/route.ts
- frontend/src/app/(editor)/trails/trail-overlap-review.tsx
- frontend/src/app/(editor)/trails/page.tsx (small installer injection)

Apply with ZIP
--------------
cd /data/projects/hedgedoc || exit 1
unzip -o memex-trail-overlap-review-2026-08-25.zip || exit 1
python3 apply-memex-trail-overlap-review.py

Verify markers
--------------
grep -nE \
  'MEMEX_TRAIL_OVERLAP_REVIEW|TrailOverlapReview' \
  'frontend/src/app/(editor)/trails/page.tsx'

test -f frontend/src/app/memex-trail-overlap/route.ts && echo "ROUTE OK"
test -f 'frontend/src/app/(editor)/trails/trail-overlap-review.tsx' && echo "COMPONENT OK"

Build
-----
This changes the HedgeDoc frontend source tree, so use the existing safe
production build/deploy workflow after source validation.

Environment
-----------
The route reads, in order:
- MEMEX_OLLAMA_URL
- OLLAMA_URL
- fallback: http://192.168.1.99:11434

and:
- MEMEX_OLLAMA_MODEL
- OLLAMA_MODEL
- fallback: gemma4:26b

The call uses /api/chat, JSON mode, temperature 0.1, num_ctx 32768.

Patch artifact
--------------
The .patch is a companion source artifact containing the new files and
installer. The installer performs the small page.tsx injection structurally,
so it remains safer than a brittle line-number patch against a changing
/trails page.
