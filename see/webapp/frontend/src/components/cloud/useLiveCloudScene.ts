// Owns the Three.js scene for a stream of pushed frames: buffers, orbit camera,
// render loop, disposal. The batch viewer's scene draws a cloud it already has;
// this one is handed one frame at a time and never knows what comes next.

import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  GridHelper,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

import type { StaticWorld } from '@/cloud/staticWorld'
import { isReplaced, MOVING, SURFACE_COLOURS } from '@/cloud/tileWorld'

import { createBlobBoxes } from './blobBoxes'
import { createSurfaceMesh, type SurfaceMesh } from './surfaceMesh'
import type { LiveFrame } from '@/cloud/useLiveCloudStream'

/**
 * How far back to stand from where the real camera was, as a multiple of its
 * distance to the scene. Standing exactly on it would reproduce the flat 2D view
 * with no parallax; a little behind keeps the orientation and shows the depth.
 */
const VIEWPOINT_PULLBACK = 1.5
/**
 * Swing this far around the vertical from the real camera's bearing. Straight
 * down its own axis reproduces the flat photograph with no parallax, which is
 * the one view that hides the reconstruction; a three-quarter angle keeps the
 * scene the right way round and shows its depth.
 */
const VIEWPOINT_SWING = -Math.PI / 4
/**
 * How high to stand above the ground, in radians of elevation.
 *
 * The world is flat by construction, so a low eye sees it edge-on as a ribbon —
 * the one angle at which a laid-out street reads as nothing at all. Looking down
 * on it is what makes the road, the kerbs and the paint legible as a plan, and
 * it is the angle a car's own display uses for the same reason.
 */
const VIEWPOINT_ELEVATION = Math.PI / 4.6
/** Only used until the first frame arrives and says where the camera really is. */
const FALLBACK_DIRECTION = new Vector3(0.45, 0.22, -1).normalize()
const UP = new Vector3(0, 1, 0)
/** Fraction trimmed from each tail when sizing the view from the first frame. */
const RADIUS_PERCENTILE = 0.95
/** Slight overlap, so neighbouring cells meet rather than leaving hairlines. */
const SPACING_OVERLAP = 1.25
/** Grid extent as a multiple of the scene radius, and how many cells across. */
const GRID_SPAN = 4
const GRID_DIVISIONS = 32
/**
 * How far the real camera must move, relative to the scene, before the world is
 * considered to be in a different place and is gathered again. Levelling and
 * unlevelling move it a long way; the scale anchor's per-frame correction does
 * not come close.
 */
/**
 * Where a point stops being street and starts being overhang, and where it has
 * faded out entirely — heights above the levelled road, in the same units the
 * points arrive in.
 *
 * Everything interesting happens near the ground. Awnings, wires, foliage and
 * the tops of buildings are all reconstructed far less reliably than the road
 * is, and they crowd the very thing the display is about; fading them off with
 * height keeps the street legible without a hard ceiling that would cut the
 * scene off at a visible line. Measured against where the points actually are:
 * on a levelled clip they run from the road to about 0.21, so a car or a person
 * is comfortably below the start of the fade and an awning is not.
 */
const FADE_FROM = 0.06
const FADE_TO = 0.18
/**
 * And the same outwards, as a multiple of the world's own extent. Past the edge
 * of the street the fixed camera is looking at its far field, where a few pixels
 * of parallax stand in for tens of metres; what comes back is a curtain of
 * points around the scene rather than anything in it.
 */
const EDGE_FROM = 0.85
const EDGE_TO = 1.35

/** 1 at street level, falling to 0 by `FADE_TO`. */
function heightFade(y: number): number {
  if (y <= FADE_FROM) return 1
  if (y >= FADE_TO) return 0
  const t = (y - FADE_FROM) / (FADE_TO - FADE_FROM)
  return (1 - t) * (1 - t)
}

export type LiveColorMode = 'rgb' | 'depth' | 'class'

/**
 * The two things there are to look at, and never both.
 *
 * They are the same street twice: `points` is what was measured, `model` is what
 * the measurement was replaced with. Drawn together they only obscure each other
 * — the cloud speckles the surface it sits on and hides the boxes — and the
 * comparison that matters is between the two views, not inside one of them.
 */
export type LiveView = 'points' | 'model'

export interface LiveCloudScene {
  /** Draw a freshly arrived frame. Sizes the camera from the first one only. */
  push: (frame: LiveFrame) => void
  setColorMode: (mode: LiveColorMode) => void
  /** Show the y=0 plane — where levelling puts the road. */
  setShowGround: (show: boolean) => void
  /** Show the measurement or the model — never both at once. */
  setView: (view: LiveView) => void
  /** Lay out the world the backend built for this clip. */
  setWorld: (world: StaticWorld | null) => void
  surfaceQuads: () => number
  /** How many moving things are being drawn. */
  trackedBlobs: () => number
  resetView: () => void
  dispose: () => void
}

function framing(source: { positions: Float32Array; numPoints: number }): {
  centre: Vector3
  radius: number
} {
  const { positions, numPoints } = source
  const centre = new Vector3()
  for (let i = 0; i < numPoints; i += 1) {
    centre.x += positions[i * 3]
    centre.y += positions[i * 3 + 1]
    centre.z += positions[i * 3 + 2]
  }
  centre.divideScalar(Math.max(1, numPoints))

  const distances = new Float32Array(numPoints)
  for (let i = 0; i < numPoints; i += 1) {
    const dx = positions[i * 3] - centre.x
    const dy = positions[i * 3 + 1] - centre.y
    const dz = positions[i * 3 + 2] - centre.z
    distances[i] = Math.hypot(dx, dy, dz)
  }
  distances.sort()
  const radius = distances[Math.floor((numPoints - 1) * RADIUS_PERCENTILE)] || 1
  return { centre, radius }
}

/**
 * World-space size for every point: one scalar times distance from the camera.
 *
 * A screen-uniform grid covers a world cell of `depth * cellAngle`, so sizing a
 * point that way tiles its cell at every depth. `compensation` corrects three.js,
 * whose point shader omits the `1/tan(fov/2)` term and so undersizes at any field
 * of view narrower than 90 degrees.
 */
function fillSizes(
  frame: LiveFrame,
  sizes: Float32Array,
  compensation: number,
  fade: (index: number) => number,
  hidden: (label: number) => boolean,
): void {
  const { positions, numPoints, camera, pointScale, labels } = frame
  const scale = pointScale * SPACING_OVERLAP * compensation
  for (let index = 0; index < numPoints; index += 1) {
    // The static half of the scene is the surface now. Sizing those points to
    // nothing is how they leave: the cloud keeps only what is passing through.
    const at = index * 3
    if (hidden(labels[index]) || fade(index) <= 0) {
      sizes[index] = 0
      continue
    }
    sizes[index] =
      scale *
      Math.hypot(
        positions[at] - camera[0],
        positions[at + 1] - camera[1],
        positions[at + 2] - camera[2],
      )
  }
}

export function createLiveCloudScene(
  canvas: HTMLCanvasElement,
  numPoints: number,
  initialMode: LiveColorMode,
): LiveCloudScene {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
  // Without tone mapping the pale surfaces clip to white the moment the sun and
  // the environment are both on them, and the navy road reads as grey.
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05

  const scene = new Scene()
  const camera = new PerspectiveCamera(50, 1, 0.01, 200)

  // Something for the road to reflect. A metal surface with no environment is
  // just a black one, so the sheen needs a source: a procedural room, filtered
  // once into a cube map, costs nothing per frame and carries no assets.
  const pmrem = new PMREMGenerator(renderer)
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = environment.texture
  // Turned right down: the room is a bright studio, and a polished road
  // reflecting it at full strength looks like haze lying on the tarmac. What is
  // wanted from it is the shape of a highlight, not its brightness.
  scene.environmentIntensity = 0.25

  // A cold key light, not a sun: the surfaces carry their own emission, so this
  // is here to strike a highlight off the polished road and throw a kerb's
  // shadow, not to illuminate the scene.
  const sun = new DirectionalLight(0x9fd8ff, 1.1)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0008
  scene.add(sun, sun.target)
  scene.add(new HemisphereLight(0x4f7dff, 0x02040a, 0.35))
  const target = new Vector3()

  const geometry = new BufferGeometry()
  const positionBuffer = new Float32Array(numPoints * 3)
  const colorBuffer = new Float32Array(numPoints * 3)
  const sizeBuffer = new Float32Array(numPoints)
  const positionAttribute = new BufferAttribute(positionBuffer, 3)
  const colorAttribute = new BufferAttribute(colorBuffer, 3)
  const sizeAttribute = new BufferAttribute(sizeBuffer, 1)
  positionAttribute.setUsage(DynamicDrawUsage)
  colorAttribute.setUsage(DynamicDrawUsage)
  sizeAttribute.setUsage(DynamicDrawUsage)
  geometry.setAttribute('position', positionAttribute)
  geometry.setAttribute('color', colorAttribute)
  geometry.setAttribute('aSize', sizeAttribute)

  const material = new PointsMaterial({
    // The per-point attribute carries the real size; this stays 1 so it is a
    // plain multiplier rather than a second scale to keep in step.
    size: 1,
    vertexColors: true,
    sizeAttenuation: true,
    transparent: false,
  })
  // Patch the stock shader rather than owning a whole ShaderMaterial: all that
  // is needed is one attribute multiplied in before the usual attenuation.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute float aSize;\nvoid main() {')
      .replace('gl_PointSize = size;', 'gl_PointSize = size * aSize;')
  }

  const points = new Points(geometry, material)
  points.frustumCulled = false
  scene.add(points)

  // The plane the anchor holds the road on. Built at unit size and scaled once
  // the scene is framed, so it always spans the cloud rather than a fixed extent.
  const ground = new GridHelper(1, GRID_DIVISIONS, 0x1e6f8f, 0x0d3346)
  ground.material.transparent = true
  ground.material.opacity = 0.3
  ground.visible = false
  scene.add(ground)

  // A soft bloom, held back deliberately. Enough that the paint and the kerb
  // edges catch the eye the way lit trim does in a car; past this it stops
  // reading as a street and starts reading as a light show.
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.32, 0.4, 0.95)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08

  /** Recomputed rather than cached: it follows the camera's field of view. */
  const sizeCompensation = (): number => 1 / Math.tan((camera.fov * Math.PI) / 360)

  /** Where the camera that made this scene sits, once a frame has told us. */
  const viewpoint = new Vector3()
  let hasViewpoint = false

  let surface: SurfaceMesh | null = null
  let quads = 0

  const blobs = createBlobBoxes()
  scene.add(blobs.mesh, blobs.glow, blobs.wheels)

  function setView(next: LiveView): void {
    view = next
    const model = next === 'model'
    points.visible = !model
    blobs.mesh.visible = model
    blobs.glow.visible = model
    blobs.wheels.visible = model
    if (surface) surface.mesh.visible = model
    needsRender = true
  }

  function setWorld(world: StaticWorld | null): void {
    surface?.dispose()
    if (surface) scene.remove(surface.mesh)
    surface = null
    quads = 0
    if (world) {
      surface = createSurfaceMesh(world.numPoints)
      surface.mesh.visible = view === 'model' 
      scene.add(surface.mesh)
      quads = surface.build(world)
      // The world is the scene: it is what the view should be about, and it is
      // the one thing that will not move. Framing on the live cloud instead
      // aims the camera at whatever traffic happens to be passing.
      frameOn(framing(world), world.camera)
    }
    needsRender = true
  }

  /** Point the camera and the sun at a measured centre and extent. */
  function frameOn(measured: { centre: Vector3; radius: number }, eye: ArrayLike<number>): void {
    target.copy(measured.centre)
    // The world lives on the ground plane, so that is what the view is about;
    // the centroid still sits wherever the leftover traffic happens to.
    target.y = 0
    sceneRadius = measured.radius
    viewpoint.set(eye[0], eye[1], eye[2])
    hasViewpoint = true
    ground.scale.setScalar(sceneRadius * GRID_SPAN)
    controls.minDistance = sceneRadius * 0.15
    controls.maxDistance = sceneRadius * 20
    // The sun follows the scene, so a kerb throws a shadow of a sensible length
    // whatever size the street turns out to be.
    sun.position.set(target.x + sceneRadius, sceneRadius * 1.6, target.z + sceneRadius * 0.7)
    sun.target.position.copy(target)
    sun.target.updateMatrixWorld()
    const reach = sceneRadius * 3
    sun.shadow.camera.left = -reach
    sun.shadow.camera.right = reach
    sun.shadow.camera.top = reach
    sun.shadow.camera.bottom = -reach
    sun.shadow.camera.far = sceneRadius * 8
    sun.shadow.camera.updateProjectionMatrix()
    sized = true
    resetView()
  }

  /** Quads in the last surface built, for the viewer to report. */
  function surfaceQuads(): number {
    return quads
  }

  let mode: LiveColorMode = initialMode
  let view: LiveView = 'model'
  let showGround = false
  let sized = false
  let sceneRadius = 1
  let needsRender = true
  let animationHandle = 0
  let disposed = false

  /**
   * How much of a point survives: full on the street, gone above it and gone
   * beyond it. Both falls are needed — the overhang is up, the far field is out,
   * and either one alone leaves the other crowding the street.
   */
  function pointFade(frame: LiveFrame): (index: number) => number {
    const { positions } = frame
    return (index: number): number => {
      const at = index * 3
      const height = heightFade(positions[at + 1])
      if (height <= 0) return 0
      const out =
        Math.hypot(positions[at] - target.x, positions[at + 2] - target.z) /
        Math.max(sceneRadius, 1e-6)
      if (out >= EDGE_TO) return 0
      if (out <= EDGE_FROM) return height
      const t = (out - EDGE_FROM) / (EDGE_TO - EDGE_FROM)
      return height * (1 - t) * (1 - t)
    }
  }

  function writeColors(frame: LiveFrame): void {
    const fade = pointFade(frame)
    if (mode === 'class') {
      for (let i = 0; i < frame.numPoints; i += 1) {
        const [r, g, b] = SURFACE_COLOURS[frame.labels[i]] ?? [0.35, 0.35, 0.4]
        const dim = fade(i)
        colorBuffer[i * 3] = r * dim
        colorBuffer[i * 3 + 1] = g * dim
        colorBuffer[i * 3 + 2] = b * dim
      }
      colorAttribute.needsUpdate = true
      return
    }
    if (mode === 'rgb') {
      for (let i = 0; i < frame.numPoints; i += 1) {
        const dim = fade(i)
        colorBuffer[i * 3] = frame.colors[i * 3] * dim
        colorBuffer[i * 3 + 1] = frame.colors[i * 3 + 1] * dim
        colorBuffer[i * 3 + 2] = frame.colors[i * 3 + 2] * dim
      }
      colorAttribute.needsUpdate = true
      return
    }
    // Depth ramp over this frame's own z spread — near warm, far cool.
    let low = Infinity
    let high = -Infinity
    for (let i = 0; i < frame.numPoints; i += 1) {
      const z = frame.positions[i * 3 + 2]
      if (z < low) low = z
      if (z > high) high = z
    }
    const span = Math.max(high - low, 1e-6)
    for (let i = 0; i < frame.numPoints; i += 1) {
      const t = (frame.positions[i * 3 + 2] - low) / span
      const dim = fade(i)
      colorBuffer[i * 3] = (1 - t) * dim
      colorBuffer[i * 3 + 1] = (0.35 + 0.3 * Math.sin(Math.PI * t)) * dim
      colorBuffer[i * 3 + 2] = t * dim
    }
    colorAttribute.needsUpdate = true
  }

  function resetView(): void {
    if (disposed) return
    controls.target.copy(target)
    if (hasViewpoint) {
      // Start from where the scene was actually filmed — guessing a direction
      // gets the side wrong half the time, and the header already carries it —
      // then swing off that axis so the depth is visible.
      const bearing = viewpoint.clone().sub(target)
      bearing.y = 0
      if (bearing.lengthSq() < 1e-9) bearing.copy(FALLBACK_DIRECTION)
      bearing.normalize().applyAxisAngle(UP, VIEWPOINT_SWING)
      const distance = viewpoint.distanceTo(target) * VIEWPOINT_PULLBACK
      camera.position
        .copy(target)
        .addScaledVector(bearing, distance * Math.cos(VIEWPOINT_ELEVATION))
        .addScaledVector(UP, distance * Math.sin(VIEWPOINT_ELEVATION))
    } else {
      camera.position
        .copy(target)
        .addScaledVector(FALLBACK_DIRECTION, sceneRadius * VIEWPOINT_PULLBACK)
    }
    camera.near = sceneRadius * 0.01
    camera.far = sceneRadius * 40
    camera.updateProjectionMatrix()
    controls.update()
    needsRender = true
  }

  function push(frame: LiveFrame): void {
    if (disposed || frame.numPoints * 3 !== positionBuffer.length) return
    viewpoint.set(frame.camera[0], frame.camera[1], frame.camera[2])
    hasViewpoint = true
    positionBuffer.set(frame.positions)
    positionAttribute.needsUpdate = true
    // A moving thing's points are gone in both views: in the model they are a
    // box, and in the cloud they are the pixels this whole thing exists to
    // remove. Static scenery is only redundant, so it stays in the cloud view.
    fillSizes(frame, sizeBuffer, sizeCompensation(), pointFade(frame), (label) =>
      view === 'model' ? isReplaced(label) : label === MOVING,
    )
    sizeAttribute.needsUpdate = true
    writeColors(frame)

    blobs.accept(frame.blobs)
    // Framed by the world where there is one; a clip without a world falls back
    // to the first frame's own extent.
    if (!sized) frameOn(framing(frame), frame.camera)

    needsRender = true
  }

  function setColorMode(next: LiveColorMode): void {
    mode = next
    needsRender = true
  }

  function setShowGround(show: boolean): void {
    showGround = show
    ground.visible = show
    needsRender = true
  }

  function resize(): void {
    if (disposed) return
    const width = Math.max(1, canvas.clientWidth)
    const height = Math.max(1, canvas.clientHeight)
    renderer.setSize(width, height, false)
    composer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    needsRender = true
  }

  const observer = new ResizeObserver(resize)
  observer.observe(canvas)

  let lastTick = 0
  function frameLoop(now: number = 0): void {
    animationHandle = requestAnimationFrame(frameLoop)
    const dt = lastTick ? Math.min((now - lastTick) / 1000, 0.1) : 1 / 60
    lastTick = now
    // The boxes are always moving between measurements, so a demand-driven loop
    // would only step them when the mouse did.
    const gliding = blobs.advance(dt)
    if (controls.update() || needsRender || gliding) {
      composer.render()
      needsRender = false
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(animationHandle)
    observer.disconnect()
    surface?.dispose()
    controls.dispose()
    geometry.dispose()
    material.dispose()
    ground.geometry.dispose()
    ground.material.dispose()
    blobs.dispose()
    environment.texture.dispose()
    pmrem.dispose()
    composer.dispose()
    renderer.dispose()
  }

  // Opaque and nearly black: bloom reads the rendered frame, so a transparent
  // canvas over the page would have nothing to bleed into.
  scene.background = new Color(0x03060f)
  renderer.setClearColor(new Color(0x03060f), 1)
  resize()
  resetView()
  frameLoop()

  setShowGround(showGround)
  return {
    push,
    setColorMode,
    setShowGround,
    setView,
    setWorld,
    surfaceQuads,
    trackedBlobs: () => blobs.count(),
    resetView,
    dispose,
  }
}
