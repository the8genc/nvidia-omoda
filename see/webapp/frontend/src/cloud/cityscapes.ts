// The Cityscapes 19-class palette, as the benchmark defines it. Kept verbatim
// rather than restyled: anyone who has looked at Cityscapes output reads these
// colours instantly, and a prettier palette would cost that recognition.

/** Official Cityscapes `trainId` colours, 0..18, as 0..1 RGB triples. */
const PALETTE_8BIT: readonly (readonly [number, number, number])[] = [
  [128, 64, 128], // road
  [244, 35, 232], // sidewalk
  [70, 70, 70], // building
  [102, 102, 156], // wall
  [190, 153, 153], // fence
  [153, 153, 153], // pole
  [250, 170, 30], // traffic light
  [220, 220, 0], // traffic sign
  [107, 142, 35], // vegetation
  [152, 251, 152], // terrain
  [70, 130, 180], // sky
  [220, 20, 60], // person
  [255, 0, 0], // rider
  [0, 0, 142], // car
  [0, 0, 70], // truck
  [0, 60, 100], // bus
  [0, 80, 100], // train
  [0, 0, 230], // motorcycle
  [119, 11, 32], // bicycle
]

/** Anything the model did not label, including the stub's placeholder ids. */
const UNLABELLED: readonly [number, number, number] = [0.35, 0.35, 0.35]

export const CITYSCAPES_PALETTE: readonly (readonly [number, number, number])[] =
  PALETTE_8BIT.map(([r, g, b]) => [r / 255, g / 255, b / 255] as const)

export function classColor(id: number): readonly [number, number, number] {
  return CITYSCAPES_PALETTE[id] ?? UNLABELLED
}

/**
 * Classes that become instances (things) rather than surfaces (stuff). The
 * distinction drives the digital-twin substitution: things get a primitive,
 * stuff gets a fitted surface.
 */
export const THING_CLASSES: ReadonlySet<number> = new Set([11, 12, 13, 14, 15, 16, 17, 18])

/** Classes whose points depict identifiable people or vehicles. */
export const SENSITIVE_CLASSES: ReadonlySet<number> = new Set([11, 12, 13, 14, 15, 17, 18])
