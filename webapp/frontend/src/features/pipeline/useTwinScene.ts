// Concern: own the three.js renderer/scene/camera/grid and draw the primitives a render frame hands it, RAII-disposed | Non-concern: fetch/parse render.json (render.ts) | IO: (container) -> scene
import { onMounted, onUnmounted, type Ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { RenderFrame, RenderPrimitive } from '@/types/pipeline'

export function useTwinScene(container: Ref<HTMLElement | null>) {
  let renderer: THREE.WebGLRenderer | null = null
  let scene: THREE.Scene | null = null
  let camera: THREE.PerspectiveCamera | null = null
  let controls: OrbitControls | null = null
  let grid: THREE.GridHelper | null = null
  let group: THREE.Group | null = null
  let resizeObserver: ResizeObserver | null = null

  // Geometry/material caches keyed by quantized dimensions/color so identical primitives share GPU resources across frames
  const geoCache = new Map<string, THREE.BufferGeometry>()
  const matCache = new Map<string, THREE.MeshStandardMaterial>()

  let hasFit = false
  let lastRadius = 0
  // The ground plane is constant per job, so the grid is rebuilt only when the extent/height actually change
  let gridKey = ''

  function render(): void {
    if (renderer && scene && camera) renderer.render(scene, camera)
  }

  function resize(): void {
    if (!renderer || !camera || !container.value) return
    const { clientWidth, clientHeight } = container.value
    if (clientWidth === 0 || clientHeight === 0) return
    renderer.setSize(clientWidth, clientHeight, false)
    camera.aspect = clientWidth / clientHeight
    camera.updateProjectionMatrix()
    render()
  }

  function disposeGrid(): void {
    if (grid && scene) scene.remove(grid)
    grid?.geometry.dispose()
    ;(grid?.material as THREE.Material | undefined)?.dispose()
    grid = null
  }

  // Remove and drop only the per-frame meshes; cached geometries/materials outlive the frame
  function clearGroup(): void {
    if (!group) return
    for (const child of [...group.children]) group.remove(child)
  }

  function q(n: number): number {
    return Math.round(n * 1000) / 1000
  }

  function boxGeometry(size: [number, number, number]): THREE.BufferGeometry {
    const key = `${q(size[0])}:${q(size[1])}:${q(size[2])}`
    let geo = geoCache.get(key)
    if (!geo) {
      geo = new THREE.BoxGeometry(size[0], size[1], size[2])
      geoCache.set(key, geo)
    }
    return geo
  }

  function material(color: [number, number, number]): THREE.MeshStandardMaterial {
    const key = `${q(color[0])}:${q(color[1])}:${q(color[2])}`
    let mat = matCache.get(key)
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color[0], color[1], color[2]), roughness: 0.65, metalness: 0.08 })
      matCache.set(key, mat)
    }
    return mat
  }

  // Shape dispatch: each entry builds a mesh from data alone; an unknown shape returns null and is skipped
  const shapeBuilders: Record<string, (p: RenderPrimitive) => THREE.Object3D> = {
    box(p) {
      return new THREE.Mesh(boxGeometry(p.size), material(p.color))
    }
  }

  function buildPrimitive(p: RenderPrimitive): THREE.Object3D | null {
    const builder = shapeBuilders[p.shape]
    if (!builder) return null
    const mesh = builder(p)
    mesh.position.set(p.position[0], p.position[1], p.position[2])
    mesh.rotation.y = p.rotation_y
    return mesh
  }

  function fitCamera(sphere: THREE.Sphere): void {
    if (!camera || !controls) return
    const radius = sphere.radius > 0 ? sphere.radius : 8
    controls.target.copy(sphere.center)
    const vFov = (camera.fov * Math.PI) / 180
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
    const fitV = radius / Math.sin(vFov / 2)
    const fitH = radius / Math.sin(hFov / 2)
    const distance = Math.max(fitV, fitH) * 1.1
    const dir = new THREE.Vector3(0.7, 0.6, 1).normalize()
    camera.position.copy(sphere.center).addScaledVector(dir, distance)
    camera.near = Math.max(distance / 1000, 0.01)
    camera.far = distance * 100
    camera.updateProjectionMatrix()
    controls.update()
  }

  // Draw the ground grid spanning the given extent at the given height
  function buildGrid(extent: [number, number, number, number], y: number): void {
    if (!scene) return
    disposeGrid()
    const width = Math.abs(extent[2] - extent[0])
    const depth = Math.abs(extent[3] - extent[1])
    const span = Math.max(width, depth) || 20
    const cx = (extent[0] + extent[2]) / 2
    const cz = (extent[1] + extent[3]) / 2
    grid = new THREE.GridHelper(span, 24, 0x3a4250, 0x232a35)
    grid.position.set(cx, y, cz)
    const gridMaterial = grid.material as THREE.LineBasicMaterial
    gridMaterial.transparent = true
    gridMaterial.opacity = 0.32
    scene.add(grid)
  }

  function setFrame(frame: RenderFrame): void {
    if (!scene || !group) return
    clearGroup()

    const box = new THREE.Box3()
    for (const p of frame.primitives) {
      const mesh = buildPrimitive(p)
      if (!mesh) continue
      group.add(mesh)
      box.expandByPoint(new THREE.Vector3(p.position[0], p.position[1], p.position[2]))
    }

    const { extent, y } = frame.ground
    box.expandByPoint(new THREE.Vector3(extent[0], y, extent[1]))
    box.expandByPoint(new THREE.Vector3(extent[2], y, extent[3]))
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, y, 0), new THREE.Vector3(20, 1, 20))

    box.expandByScalar(1.5)
    const sphere = new THREE.Sphere()
    box.getBoundingSphere(sphere)
    const changed = !hasFit || Math.abs(sphere.radius - lastRadius) > lastRadius * 0.4
    const nextGridKey = `${q(extent[0])}:${q(extent[1])}:${q(extent[2])}:${q(extent[3])}:${q(y)}`
    if (nextGridKey !== gridKey) {
      buildGrid(extent, y)
      gridKey = nextGridKey
    }
    if (changed) {
      fitCamera(sphere)
      hasFit = true
      lastRadius = sphere.radius
    }
    render()
  }

  function resetView(): void {
    if (!group) return
    const box = new THREE.Box3().setFromObject(group)
    if (grid) box.expandByObject(grid)
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(20, 1, 20))
    const sphere = new THREE.Sphere()
    box.getBoundingSphere(sphere)
    fitCamera(sphere)
    render()
  }

  onMounted(() => {
    const el = container.value
    if (!el) return

    scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0c0e14)

    camera = new THREE.PerspectiveCamera(55, 1, 0.01, 1000)
    camera.position.set(0, 8, 12)

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0xffffff, 0.75))
    const key = new THREE.DirectionalLight(0xffffff, 0.9)
    key.position.set(4, 10, 6)
    scene.add(key)

    group = new THREE.Group()
    scene.add(group)

    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.12
    controls.rotateSpeed = 0.8
    controls.addEventListener('change', render)

    resizeObserver = new ResizeObserver(() => resize())
    resizeObserver.observe(el)
    resize()
  })

  onUnmounted(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
    controls?.removeEventListener('change', render)
    controls?.dispose()
    controls = null
    clearGroup()
    disposeGrid()
    if (group && scene) scene.remove(group)
    group = null
    for (const geo of geoCache.values()) geo.dispose()
    for (const mat of matCache.values()) mat.dispose()
    geoCache.clear()
    matCache.clear()
    if (renderer) {
      renderer.domElement.remove()
      renderer.dispose()
      renderer = null
    }
    scene = null
    camera = null
  })

  return { setFrame, resetView, resize }
}
