# Research Horizon: Computer-Native Prompt & Context Compression
## Symbolic DSLs, Pre-Compiled KV States, and Continuous Latent "Gist" Vectors (`inputs_embeds`)

**Author**: ContextForge contributors
**Date**: October 26, 2026
**Target Repositories**: the optional latent-compression research track & `specs/contextforge-v2/05-RESEARCH-HORIZON-LATENT-AND-SYMBOLIC-COMPRESSION.md`
**Status**: Research Proposal & Feasibility Analysis

---

## 1. Problem Statement & Core Question

When an AI agent framework (like OpenClaw) builds a prompt, it represents system rules, tool contracts, and durable memories as **verbose natural-language English prose** (often 15,000–22,000 tokens before the user even speaks).

Can we convert system prompts and compiled context from human-readable English words into a **computer-native representation** to drastically reduce token count, KV-cache footprint, and prefill latency before compaction is ever needed?

To evaluate this rigorously, we separate **three distinct physical layers** of the LLM inference stack:
1. **Above the BPE Tokenizer (Discrete Token IDs):** Symbolic / Code-Native DSLs vs. the "Binary/Hex Trap".
2. **Inside the Attention Cache (Pre-Compiled KV States):** Binary KV-tensor state snapshots (`llama_state_seq_save_file`).
3. **Below the Embedding Lookup (`inputs_embeds` / Layer 0):** Continuous Latent "Gist" Vectors (10x–40x sequence compression) and their connection to shared semantic representations.

---

## 2. Layer 1 (Above the Tokenizer): Why Binary/Hex Fails and Symbolic DSLs Cut Tokens by 60–75%

### 2.1 The BPE Information-Theory Trap
A transformer never sees raw ASCII strings; its first operation is a Byte-Pair Encoding (BPE) lookup that maps common English words/subwords into 32-bit integer token IDs from a vocabulary $V$ ($|V| \approx 128,000\text{–}256,000$).
- Each discrete token ID carries $\log_2(|V|) \approx \mathbf{17\text{ to }18\text{ bits}}$ of entropy, which immediately indexes a full $d_{\text{model}}$-dimensional vector (e.g., $4096 \times 16\text{ bits} = 65,536\text{ bits}$).
- **Why raw binary/hex/base64 fails above the tokenizer:** Because BPE merges are trained on natural text and source code, arbitrary hex/base64/Huffman strings miss the multi-character vocabulary entries and shatter into 1–2 character tokens—**increasing token count by 3x–6x** while forcing early transformer layers to act as a cryptographic decoder instead of a reasoning engine.

### 2.2 The Computer-Native Solution That Works Today: **Symbolic / Code-Native DSL**
What bloats a 22,000-token system prompt is not the semantic predicates—it is **English conversational scaffolding** (articles, prepositions, polite modal verbs, and repetitive explanatory paragraphs).

Because modern LLMs are heavily pre-trained and RL-tuned on TypeScript, Rust, JSON, and formal logic, compiling prose instructions into a **Typed Symbolic DSL** achieves **50%–75% token reduction** with equal or superior instruction adherence:

| Representation | Example | Token Count (`o200k` / `gemma4`) |
| :--- | :--- | :---: |
| **Verbose English Prose** | *"Before making any edits to configuration files or system schedulers such as crontab, systemd units, nginx configs, or shell rc files, you must always inspect the existing state first and preserve or merge the existing settings by default. Never perform a whole-file replacement unless the user explicitly asks you to."* | **58 tokens** |
| **Symbolic / Code-Native DSL** | `@rule(cfg: crontab\|systemd\|nginx\|rc) => inspect() -> merge_preserve(); !replace_file(unless: explicit_user_ask)` | **21 tokens (-64%)** |

#### Why Isn't Symbolic DSL the Industry Standard for System Prompts Today?
1. **Human Authoring & Maintainability Friction:** System prompts (`AGENTS.md`, `SOUL.md`, `SKILL.md`) are written, read, and debugged by humans in Markdown. Humans think in prose, not minified DSLs.
2. **RLHF Prose Bias ("Safety & Persona Drift"):** Frontier labs (OpenAI, Anthropic, Google) do 95%+ of their instruction-following and safety alignment (RLHF/DPO) on natural English system prompts. If you convert *100%* of a system prompt into dense symbolic code, models sometimes adopt a terse, robotic "compiler output" tone in their user-facing replies unless the persona/tone section remains in natural language.
3. **Lack of a Deterministic Prompt Compiler:** Until now, agent frameworks simply concatenated raw `.md` files into the prompt instead of treating `.md` files as **source code** that gets compiled into a compact intermediate representation (IR) for smaller-window models.

**Actionable Opportunity for ContextForge:**
Keep human-authored files (`AGENTS.md`, `USER.md`, `L3` rules) in readable Markdown on disk, but add an optional **Deterministic Symbolic IR Compiler** in ContextForge that compiles operational rules and L1/L2 fact tables into compact symbolic tuples when targeting tight token budgets, while keeping `SOUL.md` (persona/voice) in natural prose so conversational warmth never degrades!

---

## 3. Layer 2 (Inside the Attention Cache): Pre-Compiled Binary KV-Cache States

On self-hosted inference engines (`llama.cpp`, `vLLM`, `SGLang`, `TensorRT-LLM`), once the system prompt and L3 permanent context are processed once, they exist in GPU memory as **Key/Value (`KV`) attention tensors**.
- Using `llama.cpp`'s native state serialization (`POST /slots/{id}?action=save` / `llama_state_seq_save_file`), ContextForge can save a **pre-compiled binary KV snapshot** per Epoch (`epoch_id.kv.bin`).
- **Benefit:** Restoring a pre-compiled KV state bypasses tokenization and transformer prefill compute (`0 ms` prompt evaluation)—loading directly into VRAM at memory-copy speed.
- **Limitation:** It eliminates *prefill compute latency*, but it still occupies $N$ token positions inside the model's context window.

---

## 4. Layer 3 (Below the Tokenizer): Continuous Latent "Gist" Vectors (`inputs_embeds`)

### 4.1 The Information-Density Breakthrough (17 Bits vs. 65,536 Bits per Position)
While a discrete token ID `input_ids[i]` can only select 1 of ~150,000 dictionary words ($\approx 17.2\text{ bits}$), the actual input to Transformer Layer 0 is a continuous vector $\mathbf{e}_i \in \mathbb{R}^{d_{\text{model}}}$ (`inputs_embeds`, e.g., $4096 \times \text{float16} = \mathbf{65,536\text{ bits}}$).

Recent literature demonstrates that a small compressor/projector can pack **4,000 to 10,000 text tokens** into **64 to 256 continuous latent "soft tokens" (gist vectors)** injected directly into `inputs_embeds`:
- **Gist Tokens** (Mu et al., Stanford): Compresses system prompts into a handful of gist activations; up to **26x compression** with minimal task loss.
- **ICAE (In-Context Autoencoder)** (Ge et al., Microsoft Research): Autoencodes long contexts into compact memory slots (4x–8x+ exact reconstruction, higher for semantic recall).
- **xRAG** (Cheng et al.): Projects entire document embeddings into **a single continuous token** in the LLM's representation space via a lightweight MLP modality bridge (exact same mathematical structure as LLaVA vision tokens!).
- **Activation Beacons / AutoCompressor** (Chevalier et al.): Compresses streaming context windows into recurrent latent summary vectors.

### 4.2 Model-Independent Representations and Projection Adapters
This latent context compression path can separate shared representations from model-specific adapters:
- Separate a **model-independent semantic bus** from **tiny model-specific projection heads**.
- In ContextForge Latent Compression:
  1. ContextForge's SQLite `L1/L2` graph (or a small frozen encoder like a 100M–300M bidirectional encoder) produces a **model-agnostic semantic representation** of a memory branch or system-prompt module.
  2. A tiny **per-model MLP Projection Adapter** ($\sim 10\text{–}30\text{ MB}$, trained via self-supervised reconstruction / distillation—just like a vision projector in `llava` / `mmproj.gguf`!) maps those semantic vectors directly into the target model's Layer-0 `inputs_embeds` space.
  3. **Result:** `llama.cpp` already supports `--mmproj` (multimodal continuous embedding injection into `llama_batch.embd`!). We can piggyback on `llama.cpp`'s existing `embd` C++ pathway—treating compressed ContextForge memory packets as "pseudo-image" continuous token embeddings—to inject 5,000 tokens of context using only **64 to 128 KV-cache positions**!

---

## 5. Platform & API Feasibility Matrix (Where Can We Inject `inputs_embeds`?)

Can we bypass the discrete tokenizer and inject continuous `inputs_embeds` or raw KV caches on **GitHub Copilot**, **Microsoft Azure AI Foundry**, or **OpenAI / Anthropic / Google APIs**?

| Platform / Deployment Tier | Can We Use Symbolic DSL (Layer 1)? | Can We Pin/Control KV Cache (Layer 2)? | Can We Inject Continuous Latent Vectors `inputs_embeds` (Layer 3)? | Technical Why |
| :--- | :---: | :---: | :---: | :--- |
| **GitHub Copilot API** | ✅ **Yes** (60–70% token reduction today) | ⚠️ Automatic prefix cache only | ❌ **No** | Copilot proxies through a strict chat-completion JSON schema (`messages: [{role, content: string}]`). Only text strings and image URLs are accepted. |
| **OpenAI / Anthropic / Google Public Serverless APIs** | ✅ **Yes** | ✅ Prefix caching (`prompt_cache_key` / `cache_control`) | ❌ **No** | Proprietary weights; exposing raw `inputs_embeds` is blocked both by their HTTP schema and because continuous embedding access allows model-inversion / safety-filter bypass attacks. |
| **Microsoft Foundry — Serverless MaaS (Pay-per-token OpenAI / Cohere / Meta endpoints)** | ✅ **Yes** | ✅ Automatic prefix caching | ❌ **No** | Managed Serverless endpoints expose the standard OpenAI `/chat/completions` or `/responses` REST contract, which requires discrete text/image inputs. |
| **Microsoft Foundry — Managed Compute / Custom Container / AKS (`vLLM` / `SGLang` / `Triton` / `HuggingFace` on Azure GPUs)** | ✅ **Yes** | ✅ **Full Control** (LMCache / KV-cache offloading / prefix pinning) | ✅ **YES!** (`prompt_embeds` in vLLM / HF pipeline) | When you deploy open-weight or custom models on **Foundry Managed Compute** (or Azure ML / AKS with `vLLM`), **you own the inference container**! `vLLM` natively supports passing `prompt_embeds` (raw PyTorch tensors) directly into `LLM.generate()` / OpenAI-compatible extensions! |
| **Local / Self-Hosted (`llama.cpp` on configured local hosts)** | ✅ **Yes** | ✅ **Full Control** (`/slots?action=save`) | ✅ **YES!** (`llama_batch.embd` / `--mmproj` pathway) | Full C++ access to `llama_decode` and `llama_batch.embd`, allowing direct injection of continuous `float32`/`float16` embedding vectors alongside normal text tokens. |

---

## 6. Proposed 3-Phase Research & Prototype Roadmap

1. **Phase R1 — Deterministic Symbolic IR Compiler (Works Everywhere Today: Copilot, Foundry Serverless, Local):**
   - Build a dual-channel prompt compiler in ContextForge:
     - **Channel A (Persona & Tone):** Kept in natural English prose (~250 tokens) so the model's conversational warmth and emotional intelligence never sound robotic.
     - **Channel B (Operational Rules, Tool Contracts & L1/L2 Memory Facts):** Compiled into a compact **Typed Symbolic IR** (`@rule`, compact tuple tables) and benchmarked head-to-head against verbose Markdown on both `Gemma 4 26B-A4B` and `cloud-model-C` for token savings vs. instruction adherence.
2. **Phase R2 — `llama.cpp` Binary KV-State Slot Persistence (Local Zero-Prefill):**
   - Wire ContextForge `epochs` to `llama-server`'s `/slots/0?action=save` and `?action=restore` endpoints so switching between conversations (e.g., Dev-Main $\leftrightarrow$ Health Journal) swaps pre-compiled binary KV states from disk in `< 1 second` instead of re-prefilling.
3. **Phase R3 — Continuous Latent Memory Cartridges (`mmproj`-style `inputs_embeds` on Local & Foundry Managed Compute):**
   - Train a lightweight **ContextForge Latent Projector** (connecting a shared representation encoder to `llama.cpp`'s `embd` / `vLLM`'s `prompt_embeds` interface) that compresses a 2,000-token L2 Wiki page into **32 continuous soft tokens**, measuring exact fact-recall fidelity vs. token compression ratio.
