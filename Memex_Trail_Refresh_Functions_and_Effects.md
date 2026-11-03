---
type: document
okf_type: Concept
title: "Memex Trail Refresh — Controls, Functions and Effects"
description: "Operator guide to what /memex-trail-refresh does, what each button changes, and where the results appear."
tags: [memex, trails, okf, wiki, nodebook, operations]
status: workarea
created: "2026-10-30"
sources: []
---

# Memex Trail Refresh — What each function does

**Page:** <http://192.168.1.142:8180/memex-trail-refresh>  
**System:** HedgeDoc (G3), Memex source/trail index, derived Memex Wiki and nodeBook  
**Document date:** 30 October 2026

## 1. The purpose of this page

`/memex-trail-refresh` is an **operator control page**. It contains workflows that have different effects and must not be confused:

1. **System Trail Refresh** — reviews the Memex source catalogue and proposes/updates *system trails* in `memex/index.md`.
2. **OKF Source-Summary Refresh** — uses the LLM to identify evidence-backed **Topic** and **Entity** labels across derived Wiki source summaries; stores the result as a separate JSON navigation index.
3. **Apply OKF Results → Memex Wiki** — publishes **new derived Topic and Entity pages** based on the applied OKF index; then creates a **separate, bounded nodeBook navigation graph**.

**The word “Apply” is context-dependent.** Applying **system trails**, applying the **OKF source index**, and publishing **Wiki pages** are three distinct operations with different write targets.

## 2. At a glance: action → effect

| Function / control | What it does | What it changes | What it does **not** change |
|---|---|---|---|
| **System trail preview** | Sequentially reviews indexed raw sources and proposes trail membership/groupings. | Preview/work-state files only. | Does not yet alter `index.md`, the Wiki, raw notes or approved associations. |
| **System trail Apply** | Replaces the `## Trails` section with reviewed system trails. | `memex/index.md` and its HedgeDoc `memex-index` mirror; takes backup snapshots. | Preserves the `## Sources` section and separate user trails; does not approve `associated_with` edges. |
| **Refresh Wiki catalogue** | Reloads the existing Topic/Entity catalogue and separately approved Topic–Entity link counts. | Browser view only. | Does not classify, publish or rewrite pages. |
| **Generate sequential preview** | Begins a **new** source-summary classification run with the configured LLM. | OKF preview checkpoint. | Does not publish Wiki pages or change canonical evidence. **Can supersede earlier preview progress.** |
| **Resume preview** | Continues an unfinished source-summary review or its verification pass. | Advances the saved preview checkpoint. | Does not begin a new classification from source 1. |
| **Stop preview** | Requests a pause after the current step. | Saves/retains completed progress. | Does not undo completed reviews. |
| **Load saved preview** | Loads the previous review and Wiki-publication checkpoints. | Browser view only. | Does not run the LLM or apply changes. |
| **Source-grounded OKF preview** | Shows discovered Topics, Entities and shared-source candidates with links to supporting summaries. | Browser view only. | **Co-occurrence is not an approved semantic relationship.** |
| **Apply → memex-wiki** (from a *ready* source preview) | Saves the verified OKF index, then starts Wiki publication. Requires typing `APPLY` and write permission. | `memex/okf_source_navigation.json`, followed by new Wiki pages through the publication workflow. | Does not edit raw source notes, approved associations or system trails. |
| **Apply persisted OKF results → memex-wiki** | Starts Wiki publication from an **already-applied** OKF source index. Requires typing `APPLY`. | New derived Topic/Entity notes; updated maintained Wiki catalogue; eventual separate graph page. | Does **not** rerun the 341-source classification. Existing derived pages are skipped rather than rewritten. |
| **Resume Wiki publication** | Continues the incomplete publication job. | Adds the next planned Wiki pages and advances `okf-wiki-publish.json`. | Does not reset completed batches. |
| **Stop Wiki publication** | Pauses publication after the current batch. | Retains publication progress and pages already created. | **Does not roll back** pages published before stopping. |
| **Load publication progress** | Reloads current publication counters. | Browser view only. | No notes or indexes are changed. |
| **Open index → nodeBook navigation graph** | Opens the finished graph *note* after graph creation. | Navigation only. | Does not update the existing live Memex Network graph. |

## 3. System Trail Refresh — what “trail” means

A **trail** is a named collection of source notes with a reason for being grouped. It helps a person or agent browse related materials. **Trail membership is not the same as an approved, canonical source-to-source `associated_with` relationship.**

The reviewed `memex/refresh_trails.py` implementation:

- Reads the source catalogue from `memex/index.md`.
- Reviews **each source individually** with the configured Memex LLM, proposes existing/new trails, and saves resumable work and preview files under `/backups/builds`.
- **Preview:** makes no change to the accepted index or its mirror.
- **Apply:** requires a preview hash and literal `APPLY`, checks that the source catalogue is unchanged, makes a backup, replaces **only** the `## Trails` part of `memex/index.md`, and updates the HedgeDoc `memex-index` mirror.
- Keeps raw source notes and human-managed associations outside this workflow.

**Important:** The queue processor (`memex/process_queue_once.py`) can also regenerate `memex/index.md` and the live Memex Network host when processing a new source. Therefore system-trail changes must be considered alongside the queue's normal index lifecycle. The local UI wrapper was not independently inspected here; these trail semantics are from the reviewed Python implementation on the `staging` branch.

## 4. OKF Source-Summary Refresh — source → labels

This is the **“OKF source-summary refresh”** section shown on the page.

### Processing sequence

```text
Maintained Memex Wiki catalogue
    ↓
All eligible derived source-summary pages
    ↓
LLM review (up to 4 summaries per batch)
    ↓
Topic candidates + Entity candidates + exact supporting quotes
    ↓
Reject malformed / unsupported candidate claims
    ↓
Source-integrity verification
    ↓
State: ready
    ↓ operator types APPLY
Saved OKF source-navigation JSON index
    ↓
State: applied
```

**What is verified:** the reviewed source content is checked against the snapshot, and candidate quotes are validated against their source-summary text. This does **not** automatically prove that every extracted interpretation is correct, or that a Topic–Entity co-occurrence is a semantic relationship.

### Current successfully applied result

As reported by the operator on **30 October 2026**:

| Metric | Recorded result |
|---|---:|
| Source summaries classified and verified | **341 / 341** |
| Distinct Topic labels | **499** |
| Distinct Entity labels | **514** |
| Source-level co-occurrence candidates | **1,747** |
| Rejected unsupported model candidates | **85**, across **67** source summaries (UI screenshot) |
| State | **applied** |

An originally indexed **342nd** `memex-wiki-source-summary-…` alias was found to be a **canonical note**, not a derived Wiki summary. It was excluded from this run rather than overwritten or falsely relabelled. The 341-source result is therefore a deliberate current scope, not evidence that the source has been deleted.

### Where the OKF result is stored

- **Saved navigation index:** `/data/projects/hedgedoc/memex/okf_source_navigation.json`
- **Source review checkpoint:** `/data/projects/hedgedoc/memex/okf-source-refresh-preview.json`
- **API for this workflow:** `/memex-okf-topic-entity/refresh`
- **Inference:** Memex model settings, currently a Gemma model on G5; model work uses the LLM endpoint. Source verification and checkpointing run on G3 and may read HedgeDoc content.

**Applying this JSON index alone does not create Wiki Topic/Entity notes or edit `memex/index.md`.** Wiki publication is the next, separate phase.

## 5. Apply persisted OKF results → Memex Wiki

This section becomes available once a source-navigation index has been **applied**.

### Its effects

1. Read the existing, applied OKF navigation JSON.
2. Compare generated Topic/Entity labels with existing `/memex-wiki` pages.
3. **Preserve** existing derived Topic/Entity pages (do not overwrite).
4. **Reject** unsafe names and alias collisions rather than overwriting an unrelated note.
5. Create new evidence-backed derived Topic/Entity Wiki notes, including YAML `sources` links to canonical notes, source-summary links and clearly labelled **unapproved co-occurrence** navigation.
6. Let `/memex-wiki-maintain` register newly created notes in the maintained `memex-wiki-index` catalogue.
7. **Only after all page batches finish**, create/preserve the separate synthesis note containing a bounded `nodeBook` graph.

### Why publication is slow and resumable

- Up to **8** planned pages per publication step.
- Minimum **90-second spacing** between write batches to reduce HedgeDoc HTTP 429 rate limiting.
- Explicitly handles rate-limit backoff and saves a checkpoint after completed batches.
- It is **not one atomic 1,000-page transaction**: previously created pages remain if publication stops or fails.
- The correct recovery is normally **Load saved preview → Resume Wiki publication**, not starting a fresh source-review run or restarting HedgeDoc.

### Interpreting the publication terminal

| Display field | Meaning |
|---|---|
| `Wiki publication: running` | The publication plan is actively being processed by browser-driven steps. |
| `Processed: 8/1008` | 8 of the 1,008 **planned new-page items** have been considered; not 8 of the 341 source summaries. |
| `New pages: 8` | 8 new derived Wiki pages have been created. |
| `Existing preserved: 3` | 3 existing matching pages are retained unchanged. |
| `Unpublished conflicts/invalid names: 2` | 2 candidates were excluded; inspect the **Publication exceptions** details. |
| `nodeBook index graph: pending` | Normal while Topic/Entity publication is incomplete; graph creation is the **final** step. |
| `Wiki publication: completed` | All planned items have been processed and the graph step has completed. |
| `nodeBook index graph: created / preserved` | Graph note was created, or a matching existing graph note was left unchanged. |

**The sample `8/1008` figures are an observed snapshot, not confirmation that publication has finished.**

### Where publication writes

- **Publication checkpoint:** `/data/projects/hedgedoc/memex/okf-wiki-publish.json`
- **API:** `/memex-okf-topic-entity/wiki-publish`
- **Created Wiki pages:** `memex-wiki-topic-*` and `memex-wiki-entity-*` derived HedgeDoc notes.
- **Maintained Wiki catalogue:** HedgeDoc note alias `memex-wiki-index`.
- **Graph Wiki note:** alias `memex-wiki-synthesis-okf-source-navigation-graph` (created last if not already present).

### About the nodeBook graph

The graph depicts an entry route such as:

```text
Memex Index
   → Memex Wiki Index
      → Topic
         → Entity [shared-source co-occurrence; NOT approved]
            → Source summary
               → Canonical HedgeDoc source
```

This is a **bounded visual projection**, not the whole 1,747-candidate graph: the publisher selects up to **20 Topics** and **4 co-occurring Entities per Topic**, plus a limited set of supporting summaries and raw sources. The full classification remains in the JSON navigation index and in published derived pages.

The graph is **separate** from the live Memex Network and is linked from `/memex-index` and `/memex-wiki`. The patch does **not** append a graph section directly to `memex/index.md` or overwrite the live Memex Network nodeBook note.

## 6. Effect on Wiki Chat — important limitation

`/memex-wiki/chat` already reads the **maintained Wiki catalogue**, uses **lexical retrieval**, and can traverse **separately approved Topic ↔ Entity links**.

Once Topic/Entity pages are published, they become available to that catalogue-based retrieval. **However, this publishing patch does not change Wiki Chat to read `okf_source_navigation.json` or perform the full deliberate chain** `Topic → Entity → Source Summary → Canonical Evidence` on every question.

This distinction prevents mistaking a **visual navigation graph** or **source co-occurrence** for verified, deployed multi-hop reasoning.

## 7. What remains protected

The OKF classification and Wiki publication workflows are designed **not** to modify:

- Raw/canonical HedgeDoc source content or its YAML frontmatter.
- `memex/index.md` and its `## Trails` section **during OKF publication** (system trail Apply is a different action).
- User-trail membership or canonical `associated_with` source associations.
- Separately approved Topic–Entity relationships.
- Existing derived Topic/Entity pages (publisher skips matches, rather than overwriting).
- The existing Memex Network graph and `memex/process_queue_once.py`.

**Caution:** Wiki publication *does* create new derived Wiki notes with YAML, and it *does* update the Wiki index. It is not read-only once `APPLY` is confirmed.

## 8. States, correct next action and common pitfalls

| State / issue | Meaning | Correct action |
|---|---|---|
| `running` (source review) | LLM classification batches are in progress. | Let it advance; or use **Stop preview** and later **Resume preview**. |
| `verifying` | Checking recorded source snapshots/evidence; no new Topic discovery is intended. | Allow it to finish; check errors if the counter stops advancing. |
| `ready` | Classification/verification finished; not yet written to the persistent index. | Review exclusions and candidates, then type `APPLY` if satisfied. |
| `applied` | Source-navigation JSON index is saved. | **Do not regenerate** just to make `/memex-wiki` change; use **Apply persisted OKF results**. |
| `running` (Wiki publication) | New derived pages are being created in batches. | Leave browser workflow running; monitor the publication counter. |
| `paused` (Wiki publication) | Checkpoint retained; some pages may already exist. | **Load saved preview → Resume Wiki publication.** |
| HTTP `429` | HedgeDoc API rate limit, not necessarily a corrupt page. | Allow the built-in backoff; avoid repeated manual requests/restarts. |
| Publication exception | Unsafe name or existing alias conflict. | Open **Publication exceptions**; do not overwrite or retag the conflicting note. |
| Graph `pending` | The final graph step has not yet run. | Complete Wiki page publication first. |
| Graph `created` / `preserved` | Graph step has completed. | Follow the graph link and inspect `/memex-wiki` page counts. |

**Avoid these errors:**

- **Do not click “Generate sequential preview” to resume** a 341/341 applied result; that starts a new review.
- **Do not treat co-occurrence as an approved relationship.** These are navigation suggestions grounded in shared sources.
- **Do not mistake an `HTTP 200` for publishing completion.** Service health and job completion are different checks.
- **Do not restart HedgeDoc to speed up publication.** Restart may interrupt an active browser-driven step; resume from the persisted checkpoint instead.
- **Do not add generated graph content to `memex/index.md` manually.** The queue processor regenerates that file in its own workflow.

## 9. Minimal operator checklist

For the current applied 341-source run:

1. Open `/memex-trail-refresh` and **Load saved preview**.
2. Inspect **Apply persisted OKF results → memex-wiki**.
3. If publication says **running**, monitor it; if **paused**, use **Resume Wiki publication**.
4. Inspect **Publication exceptions** without altering conflicting notes.
5. Confirm the final state is **completed** and graph is **created** or **preserved**.
6. Refresh `/memex-wiki` and verify Topic/Entity counts increased. Open the linked nodeBook graph note.
7. Separately test Wiki Chat retrieval: presence of new pages in references is **not** proof of complete OKF source traversal.

## 10. Implementation basis and scope of validation

This description is based on the provided October 30 OKF source-refresh and Wiki-publication patches, user-reported UI/terminal results, and the `staging` implementations of `memex/refresh_trails.py` and `memex/process_queue_once.py` reviewed in the conversation. The **live G3 source was not remotely inspected in full**, so locally modified wrappers or subsequent patches may differ. The latest operator-confirmed publication snapshot was **8/1008, running**.

**Quick reference:**

- `memex/index.md` = source/trail catalogue, updated by system trail Apply or queue processing.
- `memex/okf_source_navigation.json` = applied OKF classification/navigation data.
- `memex-wiki-index` = maintained derived-Wiki page catalogue.
- `memex/okf-wiki-publish.json` = resumable Wiki publication progress.
- `memex-wiki-synthesis-okf-source-navigation-graph` = separate, bounded nodeBook graph note, published last.
- `/memex-wiki/chat` = existing Wiki chat; **not yet fully integrated with the new JSON OKF traversal index**.
