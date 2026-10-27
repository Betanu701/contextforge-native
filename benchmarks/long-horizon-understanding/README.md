# Long-Horizon Deep Understanding & Compaction Stress Benchmark

A deterministic **SQLite → compiler → planner → actual provider-wire** verifier plus an opt-in sequential model runner. Offline success measures source-premise delivery, not model comprehension. No inference is needed to run tests.

## Quick start (Node 24)

```sh
npm run build
node benchmarks/long-horizon-understanding/evaluate-offline.mjs --turns 50 --pressure-spikes 3 --spike-tokens 150000 --output long-50.json
node benchmarks/long-horizon-understanding/evaluate-offline.mjs --preset stress-max --turns 100 --pressure-spikes 5 --output long-100.json
node --experimental-strip-types --test test/long-horizon-benchmark.test.ts
# Local physical windows: the pressure lever scales to W, never pretends 150k fits 32k.
node benchmarks/long-horizon-understanding/evaluate-offline.mjs --window 32768 --spike-ratio 0.92 --max-output 384 --output long-local.json
```

The full offline matrix is **50/100 turns × 3/5 spikes**, each requesting **150,000 heuristic text tokens**. Each spike attaches twelve real telemetry documents (540,000+ bytes), selects every document and verifies the actual serialized wire exceeds the requested tranche. The **immediate next turn** carries ordinary 2k–10k working input, has zero selected pressure sources and no pressure marker leakage. Sources remain active: no deletion, withdrawal, artificial receipt charges or permanent-context answer injection is used. Repeated spikes reuse immutable identical payload sources to bound fixture compilation cost; the full bytes are still hydrated afresh at each spike. Large payload tests take tens of seconds per configuration, depending on disk/CPU; targeted CLI/fixture tests are fast.

Options: `--turns 50|100`, `--pressure-spikes 0..5`, `--spike-tokens N` **or** `--spike-ratio 0<R<1`, `--window W`, `--max-output N`, `--timeout-ms N`, `--preset NAME`, `--output FILE`. Invalid windows/reservations fail closed. Model-specific tokenizers may need smaller payload ratios: final provider admission is mandatory.

## Five scenario tracks

Runtime fixtures (`fixtures.ts`) and scoring/oracles (`oracles.ts`) are separate, versioned and SHA-256 frozen by `fixture-manifest.json`. Production code contains no fixture names/answers. Questions receive no oracle IDs or forced premise lists. Raw authoritative observations are archived and also committed as original host turns; assistant answers are not authoritative.

1. **Architecture evolution:** Plan A proposed, early native load-test output finds duplicate commits on stale-writer reconnect; Plan B adds a temporary epoch fence. At turn 65 (100-turn schedule), only steady-state fences are removed. A late proposed reconnect-fence removal must be evaluated against the empirical failure more than 50 turns earlier. Required: all four original evolution premises, not merely the latest config.
2. **Prudential constraint in a novel situation:** early Tuesday restricted interval, a conjunctive exception (all three replicas current and below 70C), plus an outside-interval majority rule. The late question supplies Tuesday 20:15, 66C, two replicas current and one behind, then asks what changes if the third catches up—without repeating the rule keywords.
3. **Three-hop debugging:** early original ECONNREFUSED/health trace, middle native deployment PNG, and configuration specification 33 turns after the image. Synthesize endpoint mismatch → effective listener → override precedence; give port 8120 and timeout 900, narrowly correct the stale 8119/120 override, restart and verify. Native multi-step call/result sequences include log inspection and test/config-diff/EXPLAIN results.
4. **High-interference same-entity drift:** 27 cumulative Orion meter observations interleaved with spikes, rejected retry RFC, superseded batch configuration, and natural-prose untared scale readings. Reconstruct active config and exact meter differences, plus resin 425.25 and solvent 257.5 g without summing cumulative readings. Compiler arithmetic uses BigInt exact decimals; separate numeric and unit output fields are requested.
5. **Calibrated abstention:** dense sibling cluster metrics provide tempting east/west settings. North remains unprovisioned, planned timeout known but quorum explicitly undecided. After turn 80 (100-turn schedule), report the unknown quorum rather than copy a sibling. The 50-turn schedule is scaled and does not claim an 80-turn interval.

The five late checkpoints require **41 exact original-source premises** (4 + 2 + 3 + 30 + 2). The verifier requires real selected original span IDs, exact original text in rendered messages, source trust, no unrelated pressure payload, physical envelope accounting and tool protocol closure. It verifies source spans through the store's hash-checking API. These are premise-availability tests, not proof of correct model reasoning.

## Images and agentic protocol

A deterministic real raster PNG encodes `EDGE:8120` and `RUN:8119`; native models receive a PNG base64 data URL via `image_url`, with an explicit **765-token heuristic media charge**. Paired source-backed caption and OCR artifacts permit text-only fallback. Native image delivery and fallback are reported distinctly; OCR is not claimed to be vision. The original image is attached at the middle episode and debug checkpoint. Original historical tool calls/results retain protocol closure; late tool evidence is quoted as evidence rather than forged as newly executed calls. Additional call/result pairs exercise config diff, database EXPLAIN and test output surfaces.

## Live execution: explicit authorization only

| Preset | Turns | Spikes | Window | Max output |
|---|---:|---:|---:|---:|
| `local-sequential` | 50 | 4 × 150k | 262144 | 512 |
| `cloud-economical` | 100 | 3 × 150k | 262144 | 384 |
| `stress-max` | 100 | 5 × 150k | 922000 | 768 |

These are resource presets, not measured provider/model claims. Select a smaller window and `--spike-ratio 0.92` for 32k/65k local models. No discovery, warmup, retries, parallel inference, hidden judge or paid provider is implicit.

```sh
# Inference ONLY when separately authorized:
node benchmarks/long-horizon-understanding/run-live.mjs --preset local-sequential --endpoint http://127.0.0.1:8080/v1 --model YOUR_MODEL_ID --output live.json
node benchmarks/long-horizon-understanding/run-live.mjs --preset cloud-economical --models models.json --output live-models.json
```

Model file: `[ {"model":"YOUR_MODEL_ID","endpoint":"https://YOUR_APPROVED_PROVIDER/v1","window":262144,"image":true,"apiKeyEnv":"BENCHMARK_API_KEY"} ]`. Use `image:false` for text-only OCR fallback. Compatible local and cloud text/image chat APIs are supported; provider-specific APIs need a transport adapter. Models and turns run strictly sequentially. Credentials are environment-only and never written in reports. HTTP errors stop without retry/spend and retain completed-turn results.

Reports record exact wire byte counts/SHA-256, heuristic text and media charges, admission disposition, original span checks, spike/release events, live usage/latency and actual responses. Text tokens use UTF-8 bytes / 3.6 over actual serialized text, **not an exact provider tokenizer**. Offline 150k is a real 150k+ estimated-wire tranche, not an asserted provider billing count. Live responses receive a conservative lexical screen; causality, exact math, abstention and citations require human review. A passing lexical screen is not a semantic understanding score. No live model inference was performed for this implementation.
