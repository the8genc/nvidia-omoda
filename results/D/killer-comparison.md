<!-- Concern: the neutral real-vs-twin comparison — the PII value-prop proof and the honest fidelity limit | Non-concern: the twin build details or perf | IO: none -->

# Killer comparison — raw frame vs twin, by neutral reviewers

Two blind reviewers, same frozen neutral prompt (the raw-frame reviewer was additionally asked to note
identifying details — a PII probe; the twin reviewer got the pure neutral prompt).

## Raw frame 05 — what a neutral viewer extracts
Named it "a busy **Shibuya** scramble intersection, **Japan**." Read signage: **TSUTAYA, Acom (アコム),
Promis (プロミス), COFFEE**, an LED billboard. Described **people**: "dense crowds… summer clothing in
various colors (whites, dark tones, brighter colors)… a few carry **umbrellas/parasols**… some carry
**bags**." Every vehicle, the elevated train, the buildings. → location + brands + crowd attire +
vehicles = richly identifying.

## The twin (bev_clean_05) — what a neutral viewer extracts
"A muted purple trapezoidal/bowl shape with white diagonal bands, magenta and olive speckles, and
orange & cyan square markers." → **no people, no clothing, no faces, no signage, no brands, no
location.** Only anonymized colored regions + vehicle markers.

## Verdict (honest, two-sided)
- **PII strip — strongly PROVEN.** A neutral oracle recovered zero identifying information from the twin
  while recovering abundant identity from the raw frame. This is the value proposition, demonstrated by
  an unbendable oracle, not asserted.
- **Semantic fidelity — PARTIAL.** The twin reviewer did **not** independently recognize the scene as an
  intersection; it read as an abstract colored shape with markers. The scene *elements* are present
  (flat road surface, white crowd/crossing bands, cyan-bus / orange-car markers in plausible positions)
  but are **not legible as "a street" to a naive observer.** The abstraction that guarantees privacy
  also costs recognizability.

## Framing
This is a coherent proposition — **privacy by abstraction**: the twin is deliberately not
photorealistic; it preserves *activity and geometry* (where vehicles are, where crowds mass, the ground
layout) while discarding *identity* (faces, clothing, brands, place). The honest gap is legibility —
making the abstract twin read as the scene without re-introducing PII is the open problem, not a solved
one.
