// Static surface classes, matching `Open-d4rt/stream_pairs.py`.
//
// A surface is the reconstruction's own points plus a label. The model already
// places every query in 3D, so nothing here re-derives a position.

export const EMPTY = 0
export const TERRAIN = 1
export const ROAD = 2
export const SIDEWALK = 3
export const MARKING = 4
/** Something passing through: erased on the backend, drawn as a generic box. */
export const MOVING = 5

export const SURFACE_COLOURS: Record<number, readonly [number, number, number]> = {
  [TERRAIN]: [0.17, 0.32, 0.2],
  [ROAD]: [0.1, 0.13, 0.3],
  [SIDEWALK]: [0.46, 0.5, 0.58],
  [MARKING]: [0.9, 0.93, 1.0],
  [MOVING]: [0.25, 0.6, 1.0],
}

export const SURFACE_NAMES: Record<number, string> = {
  [TERRAIN]: 'terrain',
  [ROAD]: 'road',
  [SIDEWALK]: 'sidewalk',
  [MARKING]: 'markings',
  [MOVING]: 'moving',
}

/**
 * True where the world already draws this, so the points would only be drawing
 * it twice. Static scenery is the surface mesh; a moving thing is its box — and
 * in that case the points are not merely redundant, they are the very pixels
 * the box exists to replace.
 */
export function isReplaced(surface: number): boolean {
  return surface !== EMPTY
}
