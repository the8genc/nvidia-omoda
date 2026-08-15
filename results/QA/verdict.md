<!-- Concern: the depth-vs-seg/input cross-check verdict — is the monocular depth geometrically trustworthy | Non-concern: the seg's own accuracy (its verdicts) or the twin render | IO: none -->

# Depth QA — geometric cross-check verdict

Cross-checked the monocular depth against the seg + input frame (frames 05 and 08). Depth is
disparity-like (larger = nearer).

## Findings (the depth is geometrically sound where it matters)
- **Road is a coherent plane.** `depth ≈ a·row + b·col + c` fits road pixels at **R² = 0.84** (both
  frames), dominated by the row term (a≈0.0073–0.0078) with a near-zero column term — exactly an
  oblique view of a flat intersection. Row correlation **+0.915**, monotonic, correctly signed (near at
  the bottom). Residual std 0.64 against a road range ~1.1→5.2 ≈ 16% unexplained = mild perspective
  nonlinearity + crosswalk-marking texture, **not** bumpy/incoherent depth.
- **Buildings correctly farther** than the road (mean 1.19/1.83 vs 2.93/3.29) and farther than
  vegetation — matches buildings framing the far background.
- **Clean foreground→background gradient**: road bottom-20% ≈ 5.2 (near) vs top-20% ≈ 1.1 (far).
- **Visual composite** (`depth_check_05.png` = input | depth | seg) confirms the depth agrees with the
  scene: near foreground, far buildings, smoothly receding road.

## Consequences
- **The depth backbone is trustworthy** → the twin's ground and object placement rest on sound geometry.
- **Road-flattening is justified**: R²=0.84 means a plane captures the road; replacing road depth with
  the fitted plane cleans the ~16% residual → a flat clean ground (being applied in twin_clean).
- **Seg imperfection is orthogonal and documented**: frame 05 over-labels road, frame 08 over-labels
  vegetation (the SegFormer elevated-crowd domain gap). The depth is independent of this and sound.
- **One negligible anomaly**: frame 08 has a 105-px "sky" seg mislabel reading as near — a seg error,
  not a depth error; immaterial (105 px).

**Verdict: depth cross-check PASSES — geometry is trustworthy; road-flatten warranted.**
