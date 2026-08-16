<!-- Concern: the B1a baseline result, the data-integrity catch, and the spatial finding that redirected the crux | Non-concern: the B1b anchor implementation or the seg bug-hunt (their own artifacts) | IO: none -->

# B1a — baseline finding + data-integrity catch

## Raw stat block (frames 05 vs 08, over garbage-seg "static")
mean 0.033 · median 0.048 · std 0.140 · affine a=0.978 b=0.096 · residual 0.136 (affine removes 3.3%).
"shared_static" = 99.4% of pixels.

## Integrity catch (owned per the values doc — validity lives in me, not the tool)
The agent flagged SegFormer class-% flipping wildly: 05 (81% road) → 08 (10% road / 55% building). I
verified against the raw frames: **frame 08 is visually near-identical to 05** (road still ~80%, same
crowds/buses). The frame-08 **seg is garbage** (chaotic building/veg/road blobs, no scene structure);
the frame-08 **depth is coherent** (clean near→far, like 05). → "SegFormer is unstable" is a **bug in
the frame-08 seg run, not a real finding**; the depth pipeline is sound. Because the garbage-seg
"static" mask was ~all pixels, the 0.140 std was measured over movers too, not truly-static background.

## Spatial finding (the real story — from `diff_raw_05_08.png`)
Symmetric turbo, green ≈ 0. The **static background (road, far buildings) is green → already stable**
frame-to-frame. The large diffs are **localized to movers**: the lower-left bus, cars/taxi, the
rustling upper-right tree, the crowds. → the aggregate 0.140 was inflated by (a) movers and (b) the
garbage seg counting movers as static. **The true static-background hop is much smaller.**

## Redirects
- **Global static-pixel affine anchor: abandoned.** Not just ineffective (3.3%) — its premise (a
  drifting static background) is largely false. No band-aid.
- **B1 geometry:** measure the *true* static hop via **background-subtraction** (RGB temporal
  constancy, seg-independent) static mask; expect small; add at most a light per-pixel temporal median
  to clean residual shimmer.
- **Seg-stability:** a **separate** bug to isolate — why did frame 08 seg produce garbage on a frame
  near-identical to 05? Critical for the labeling half of the bet. Do **not** rely on per-frame seg for
  static detection.

Not stuck — the data redirected the crux productively. Proceeding in parallel: (1) B1b true-static-hop,
(2) seg-stability bug-hunt.
