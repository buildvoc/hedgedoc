import json
import re
import urllib.request
from pathlib import Path

OLLAMA = "http://192.168.1.99:11434"
MODELS = [
    "gemma4:26b",
    "nemotron-cascade-2:30b-a3b-q4_K_M",
]

ROOT = Path("/data/projects/hedgedoc")
NOTES = ROOT / "migration-v1/notes.jsonl"
ASSOC = ROOT / "memex/associations.jsonl"


def load_notes():
    out = {}
    with NOTES.open(encoding="utf-8") as f:
        for line in f:
            n = json.loads(line)
            alias = (
                n.get("alias")
                or n.get("shortid")
                or n.get("shortId")
                or n.get("id")
            )
            if not alias:
                continue

            content = n.get("content") or n.get("text") or ""
            title = n.get("title") or ""

            if not title:
                m = re.search(r"(?m)^#\s+(.+)$", content)
                title = m.group(1).strip() if m else alias

            out[str(alias)] = {
                "alias": str(alias),
                "title": title[:120],
                "content": content,
            }
    return out


def choose_30(notes):
    edges = []
    with ASSOC.open(encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if not r.get("keep"):
                continue
            if r.get("a") not in notes or r.get("b") not in notes:
                continue
            edges.append(r)

    edges.sort(
        key=lambda r: (
            float(r.get("confidence", 0)),
            float(r.get("similarity", 0)),
        ),
        reverse=True,
    )

    selected = []
    seen = set()

    if edges:
        for alias in (edges[0]["a"], edges[0]["b"]):
            selected.append(alias)
            seen.add(alias)

    while len(selected) < 30:
        candidate = None

        for r in edges:
            a, b = r["a"], r["b"]
            if a in seen and b not in seen:
                candidate = b
                break
            if b in seen and a not in seen:
                candidate = a
                break

        if candidate is None:
            for r in edges:
                for alias in (r["a"], r["b"]):
                    if alias not in seen:
                        candidate = alias
                        break
                if candidate:
                    break

        if candidate is None:
            break

        seen.add(candidate)
        selected.append(candidate)

    return selected[:30]


def ask(model, docs):
    compact = []
    for n in docs:
        text = re.sub(r"\s+", " ", n["content"]).strip()
        compact.append(
            {
                "alias": n["alias"],
                "title": n["title"],
                "excerpt": text[:1400],
            }
        )

    prompt = f"""
You are discovering Memex trails from 30 HedgeDoc notes.

A TRAIL is not merely a topic cluster.
It is a named, coherent path/subgraph through related notes.
Associations are bidirectional.
A note may belong to multiple trails.

Find 3 to 8 useful trails.

Requirements:
- use ONLY aliases supplied below
- each trail should contain 3 to 12 notes
- order aliases into a plausible reading/reasoning path
- give each trail a concise meaningful name
- prefer trails that connect concepts, evidence, implementation, or progression
- overlap between trails is allowed
- do not invent aliases
- avoid weak generic groupings

Return JSON only:

{{
  "trails": [
    {{
      "name": "...",
      "aliases": ["...", "..."],
      "reason": "...",
      "confidence": 0.0
    }}
  ]
}}

NOTES:
{json.dumps(compact, ensure_ascii=False)}
"""

    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "format": "json",
            "options": {
                "temperature": 0.15,
                "num_ctx": 32768,
            },
        }
    ).encode()

    req = urllib.request.Request(
        f"{OLLAMA}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=900) as r:
        response = json.loads(r.read())

    return response["message"]["content"]


notes = load_notes()
aliases = choose_30(notes)
docs = [notes[a] for a in aliases]

print(f"Testing {len(docs)} notes")
print("aliases:", ", ".join(aliases))

for model in MODELS:
    print(f"\n=== {model} ===")

    try:
        raw = ask(model, docs)
        result = json.loads(raw)

        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", model)
        path = ROOT / "memex" / f"trail-test-30-{safe}.json"
        path.write_text(
            json.dumps(result, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        trails = result.get("trails", [])
        print(f"trails: {len(trails)}")
        for t in trails:
            print(
                f"- {t.get('name')}: "
                f"{len(t.get('aliases', []))} notes "
                f"(confidence {t.get('confidence')})"
            )

        print("saved:", path)

    except Exception as e:
        print("ERROR:", e)
