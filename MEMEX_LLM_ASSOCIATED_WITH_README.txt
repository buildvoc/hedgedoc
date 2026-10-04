Memex Process Pending -> LLM associated_with patch
===================================================

Scope: changes only /data/projects/hedgedoc/memex/process_queue_once.py.

Uses the deployed version-2 canonical store:
  /data/projects/hedgedoc-nb-frontend/data/memex-associations.json

Flow:
1. Main Process Pending LLM returns association candidates for the new/revised note.
2. Each candidate target's FULL HedgeDoc content is fetched.
3. A second strict Ollama verification compares both full notes.
4. Trail membership, broad topic, title/keyword similarity, geography alone,
   chronology alone, and speculation are rejected.
5. Only verified relationships at confidence >= 0.85 are accepted by default.
   Override with MEMEX_LLM_ASSOCIATION_MIN_CONFIDENCE.
6. Accepted edges are always relation=associated_with, createdBy=llm.
7. Reprocessing synchronizes only old LLM-created edges incident to that source.
8. User-created edges are preserved and win duplicate pairs.
9. Zero accepted associations is valid.
10. Store write is atomic.
11. Sync occurs after Memex lint PASS and before queue status becomes processed.
12. If sync fails, prior index/nodeBook are restored and queue remains pending.

Apply:
  cd /data/projects/hedgedoc || exit 1
  unzip -o memex-process-pending-llm-associated-with-2026-08-23.zip
  python3 apply-memex-llm-associated-with.py

Do not commit until one pending note is validated end-to-end.
