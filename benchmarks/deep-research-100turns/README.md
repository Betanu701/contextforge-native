# 100-Turn Zero-Filler Single-Agent Deep Research Benchmark

One researcher, one persistent SQLite-backed session, **100 substantive analytical turns,
zero phatic/filler turns**, five interleaved research tracks (20 observations each).
No production code or existing long-horizon benchmark is changed.

## Offline first — no inference

```sh
npm run build
node benchmarks/deep-research-100turns/evaluate-offline.mjs --output /tmp/deep-research.json
node benchmarks/deep-research-100turns/evaluate-offline.mjs --turns 50 --pressure-spikes 0
node benchmarks/deep-research-100turns/evaluate-offline.mjs --pressure-spikes 5 --spike-ratio 0.92
node --experimental-strip-types --test test/deep-research-benchmark.test.ts
node --experimental-strip-types --test test/*.test.ts
```

The offline entry point imports no provider adapter and rejects `--live`, `--model`
and `--endpoint`. Automated engine tests replace `fetch` with a throwing sentinel.
No request to a provider, local inference service, hidden judge or embedding server
is needed. Everything runs against the real `ContextForgeStore`, compiler,
retrieval implementation and planner. Temporary stores are removed in `finally`.
Allow several minutes for full engine cases; the full regression suite includes
other sizeable offline pressure benchmarks as well.

## Workload and dependency chains

Every turn provides a distinct original research observation and a multi-term
analytical question. Five pre-thread baseline records make even Turn 1's request
have earlier evidence. Later questions request the preceding same-track result
and original notebook records **10, 30, 60 and 85 elapsed turns back**, where those
lags exist. These references are research notebook labels, not engine source IDs.
The current observation is supplied as pending user input; expected answers are
never appended to the request. Original raw observations, not synthetic answer
summaries, are archived before admission and compiled locally.

| Thread | Source trajectory |
| --- | --- |
| `scaling-law` | Initial MoE exponent 0.31 (2); optimizer/microbatch warmup trace (19); confounded negative ablation; attempted-token denominator repair; corrected exponent 0.22 (47); hardware roofline 200,000 tokens/s (71); finite-range synthesis. |
| `calorimetry-assay` | Twenty untared vessel/reagent/solvent readings with 18 decimal places and huge common tare; gain revision; explicitly rejected outlier filter; cumulative enthalpy and titration ledger with incompatible units kept separate. |
| `distributed-consensus` | Initial quorum-intersection lemma; native tool counterexample under asymmetric partition (9); durable two-phase promise/fence repair; reboot ablation; fixed-membership safety theorem and conditional liveness. |
| `clinical-cohort` | Thresholds plus conjunctive steroid exception; confounder adjustment; 0.82→0.91 internal assay sensitivity revision; numerical calibration memo (58); external outcome labels explicitly sealed throughout. |
| `cross-track-synthesis` | Confounder analogies, revision ancestry, rejected alternatives, exact arithmetic versus statistical uncertainty, formal assumptions, and strict abstention on unavailable outcomes. |

There are **10 independently scored multi-hop checkpoints**:

| Session turns (100-turn mode) | Focus | Required original premises |
| --- | --- | --- |
| 45 / 92 | Scaling law | 5 / 8 |
| 47 / 94 | Calorimetry ledger | 9 / 19 |
| 49 / 96 | Consensus | 7 / 10 |
| 51 / 98 | Clinical cohort | 7 / 11 |
| 53 / 100 | Cross-track synthesis | 12 / 20 |

Together these require **108 premise deliveries** (some originals intentionally
recur at several checkpoints). The last synthesis retrieves the original Turn 15
observation **85 turns later**, alongside failed and corrected router hypotheses,
heat invariants, the consensus trace/theorem and sealed-label restrictions.
Checkpoint questions name the records to compare but do not reveal their values
or expected interpretation. Thus this is a **named-reference evidence-acquisition
benchmark**, not a claim that the engine autonomously infers arbitrary unstated
semantic dependency chains. Original notebook observations are document-kind
sources keyed by those natural notebook labels; the engine's normal explicit
document-name resolution makes named records mandatory. Other candidates still
undergo ordinary lexical discovery. Checkpoint coverage therefore tests exact
named-reference admission and original provenance, not unaided search recall.

`--turns 50` is an explicitly scaled subset: retain the first 40 observations and
the final 10, retaining five tracks of 10 observations. Notebook labels preserve
full-study numbering; session numbering is remapped. Mid checkpoints occur at
31/33/35/37/39 and late checkpoints at 42/44/46/48/50. Dependencies are restricted
to observations actually retained and already seen. Only ten heat ledger steps
enter this scaled session; the independent arithmetic unit check still validates
the complete 20-step fixture. This subset does **not** claim 80+ elapsed-turn
retention or a complete in-session 20-step reconstruction. Its ten checkpoints
require 72 original premise deliveries.

## Admission budgets and pressure

Defaults:

- `--turns 100` (only 50 or 100)
- `--pressure-spikes 3` (integer 0..5)
- `--spike-tokens 150000`, or mutually exclusive `--spike-ratio 0.92`
- `--window 262144`
- `--research-budget 12000` (3000..14000; strict output verification still applies)
- `--max-output 512`, `--timeout-ms 300000`

**Budget scheduling is explicit, not a claim that unconstrained retrieval stops
at 12k by itself.** Normal substantive turns receive a 12k total-input host
admission envelope within the configured native model window; pressure turns
receive the full native-window envelope. The benchmark independently measures the
actual serialized provider-style payload, rejecting any non-spike turn above
14,000 estimated wire tokens. Early admissions may be below 3k; no filler or
artificial padding is added to meet a token floor. Smaller user-selected research budgets can fail
premise coverage; a report does not silently relax the oracle or trim the wire.

Each pressure event ingests **12 actual bulky literature/dataset sources** whose
combined original bytes are at least `spikeTokens * 3.6`. Each spike has unique
content, remains archived in SQLite through Turn 100, and must be admitted in its
entirety on the ingestion turn. Scheduling avoids synthesis-spike collisions.
The dump is passed through the planner via explicit source references only on
that turn. It is not planted in the mandatory transcript tail: it is a separate
original-source archive, with the research conversation itself committed as
native user/assistant turns. This is **not** a host-transcript-only workload.
The planner can mark a budget-limited admission `partial` when optional recall
remains; a spike still passes only when **every requested source obligation is
satisfied and 12/12 full dump bodies are actually delivered**. `partial` is not
treated as proof that a missing body was admitted.
The very next turn is another substantive research question, not “thanks”, and
must shed **100%** of the bulk source selections and payload markers. Every
non-spike turn, not just checkpoints or immediate releases, is checked for any
old pressure payload leakage. A spike cannot accidentally re-admit an older dump.

## Strict verification and interpretation

The JSON report includes configuration, fixture hashes, per-turn demand signals,
substantive-term count, optional evidence selection and expansion counts, actual
serialized wire bytes/token estimate/hash, receipt input estimate, budget,
archived pressure source count, native call/result closure, original span checks,
checkpoint coverage, pressure/release results and independently computed ledger
arithmetic. CLI exits nonzero when any mandatory criterion fails:

1. Every turn has substantive terms, `substantive_evidence_query`, and a
   non-conversational demand class.
2. All ten checkpoints deliver **every required original premise**, both in
   provenance-backed selections and in their rendered message indexes. A prior
   assistant answer cannot satisfy this predicate.
3. Normal wire payloads are <=14k estimated tokens, without pressure markers or
   pressure source selections (including secondary provenance supports);
   reservations also fit the model window.
4. Each spike delivers 12/12 complete original dump sources, >=requested wire
   tokens, without old-spike leakage; every immediate release selects zero bulk
   sources and sends zero bulk markers.
5. Genuine native tool calls/results remain paired; every stored evidence span
   validates against its original bytes.
6. The separately frozen exact-decimal oracle verifies all 20 cumulative heat
   observations and final net masses using `BigInt`, never IEEE-754 subtraction.

The cumulative heat difference is **2.345678991234567901 J**. Last reagent and
solvent net masses are **0.200000000000000020 g** and
**0.400000000000000060 g**, despite a tare above 10^12 g. These are offline
fixture/arithmetic checks, **not claims that a model computed them correctly**.

Tokens are the engine's **UTF-8/3.6 heuristic**, measured on the actual serialized
provider-style payload, not provider tokenizer counts. Live provider usage is
reported separately. Offline verification proves original evidence availability,
pressure behavior, protocol integrity and token-budget enforcement—not model
comprehension, clinical correctness, causal reasoning, theorem proving or
semantic reference resolution. Distinct but lexically overlapping research
threads are deliberately adversarial; no scoring-side source IDs or oracle
premises are supplied as planner hints.

## Opt-in live runner — do not run while another inference job owns the server

The separate adapter requires explicit consent and explicit model/endpoint; it
has no service defaults. The following is documentation only:

```sh
node benchmarks/deep-research-100turns/run-live.mjs \
  --live --endpoint https://YOUR-APPROVED-PROVIDER/v1 --model YOUR-MODEL \
  --api-key-env APPROVED_PROVIDER_KEY --max-output 2048 --turns 100 --output /tmp/deep-live.json
```

This makes exactly one completion per turn, sequentially in the same persistent
session, using the same evidence assembly as offline mode. There are no warmup,
parallel, retry, embedding or judge calls. An HTTP/provider failure stops the run.
Live checkpoint responses and conservative lexical screens are retained; they
still need human semantic/citation review and must not be presented as a proven
reasoning score. API keys are read from the named environment variable and never
written to reports.

## File boundaries and fixture custody

- `fixtures.ts`: runtime source observations, questions, schedule, baseline and
  real pressure bytes only.
- `oracles.ts`: independent checkpoint source requirements, frozen numeric values,
  exact arithmetic and post-plan coverage/response screens.
- `fixture-manifest.json`: SHA-256, byte and line counts for those two frozen files;
  checked before each run. Intentional fixture changes require updating this
  manifest together with review of both runtime and scoring changes.
- `runner.ts`: real offline engine admission and report generation; optional
  injected dispatch hook, no provider imports or network implementation.
- `evaluate-offline.mjs`: offline-only entry point.
- `run-live.mjs` / `live-runner.ts`: opt-in gate and isolated sequential provider adapter.
- `test/deep-research-benchmark.test.ts`: static custody/leakage checks, negative
  oracle control, arithmetic/protocol tests and fetch-forbidden engine runs for
  default 100-turn pressure, 50-turn no-pressure and 50-turn 92%-window pressure.
