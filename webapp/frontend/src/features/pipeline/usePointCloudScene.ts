// Concern: owns the three.js renderer/scene/camera/grid for one point cloud, RAII-disposed | Non-concern: fetching or parsing cloud.bin (cloud.ts) | IO: (container ref) -> scene handle
import { onMounted, onUnmounted, type Ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { PointCloud } from '@/types/pipeline'

export type ColorMode = 'rgb' | 'label'

export function usePointCloudScene(container: Ref<HTMLElement | null>) {
  let renderer: THREE.WebGLRenderer | null = null
  let scene: THREE.Scene | null = null
  let camera: THREE.PerspectiveCamera | null = null
  let controls: OrbitControls | null = null
  let geometry: THREE.BufferGeometry | null = null
  let material: THREE.PointsMaterial | null = null
  let points: THREE.Points | null = null
  let grid: THREE.GridHelper | null = null
  let resizeObserver: ResizeObserver | null = null

  let rgbColors: Float32Array | null = null
  let labelColors: Float32Array | null = null
  let colorMode: ColorMode = 'rgb'

  // Auto-fit only on first cloud or a material extent change, so orbiting persists between frames
  let hasFit = false
  let lastRadius = 0

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

  function disposeCloud(): void {
    if (points && scene) scene.remove(points)
    geometry?.dispose()
    material?.dispose()
    geometry = null
    material = null
    points = null
  }

  // Faint grid on the XZ plane, sized to the cloud footprint and dropped to its base so it reads as a floor
  function buildGrid(box: THREE.Box3): void {
    if (!scene) return
    disposeGrid()
    const size = new THREE.Vector3()
    box.getSize(size)
    const span = Math.max(size.x, size.z) * 1.35 || 1
    const center = new THREE.Vector3()
    box.getCenter(center)
    grid = new THREE.GridHelper(span, 24, 0x3a4250, 0x232a35)
    grid.position.set(center.x, box.min.y, center.z)
    const gridMaterial = grid.material as THREE.LineBasicMaterial
    gridMaterial.transparent = true
    gridMaterial.opacity = 0.3
    scene.add(grid)
  }

  // Frame the whole cloud from an oblique, slightly-elevated 3/4 angle with a small margin
  function fitCamera(sphere: THREE.Sphere): void {
    if (!camera || !controls) return
    const radius = sphere.radius > 0 ? sphere.radius : 1
    controls.target.copy(sphere.center)
    const vFov = (camera.fov * Math.PI) / 180
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
    const fitV = radius / Math.sin(vFov / 2)
    const fitH = radius / Math.sin(hFov / 2)
    const distance = Math.max(fitV, fitH) * 1.06
    const dir = new THREE.Vector3(0.85, 0.55, 1).normalize()
    camera.position.copy(sphere.center).addScaledVector(dir, distance)
    camera.near = Math.max(distance / 1000, 0.001)
    camera.far = distance * 100
    camera.updateProjectionMatrix()
    controls.update()
  }

  function setCloud(cloud: PointCloud): void {
    if (!scene) return
    disposeCloud()

    rgbColors = cloud.colors
    labelColors = cloud.labelColors

    geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
    const active = colorMode === 'rgb' ? rgbColors : labelColors
    geometry.setAttribute('color', new THREE.BufferAttribute(active, 3))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    const box = geometry.boundingBox
    const sphere = geometry.boundingSphere
    const radius = sphere && sphere.radius > 0 ? sphere.radius : 1

    // Scale point size to sphere radius and density so the cloud reads as a surface, not dust
    const spacing = radius / Math.sqrt(Math.max(cloud.count, 1))
    const size = THREE.MathUtils.clamp(spacing * 2.0, radius * 0.0015, radius * 0.035)
    material = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true })
    points = new THREE.Points(geometry, material)
    scene.add(points)

    if (box && sphere) {
      const changed = !hasFit || Math.abs(sphere.radius - lastRadius) > lastRadius * 0.25
      if (changed) {
        buildGrid(box)
        fitCamera(sphere)
        hasFit = true
        lastRadius = sphere.radius
      }
    }
    render()
  }

  function resetView(): void {
    if (!geometry) return
    const box = geometry.boundingBox
    const sphere = geometry.boundingSphere
    if (box) buildGrid(box)
    if (sphere) fitCamera(sphere)
    render()
  }

  function setColorMode(mode: ColorMode): void {
    colorMode = mode
    if (!geometry) return
    const active = mode === 'rgb' ? rgbColors : labelColors
    if (!active) return
    geometry.setAttribute('color', new THREE.BufferAttribute(active, 3))
    const attr = geometry.getAttribute('color') as THREE.BufferAttribute
    attr.needsUpdate = true
    render()
  }

  onMounted(() => {
    const el = container.value
    if (!el) return

    scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0c0e14)

    camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100)
    camera.position.set(0, 0, 2)

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(renderer.domElement)

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
    disposeGrid()
    disposeCloud()
    if (renderer) {
      renderer.domElement.remove()
      renderer.dispose()
      renderer = null
    }
    scene = null
    camera = null
    rgbColors = null
    labelColors = null
  })

  return { setCloud, setColorMode, resetView, resize }
}
