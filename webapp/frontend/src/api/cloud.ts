// Concern: decodes a little-endian cloud.bin buffer into a PointCloud | Non-concern: fetching or rendering it (PointCloudPanel/scene own that) | IO: (ArrayBuffer) -> PointCloud
import type { PointCloud } from '@/types/pipeline'

export function parseCloudBin(buffer: ArrayBuffer): PointCloud {
  const view = new DataView(buffer)
  const count = view.getUint32(0, true)

  let offset = 4
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count * 3; i++) {
    positions[i] = view.getFloat32(offset, true)
    offset += 4
  }

  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count * 3; i++) {
    colors[i] = view.getUint8(offset) / 255
    offset += 1
  }

  const labelColors = new Float32Array(count * 3)
  for (let i = 0; i < count * 3; i++) {
    labelColors[i] = view.getUint8(offset) / 255
    offset += 1
  }

  return { count, positions, colors, labelColors }
}
