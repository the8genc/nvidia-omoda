# Build plan: the v4 scope, against the freeze

**Now:** Saturday evening. **Working through the night; our own code stop is
Sunday 09:00**, leaving 09:00 to 11:00 for the demo video and the Airtable
submission. Event freeze 11:00, judging 11:30.

Requirements are §23 of the PRD. The ordering rule: everything that lands must be
demonstrable on the box, and the demo video outranks any feature not yet started
by 09:00.

## First block (P0: the contracts)

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

## Second block (P1, in this order)

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

## Sunday, 09:00 to 11:00

7. **Demo video, then the Airtable form.** Script: voice note to Telegram, Omni
   transcribes on the box, L0 routes it, the financial write is 403 until the
   tap, capability for one call, 403 after, AUDIT from the phone. Record against
   the box, not a laptop (deployment doc rule).

## Cut list, decided now rather than at 10:40 Sunday

(Recalibrated for the all-night window; only the video item moved.)

- **Video modality transform.** Stretch, promoted by the all-night window: the
  transform layer labels `modality: video` from day one, and the full describe
  path lands if items 1 through 6 are done with margin before 08:00. Voice still
  proves the multimodal claim on its own.
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

## Addendum, Saturday night: the COCO merge (PRD section 24)

COCO's PRD landed and reorders the remaining night. It answers #25 (they serve,
we dial) and defines the incident classes; it adds the adapter and the judge.

Revised order for the remaining hours:

1. **COCO adapter + Observation Judge** (new, demo-critical): schema-v1 frames in,
   deterministic candidate filter, Nemotron structured-output judgment on
   candidates only, one intent per incident, nominal = zero intents and zero
   model calls. A mock COCO server in the test suite drives three consecutive
   See-to-Do runs so the merge does not depend on both services being up to test.
2. **Wire to the real socket** the moment the See team names host and port
   (config, not code).
3. **Demo dry-run** with the COCO leg: observation fixture -> judge -> escalation
   -> tap -> capability -> revert -> AUDIT.
4. Everything previously listed (video stretch, transport seam) is DONE.

Cut nothing silently: if the real COCO socket is not up by 08:00, the demo runs
the recorded observation fixture through the same adapter and says so on screen.

Decision needed from Arif and the See team before the freeze: their PRD requires
a combined monorepo submission (tracked as a GitHub issue).
