# Build plan: the v4 scope, against the freeze

**Now:** Saturday 18:18. **Hard stop tonight:** 20:00. **Code freeze and Airtable
submission:** Sunday 11:00. Judging 11:30. That is roughly 1.5 working hours
tonight and 3.5 tomorrow morning, minus the demo video, which is not optional.

Requirements are §23 of the PRD. The ordering rule: everything that lands must be
demonstrable on the box, and the demo video outranks any feature not yet started
by 09:30 Sunday.

## Tonight, by 20:00 (P0: the contracts)

Small, testable, and they unblock everything Sunday.

1. **`level` in the skill manifest, structurally enforced.** Schema accepts
   `level: 0..3` (default 2, today's behaviour). The loader injects by level and
   the compiler refuses at boot: a level-2 skill declaring inference, or a
   level-3 skill declaring anything beyond tool connectivity, fails compilation.
   Tests assert the refusals, not just the happy path.
2. **`PUT /v1/intents/{id}`.** An update to a previously posted engagement:
   ledgered, idempotent, refused on unknown or closed intents, and it cannot
   touch decisions. Same auth as POST.
3. **WebSocket outbound client mode.** `OMODA_STREAM_CONNECT=<url>` makes the
   platform dial a stream that is already pushing JSON; frames enter the exact
   same signed-envelope, dedupe, debounce path as the inbound listener. Runs on
   the host service, never from the sandbox (§23.1).

## Sunday, 07:00 to 09:30 (P1, in this order)

4. **Telegram voice transform.** Voice note arrives, file is downloaded to the
   box, local Omni transcribes it, the transcript becomes a normal proposed
   intent carrying `modality: voice`. This is the highest-value item of the
   whole v4 scope: it puts the multimodal model to work in the live path, on-box,
   zero egress, and it is one minute of demo video that no API-calling project
   can reproduce.
5. **Transport layer unification.** One module emits the canonical envelope for
   all three doors. Mostly moving existing code behind one seam; do it after
   voice so the refactor has three real intakes to unify.
6. **Retrieval + admin portal.** Lexical store over uploaded documents,
   `/ui/knowledge` upload page in the SSR UI, retrieved context injected into L1
   inference calls. Honest naming: retrieval, not embeddings (no endpoint, §23.2).

## Sunday, 09:30 to 11:00

7. **Demo video, then the Airtable form.** Script: voice note to Telegram, Omni
   transcribes on the box, L0 routes it, the financial write is 403 until the
   tap, capability for one call, 403 after, AUDIT from the phone. Record against
   the box, not a laptop (deployment doc rule).

## Cut list, decided now rather than at 10:40 Sunday

- **Video modality transform.** Stretch. The transform layer detects and labels
  `modality: video` from day one, and Omni does accept video, but transcoding
  edge cases can eat an hour. Voice proves the multimodal claim; video lands
  only if items 4 through 6 are done before 09:00.
- **Vector retrieval.** Blocked: the shared vLLM serves no embeddings endpoint,
  and standing up a second model server for embeddings on a shared box the
  morning of the freeze is a risk with no demo payoff. The store's interface
  takes a pluggable scorer; the vector scorer is a fast follow.
- **L1 fan-out beyond one domain.** The org chart supports many L1s; the demo
  needs one exercised end to end. Additional domains are manifest files, not
  code, which is the point of §23.4.
- **Migrating existing YAML manifests to `.skill.md`.** The loader accepts both;
  migration is mechanical and proves nothing. After the hackathon.

## Standing rules that apply to all of it

- Green means green on the box (`docs/deployment.md`); every item above ends
  with `scripts/deploy-box.sh` passing.
- The two-week dependency rule holds; nothing here needs a new dependency
  except possibly none at all.
- The demo ledger stays clean (`demo-<ts>.jsonl`), and the exposed bot token and
  gateway token rotate after the demo (#18).
