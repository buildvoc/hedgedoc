import json, math, urllib.request
from pathlib import Path

MODEL = "nomic-embed-text"
TOP_K = 8

notes = [
    n for n in map(json.loads, Path("migration-v1/notes.jsonl").read_text().splitlines())
    if (n.get("content") or "").strip()
]

def embed(text):
    data = json.dumps({
        "model": MODEL,
        "input": text[:12000]
    }).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/embed",
        data=data,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["embeddings"][0]

def cosine(a, b):
    dot = sum(x*y for x,y in zip(a,b))
    return dot / math.sqrt(sum(x*x for x in a) * sum(y*y for y in b))

vectors = []

for i, n in enumerate(notes, 1):
    text = f"{n.get('title','')}\n\n{n['content']}"
    vectors.append(embed(text))
    print(f"[{i}/{len(notes)}] {n['shortid']}")

pairs = {}

for i, n in enumerate(notes):
    scores = sorted(
        ((cosine(vectors[i], vectors[j]), j)
         for j in range(len(notes)) if j != i),
        reverse=True
    )[:TOP_K]

    for score, j in scores:
        a, b = sorted([n["shortid"], notes[j]["shortid"]])
        pairs[(a,b)] = max(score, pairs.get((a,b), 0))

with open("memex/candidates.jsonl", "w") as f:
    for (a,b), score in sorted(pairs.items(), key=lambda x: -x[1]):
        f.write(json.dumps({
            "a": a,
            "b": b,
            "similarity": round(score, 4)
        }) + "\n")

print("\nassociations candidates:", len(pairs))
print("written: memex/candidates.jsonl")
