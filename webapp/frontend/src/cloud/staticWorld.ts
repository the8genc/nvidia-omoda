// The clip's static world, fetched once from the backend.
//
// It is reconstructed there at startup, at the largest grid the model takes and
// from far more of the clip than a stream could average, then kept for the life
// of the process. So this is a document to fetch when a clip is chosen, not
// something to rebuild from frames as they arrive — and the live stream stands
// on the same ground plane it was levelled against, so the two line up.

/** The clip's static world, decoded from `/api/local/d4rt-world`. */
export interface StaticWorld {
  gridSide: number
  numPoints: number
  radius: number
  /** [3] where the real camera sits, in the world's own frame. */
  camera: Float32Array
  /** [N * 3] world-space, in the same units and axes as a live frame. */
  positions: Float32Array
  /** [N] surface class per point. */
  labels: Uint8Array
}

/** Matches `_WORLD_HEADER` in `backend/d4rt_backend/api.py`. */
const HEADER_BYTES = 24
/** Matches `QUANT_SCALE` in `useLiveCloudStream.ts` — the same wire convention. */
const QUANT_SCALE = 32000

export function decodeStaticWorld(buffer: ArrayBuffer): StaticWorld {
  const header = new DataView(buffer, 0, HEADER_BYTES)
  const gridSide = header.getUint32(0, true)
  const numPoints = header.getUint32(4, true)
  const radius = header.getFloat32(8, true)
  // Same axis flip the points get, so the camera stays where it belongs.
  const camera = new Float32Array([
    header.getFloat32(12, true),
    -header.getFloat32(16, true),
    -header.getFloat32(20, true),
  ])

  const quantised = new Int16Array(buffer, HEADER_BYTES, numPoints * 3)
  // The world's own per-point spread follows the labels. The detector on the
  // backend is what needs it; nothing here reads it, so it is simply not sliced.
  const labels = new Uint8Array(buffer.slice(HEADER_BYTES + numPoints * 6, HEADER_BYTES + numPoints * 7))
  const positions = new Float32Array(numPoints * 3)
  // Same axis flip as the live frames: the reconstruction's y and z both point
  // the other way from three.js's.
  for (let i = 0; i < numPoints * 3; i += 3) {
    positions[i] = quantised[i] / QUANT_SCALE
    positions[i + 1] = -quantised[i + 1] / QUANT_SCALE
    positions[i + 2] = -quantised[i + 2] / QUANT_SCALE
  }
  return { gridSide, numPoints, radius, camera, positions, labels }
}
