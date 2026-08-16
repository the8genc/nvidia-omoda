// Moving things, as generic boxes that glide.
//
// The backend measures a box a few times a second; the display runs at sixty.
// Everything here exists to close that gap without either freezing between
// updates or snapping when one lands: each box is dead-reckoned to where it
// should be now, and the drawn box is pulled towards that by a critically
// damped spring. What you see is never a measurement — it is a box catching up
// to one, which is what makes it read as a vehicle rather than as a readout.

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three'

import type { LiveBlob } from '@/cloud/useLiveCloudStream'

/** Most boxes drawn at once. Beyond this a street is not a street any more. */
const MAX_BOXES = 64
/**
 * How far a box may be carried past its last measurement, in seconds. Past this
 * a missing update means the thing is gone or hidden, not that it kept going,
 * and extrapolating further sends a ghost sailing through a building.
 */
const MAX_LEAD = 0.35
/**
 * Spring time constant. A spring rather than a fixed lerp because a lerp factor
 * is frame-rate dependent — its stiffness silently changes when the tab drops
 * to thirty — while the implicit critically damped form below is dt-correct and
 * cannot overshoot, so a box never wobbles past a stop. This is the soft
 * acceleration on the movement: position responds, it does not jump.
 */
const SPRING_TAU = 0.12
/** A box turning faster than this is a tracking glitch, not a vehicle. */
const MAX_YAW_RATE = Math.PI

/**
 * Wheels, as a fraction of the body they belong to.
 *
 * They exist for one reason: a box that slides is a readout, and a box whose
 * wheels turn is a vehicle. The roll is integrated from distance travelled and
 * nothing else, so it is physically tied to the motion — a stopped car's wheels
 * are still, a reversing one's turn backwards, and there is no rate to keep in
 * step with the animation because there is no rate, only distance.
 */
const WHEEL_RADIUS = 0.19
const WHEEL_WIDTH = 0.16
const WHEEL_ALONG = 0.31
/** Four per vehicle, so the instance pool is that much larger. */
const WHEELS_PER_BOX = 4

const KIND_COLOURS: Record<number, number> = {
  0: 0x2f6fd0, // unknown — still a box, still anonymous
  1: 0x2f6fd0, // vehicle
  2: 0xd08a2f, // person
}

interface Drawn {
  /** Where it is drawn, which lags where it is measured. */
  position: Vector3
  heading: number
  /** Where it was told to be, and when, so it can be carried forward. */
  target: Vector3
  velocity: Vector3
  targetHeading: number
  length: number
  width: number
  height: number
  kind: number
  /** Radians of roll accumulated from distance travelled. */
  roll: number
  /** On the client's own clock, so lead time never inherits clock skew. */
  seenAt: number
}

export interface BlobBoxes {
  mesh: InstancedMesh
  glow: InstancedMesh
  wheels: InstancedMesh
  /** Take a frame's worth of measurements. */
  accept: (blobs: readonly LiveBlob[]) => void
  /** Advance the drawn boxes by `dt`. True while anything is still moving. */
  advance: (dt: number) => boolean
  count: () => number
  dispose: () => void
}

export function createBlobBoxes(): BlobBoxes {
  const geometry = new BoxGeometry(1, 1, 1)
  const material = new MeshStandardMaterial({
    color: new Color(0x0d1b3a),
    emissive: new Color(0x2f6fd0),
    emissiveIntensity: 0.75,
    roughness: 0.25,
    metalness: 0.5,
  })
  const mesh = new InstancedMesh(geometry, material, MAX_BOXES)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.castShadow = true
  mesh.count = 0

  // A contact shadow in reverse: a thin skirt of light just wider than the body,
  // so a vehicle sits in the road rather than hovering over it. Any larger and it
  // stops reading as contact and starts reading as a spotlight.
  const glowGeometry = new BoxGeometry(1, 0.001, 1)
  const glowMaterial = new MeshStandardMaterial({
    color: new Color(0x000000),
    emissive: new Color(0x6fd0ff),
    emissiveIntensity: 0.9,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  })
  const glow = new InstancedMesh(glowGeometry, glowMaterial, MAX_BOXES)
  glow.instanceMatrix.setUsage(DynamicDrawUsage)
  glow.frustumCulled = false
  glow.count = 0

  // Laid on its side once, at build time, so the axle runs along the body's own
  // across-axis and rolling is then a rotation about local x.
  const wheelGeometry = new CylinderGeometry(1, 1, 1, 14)
  wheelGeometry.rotateZ(Math.PI / 2)
  const wheelMaterial = new MeshStandardMaterial({
    color: new Color(0x05070d),
    emissive: new Color(0x1b3f7a),
    emissiveIntensity: 0.35,
    roughness: 0.6,
    metalness: 0.3,
  })
  const wheels = new InstancedMesh(wheelGeometry, wheelMaterial, MAX_BOXES * WHEELS_PER_BOX)
  wheels.instanceMatrix.setUsage(DynamicDrawUsage)
  wheels.frustumCulled = false
  wheels.castShadow = true
  wheels.count = 0

  const drawn = new Map<number, Drawn>()
  const scratch = new Object3D()
  const spin = new Quaternion()
  const roll = new Quaternion()
  const up = new Vector3(0, 1, 0)
  const axle = new Vector3(1, 0, 0)
  let clock = 0

  function accept(blobs: readonly LiveBlob[]): void {
    for (const blob of blobs) {
      const existing = drawn.get(blob.id)
      const heading = Math.atan2(blob.hx, blob.hz)
      if (existing) {
        existing.target.set(blob.x, 0, blob.z)
        existing.velocity.set(blob.vx, 0, blob.vz)
        // Fold to the same half turn as the drawn heading before comparing: a
        // box has no front, so the shorter way round is always the right way.
        existing.targetHeading = fold(heading, existing.heading)
        existing.length = blob.length
        existing.width = blob.width
        existing.height = blob.height
        existing.kind = blob.kind
        existing.seenAt = clock
        continue
      }
      // A new box starts where it was measured rather than springing in from
      // wherever the last one with this id happened to be.
      drawn.set(blob.id, {
        position: new Vector3(blob.x, 0, blob.z),
        heading,
        target: new Vector3(blob.x, 0, blob.z),
        velocity: new Vector3(blob.vx, 0, blob.vz),
        targetHeading: heading,
        length: blob.length,
        width: blob.width,
        height: blob.height,
        kind: blob.kind,
        roll: 0,
        seenAt: clock,
      })
    }
    const live = new Set(blobs.map((blob) => blob.id))
    for (const [id, box] of drawn) {
      // Dropped by the tracker, so it is gone. The frame it vanished from is
      // authoritative; there is nothing to fade towards.
      if (!live.has(id) && clock - box.seenAt > MAX_LEAD) drawn.delete(id)
    }
  }

  function advance(dt: number): boolean {
    clock += dt
    // Implicit critically damped spring: stable at any step, no overshoot.
    const follow = 1 - Math.exp(-dt / SPRING_TAU)
    let index = 0
    let wheel = 0
    let moving = false

    for (const box of drawn.values()) {
      const lead = Math.min(clock - box.seenAt, MAX_LEAD)
      const wantedX = box.target.x + box.velocity.x * lead
      const wantedZ = box.target.z + box.velocity.z * lead
      const dx = wantedX - box.position.x
      const dz = wantedZ - box.position.z
      const stepX = dx * follow
      const stepZ = dz * follow
      box.position.x += stepX
      box.position.z += stepZ

      // Rolled by how far it actually went, signed along its own heading, so a
      // wheel cannot turn while the body is still.
      const forwardX = Math.sin(box.heading)
      const forwardZ = Math.cos(box.heading)
      const travelled = stepX * forwardX + stepZ * forwardZ
      box.roll += travelled / (WHEEL_RADIUS * box.height)

      let turn = (box.targetHeading - box.heading) * follow
      const most = MAX_YAW_RATE * dt
      turn = Math.max(-most, Math.min(most, turn))
      box.heading += turn
      if (Math.abs(dx) + Math.abs(dz) > 1e-5 || Math.abs(turn) > 1e-5) moving = true

      if (index >= MAX_BOXES) break
      spin.setFromAxisAngle(up, box.heading)
      // Sitting on the road by construction: half its own height above zero,
      // so there is no arithmetic by which a box floats or sinks.
      scratch.position.set(box.position.x, box.height / 2, box.position.z)
      scratch.quaternion.copy(spin)
      scratch.scale.set(box.width, box.height, box.length)
      scratch.updateMatrix()
      mesh.setMatrixAt(index, scratch.matrix)
      mesh.setColorAt(index, colourFor(box.kind))

      scratch.position.y = 0.001
      scratch.scale.set(box.width * 1.25, 1, box.length * 1.12)
      scratch.updateMatrix()
      glow.setMatrixAt(index, scratch.matrix)
      index += 1

      // A person does not have wheels; everything else is presumed to until the
      // classifier says otherwise, since a street's traffic mostly does.
      if (box.kind === 2) continue
      const radius = WHEEL_RADIUS * box.height
      roll.setFromAxisAngle(axle, box.roll)
      scratch.quaternion.multiplyQuaternions(spin, roll)
      scratch.scale.set(WHEEL_WIDTH * box.width, radius * 2, radius * 2)
      for (const along of [WHEEL_ALONG, -WHEEL_ALONG]) {
        for (const across of [0.5, -0.5]) {
          const offsetX = forwardX * along * box.length + forwardZ * across * box.width
          const offsetZ = forwardZ * along * box.length - forwardX * across * box.width
          scratch.position.set(box.position.x + offsetX, radius, box.position.z + offsetZ)
          scratch.updateMatrix()
          wheels.setMatrixAt(wheel, scratch.matrix)
          wheel += 1
        }
      }
    }

    mesh.count = index
    glow.count = index
    wheels.count = wheel
    mesh.instanceMatrix.needsUpdate = true
    glow.instanceMatrix.needsUpdate = true
    wheels.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    return moving || index > 0
  }

  const colours = new Map<number, Color>()
  function colourFor(kind: number): Color {
    let colour = colours.get(kind)
    if (!colour) {
      colour = new Color(KIND_COLOURS[kind] ?? KIND_COLOURS[0])
      colours.set(kind, colour)
    }
    return colour
  }

  function dispose(): void {
    geometry.dispose()
    material.dispose()
    glowGeometry.dispose()
    glowMaterial.dispose()
    wheelGeometry.dispose()
    wheelMaterial.dispose()
    mesh.dispose()
    glow.dispose()
    wheels.dispose()
  }

  return { mesh, glow, wheels, accept, advance, count: () => drawn.size, dispose }
}

/** `angle`, moved by whole turns and half turns to sit nearest `near`. */
function fold(angle: number, near: number): number {
  let folded = angle
  while (folded - near > Math.PI / 2) folded -= Math.PI
  while (near - folded > Math.PI / 2) folded += Math.PI
  return folded
}
