// The static world as built geometry: a set of flat levels, not a skin over the
// reconstruction.
//
// The model supplies where each surface is on the ground — its (x, z) — and the
// segmentation supplies what it is. Height is not measured, it is decided: road
// is exactly zero, kerbs and terrain are lifted by a fixed amount, paint floats
// a hair above the tarmac. That is what makes this a simulation's view of a
// street rather than a photogrammetric shell of one, and it is why a wall the
// masks called pavement collapses into its own footprint instead of standing up
// as a fin.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshStandardMaterial,
} from 'three'

import type { StaticWorld } from '@/cloud/staticWorld'
import { MARKING, ROAD, SIDEWALK, TERRAIN } from '@/cloud/tileWorld'

/** Drawn in this order, so each class is one contiguous run the geometry can group. */
const CLASSES = [ROAD, MARKING, TERRAIN, SIDEWALK] as const

/**
 * Height per class, as a fraction of the scene radius. Road is the datum. The
 * rest are embossed off it by enough to catch a shadow at a kerb and no more —
 * these are steps in a diagram, not measured elevations.
 */
const LEVELS: Record<number, number> = {
  [ROAD]: 0,
  [MARKING]: 0.0015,
  [TERRAIN]: 0.006,
  [SIDEWALK]: 0.011,
}

/**
 * Largest ground cell a quad may cover, as a fraction of the scene radius.
 *
 * Judged in world units, not against the frame's typical cell: a lattice cell on
 * the ground grows with the square of its distance under an oblique camera, so a
 * near cell and a far one differ by a hundred times and no single multiple of
 * the median admits both. What actually needs rejecting is absolute — a cell
 * that spans a tenth of the scene is a silhouette being dragged across open
 * space, whatever the rest of the frame looks like.
 */
const MAX_CELL_SPAN = 0.08
/**
 * How far from the camera the world is allowed to extend, as a multiple of the
 * scene radius. A row of pixels just under the horizon lands hundreds of units
 * out once it is laid flat, and a quad built across it smears the road off to
 * infinity. A fixed camera has no usable depth out there anyway.
 */
const MAX_REACH = 3.5
/**
 * How far off the levelled ground a point may sit and still be ground, as a
 * fraction of the scene radius.
 *
 * The masks answer "what is this" and not "where is this". A building facade
 * above a kerb is pavement to Mapillary, and flattening it onto y=0 drags its
 * whole height into a fan of slivers across the road. Height decides membership;
 * the class only decides which level it lands on.
 */
const GROUND_BAND = 0.07
/**
 * Cells a run of paint needs before it is fitted as a stripe. Below this it is
 * a speck the segmentation misfired on, and fitting a rectangle to it only makes
 * the misfire bigger and straighter.
 */
const MIN_MARKING_CELLS = 6
/** How much of its own bounding rectangle a run of paint must occupy to be one. */
const MIN_MARKING_FILL = 0.55
/**
 * Largest hole the road will close over, as a share of the road's own area. A
 * vehicle, a stripe of paint or a dropped patch of mask falls well under this;
 * a courtyard or a whole occluded block does not, and should stay a hole.
 */
const MAX_HOLE_SHARE = 0.06

/**
 * A display, not a daylight render.
 *
 * Deep navy, polished, and lit mostly by its own faint emission — that is what
 * separates a car's own view of a street from a photograph of one. The emission
 * stays low on purpose: enough that the paint and the kerbs sit above the road
 * rather than in it, well short of the neon that would turn a street into a
 * light show.
 */
function surfaceMaterials(): Record<number, MeshStandardMaterial> {
  return {
    [ROAD]: new MeshStandardMaterial({
      color: new Color(0x0c1c42),
      emissive: new Color(0x143d7d),
      emissiveIntensity: 0.6,
      roughness: 0.14,
      metalness: 0.6,
      side: DoubleSide,
    }),
    // Paint, drawn as light rather than as pigment: transparent so the road
    // reads through it, and never writing depth so the millimetre it floats
    // above the tarmac cannot z-fight.
    [MARKING]: new MeshStandardMaterial({
      color: new Color(0xbcd8e6),
      emissive: new Color(0x9fe4f5),
      emissiveIntensity: 0.35,
      roughness: 0.3,
      metalness: 0.1,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: DoubleSide,
    }),
    [TERRAIN]: new MeshStandardMaterial({
      color: new Color(0x05191f),
      emissive: new Color(0x11737e),
      emissiveIntensity: 0.35,
      roughness: 0.55,
      metalness: 0.5,
      side: DoubleSide,
    }),
    [SIDEWALK]: new MeshStandardMaterial({
      color: new Color(0x0d1c33),
      emissive: new Color(0x2f7ae0),
      emissiveIntensity: 0.3,
      roughness: 0.25,
      metalness: 0.7,
      side: DoubleSide,
    }),
  }
}

export interface SurfaceMesh {
  mesh: Mesh
  /** Lay out the world the backend built. Returns how many quads it came to. */
  build: (world: StaticWorld) => number
  dispose: () => void
}

export function createSurfaceMesh(maxPoints: number): SurfaceMesh {
  // Not indexed: a lattice vertex shared by a road cell and a kerb cell needs a
  // different height in each, so every quad carries its own corners.
  const positions = new Float32Array(maxPoints * 6 * 3)
  const geometry = new BufferGeometry()
  const positionAttribute = new BufferAttribute(positions, 3)
  positionAttribute.setUsage(DynamicDrawUsage)
  geometry.setAttribute('position', positionAttribute)

  // Every face is level, so the normals are known up front and never change.
  const normals = new Float32Array(maxPoints * 6 * 3)
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))

  const materials = surfaceMaterials()
  const order = CLASSES.map((value) => materials[value])
  const mesh = new Mesh(geometry, order)
  mesh.frustumCulled = false
  mesh.castShadow = true
  mesh.receiveShadow = true

  function build(world: StaticWorld): number {
    const { positions: source, labels, numPoints, gridSide: side } = world
    // The world arrives already divided by its own radius, so its extent is
    // about one and the fractions below are read against that directly.
    const radius = 1

    const limit = MAX_CELL_SPAN * radius
    const reach = MAX_REACH * radius
    const band = GROUND_BAND * radius
    const [camX, , camZ] = world.camera

    let written = 0
    geometry.clearGroups()

    /** Is this lattice point somewhere the world is allowed to exist? */
    const usable = (i: number): boolean =>
      Math.abs(source[i * 3 + 1]) <= band &&
      Math.hypot(source[i * 3] - camX, source[i * 3 + 2] - camZ) <= reach

    const road = solidRoad(source, labels, side, numPoints, usable)

    for (const surface of CLASSES) {
      const height = LEVELS[surface] * radius
      const started = written
      if (surface === MARKING) {
        written = fitMarkings(source, labels, side, numPoints, height, usable, written)
        if (written > started) {
          geometry.addGroup(started, written - started, CLASSES.indexOf(surface))
        }
        continue
      }
      const belongs =
        surface === ROAD
          ? (i: number): boolean => road.filled[i] === 1
          : (i: number): boolean => labels[i] === surface && usable(i)
      const at = surface === ROAD ? road.xz : source
      const stride = surface === ROAD ? 2 : 3
      for (let row = 0; row < side - 1; row += 1) {
        for (let col = 0; col < side - 1; col += 1) {
          const a = row * side + col
          const b = a + 1
          const c = a + side
          const d = c + 1
          if (d >= numPoints) continue
          if (!belongs(a) || !belongs(b) || !belongs(c) || !belongs(d)) continue
          // Footprint only: the span that matters is across the ground, since
          // the height is about to be discarded anyway.
          const stretched =
            Math.hypot(
              at[d * stride] - at[a * stride],
              at[d * stride + stride - 1] - at[a * stride + stride - 1],
            ) > limit
          if (stretched) continue
          for (const corner of [a, c, b, b, c, d]) {
            positions[written * 3] = at[corner * stride]
            positions[written * 3 + 1] = height
            positions[written * 3 + 2] = at[corner * stride + stride - 1]
            written += 1
          }
        }
      }
      if (written > started) geometry.addGroup(started, written - started, CLASSES.indexOf(surface))
    }

    geometry.setDrawRange(0, written)
    positionAttribute.needsUpdate = true
    geometry.computeBoundingSphere()
    return written / 6
  }

  /**
   * The road as one unbroken slab: whatever the road encloses is road.
   *
   * A street is not full of holes, but its reconstruction is. A parked car
   * throws the depth under it out of the ground band; paint and manhole covers
   * are other classes; the masks simply drop cells here and there. Every one of
   * those is a gap with road all the way around it, and a gap of that shape is
   * an artefact of how the surface was measured rather than something to
   * faithfully reproduce — leaving them in would also punch a car-shaped hole
   * through the very thing that is meant to be generic.
   *
   * So: anything not reachable from outside without crossing road is road. The
   * positions inside a hole cannot be trusted (that was why some of them were
   * rejected), so they are diffused in from the rim rather than read back out.
   */
  function solidRoad(
    source: Float32Array,
    labels: Uint8Array,
    side: number,
    numPoints: number,
    usable: (index: number) => boolean,
  ): { filled: Uint8Array; xz: Float32Array } {
    const filled = new Uint8Array(numPoints)
    const xz = new Float32Array(numPoints * 2)
    for (let i = 0; i < numPoints; i += 1) {
      if (labels[i] === ROAD && usable(i)) {
        filled[i] = 1
        xz[i * 2] = source[i * 3]
        xz[i * 2 + 1] = source[i * 3 + 2]
      }
    }

    // Everything the outside can reach without stepping on road. What it cannot
    // reach is enclosed, whatever the masks called it.
    const outside = new Uint8Array(numPoints)
    const queue: number[] = []
    for (let i = 0; i < numPoints; i += 1) {
      const col = i % side
      const row = (i - col) / side
      const edge = row === 0 || col === 0 || col === side - 1 || i + side >= numPoints
      if (edge && !filled[i]) {
        outside[i] = 1
        queue.push(i)
      }
    }
    while (queue.length) {
      const at = queue.pop()!
      const col = at % side
      for (const next of [at - side, at + side, col > 0 ? at - 1 : -1, col < side - 1 ? at + 1 : -1]) {
        if (next < 0 || next >= numPoints || outside[next] || filled[next]) continue
        outside[next] = 1
        queue.push(next)
      }
    }

    // Only holes up to a size worth closing. A car, a paint stripe or a dropped
    // patch of mask is small against the road it sits in; a courtyard or a whole
    // occluded block is not, and paving one over would be inventing street
    // rather than repairing it.
    let area = 0
    for (let i = 0; i < numPoints; i += 1) if (filled[i]) area += 1
    const largest = area * MAX_HOLE_SHARE

    const patch: number[] = []
    const grouped = new Uint8Array(numPoints)
    for (let root = 0; root < numPoints; root += 1) {
      if (filled[root] || outside[root] || grouped[root]) continue
      const hole: number[] = [root]
      grouped[root] = 1
      for (let head = 0; head < hole.length; head += 1) {
        const col = hole[head] % side
        const around = [
          hole[head] - side,
          hole[head] + side,
          col > 0 ? hole[head] - 1 : -1,
          col < side - 1 ? hole[head] + 1 : -1,
        ]
        for (const near of around) {
          if (near < 0 || near >= numPoints || grouped[near] || filled[near] || outside[near]) continue
          grouped[near] = 1
          hole.push(near)
        }
      }
      if (hole.length <= largest) patch.push(...hole)
    }

    // Filled from their rims inwards: each cell takes the average of the
    // neighbours that already have a position, so a gap closes over smoothly
    // instead of snapping to whatever the depth estimate did inside it.
    let pending = patch
    while (pending.length) {
      const next: number[] = []
      let settled = 0
      for (const i of pending) {
        const col = i % side
        let x = 0
        let z = 0
        let count = 0
        for (const near of [i - side, i + side, col > 0 ? i - 1 : -1, col < side - 1 ? i + 1 : -1]) {
          if (near < 0 || near >= numPoints || filled[near] !== 1) continue
          x += xz[near * 2]
          z += xz[near * 2 + 1]
          count += 1
        }
        if (!count) {
          next.push(i)
          continue
        }
        xz[i * 2] = x / count
        xz[i * 2 + 1] = z / count
        filled[i] = 2 // settled this pass, so the rest of it reads the old rim
        settled += 1
      }
      for (const i of pending) if (filled[i] === 2) filled[i] = 1
      if (!settled) break
      pending = next
    }
    return { filled, xz }
  }

  /**
   * Every stripe of paint as one rectangle, rather than as the cells it lit up.
   *
   * A dash, a stop bar and a crosswalk rung are all rectangles on the ground, so
   * the staircase the mask traces around them is not detail — it is the sampling
   * grid showing through. Each connected run of paint is reduced to its own
   * principal axis and the extent along it, which is the rectangle it was always
   * meant to be: two triangles with straight edges at any angle, instead of a
   * few hundred little squares stepping around one.
   */
  function fitMarkings(
    source: Float32Array,
    labels: Uint8Array,
    side: number,
    numPoints: number,
    height: number,
    usable: (index: number) => boolean,
    start: number,
  ): number {
    let written = start
    const seen = new Uint8Array(numPoints)
    const queue: number[] = []
    const cells: number[] = []

    for (let root = 0; root < numPoints; root += 1) {
      if (seen[root] || labels[root] !== MARKING || !usable(root)) continue
      cells.length = 0
      queue.length = 0
      queue.push(root)
      seen[root] = 1
      while (queue.length) {
        const at = queue.pop()!
        cells.push(at)
        const col = at % side
        const neighbours = [at - side, at + side, col > 0 ? at - 1 : -1, col < side - 1 ? at + 1 : -1]
        for (const next of neighbours) {
          if (next < 0 || next >= numPoints || seen[next]) continue
          if (labels[next] !== MARKING || !usable(next)) continue
          seen[next] = 1
          queue.push(next)
        }
      }
      if (cells.length < MIN_MARKING_CELLS) continue

      let cx = 0
      let cz = 0
      for (const cell of cells) {
        cx += source[cell * 3]
        cz += source[cell * 3 + 2]
      }
      cx /= cells.length
      cz /= cells.length

      // The principal axis of the run, from the 2x2 covariance in closed form.
      // A stripe is long and thin, so this is the direction it was painted in.
      let xx = 0
      let xz = 0
      let zz = 0
      for (const cell of cells) {
        const dx = source[cell * 3] - cx
        const dz = source[cell * 3 + 2] - cz
        xx += dx * dx
        xz += dx * dz
        zz += dz * dz
      }
      const spread = Math.hypot(xx - zz, 2 * xz)
      let ux = xx - zz + spread
      let uz = 2 * xz
      const length = Math.hypot(ux, uz)
      if (length < 1e-12) {
        ux = 1
        uz = 0
      } else {
        ux /= length
        uz /= length
      }

      let alongLow = Infinity
      let alongHigh = -Infinity
      let acrossLow = Infinity
      let acrossHigh = -Infinity
      for (const cell of cells) {
        const dx = source[cell * 3] - cx
        const dz = source[cell * 3 + 2] - cz
        const along = dx * ux + dz * uz
        const across = -dx * uz + dz * ux
        if (along < alongLow) alongLow = along
        if (along > alongHigh) alongHigh = along
        if (across < acrossLow) acrossLow = across
        if (across > acrossHigh) acrossHigh = across
      }

      // Only paint that actually fills its rectangle becomes one. An L of kerb
      // paint or a scatter of mask noise has a bounding box far larger than the
      // paint in it, and fitting that box would invent a slab of road markings
      // where there is none. Judged against the run's own lattice spacing.
      let spacing = 0
      let pairs = 0
      for (const cell of cells) {
        const right = cell + 1
        if (cell % side === side - 1 || labels[right] !== MARKING || !seen[right]) continue
        spacing += Math.hypot(source[right * 3] - source[cell * 3], source[right * 3 + 2] - source[cell * 3 + 2])
        pairs += 1
      }
      if (pairs > 0) {
        const cellArea = (spacing / pairs) ** 2
        const boxArea = (alongHigh - alongLow) * (acrossHigh - acrossLow)
        if (boxArea > 0 && (cells.length * cellArea) / boxArea < MIN_MARKING_FILL) continue
      }

      const corner = (along: number, across: number): [number, number] => [
        cx + ux * along - uz * across,
        cz + uz * along + ux * across,
      ]
      const p0 = corner(alongLow, acrossLow)
      const p1 = corner(alongHigh, acrossLow)
      const p2 = corner(alongHigh, acrossHigh)
      const p3 = corner(alongLow, acrossHigh)
      for (const [x, z] of [p0, p1, p2, p0, p2, p3]) {
        positions[written * 3] = x
        positions[written * 3 + 1] = height
        positions[written * 3 + 2] = z
        written += 1
      }
    }
    return written
  }

  function dispose(): void {
    geometry.dispose()
    for (const material of order) material.dispose()
  }

  return { mesh, build, dispose }
}
