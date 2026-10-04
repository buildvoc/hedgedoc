import json, urllib.request
from pathlib import Path

MODEL = "gemma4:12b"
LIMIT = 300

notes = {
    n["shortid"]: n
    for n in map(json.loads, Path("migration-v1/notes.jsonl").read_text().splitlines())
}

candidates = [
    json.loads(x)
    for x in Path("memex/candidates.jsonl").read_text().splitlines()
][:LIMIT]

out = Path("memex/associations.jsonl")

for i, c in enumerate(candidates, 1):
    a, b = notes[c["a"]], notes[c["b"]]

    prompt = f"""
Evaluate whether these two notes have a meaningful MEMEX association.

The association is BIDIRECTIONAL: A <-> B.

Return JSON only:
{{
  "keep": true,
  "relation": "related|overlaps|complements|contrasts|same_topic|shared_context",
  "reason": "short explanation",
  "confidence": 0.0
}}

Reject superficial keyword similarity.

NOTE A
Title: {a.get("title","")}
Content:
{(a.get("content") or "")[:5000]}

NOTE B
Title: {b.get("title","")}
Content:
{(b.get("content") or "")[:5000]}
"""

    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/chat",
        data=json.dumps({
            "model": MODEL,
            "stream": False,
            "format": "json",
            "messages": [{"role": "user", "content": prompt}]
        }).encode(),
        headers={"Content-Type": "application/json"}
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            result = json.loads(json.load(r)["message"]["content"])

        if result.get("keep"):
            record = {
                "a": c["a"],
                "b": c["b"],
                "similarity": c["similarity"],
                **result
            }
            with out.open("a") as f:
                f.write(json.dumps(record) + "\n")

        print(f"[{i}/{len(candidates)}] {'KEEP' if result.get('keep') else 'DROP'} {c['a']} <-> {c['b']}")

    except Exception as e:
        print("ERROR", c["a"], c["b"], e)

print("\nwritten:", out)
