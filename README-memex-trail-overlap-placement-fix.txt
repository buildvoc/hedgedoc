Memex Trail Overlap Review — placement fix
===========================================

Why this fix exists
-------------------
The first overlap-review installer selected the last `return (` in trails/page.tsx.
The live page contains nested source-map callbacks after the page-level return,
so the component was inserted inside each source <a> element.

Do not build the v1 placement.

This fix:
- removes the misplaced review JSX;
- preserves the TrailOverlapReview import;
- finds the shallowest multiline JSX return block;
- chooses the last shallow return to avoid same-level early returns;
- inserts the review directly under the page-level JSX root;
- verifies there is exactly one review instance;
- refuses to write if the resulting marker is still deeply nested.

Apply
-----
cd /data/projects/hedgedoc || exit 1
unzip -o memex-trail-overlap-review-placement-fix-2026-08-25.zip || exit 1
python3 apply-memex-trail-overlap-placement-fix.py

Verify
------
grep -n -B4 -A8 'MEMEX_TRAIL_OVERLAP_REVIEW'   'frontend/src/app/(editor)/trails/page.tsx'

Do not build until the verification shows the component at page level, not
inside `<a href={/n/...}>`, `<g>`, or a `.map(...)` callback.
