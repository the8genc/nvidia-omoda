<!-- Concern: the root-cause diagnosis and one-line fix for the SegFormer frame-to-frame instability | Non-concern: the B1 geometry verdict or the streaming integration | IO: none -->

# Seg instability — root cause + fix

**Symptom:** 7/10 visually-near-identical frames segmented to garbage (frame 08: 10% road / 55%
building), while frame 05 came out clean (81% road). First read as "SegFormer is unstable."

**Root cause (it's a preprocessing bug, not the model):** `SegformerImageProcessor` for this checkpoint
defaults to `do_resize=True, size=512×512`, squishing each 1280×720 (16:9) frame into a **512×512
square** and destroying the aspect ratio. SegFormer-B0 was fine-tuned on wide (~2:1) Cityscapes driving
imagery; the aspect-distorted square input is out-of-distribution, so near-identical frames land on
opposite sides of decision boundaries → chaotic instability.

**Evidence:**
- Deterministic (frame 08 twice → identical md5). Not RNG.
- Frames are clean (all `1280×720 8-bit RGB`; cv2==PIL decode; no BGR/RGB/format issue).
- The divergence is purely the model's response to the squished 512² input (processor stats identical).
- **Proof:** feeding native aspect ratio makes road dominant on **all 10 frames** and collapses the
  variance — `road%` per frame goes from `[52.9 41.0 26.3 53.0 82.1 92.5 43.3 11.4 9.4 7.0]` (7 garbage)
  to `[62.5 70.8 81.1 90.2 92.8 89.0 80.2 62.2 59.9 68.9]` (0 garbage). Frame 08: 10.1% → 62.2% road.

**Fix (one line in `seg.py`):** pass `do_resize=False` to the processor call so the frame is fed at
native 720×1280 (aspect preserved). A real correction, not a band-aid — it removes an out-of-distribution
distortion the model was never meant to see.

**Consequence for the bet:** the labeling half is viable. SegFormer is stable frame-to-frame at native
aspect. (Belt-and-suspenders: B1 also showed background-subtraction gives static/mover separation
without seg at all — so the geometry never depended on this fix.)
