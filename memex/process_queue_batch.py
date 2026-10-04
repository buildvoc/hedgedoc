#!/usr/bin/env python3
"""Process every currently pending Memex queue row.

Normal mode repeatedly invokes process_queue_once.py until the pending set is
empty.

Rebuild mode is selected automatically when pending rows have
queueReason="orphan-repair". It is designed for intentionally rebuilding an
empty or reduced memex/index.md from already-processed HedgeDocs.

For each orphan-repair item this runner gives process_queue_once.py a temporary
queue view containing only sources already present in the current index,
sources successfully rebuilt earlier in this batch, and the one pending source
being processed now. The complete queue is restored after every child
invocation and the result for the current row is merged back into full history.
"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote
import uuid

PROJECT_ROOT = Path(os.environ.get("MEMEX_PROJECT_ROOT", "/data/projects/hedgedoc"))
QUEUE = Path(os.environ.get("MEMEX_QUEUE_PATH", str(PROJECT_ROOT / "memex/queue.jsonl")))
INDEX = Path(os.environ.get("MEMEX_INDEX_PATH", str(PROJECT_ROOT / "memex/index.md")))
PROCESSOR = Path(os.environ.get("MEMEX_PROCESS_QUEUE_ONCE", str(PROJECT_ROOT / "memex/process_queue_once.py")))
MAX_ITERATIONS = int(os.environ.get("MEMEX_PROCESS_BATCH_MAX", "1000"))
REBUILD_REASON = "orphan-repair"
SELECTED_ALIASES_ENV = "MEMEX_PROCESS_BATCH_ALIASES"
SCOPED_BATCH_MAX = 4



def selected_aliases_from_env() -> list[str] | None:
    raw = os.environ.get(SELECTED_ALIASES_ENV, "").strip()
    if not raw:
        return None

    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Invalid {SELECTED_ALIASES_ENV} JSON: {exc}"
        ) from exc

    if not isinstance(value, list):
        raise RuntimeError(f"{SELECTED_ALIASES_ENV} must be a JSON array")

    aliases: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            raise RuntimeError(f"{SELECTED_ALIASES_ENV} entries must be strings")
        alias = item.strip()
        if not alias or alias in seen:
            continue
        seen.add(alias)
        aliases.append(alias)

    if not aliases:
        raise RuntimeError(f"{SELECTED_ALIASES_ENV} contains no aliases")
    if len(aliases) > SCOPED_BATCH_MAX:
        raise RuntimeError(
            f"Scoped Memex batch has {len(aliases)} aliases; maximum is {SCOPED_BATCH_MAX}"
        )

    return aliases


def read_rows(path: Path = QUEUE) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Invalid queue JSON at {path}:{number}: {exc}") from exc
        if isinstance(value, dict):
            rows.append(value)
    return rows


def write_rows(rows: list[dict[str, Any]], path: Path = QUEUE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temp.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    os.replace(temp, path)


def pending_rows(rows: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    source = read_rows() if rows is None else rows
    return [row for row in source if row.get("status") == "pending"]


def pending_ids(rows: list[dict[str, Any]] | None = None) -> list[str]:
    return [str(row.get("id") or "") for row in pending_rows(rows) if row.get("id")]


def pending_aliases(rows: list[dict[str, Any]] | None = None) -> list[str]:
    return [str(row.get("alias") or "") for row in pending_rows(rows) if row.get("alias")]


def aliases_from_section(section: str) -> list[str]:
    aliases: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r"/n/([^)\s?#]+)", section):
        alias = unquote(match.group(1))
        if alias in seen:
            continue
        seen.add(alias)
        aliases.append(alias)
    return aliases


def indexed_aliases() -> list[str]:
    if not INDEX.exists():
        return []
    text = INDEX.read_text(encoding="utf-8")
    if "## Sources" not in text:
        return []
    section = text.split("## Sources", 1)[1]
    if "## Trails" in section:
        section = section.split("## Trails", 1)[0]
    return aliases_from_section(section)


def trail_member_aliases() -> list[str]:
    """Return only source aliases already represented in maintained trails.

    The source catalogue intentionally survives Snapshot + reset all trails, so
    indexed_aliases() is not a valid rebuild context after a reset.  Scoped
    reruns must grow trail context from sources that have actually been rebuilt,
    not from every catalogue source.
    """
    if not INDEX.exists():
        return []
    text = INDEX.read_text(encoding="utf-8")
    if "## Trails" not in text:
        return []
    section = text.split("## Trails", 1)[1]
    return aliases_from_section(section)


def preserve_source_catalogue(catalogue_index: str, generated_index: str) -> str:
    """Keep the full catalogue and merge sources materialized by this run.

    Scoped rebuilds deliberately present process_queue_once.py with a reduced
    queue/index view.  The generated Sources section may therefore contain only
    the current scoped corpus, including a source that was not present in the
    pre-run catalogue.  Preserve every existing catalogue row, refresh rows
    returned by the processor, append genuinely new source rows, and retain the
    generated Trails section.
    """
    source_marker = "## Sources"
    trail_marker = "## Trails"
    if (
        source_marker not in catalogue_index
        or trail_marker not in catalogue_index
        or source_marker not in generated_index
        or trail_marker not in generated_index
    ):
        return generated_index

    catalogue_prefix, catalogue_after_sources = catalogue_index.split(source_marker, 1)
    catalogue_sources, _ = catalogue_after_sources.split(trail_marker, 1)
    _, generated_after_sources = generated_index.split(source_marker, 1)
    generated_sources, generated_trails = generated_after_sources.split(trail_marker, 1)

    generated_by_alias: dict[str, str] = {}
    generated_source_lines: list[tuple[list[str], str]] = []
    for line in generated_sources.splitlines():
        aliases = aliases_from_section(line)
        if not aliases:
            continue
        generated_source_lines.append((aliases, line))
        for alias in aliases:
            generated_by_alias[alias] = line

    merged_lines: list[str] = []
    emitted_lines: set[str] = set()
    known_aliases: set[str] = set()

    for line in catalogue_sources.splitlines():
        aliases = aliases_from_section(line)
        replacement = next(
            (generated_by_alias[alias] for alias in aliases if alias in generated_by_alias),
            None,
        )
        chosen = replacement if replacement is not None else line
        merged_lines.append(chosen)
        emitted_lines.add(chosen)
        known_aliases.update(aliases_from_section(chosen))

    for aliases, line in generated_source_lines:
        if any(alias in known_aliases for alias in aliases):
            continue
        if line in emitted_lines:
            continue
        merged_lines.append(line)
        emitted_lines.add(line)
        known_aliases.update(aliases)

    merged_sources = "\n".join(merged_lines).strip("\n")
    trails = generated_trails.lstrip("\r\n")

    return (
        f"{catalogue_prefix.rstrip()}\n\n{source_marker}\n"
        f"{merged_sources}\n\n{trail_marker}\n{trails}"
    )


def scope_index_sources(index_text: str, allowed_aliases: set[str]) -> str:
    """Restrict the Sources section supplied to one scoped rebuild iteration.

    process_queue_once.py may derive its LLM document corpus from memex/index.md
    as well as the queue.  Scoping only queue.jsonl therefore is insufficient:
    after a trail reset the full catalogue can leak back into the LLM prompt
    and regenerate trails for unselected sources.

    Keep the current Trails section, but expose only source catalogue rows whose
    aliases are explicitly active for this iteration.
    """
    source_marker = "## Sources"
    trail_marker = "## Trails"

    if source_marker not in index_text or trail_marker not in index_text:
        return index_text

    prefix, after_sources = index_text.split(source_marker, 1)
    source_section, trail_section = after_sources.split(trail_marker, 1)

    filtered_lines: list[str] = []
    for line in source_section.splitlines():
        line_aliases = aliases_from_section(line)
        if line_aliases and not any(alias in allowed_aliases for alias in line_aliases):
            continue
        filtered_lines.append(line)

    scoped_sources = "\n".join(filtered_lines).strip("\n")
    trails = trail_section.lstrip("\r\n")

    return (
        f"{prefix.rstrip()}\n\n{source_marker}\n"
        f"{scoped_sources}\n\n{trail_marker}\n{trails}"
    )


def seal_membership_to_index(
    rows: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Withdraw stale processed aliases while preserving pending work."""

    source_rows = read_rows() if rows is None else [dict(row) for row in rows]
    active = set(indexed_aliases())

    latest: dict[str, dict[str, Any]] = {}
    for row in source_rows:
        alias = str(row.get("alias") or "")
        if not alias or row.get("queueReason") == "snapshot-process":
            continue
        latest[alias] = row

    now = datetime.now(timezone.utc).isoformat()
    additions: list[dict[str, Any]] = []

    for alias, row in latest.items():
        if alias in active:
            continue
        if row.get("status") != "processed":
            # Pending rows are intentional future work and stay active.
            continue

        cancel_row: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "alias": alias,
            "queuedAt": now,
            "status": "cancelled",
            "cancelledAt": now,
            "queueReason": "rebuild-membership-reset",
            "nodeBook": row.get("nodeBook", "memex-network"),
        }
        if row.get("sourceRevision"):
            cancel_row["sourceRevision"] = row["sourceRevision"]
        additions.append(cancel_row)

    if additions:
        source_rows.extend(additions)
        write_rows(source_rows)

    return source_rows, len(additions)


def manual_seal_membership() -> int:
    rows = read_rows()
    active = indexed_aliases()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = QUEUE.with_name(f"{QUEUE.name}.before-membership-seal-{stamp}")
    write_rows(rows, backup)

    _, cancelled = seal_membership_to_index(rows)

    print(f"MEMEX membership seal backup: {backup}", flush=True)
    print(f"MEMEX indexed sources: {len(active)}", flush=True)
    print(f"MEMEX stale processed sources cancelled: {cancelled}", flush=True)
    print(f"MEMEX pending rows preserved: {len(pending_rows())}", flush=True)
    return 0


def latest_processed_for_alias(rows: list[dict[str, Any]], alias: str) -> dict[str, Any] | None:
    for row in reversed(rows):
        if row.get("alias") != alias:
            continue
        if row.get("queueReason") == "snapshot-process":
            continue
        if row.get("status") == "processed":
            return dict(row)
    return None


def base_processed_row(rows: list[dict[str, Any]], alias: str) -> dict[str, Any]:
    existing = latest_processed_for_alias(rows, alias)
    if existing is not None:
        existing["status"] = "processed"
        return existing
    return {
        "id": f"rebuild-base-{alias}",
        "alias": alias,
        "queuedAt": "1970-01-01T00:00:00+00:00",
        "status": "processed",
        "nodeBook": "memex-network",
        "queueReason": "rebuild-base",
    }


def merge_scoped_result(full_rows: list[dict[str, Any]], scoped_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = [dict(row) for row in full_rows]
    positions = {str(row.get("id")): index for index, row in enumerate(result) if row.get("id")}
    for row in scoped_rows:
        row_id = str(row.get("id") or "")
        if not row_id or row_id.startswith("rebuild-base-"):
            continue
        if row_id in positions:
            merged = dict(result[positions[row_id]])
            merged.update(row)
            result[positions[row_id]] = merged
        else:
            positions[row_id] = len(result)
            result.append(dict(row))
    return result


def run_child() -> subprocess.CompletedProcess[Any]:
    return subprocess.run([sys.executable, str(PROCESSOR)], cwd=str(PROJECT_ROOT), env=os.environ.copy(), check=False)


def run_rebuild_batch(allowed_aliases: set[str] | None = None) -> int:
    full_rows = read_rows()
    targets = [
        dict(row)
        for row in full_rows
        if row.get("status") == "pending"
        and row.get("queueReason") == REBUILD_REASON
        and (allowed_aliases is None or str(row.get("alias") or "") in allowed_aliases)
    ]
    if not targets:
        return 0

    if allowed_aliases is not None:
        found = {str(row.get("alias") or "") for row in targets}
        missing = sorted(allowed_aliases - found)
        if missing:
            print(
                "ERROR: scoped rebuild aliases are not pending orphan-repair rows: "
                + ", ".join(missing),
                flush=True,
            )
            return 4

    catalogue_index = INDEX.read_text(encoding="utf-8") if INDEX.exists() else ""
    if allowed_aliases is None:
        base_aliases = indexed_aliases()
        base_label = "indexed-base"
    else:
        # A reset preserves all catalogue sources but deliberately clears trails.
        # Only already-trailed sources belong in the scoped rebuild context.
        base_aliases = trail_member_aliases()
        base_label = "trail-base"

    completed_aliases: list[str] = []
    backup = QUEUE.with_name(f"{QUEUE.name}.rebuild-backup-{os.getpid()}")

    print(
        f"MEMEX rebuild batch: targets={len(targets)} {base_label}={len(base_aliases)} "+
        f"catalogue={len(indexed_aliases())}",
        flush=True,
    )
    print(f"MEMEX rebuild queue safety backup: {backup}", flush=True)

    try:
        write_rows(full_rows, backup)

        for iteration, target in enumerate(targets, start=1):
            target_id = str(target.get("id") or "")
            target_alias = str(target.get("alias") or "")
            if not target_id or not target_alias:
                print(f"ERROR: rebuild target missing id/alias at step {iteration}", flush=True)
                return 2

            full_rows = read_rows()
            current = next((dict(row) for row in full_rows if str(row.get("id") or "") == target_id), None)
            if current is None:
                print(f"ERROR: rebuild queue row disappeared: {target_id}", flush=True)
                return 2
            if current.get("status") != "pending":
                print(f"MEMEX rebuild [{iteration}/{len(targets)}]: {target_alias} already {current.get('status')}; skipping", flush=True)
                if current.get("status") == "processed":
                    completed_aliases.append(target_alias)
                continue

            active_aliases: list[str] = []
            seen: set[str] = set()
            for alias in [*base_aliases, *completed_aliases]:
                if not alias or alias == target_alias or alias in seen:
                    continue
                seen.add(alias)
                active_aliases.append(alias)

            scoped_rows = [base_processed_row(full_rows, alias) for alias in active_aliases]
            scoped_rows.append(current)

            print(f"MEMEX rebuild [{iteration}/{len(targets)}]: active-before={len(active_aliases)} processing={target_alias}", flush=True)

            write_rows(full_rows, backup)
            write_rows(scoped_rows)

            live_index_before_child = (
                INDEX.read_text(encoding="utf-8")
                if INDEX.exists()
                else ""
            )
            iteration_aliases = set([*active_aliases, target_alias])

            if allowed_aliases is not None and live_index_before_child:
                scoped_index = scope_index_sources(
                    live_index_before_child,
                    iteration_aliases,
                )
                INDEX.write_text(scoped_index, encoding="utf-8")
                print(
                    f"MEMEX scoped rebuild index: source-context={len(indexed_aliases())} "
                    f"trail-members-before={len(trail_member_aliases())}",
                    flush=True,
                )

            child: subprocess.CompletedProcess[Any] | None = None
            scoped_after: list[dict[str, Any]] = []
            try:
                child = run_child()
                scoped_after = read_rows()
            finally:
                if not scoped_after and QUEUE.exists():
                    try:
                        scoped_after = read_rows()
                    except Exception:
                        scoped_after = []
                restored = merge_scoped_result(full_rows, scoped_after)
                write_rows(restored)

                if allowed_aliases is not None and catalogue_index and INDEX.exists():
                    generated_index = INDEX.read_text(encoding="utf-8")
                    merged_index = preserve_source_catalogue(catalogue_index, generated_index)
                    if merged_index != generated_index:
                        INDEX.write_text(merged_index, encoding="utf-8")
                        print(
                            f"MEMEX scoped rebuild: restored full source catalogue; "+
                            f"trail-members={len(trail_member_aliases())}",
                            flush=True,
                        )

            updated = next((row for row in scoped_after if str(row.get("id") or "") == target_id), None)
            if updated is None or updated.get("status") != "processed":
                return_code = child.returncode if child is not None else 1
                print("ERROR: rebuild item did not complete; " f"exit={return_code} alias={target_alias} " f"status={updated.get('status') if updated else 'missing'}", flush=True)
                print(f"Full queue restored. Safety backup retained at {backup}", flush=True)
                return return_code if return_code not in (0, None) else 1

            completed_aliases.append(target_alias)
            print(f"MEMEX rebuild progress: {iteration}/{len(targets)} completed; indexed-now={len(indexed_aliases())}", flush=True)

        rebuilt_index = indexed_aliases()
        _, sealed = seal_membership_to_index()
        print(
            f"MEMEX rebuild complete: {len(completed_aliases)} items processed; "
            f"indexed={len(rebuilt_index)} stale-processed-cancelled={sealed}",
            flush=True,
        )
        try:
            backup.unlink()
        except FileNotFoundError:
            pass
        return 0
    except BaseException:
        if backup.exists():
            try:
                write_rows(read_rows(backup))
            except Exception as restore_error:
                print(f"ERROR: failed to restore queue from {backup}: {restore_error}", flush=True)
        raise


def run_normal_batch() -> int:
    processed_steps = 0
    for iteration in range(1, MAX_ITERATIONS + 1):
        before_rows = read_rows()
        before = pending_ids(before_rows)
        if not before:
            print(f"MEMEX batch complete: steps={processed_steps} pending=0", flush=True)
            return 0
        current = next(
            (row for row in reversed(before_rows) if row.get("status") == "pending"),
            None,
        )
        current_alias = (
            str(current.get("alias") or "<unknown>")
            if current
            else "<unknown>"
        )
        print(f"MEMEX batch [{iteration}]: pending={len(before)} next={current_alias}", flush=True)
        child = run_child()
        after = pending_ids()
        if after == before:
            print("ERROR: process_queue_once.py made no queue progress; " f"exit={child.returncode} pending={len(after)} next={current_alias}", flush=True)
            return child.returncode if child.returncode not in (0, None) else 1
        processed_steps += 1
        if child.returncode != 0:
            print("MEMEX batch: child returned non-zero but queue advanced; " f"continuing (exit={child.returncode}, remaining={len(after)})", flush=True)
    remaining = pending_ids()
    print(f"ERROR: MEMEX batch iteration limit reached: limit={MAX_ITERATIONS} remaining={len(remaining)}", flush=True)
    return 3


def main() -> int:
    if "--seal-membership" in sys.argv[1:]:
        return manual_seal_membership()

    if not PROCESSOR.exists():
        print(f"ERROR: single-item processor not found: {PROCESSOR}", flush=True)
        return 2

    try:
        selected_aliases = selected_aliases_from_env()
    except RuntimeError as exc:
        print(f"ERROR: {exc}", flush=True)
        return 4

    initial_rows = read_rows()
    initial_pending = pending_rows(initial_rows)
    rebuild_pending = [row for row in initial_pending if row.get("queueReason") == REBUILD_REASON]

    if selected_aliases is not None:
        selected_set = set(selected_aliases)
        scoped_pending = [
            row
            for row in initial_pending
            if str(row.get("alias") or "") in selected_set
        ]
        scoped_rebuild = [
            row
            for row in scoped_pending
            if row.get("queueReason") == REBUILD_REASON
        ]
        print(
            f"MEMEX scoped batch start: selected={len(selected_aliases)} "
            f"global-pending={len(initial_pending)} scoped-pending={len(scoped_pending)} "
            f"scoped-rebuild={len(scoped_rebuild)} queue={QUEUE} processor={PROCESSOR}",
            flush=True,
        )

        missing = sorted(
            selected_set
            - {str(row.get("alias") or "") for row in scoped_pending}
        )
        if missing:
            print(
                "ERROR: selected aliases are not currently pending: "
                + ", ".join(missing),
                flush=True,
            )
            return 4

        non_rebuild = [
            str(row.get("alias") or "")
            for row in scoped_pending
            if row.get("queueReason") != REBUILD_REASON
        ]
        if non_rebuild:
            print(
                "ERROR: scoped rerun only accepts pending orphan-repair rows: "
                + ", ".join(non_rebuild),
                flush=True,
            )
            return 4

        result = run_rebuild_batch(selected_set)
        if result == 0:
            print(
                f"MEMEX scoped batch complete: selected={len(selected_aliases)}; "
                "unrelated pending rows were left untouched",
                flush=True,
            )
        return result

    print(f"MEMEX batch start: pending={len(initial_pending)} rebuild={len(rebuild_pending)} queue={QUEUE} processor={PROCESSOR}", flush=True)
    if not initial_pending:
        print("MEMEX batch complete: no pending rows", flush=True)
        return 0
    if rebuild_pending:
        rebuild_result = run_rebuild_batch()
        if rebuild_result != 0:
            return rebuild_result
    if pending_ids():
        return run_normal_batch()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
