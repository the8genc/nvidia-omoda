<!-- Concern: orient a newcomer to the repo — what it is, where things live, how it runs | Non-concern: the experiment design (ROADMAP.md) or the reviewer wording (neutral-reviewer.md) | IO: none -->

# hackathon — privacy-preserving real-time digital twin

Turn a static CCTV feed into a continuous, temporally-stable, semantically-labeled 3D representation
that carries no PII, fully local on an NVIDIA DGX Spark (GB10). See `ROADMAP.md` for the bet, the
ratchet, the goals, and the gate criteria.

**Topology.** Author + git + gates here (this laptop); execute on the DGX (`gn100` / `acer01`) via
`rsync`; models run in a container derived from the on-box `nvcr.io/nvidia/vllm` image (Blackwell
torch). Results flow back and commit here as proof artifacts.

**Layout.**
- `ROADMAP.md` — the plan, goals, gate criteria
- `neutral-reviewer.md` — the frozen blind-reviewer prompt (the semantic gate)
- `gates/` — pre-registered intents per stage, written before any artifact exists
- DGX `/home/acer01/hackathon/` — frames, env (Dockerfile), results
