<!-- Concern: the B1 crux verdict — can the static background depth be held stable across frames, seg-independently | Non-concern: streaming application (Stage C) or the seg bug (its own hunt) | IO: none -->

# B1 — depth-anchor crux verdict

**Claim tested:** the static-background depth can be held stable across frames, seg-independently.

**Method:** background-subtraction static mask — per-pixel temporal grayscale std over frames 04..08,
Otsu knee → **88.7% static**, seg-independent (does not touch SegFormer).

**Quantitative (frame 05↔08 depth diff):**
- static (bg-sub mask): mean 0.052 · median 0.049 · **std 0.078**
- movers: mean −0.122 · median 0.025 · **std 0.323** (~4× static)
- polluted baseline (garbage-seg "static"): 0.140
- Median-vs-mean shimmer: median **8% worse** → the shimmer is broadband noise, not outliers → the
  anchor uses temporal **mean/EMA**, not median.

**Visual (`static_mask.png`):** correctly isolates the movers — both buses, the right-side crowds (as
speckle), the bottom-right car, the elevated train — and keeps the road + buildings static. Clean,
seg-independent.

**Visual (`diff_static_only_05_08.png`, movers greyed, green≈0):** the **road / ground plane is
uniformly green → stable.** Residual static hops are localized to the top-left building edge, the
upper-right foliage (semi-dynamic — it rustles), and mover-boundary fringes — **not** the ground plane.

## Verdict (reasoning)

**The load-bearing claim holds:** the ground plane is stable across frames, and static/mover separation
is clean and **seg-independent**. The global static-pixel *affine* anchor is abandoned (its premise —
a drifting static background — was largely false); the anchor is a **per-pixel temporal mean/EMA over
background-subtraction static pixels**, which pins the residual ~0.08 shimmer by construction.

**Documented gap:** the far backdrop (buildings / foliage) and mover-boundary fringes carry ~0.08 std
residual instability; foliage is genuinely semi-dynamic (arguably a mover). Adequate for the ground
plane the twin rests on; the backdrop is the far scenery, not load-bearing.

**Architectural insight (important):** background-subtraction delivers static/mover separation *without*
the flaky semantic seg. The ground plane can come from the static mask + depth, and the movers — which
are exactly the objects to detect and place — are isolated directly. **This reduces the pipeline's
reliance on the unreliable SegFormer**, and reframes the labeling problem: classes for the *movers*
come from the detector (YOLO); the *ground* comes from geometry, not necessarily semantic seg.

**Decision: CLOSE B1 — crux de-risked.** Full streaming application (temporal-mean background + per-frame
movers) → Stage C. **Open risk:** the SegFormer frame-08 garbage (the labeling half) — separate hunt in
progress; its outcome decides how much semantic seg the pipeline keeps.
