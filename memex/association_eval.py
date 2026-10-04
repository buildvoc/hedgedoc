#!/usr/bin/env python3
"""Evaluate Memex source associations using an Annif-style results/metrics split.

This tool is intentionally read-only with respect to canonical Memex associations.
It reads a frozen HedgeDoc snapshot revision, evaluates a deterministic pair set,
then writes detailed TSV results plus aggregate JSON metrics. Full mode evaluates every
unordered pair; quick mode evaluates a repeatable balanced screening sample.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HEDGEDOC_NOTES_API = os.environ.get(
    "HEDGEDOC_NOTES_API", "http://127.0.0.1:3100/api/v2/notes"
).rstrip("/")
DEFAULT_SETTINGS_PATH = Path(
    os.environ.get(
        "MEMEX_MODEL_SETTINGS_PATH",
        "/data/projects/hedgedoc/memex/model-settings.json",
    )
)
DEFAULT_RUNS_MD = Path(
    os.environ.get(
        "MEMEX_BENCHMARK_RUNS_PATH",
        "/data/projects/hedgedoc/memex/benchmarks/association/BenchmarkRuns.md",
    )
)
SNAPSHOTS_ALIAS = "memex-snapshots"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def load_memex_token() -> str:
    for env_path in (
        Path("/data/projects/hedgedoc/.env.memex"),
        Path("/data/projects/hedgedoc/.env"),
    ):
        load_env_file(env_path)
    token = os.environ.get("MEMEX_API_TOKEN", "").strip()
    if not token:
        raise RuntimeError("MEMEX_API_TOKEN is not configured")
    return token


def http_json(url: str, *, token: str | None = None, timeout: int = 30) -> Any:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"HTTP {exc.code} for {url}: {body}") from exc


def http_post_json(url: str, payload: dict[str, Any], timeout: int) -> Any:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Ollama HTTP {exc.code}: {body}") from exc


def read_settings(path: Path) -> dict[str, Any]:
    settings = json.loads(path.read_text(encoding="utf-8"))
    settings.setdefault("baseUrl", "http://192.168.1.99:11434")
    settings.setdefault("defaultModel", "gemma4:12b")
    settings.setdefault("associationModel", settings["defaultModel"])
    settings.setdefault("numCtx", 65536)
    settings.setdefault("maxPromptChars", 80000)
    settings.setdefault("timeoutSeconds", 600)
    settings.setdefault("temperature", 0.35)
    settings.setdefault("associationMinConfidence", 0.85)
    return settings


def latest_revision_id(alias: str, token: str) -> str:
    rows = http_json(
        f"{HEDGEDOC_NOTES_API}/{urllib.parse.quote(alias, safe='')}/revisions",
        token=token,
    )
    if not isinstance(rows, list) or not rows:
        raise RuntimeError(f"No HedgeDoc revisions found for {alias}")
    rows = sorted(rows, key=lambda row: row.get("createdAt", ""), reverse=True)
    revision = rows[0].get("uuid")
    if not revision:
        raise RuntimeError(f"Latest revision for {alias} has no uuid")
    return str(revision)


def fetch_revision(alias: str, revision_id: str, token: str) -> dict[str, Any]:
    url = (
        f"{HEDGEDOC_NOTES_API}/{urllib.parse.quote(alias, safe='')}/revisions/"
        f"{urllib.parse.quote(revision_id, safe='')}"
    )
    row = http_json(url, token=token)
    if not isinstance(row, dict) or not isinstance(row.get("content"), str):
        raise RuntimeError(f"Revision {revision_id} for {alias} has no content")
    return row


def parse_snapshot_manifest(content: str) -> dict[str, Any]:
    match = re.search(r"## Source Manifest\s*```json\s*(\{[\s\S]*?\})\s*```", content)
    if not match:
        raise RuntimeError("Snapshot revision does not contain a Source Manifest JSON block")
    manifest = json.loads(match.group(1))
    sources = manifest.get("sources")
    if not isinstance(sources, list) or len(sources) < 2:
        raise RuntimeError("Snapshot manifest contains fewer than two sources")
    return manifest


def load_snapshot(snapshot_revision: str, token: str) -> tuple[str, dict[str, Any], list[dict[str, str]]]:
    resolved = (
        latest_revision_id(SNAPSHOTS_ALIAS, token)
        if snapshot_revision == "latest"
        else snapshot_revision
    )
    snapshot = fetch_revision(SNAPSHOTS_ALIAS, resolved, token)
    manifest = parse_snapshot_manifest(snapshot["content"])
    sources: list[dict[str, str]] = []
    for item in manifest["sources"]:
        alias = str(item.get("alias", "")).strip()
        title = str(item.get("title", alias)).strip()
        revision_id = str(item.get("revisionId", "")).strip()
        if not alias or not revision_id:
            raise RuntimeError("Snapshot source is missing alias or revisionId")
        revision = fetch_revision(alias, revision_id, token)
        sources.append(
            {
                "alias": alias,
                "title": title or alias,
                "revisionId": revision_id,
                "content": revision["content"],
            }
        )
    return resolved, manifest, sources


def pair_key(left: str, right: str) -> tuple[str, str]:
    return tuple(sorted((left, right)))  # type: ignore[return-value]


def write_gold_template(path: Path, sources: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "source",
                "target",
                "gold_associated",
                "gold_strength",
                "gold_reason",
                "reviewed_by",
                "reviewed_at",
            ],
            delimiter="\t",
        )
        writer.writeheader()
        for left, right in itertools.combinations(sources, 2):
            writer.writerow(
                {
                    "source": left["alias"],
                    "target": right["alias"],
                    "gold_associated": "",
                    "gold_strength": "",
                    "gold_reason": "",
                    "reviewed_by": "",
                    "reviewed_at": "",
                }
            )


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"true", "1", "yes", "y"}:
        return True
    if normalized in {"false", "0", "no", "n"}:
        return False
    raise ValueError(f"Invalid boolean gold_associated value: {value!r}")


def load_gold(path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    result: dict[tuple[str, str], dict[str, Any]] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for row in reader:
            source = (row.get("source") or "").strip()
            target = (row.get("target") or "").strip()
            if not source or not target:
                continue
            result[pair_key(source, target)] = {
                **row,
                "gold_associated": parse_bool(row.get("gold_associated") or ""),
            }
    return result


def truncate_pair(left: str, right: str, max_prompt_chars: int) -> tuple[str, str]:
    allowance = max(1000, (max_prompt_chars - 6000) // 2)
    return left[:allowance], right[:allowance]


def parse_model_json(text: str) -> dict[str, Any]:
    start = text.find("{")
    if start < 0:
        raise RuntimeError("Model response contains no JSON object")
    decoder = json.JSONDecoder()
    value, _ = decoder.raw_decode(text[start:])
    if not isinstance(value, dict):
        raise RuntimeError("Model response JSON is not an object")
    return value


def ollama_classify(
    *,
    base_url: str,
    model: str,
    prompt: str,
    num_ctx: int,
    temperature: float,
    timeout_seconds: int,
    decision_key: str,
) -> tuple[bool, float, str]:
    payload = {
        "model": model,
        "stream": False,
        "format": "json",
        "messages": [{"role": "user", "content": prompt}],
        "options": {"num_ctx": num_ctx, "temperature": temperature},
    }
    response = http_post_json(f"{base_url.rstrip('/')}/api/chat", payload, timeout_seconds)
    message = response.get("message") if isinstance(response, dict) else None
    text = message.get("content", "") if isinstance(message, dict) else ""
    parsed = parse_model_json(str(text))
    decision = bool(parsed.get(decision_key, False))
    try:
        confidence = max(0.0, min(1.0, float(parsed.get("confidence", 0.0))))
    except (TypeError, ValueError):
        confidence = 0.0
    reason = str(parsed.get("reason", "")).strip()[:2000]
    return decision, confidence, reason


def candidate_prompt(left: dict[str, str], right: dict[str, str], max_chars: int) -> str:
    a, b = truncate_pair(left["content"], right["content"], max_chars)
    return f"""You are the candidate stage of a Memex source-association evaluator.
Decide whether this pair contains a direct, evidence-backed relationship worth sending to a strict verifier.
Shared topic, geography, chronology, vocabulary, or membership in the same trail is not sufficient by itself.
Return JSON only: {{\"candidate\": true|false, \"confidence\": 0..1, \"reason\": \"one concise factual sentence\"}}.

SOURCE A: {left['title']} ({left['alias']})
---
{a}

SOURCE B: {right['title']} ({right['alias']})
---
{b}
"""


def verifier_prompt(left: dict[str, str], right: dict[str, str], max_chars: int) -> str:
    a, b = truncate_pair(left["content"], right["content"], max_chars)
    return f"""You are the strict verifier for Memex source associations.
Return associated=true only when the two source documents contain a direct relationship supported by evidence in the documents.
Reject broad topical similarity, shared trail membership, geography alone, chronology alone, keyword overlap, or speculative relationships.
It is valid and preferable to return no association when evidence is insufficient.
Return JSON only: {{\"associated\": true|false, \"confidence\": 0..1, \"reason\": \"one concise factual sentence citing the relationship or why it is insufficient\"}}.

SOURCE A: {left['title']} ({left['alias']})
---
{a}

SOURCE B: {right['title']} ({right['alias']})
---
{b}
"""


def outcome(gold: bool, predicted: bool) -> str:
    if gold and predicted:
        return "true_positive"
    if not gold and not predicted:
        return "true_negative"
    if not gold and predicted:
        return "false_positive"
    return "false_negative"


def safe_div(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def append_run_markdown(path: Path, metrics: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("# Memex Association Benchmark Runs\n\n", encoding="utf-8")
    block = f"""\n## {metrics['Run']}\n\nCandidate Model = {metrics['Candidate_model']}
Verifier Model = {metrics['Verifier_model']}
Date = {metrics['Created_at']}
Snapshot = {metrics['Snapshot_name']}
Snapshot Revision = {metrics['Snapshot_revision']}
Mode = {metrics['Mode']}
Context Size = {metrics['Context_size']}
Temperature = {metrics['Temperature']}
Confidence Threshold = {metrics['Confidence_threshold']}
Prompt Version = {metrics['Prompt_version']}
KV Cache = {metrics.get('KV_cache_type', 'unknown')}
Flash Attention Profile = {metrics.get('Flash_attention', 'unknown')}
Comments =\n"""
    with path.open("a", encoding="utf-8") as handle:
        handle.write(block)


def run(args: argparse.Namespace) -> int:
    token = load_memex_token()
    settings = read_settings(Path(args.settings_file))
    resolved_revision, manifest, sources = load_snapshot(args.snapshot_revision, token)

    if args.init_gold:
        target = Path(args.init_gold)
        write_gold_template(target, sources)
        print(f"Created gold template with {len(sources) * (len(sources) - 1) // 2} pairs: {target}")
        print(f"Snapshot revision: {resolved_revision}")
        return 0

    if not args.gold_file or not args.results_file or not args.metrics_file:
        raise RuntimeError("--gold-file, --results-file and --metrics-file are required for evaluation")

    gold = load_gold(Path(args.gold_file))
    expected_pairs = {pair_key(a["alias"], b["alias"]) for a, b in itertools.combinations(sources, 2)}
    missing = sorted(expected_pairs - set(gold))
    extra = sorted(set(gold) - expected_pairs)
    if missing:
        raise RuntimeError(f"Gold file is missing {len(missing)} snapshot pairs; first: {missing[0]}")
    if extra:
        raise RuntimeError(f"Gold file contains {len(extra)} pairs not in snapshot; first: {extra[0]}")

    candidate_model = args.candidate_model or settings["defaultModel"]
    verifier_model = args.verifier_model or settings["associationModel"]
    base_url = settings["baseUrl"]
    num_ctx = args.num_ctx or int(settings["numCtx"])
    temperature = settings["temperature"] if args.temperature is None else args.temperature
    threshold = (
        settings["associationMinConfidence"]
        if args.confidence_threshold is None
        else args.confidence_threshold
    )
    max_prompt_chars = int(settings["maxPromptChars"])
    timeout_seconds = int(settings["timeoutSeconds"])
    run_id = args.run_id or datetime.now().strftime("%Y%m%d-%H%M%S")

    all_pairs = list(itertools.combinations(sources, 2))

    def stable_pair_rank(pair: tuple[dict[str, str], dict[str, str]]) -> str:
        left, right = pair
        key = pair_key(left["alias"], right["alias"])
        return hashlib.sha256(f"{resolved_revision}\0{key}".encode("utf-8")).hexdigest()

    max_pairs = max(0, int(args.max_pairs or 0))
    evaluation_scope = "full"
    selected_pairs = all_pairs
    if max_pairs and max_pairs < len(all_pairs):
        evaluation_scope = "quick"
        positives = [
            pair for pair in all_pairs
            if bool(gold[pair_key(pair[0]["alias"], pair[1]["alias"])]["gold_associated"])
        ]
        negatives = [
            pair for pair in all_pairs
            if not bool(gold[pair_key(pair[0]["alias"], pair[1]["alias"])]["gold_associated"])
        ]
        positives.sort(key=stable_pair_rank)
        negatives.sort(key=stable_pair_rank)

        positive_target = min(len(positives), max_pairs // 2)
        negative_target = min(len(negatives), max_pairs - positive_target)
        remaining = max_pairs - positive_target - negative_target
        if remaining:
            extra_positives = min(len(positives) - positive_target, remaining)
            positive_target += extra_positives
            remaining -= extra_positives
        if remaining:
            negative_target += min(len(negatives) - negative_target, remaining)

        selected_pairs = positives[:positive_target] + negatives[:negative_target]
        selected_pairs.sort(key=stable_pair_rank)

    rows: list[dict[str, Any]] = []
    started = time.monotonic()

    for index, (left, right) in enumerate(selected_pairs, start=1):
        pair_started = time.monotonic()
        gold_row = gold[pair_key(left["alias"], right["alias"])]
        candidate_found = True
        candidate_confidence = 1.0
        candidate_reason = "Verifier-only exhaustive pair evaluation."

        if args.mode == "pipeline":
            candidate_found, candidate_confidence, candidate_reason = ollama_classify(
                base_url=base_url,
                model=candidate_model,
                prompt=candidate_prompt(left, right, max_prompt_chars),
                num_ctx=num_ctx,
                temperature=temperature,
                timeout_seconds=timeout_seconds,
                decision_key="candidate",
            )

        verifier_associated = False
        verifier_confidence = 0.0
        verifier_reason = "Candidate stage rejected this pair."
        if candidate_found:
            verifier_associated, verifier_confidence, verifier_reason = ollama_classify(
                base_url=base_url,
                model=verifier_model,
                prompt=verifier_prompt(left, right, max_prompt_chars),
                num_ctx=num_ctx,
                temperature=temperature,
                timeout_seconds=timeout_seconds,
                decision_key="associated",
            )

        # Benchmark model quality from its explicit associated=true/false decision.
        # Confidence remains diagnostic; applying the production confidence threshold here
        # can turn otherwise-correct model decisions into false negatives and obscure
        # model comparison. Keep the thresholded decision alongside the direct score.
        thresholded_predicted = bool(verifier_associated and verifier_confidence >= threshold)
        predicted = bool(verifier_associated)
        gold_associated = bool(gold_row["gold_associated"])
        result = outcome(gold_associated, predicted)
        thresholded_result = outcome(gold_associated, thresholded_predicted)
        elapsed_ms = int((time.monotonic() - pair_started) * 1000)

        rows.append(
            {
                "source": left["alias"],
                "source_title": left["title"],
                "target": right["alias"],
                "target_title": right["title"],
                "gold_associated": str(gold_associated).lower(),
                "gold_strength": gold_row.get("gold_strength", ""),
                "gold_reason": gold_row.get("gold_reason", ""),
                "candidate_found": str(candidate_found).lower(),
                "candidate_confidence": f"{candidate_confidence:.6f}",
                "candidate_reason": candidate_reason,
                "verifier_associated": str(verifier_associated).lower(),
                "verifier_confidence": f"{verifier_confidence:.6f}",
                "confidence_threshold": f"{threshold:.6f}",
                "predicted_associated": str(predicted).lower(),
                "outcome": result,
                "thresholded_predicted_associated": str(thresholded_predicted).lower(),
                "thresholded_outcome": thresholded_result,
                "reason": verifier_reason,
                "human_decision": "",
                "elapsed_ms": elapsed_ms,
            }
        )
        print(f"[{index}/{len(selected_pairs)}] {left['alias']} <-> {right['alias']}: {result}")

    results_path = Path(args.results_file)
    results_path.parent.mkdir(parents=True, exist_ok=True)
    with results_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()), delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)

    counts = {name: sum(row["outcome"] == name for row in rows) for name in (
        "true_positive", "true_negative", "false_positive", "false_negative"
    )}
    tp = counts["true_positive"]
    tn = counts["true_negative"]
    fp = counts["false_positive"]
    fn = counts["false_negative"]
    precision = safe_div(tp, tp + fp)
    recall = safe_div(tp, tp + fn)
    f1 = safe_div(2 * precision * recall, precision + recall)
    specificity = safe_div(tn, tn + fp)
    fpr = safe_div(fp, fp + tn)
    candidate_gold = sum(1 for row in rows if row["gold_associated"] == "true")
    candidate_found_gold = sum(
        1 for row in rows if row["gold_associated"] == "true" and row["candidate_found"] == "true"
    )
    correct_conf = [float(row["verifier_confidence"]) for row in rows if row["outcome"] in {"true_positive", "true_negative"}]
    wrong_conf = [float(row["verifier_confidence"]) for row in rows if row["outcome"] in {"false_positive", "false_negative"}]

    metrics = {
        "Run": run_id,
        "Created_at": utc_now(),
        "Snapshot_name": manifest.get("name", "unknown"),
        "Snapshot_revision": resolved_revision,
        "Snapshot_source_count": len(sources),
        "Candidate_model": candidate_model,
        "Verifier_model": verifier_model,
        "Mode": args.mode,
        "Prompt_version": args.prompt_version,
        "Scoring_method": "model-decision",
        "Context_size": num_ctx,
        "Temperature": temperature,
        "Confidence_threshold": threshold,
        "KV_cache_type": settings.get("ollamaKvCacheType", "unknown"),
        "Flash_attention": settings.get("ollamaFlashAttention", "unknown"),
        "Precision_assoc_avg": precision,
        "Recall_assoc_avg": recall,
        "F1_score_assoc_avg": f1,
        "Specificity_assoc_avg": specificity,
        "False_positive_rate": fpr,
        "Candidate_recall": safe_div(candidate_found_gold, candidate_gold),
        "True_positives": tp,
        "True_negatives": tn,
        "False_positives": fp,
        "False_negatives": fn,
        "Evaluation_scope": evaluation_scope,
        "Pairs_total": len(all_pairs),
        "Pairs_evaluated": len(rows),
        "Average_confidence_correct": safe_div(sum(correct_conf), len(correct_conf)),
        "Average_confidence_wrong": safe_div(sum(wrong_conf), len(wrong_conf)),
        "Elapsed_seconds": round(time.monotonic() - started, 3),
        "Results_file": str(results_path),
    }

    metrics_path = Path(args.metrics_file)
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    append_run_markdown(Path(args.runs_markdown), metrics)

    print(json.dumps({
        "run": run_id,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "falsePositives": fp,
        "falseNegatives": fn,
        "scope": evaluation_scope,
        "pairs": len(rows),
        "pairsTotal": len(all_pairs),
        "resultsFile": str(results_path),
        "metricsFile": str(metrics_path),
    }, indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--snapshot-revision", default="latest", help="HedgeDoc revision UUID or 'latest'")
    ap.add_argument("--init-gold", help="Write a blank TSV gold template for the snapshot and exit")
    ap.add_argument("--gold-file")
    ap.add_argument("--results-file")
    ap.add_argument("--metrics-file")
    ap.add_argument("--runs-markdown", default=str(DEFAULT_RUNS_MD))
    ap.add_argument("--settings-file", default=str(DEFAULT_SETTINGS_PATH))
    ap.add_argument("--candidate-model")
    ap.add_argument("--verifier-model")
    ap.add_argument("--mode", choices=("verifier", "pipeline"), default="verifier")
    ap.add_argument("--run-id")
    ap.add_argument("--num-ctx", type=int)
    ap.add_argument("--temperature", type=float)
    ap.add_argument("--confidence-threshold", type=float)
    ap.add_argument("--max-pairs", type=int, default=0, help="Deterministic quick sample size; 0 evaluates all pairs")
    ap.add_argument("--prompt-version", default="association-benchmark-v1")
    return ap


if __name__ == "__main__":
    try:
        raise SystemExit(run(parser().parse_args()))
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
