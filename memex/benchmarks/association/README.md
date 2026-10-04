# Memex Association Benchmarks

Annif-style benchmark storage for Memex source-association quality.

- `gold.tsv` is human-reviewed truth for one frozen snapshot.
- `results/*.tsv` stores detailed pair-level evaluator output (`--results-file`).
- `metrics/*.json` stores aggregate graph metrics (`--metrics-file`).
- `BenchmarkRuns.md` stores human-readable model/configuration metadata.

Benchmark evaluation is read-only with respect to canonical `/memex-associations`.
