#!/usr/bin/env python3

import base64
import binascii
import fcntl
import hashlib
import mimetypes
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

OUTPUT_DIR = Path(
    os.environ.get(
        "DOCLING_BATCH_OUTPUT_DIR",
        "/data/projects/docling/batch/output-json",
    )
)
MANIFEST_PATH = Path(
    os.environ.get(
        "DOCLING_HEDGEDOC_MANIFEST_PATH",
        "/data/projects/docling/batch/hedgedoc-ingest.json",
    )
)
HEDGEDOC_NOTES_API = os.environ.get(
    "MEMEX_HEDGEDOC_API_BASE",
    "http://127.0.0.1:3100/api/v2/notes",
).rstrip("/")
HEDGEDOC_MEDIA_API = os.environ.get(
    "MEMEX_HEDGEDOC_MEDIA_API",
    HEDGEDOC_NOTES_API.removesuffix("/notes") + "/media",
).rstrip("/")
MAX_NOTE_CHARS = int(os.environ.get("DOCLING_HEDGEDOC_MAX_CHARS", "100000"))
QUEUE_PATH = Path(
    os.environ.get("MEMEX_QUEUE_PATH", "/data/projects/hedgedoc/memex/queue.jsonl")
)
TOKEN = os.environ.get("MEMEX_API_TOKEN", "").strip()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def natural_key(value: str):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        return {"version": 1, "items": {}}

    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("Docling ingestion manifest is not a JSON object")
    items = data.get("items")
    if not isinstance(items, dict):
        data["items"] = {}
    data["version"] = 1
    return data


def save_manifest(manifest: dict) -> None:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = MANIFEST_PATH.with_name(f".{MANIFEST_PATH.name}.tmp-{os.getpid()}")
    temp.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temp, 0o664)
    os.replace(temp, MANIFEST_PATH)


def request_note(method: str, url: str, body: str | None = None):
    headers = {"Authorization": f"Bearer {TOKEN}"}
    payload = None
    if body is not None:
        headers["Content-Type"] = "text/markdown"
        payload = body.encode("utf-8")

    request = Request(url, data=payload, headers=headers, method=method)
    try:
        with urlopen(request, timeout=60) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        return error.code, detail
    except URLError as error:
        raise RuntimeError(f"HedgeDoc request failed: {error}") from error


def fetch_existing(alias: str) -> str | None:
    status, body = request_note(
        "GET",
        f"{HEDGEDOC_NOTES_API}/{alias}/content",
    )
    if status == 404:
        return None
    if status != 200:
        raise RuntimeError(
            f"HedgeDoc GET {alias} failed ({status})" + (f": {body[:240]}" if body else "")
        )
    return body


def create_named_note(alias: str, markdown: str) -> None:
    status, body = request_note(
        "POST",
        f"{HEDGEDOC_NOTES_API}/{alias}",
        markdown,
    )
    if status < 200 or status >= 300:
        raise RuntimeError(
            f"HedgeDoc POST {alias} failed ({status})" + (f": {body[:240]}" if body else "")
        )

    try:
        response = json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"HedgeDoc POST {alias} returned invalid JSON") from error

    created_alias = (
        response.get("metadata", {}).get("primaryAlias")
        if isinstance(response, dict)
        else None
    )
    if created_alias != alias:
        raise RuntimeError(
            f"Created HedgeDoc returned unexpected alias: {created_alias or 'missing'}"
        )


# Images must remain embedded in Docling's conversion JSON. Only the
# HedgeDoc *copy* is externalized using the native media API.
DATA_IMAGE_RE = re.compile(r"^data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$")
MEDIA_UUID_RE = re.compile(
    r"(?:^|/)media/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:$|[?#])"
)
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def image_payloads(document: dict) -> dict[str, tuple[str, bytes]]:
    """Collect by hash; keep the source DoclingDocument unchanged."""
    found: dict[str, tuple[str, bytes]] = {}

    def walk(value):
        if isinstance(value, dict):
            for part in value.values():
                walk(part)
        elif isinstance(value, list):
            for part in value:
                walk(part)
        elif isinstance(value, str) and value.startswith("data:image/"):
            match = DATA_IMAGE_RE.fullmatch(value)
            if match is None:
                raise RuntimeError("invalid embedded Docling image data URI")
            mime, encoded = match.groups()
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as error:
                raise RuntimeError("invalid base64 image payload") from error
            if not raw:
                raise RuntimeError("empty embedded Docling image")
            digest = hashlib.sha256(raw).hexdigest()
            found.setdefault(digest, (mime.lower(), raw))

    walk(document)
    return found


def replace_embedded_images(value, media_by_hash: dict[str, str]):
    """Return a new tree, replacing only embedded image URI strings."""
    if isinstance(value, dict):
        return {key: replace_embedded_images(part, media_by_hash) for key, part in value.items()}
    if isinstance(value, list):
        return [replace_embedded_images(part, media_by_hash) for part in value]
    if isinstance(value, str) and value.startswith("data:image/"):
        match = DATA_IMAGE_RE.fullmatch(value)
        if match is None:
            raise RuntimeError("invalid embedded Docling image data URI")
        raw = base64.b64decode(match.group(2), validate=True)
        return media_by_hash[hashlib.sha256(raw).hexdigest()]
    return value


def extract_media_uuid(value):
    """Handle known HedgeDoc media response wrappers without guessing IDs."""
    if isinstance(value, str):
        if UUID_RE.fullmatch(value):
            return value.lower()
        match = MEDIA_UUID_RE.search(value)
        if match:
            return match.group(1).lower()
        return None
    if isinstance(value, dict):
        for key in ("uuid", "mediaUuid", "media_uuid", "url", "href", "src", "path"):
            if key in value:
                found = extract_media_uuid(value[key])
                if found:
                    return found
        for key in ("media", "metadata", "data", "result", "file"):
            if key in value:
                found = extract_media_uuid(value[key])
                if found:
                    return found
    return None


def upload_image(alias: str, digest: str, mime: str, raw: bytes) -> str:
    """Upload as note-associated media. Never write directly to uploads/."""
    suffix = mimetypes.guess_extension(mime) or ".bin"
    if suffix == ".jpe":
        suffix = ".jpg"
    filename = f"docling-{digest[:20]}{suffix}"
    boundary = f"docling-{uuid.uuid4().hex}"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode("utf-8")
    body = head + raw + f"\r\n--{boundary}--\r\n".encode("ascii")
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "HedgeDoc-Note": alias,
        "Accept": "application/json",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }

    for attempt in range(3):
        request = Request(HEDGEDOC_MEDIA_API, data=body, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=120) as response:
                status = response.status
                text = response.read().decode("utf-8", errors="replace")
        except HTTPError as error:
            status = error.code
            text = error.read().decode("utf-8", errors="replace")
        except URLError as error:
            raise RuntimeError(f"HedgeDoc media upload failed: {error}") from error
        if status in (429, 502, 503, 504) and attempt < 2:
            time.sleep(2 ** attempt)
            continue
        if status < 200 or status >= 300:
            raise RuntimeError(f"HedgeDoc media upload failed ({status}): {text[:240]}")
        try:
            result = json.loads(text)
        except json.JSONDecodeError as error:
            raise RuntimeError("HedgeDoc media upload response was not JSON") from error
        media_uuid = extract_media_uuid(result)
        if not media_uuid:
            raise RuntimeError(f"HedgeDoc media upload returned no media UUID: {text[:240]}")
        return f"media/{media_uuid}"
    raise RuntimeError("HedgeDoc media upload retries exhausted")


def is_batch_owned_note(content: str, title: str, filename: str, staging: str) -> bool:
    if content.strip() == staging.strip():
        return True
    prefix = build_markdown(title, {}).split("{}\n", 1)[0]
    if not content.startswith(prefix):
        return False
    try:
        document = json.loads(content[len(prefix):].strip())
    except json.JSONDecodeError:
        return False
    return (
        isinstance(document, dict)
        and document.get("schema_name") == "DoclingDocument"
        and isinstance(document.get("origin"), dict)
        and document["origin"].get("filename") == Path(filename).stem + ".pdf"
    )


def make_staging_note(title: str, filename: str) -> str:
    # Recoverable exact marker. This note is never added to the manifest until
    # the final compact DoclingDocument has been successfully PUT.
    return build_markdown(title, {}).replace("{}\n", f"<!-- docling-batch-in-progress: {filename} -->\n")


def normalize_title(value: str) -> str:
    title = " ".join(value.split()).strip()
    return title or "Untitled"


def deterministic_alias(filename: str) -> str:
    digest = hashlib.sha256(filename.encode("utf-8")).hexdigest()[:24]
    return f"docling-batch-{digest}"


def build_markdown(title: str, document: dict) -> str:
    yaml_title = json.dumps(title, ensure_ascii=False)
    compact_json = json.dumps(
        document,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return (
        "---\n"
        "type: document\n"
        "okf_type: Concept\n"
        f"title: {yaml_title}\n"
        'description: ""\n'
        "tags: []\n"
        "status: draft\n"
        "sources: []\n"
        "---\n\n"
        f"# {title}\n\n"
        f"{compact_json}\n"
    )


def ensure_pending(alias: str, *, source_changed: bool = False) -> str:
    """Idempotently enqueue a successfully ingested note, with no 4-item cap.

    Keep the queue's existing JSONL lifecycle format. A processed or manually
    cancelled unchanged note is not automatically requeued; a changed source
    is queued again. An already pending note is never duplicated.
    """
    QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with QUEUE_PATH.open("a+", encoding="utf-8") as queue:
        fcntl.flock(queue.fileno(), fcntl.LOCK_EX)
        try:
            queue.seek(0)
            latest = None
            for number, line in enumerate(queue, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RuntimeError(
                        f"malformed Memex queue JSONL line {number}"
                    ) from error
                if (
                    isinstance(row, dict)
                    and row.get("alias") == alias
                    and row.get("queueReason") != "snapshot-process"
                ):
                    latest = row

            if latest is not None:
                status = latest.get("status")
                if status == "pending":
                    return "already-pending"
                if not source_changed and status in {"processed", "cancelled"}:
                    return f"already-{status}"

            queued_at = now_iso()
            entry = {
                "id": str(uuid.uuid4()),
                "alias": alias,
                "queuedAt": queued_at,
                "status": "pending",
                "nodeBook": "memex-network",
            }
            if source_changed:
                entry["queueReason"] = "source-updated"
            queue.seek(0, os.SEEK_END)
            queue.write(json.dumps(entry, separators=(",", ":")) + "\n")
            queue.flush()
            os.fsync(queue.fileno())
            return "queued"
        finally:
            fcntl.flock(queue.fileno(), fcntl.LOCK_UN)


def ingest_all() -> int:
    if not TOKEN:
        print("ERROR: MEMEX_API_TOKEN is not configured", flush=True)
        return 2

    if not OUTPUT_DIR.is_dir():
        print(f"ERROR: output directory does not exist: {OUTPUT_DIR}", flush=True)
        return 2

    manifest = load_manifest()
    items = manifest["items"]
    files = sorted(OUTPUT_DIR.glob("*.json"), key=lambda path: natural_key(path.name))

    print("=== DOCLING JSON -> HEDGEDOC BATCH INGEST ===", flush=True)
    print(f"Input   : {OUTPUT_DIR}", flush=True)
    print(f"Manifest: {MANIFEST_PATH}", flush=True)
    print(f"Ready   : {len(files)}", flush=True)
    print(flush=True)

    created = 0
    skipped = 0
    failed = 0
    auto_queued = 0

    def queue_ingested(file_name: str, previous_hash: str | None, digest: str) -> None:
        nonlocal auto_queued
        item = items[file_name]
        # Preserve the prior user decision when the exact same source was
        # already enqueued. Changed JSON requires a new processing pass.
        if previous_hash == digest and item.get("queuedAt"):
            return
        result = ensure_pending(
            item["alias"], source_changed=bool(previous_hash and previous_hash != digest)
        )
        item["queuedAt"] = now_iso()
        save_manifest(manifest)
        if result == "queued":
            auto_queued += 1
        print(f"QUEUE: {result} -> {item['alias']}", flush=True)

    for index, path in enumerate(files, start=1):
        print("-" * 60, flush=True)
        print(f"[{index}] {path.name}", flush=True)

        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            previous = items.get(path.name)
            if previous and previous.get("jsonSha256") == digest:
                queue_ingested(path.name, digest, digest)
                print(f"SKIP: already ingested as {previous.get('alias', 'unknown')}", flush=True)
                skipped += 1
                continue

            document = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(document, dict) or document.get("schema_name") != "DoclingDocument":
                raise RuntimeError('schema_name must be "DoclingDocument"')

            title = normalize_title(path.stem)
            alias = deterministic_alias(path.name)
            if previous and previous.get("alias") != alias:
                raise RuntimeError("manifest alias differs from deterministic alias")

            # Validate the final note size *before* creating a HedgeDoc note or
            # uploading any media. Exact original Docling JSON is left on disk.
            images = image_payloads(document)
            placeholder = {key: "media/00000000-0000-0000-0000-000000000000" for key in images}
            preflight = build_markdown(title, replace_embedded_images(document, placeholder))
            if len(preflight) > MAX_NOTE_CHARS:
                raise RuntimeError(
                    f"compact note is {len(preflight)} chars after image externalization; "
                    f"limit is {MAX_NOTE_CHARS} (split source into smaller PDFs)"
                )

            staging = make_staging_note(title, path.name)
            existing = fetch_existing(alias)
            if existing is None:
                create_named_note(alias, staging)
                state = "created"
            elif is_batch_owned_note(existing, title, path.name, staging):
                state = "updated" if previous else "recovered-existing"
                if not images and existing.strip() == preflight.strip():
                    items[path.name] = {
                        "file": path.name,
                        "alias": alias,
                        "title": title,
                        "jsonSha256": digest,
                        "ingestedAt": now_iso(),
                        **({"queuedAt": previous["queuedAt"]} if previous and previous.get("queuedAt") else {}),
                    }
                    save_manifest(manifest)
                    queue_ingested(path.name, previous.get("jsonSha256") if previous else None, digest)
                    print(f"PASS: {state} (already identical) -> {alias}", flush=True)
                    created += 1
                    continue
            else:
                raise RuntimeError(f"deterministic alias collision: note {alias} is not batch-owned")

            replacements: dict[str, str] = {}
            for image_index, (image_digest, (mime, raw)) in enumerate(images.items(), 1):
                replacements[image_digest] = upload_image(alias, image_digest, mime, raw)
                print(f"MEDIA: {image_index}/{len(images)} -> {replacements[image_digest]}", flush=True)

            markdown = build_markdown(title, replace_embedded_images(document, replacements))
            if len(markdown) > MAX_NOTE_CHARS:
                raise RuntimeError("final compact note exceeded preflight size")
            status, response = request_note("PUT", f"{HEDGEDOC_NOTES_API}/{alias}", markdown)
            if status < 200 or status >= 300:
                raise RuntimeError(f"HedgeDoc PUT {alias} failed ({status}): {response[:240]}")

            items[path.name] = {
                "file": path.name,
                "alias": alias,
                "title": title,
                "jsonSha256": digest,
                "ingestedAt": now_iso(),
                **({"queuedAt": previous["queuedAt"]} if previous and previous.get("queuedAt") else {}),
            }
            save_manifest(manifest)
            queue_ingested(path.name, previous.get("jsonSha256") if previous else None, digest)
            created += 1
            print(
                f"PASS: {state} -> {alias} images={len(images)} note_chars={len(markdown)}",
                flush=True,
            )
        except Exception as error:
            failed += 1
            print(f"FAIL: {error}", flush=True)

    print(flush=True)
    print("=" * 60, flush=True)
    print("HEDGEDOC INGEST COMPLETE", flush=True)
    print(f"created/recovered = {created}", flush=True)
    print(f"skipped           = {skipped}", flush=True)
    print(f"auto-queued       = {auto_queued}", flush=True)
    print(f"failed            = {failed}", flush=True)
    print(f"manifest          = {MANIFEST_PATH}", flush=True)
    print("=" * 60, flush=True)

    return 1 if failed else 0


def main() -> int:
    # Prevent UI-triggered and post-conversion ingestion from racing.
    lock_path = MANIFEST_PATH.with_name(MANIFEST_PATH.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("ERROR: Docling HedgeDoc ingestion is already running", flush=True)
            return 2
        return ingest_all()


if __name__ == "__main__":
    sys.exit(main())
