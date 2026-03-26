/**
 * Eval Rubrics — deterministic scoring for eval workflows.
 *
 * Only rubric: objectDistance — Euclidean distance from agent to target bbox surface.
 */

export interface Vec3 { x: number; y: number; z: number; }

export interface AssetEntry {
  title?: string;
  id?: string;
  transform?: { x?: number; y?: number; z?: number };
  _bbox?: { w: number; h: number; d: number };
}

export interface SceneState {
  assets?: AssetEntry[];
  agentPos?: Vec3;
}

export interface ObjectDistanceCriteria {
  object: string;
  target: string;
  thresholdM?: number;
}

export interface ObjectDistanceResult {
  pass: boolean;
  distanceM: number;
  details: string;
}

export function scoreObjectDistance(criteria: ObjectDistanceCriteria, sceneState: SceneState): ObjectDistanceResult {
  const { target: targetName, thresholdM = 0.5 } = criteria;

  if (!sceneState.agentPos) {
    return { pass: false, distanceM: Infinity, details: "Agent position not available" };
  }

  const targetHit = _findTarget(targetName, sceneState);
  if (!targetHit) {
    return { pass: false, distanceM: Infinity, details: `Target "${targetName}" not found in scene` };
  }

  const dist = _distToSurface(sceneState.agentPos, targetHit.pos, targetHit.bbox);

  return {
    pass: dist <= thresholdM,
    distanceM: Math.round(dist * 1000) / 1000,
    details: `agent is ${dist.toFixed(3)}m from "${targetName}" surface (threshold: ${thresholdM}m)`,
  };
}

function _distToSurface(from: Vec3, center: Vec3, bbox?: { w: number; h: number; d: number }): number {
  if (!bbox) {
    const dx = from.x - center.x, dy = from.y - center.y, dz = from.z - center.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const hw = bbox.w / 2, hh = bbox.h / 2, hd = bbox.d / 2;
  const cx = Math.max(center.x - hw, Math.min(from.x, center.x + hw));
  const cy = Math.max(center.y - hh, Math.min(from.y, center.y + hh));
  const cz = Math.max(center.z - hd, Math.min(from.z, center.z + hd));
  const dx = from.x - cx, dy = from.y - cy, dz = from.z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function _findTarget(name: string, sceneState: SceneState): { pos: Vec3; bbox?: { w: number; h: number; d: number } } | null {
  const lower = name.toLowerCase();
  if (!sceneState.assets) return null;
  for (const asset of sceneState.assets) {
    if (asset.title?.toLowerCase().includes(lower) || asset.id?.toLowerCase().includes(lower)) {
      if (asset.transform) {
        return {
          pos: { x: asset.transform.x || 0, y: asset.transform.y || 0, z: asset.transform.z || 0 },
          bbox: asset._bbox,
        };
      }
    }
  }
  return null;
}
