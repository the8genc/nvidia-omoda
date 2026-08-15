// Concern: validate a class-free render.json payload into a RenderFrame, failing fast | Non-concern: fetching or drawing it (PrimitiveTwinPanel/useTwinScene) | IO: (unknown, index) -> RenderFrame
import type { RenderFrame, RenderGround, RenderPrimitive } from '@/types/pipeline'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// The backend owns this closed contract, so a shape mismatch is a real defect: throw rather than coerce or silently drop
function numbers(v: unknown, n: number, field: string): number[] {
  if (!Array.isArray(v) || v.length !== n || v.some((x) => typeof x !== 'number')) {
    throw new Error(`render.json: ${field} must be ${n} numbers, got ${JSON.stringify(v)}`)
  }
  return v as number[]
}

function parsePrimitive(raw: unknown): RenderPrimitive {
  if (!isRecord(raw) || typeof raw.shape !== 'string') throw new Error(`render.json: malformed primitive ${JSON.stringify(raw)}`)
  if (typeof raw.rotation_y !== 'number') throw new Error('render.json: primitive.rotation_y must be a number')
  return {
    shape: raw.shape,
    size: numbers(raw.size, 3, 'primitive.size') as [number, number, number],
    position: numbers(raw.position, 3, 'primitive.position') as [number, number, number],
    rotation_y: raw.rotation_y,
    color: numbers(raw.color, 3, 'primitive.color') as [number, number, number]
  }
}

function parseGround(raw: unknown): RenderGround {
  if (!isRecord(raw) || typeof raw.y !== 'number') throw new Error('render.json: malformed ground')
  return { extent: numbers(raw.extent, 4, 'ground.extent') as [number, number, number, number], y: raw.y }
}

export function parseRenderFrame(raw: unknown, index: number): RenderFrame {
  if (!isRecord(raw) || !Array.isArray(raw.primitives)) throw new Error('render.json: missing primitives array')
  const frame = typeof raw.frame === 'number' ? raw.frame : index
  return { frame, ground: parseGround(raw.ground), primitives: raw.primitives.map(parsePrimitive) }
}
