import json, os, re, time, urllib.request, urllib.error
from pathlib import Path
from urllib.parse import quote

BASE  = "http://127.0.0.1:8180"
ALIAS = "memex-network"
TOKEN = os.environ["MEMEX_API_TOKEN"]

ROOT  = Path("/data/projects/hedgedoc")
ASSOC = ROOT / "memex/associations.jsonl"
NOTES = ROOT / "migration-v1/notes.jsonl"



def build():
    notes = {
        n["shortid"]: n
        for n in map(json.loads, NOTES.read_text().splitlines())
        if n.get("shortid")
    }

    links = [
        json.loads(x)
        for x in ASSOC.read_text().splitlines()
        if x.strip()
    ]

    # Select up to 300 most-connected documents, then include ALL
    # associations between those documents.
    MAX_NODES = 300

    degree = {}
    for r in links:
        degree[r["a"]] = degree.get(r["a"], 0) + 1
        degree[r["b"]] = degree.get(r["b"], 0) + 1

    selected = set(
        x for x, _ in sorted(
            degree.items(),
            key=lambda kv: (-kv[1], kv[0])
        )[:MAX_NODES]
    )

    links = [
        r for r in links
        if r["a"] in selected and r["b"] in selected
    ]

    links.sort(
        key=lambda x: x.get("confidence", 0),
        reverse=True
    )

    used = set()

    # Keep the generated HedgeDoc note safely below the 100k character limit.
    # Prefer the strongest classified associations.
    links = sorted(
        links,
        key=lambda r: float(r.get("confidence") or 0),
        reverse=True
    )[:160]

    node_names = {}
    order = []

    for r in links:
        for alias in (r["a"], r["b"]):
            if alias in node_names:
                continue
            title = notes.get(alias, {}).get("title") or alias
            title = (
                title.replace("\n", " ")
                     .replace(";", ",")
                     .replace("<", "(")
                     .replace(">", ")")
                     .strip()[:55]
            )
            node_names[alias] = f"{title} · {alias}"
            order.append(alias)

    # Memex associations are bidirectional, so expose each relation both ways.
    adjacency = {alias: [] for alias in order}

    for r in links:
        relation = str(r.get("relation", "related")).strip().lower()
        relation = re.sub(r"[^a-z0-9_]+", "_", relation).strip("_") or "related"

        a = r["a"]
        b = r["b"]

        adjacency[a].append((relation, b))
        adjacency[b].append((relation, a))

    order = list(dict.fromkeys(order))

    MAX_BODY_CHARS = 90000

    def render_network(selected_order):
        selected = set(selected_order)

        lines = [
            "---",
            "okf_type: Index",
            'title: "Memex Association Network"',
            'description: "Automatically generated bidirectional Memex network"',
            "tags:",
            "  - memex",
            "  - associations",
            "status: stable",
            "---",
            "",
            "# Memex Association Network",
            "",
            "```nodeBook",
        ]

        for alias in selected_order:
            lines.append(f"# {node_names[alias]}")
            lines.append(f"alias: {alias};")


            seen_relations = set()
            for relation, target in adjacency[alias]:
                # Never emit a relation to a node removed by the size cap.
                if target not in selected:
                    continue

                key = (relation, target)
                if key in seen_relations:
                    continue

                seen_relations.add(key)
                lines.append(f"<{relation}> {node_names[target]};")

            lines.append("")

        lines += ["```", ""]
        return "\n".join(lines)

    selected_order = list(order)
    body = render_network(selected_order)

    while len(body) > MAX_BODY_CHARS and len(selected_order) > 2:
        remove_count = max(1, len(selected_order) // 10)
        selected_order = selected_order[:-remove_count]
        body = render_network(selected_order)

    print(
        f"memex-watch: rendered {len(selected_order)}/{len(order)} nodes, "
        f"{len(body)} chars"
    )

    return body

def publish(body):
    url = f"{BASE}/api/v2/notes/{quote(ALIAS)}"
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "text/markdown"
    }

    req = urllib.request.Request(
        url, data=body.encode(), method="PUT", headers=headers
    )

    try:
        urllib.request.urlopen(req, timeout=30).read()
        print("Memex network updated")
        return
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    req = urllib.request.Request(
        url, data=body.encode(), method="POST", headers=headers
    )
    urllib.request.urlopen(req, timeout=30).read()
    print("Memex network created")

last = None

while True:
    try:
        stamp = ASSOC.stat().st_mtime_ns
        if stamp != last:
            publish(build())
            last = stamp
    except Exception as e:
        print("memex-watch:", e)

    time.sleep(5)
