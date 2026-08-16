<!-- Concern: the holistic verdict for the A1 segmentation blind gate, judged against gates/intent-stageA | Non-concern: the A2/A3 verdicts (their own files) or the seg implementation (DGX scripts/seg.py) | IO: none -->

# A1 — segmentation blind-gate verdict

**Artifact:** `results/A1/shibuya_05_seg.png` (stripped colorized Cityscapes mask, no legend).
**Class data (rich, no pass/fail):** road 80.88 · building 13.66 · vegetation 4.54 · sidewalk 0.87 ·
person 0.03 · traffic-sign 0.01 (%). 13 of 19 classes absent.

**Blind description (independent, palette-blind):** hard-edged flat color regions — a dominant
purple base filling the lower/central/right; a broken dark-gray band across the top plus a mid-height
gray cluster; green interspersed with the gray; vivid pink shapes along the bottom edge (a ring at
bottom-center, a streak bottom-right); tiny red + yellow specks lower-right. No gradients.

**Palette decode (I hold the palette, the reviewer did not):** purple=road, gray=building,
green=vegetation, pink=sidewalk, red=person, yellow=traffic-sign.

## Verdict (reasoning, not a checkbox)

**Stuff / ground-plane job — adequate.** Road is captured, dominant, and correctly positioned (lower
and central); building is captured as the far top band; vegetation is present. The reviewer's
*independent* layout — open base, busy band at top, shapes along the bottom — is scene-consistent with
an oblique street view. The ground plane and the far frame exist and read coherently.

**Documented gaps:**
1. **People/crowds essentially absent** (0.03%; reviewer saw a tiny red speck). This was listed
   load-bearing in `gates/intent-stageA` — a **category error in my pre-registration**: in the
   pipeline architecture people are *things* (the detector's job), not *stuff* (SegFormer's). Corrected
   here in the verdict, **not** by editing the pre-registration. Reassigned to the detector unit (B2).
2. **Vehicles (buses/cars) also absent** from the seg — a mild surprise (Cityscapes has these classes);
   the elevated oblique view is out of the dashcam training domain. Also a *thing* → reassigned to B2.
3. **Sidewalk under-segmented:** crowd-occluded pavement on the right was labeled *road*, so the
   walkable-vs-drivable boundary is unreliable where crowds mass. Feeds Stage-D placement, not B1.

**Adequacy for what it feeds (the honest close test).** A1 feeds **B1's depth anchor**, which needs a
large, well-distributed set of *static* pixels. Road+building+vegetation ≈ **99%** are static classes
— excellent anchor material — and the sidewalk/road confusion does not hurt the anchor (both static).
→ **A1 is adequate for B1.** The walkable/drivable and thing gaps feed *later* units that own them.

**Domain gap (recorded, not fixed):** SegFormer-B0 Cityscapes (dashcam domain) under-segments
elevated-view crowds, vehicles, and crowd-occluded pavement. **No band-aid:** I will not swap to a
bigger seg model to chase people/vehicles — that is the detector's job; chasing it here would fight the
architecture.

**Methodology learning:** a bare colorized mask elicits *geometric/layout* description from a blind
reviewer, not semantic labels (it cannot name "road" from color alone). So this gate confirms
**structural coherence**; the **semantic** confirmation lands at A3 (the labeled 3D render), where the
scene shape is legible.

**Decision: CLOSE A1 with documented gaps. Advance to A2 gate and A3.**
