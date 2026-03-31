/**
 * SceneEditor — Browser-side script execution engine.
 *
 * Receives {type: "exec", code, id?} commands via the DimosBridge control WS,
 * evaluates user JS with full Three.js + Rapier globals exposed, and returns
 * {type: "execResult", id, success, result?, error?}.
 *
 * Must NOT modify engine.js — hooks into DimosBridge WS the same way EvalHarness does.
 */

import type { DimosBridge } from "./dimosBridge.ts";

export interface SceneEditorGlobals {
  scene: any;         // THREE.Scene
  THREE: any;         // Three.js namespace
  RAPIER: any;        // Rapier namespace (may be null until ensureRapierLoaded)
  rapierWorld: any;   // Rapier.World (may be null)
  worldBody: any;     // Fixed RigidBody for static colliders
  renderer: any;      // THREE.WebGLRenderer
  camera: any;        // THREE.PerspectiveCamera
  agent: any;         // Player agent (has getPosition, setPosition, group)
  assets: any[];      // Scene assets array
  assetsGroup: any;   // THREE.Group containing loaded asset meshes
  gltfLoader: any;    // THREE GLTFLoader instance
}

export interface SceneEditorOptions {
  bridge: DimosBridge;
  globals: SceneEditorGlobals;
  channel?: string;
}

// AsyncFunction constructor — allows top-level await in user scripts
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export class SceneEditor {
  bridge: DimosBridge;
  globals: SceneEditorGlobals;
  channel: string;

  constructor({ bridge, globals, channel }: SceneEditorOptions) {
    this.bridge = bridge;
    this.globals = globals;
    this.channel = channel || "";
    this._hookBridgeMessages();
  }

  _hookBridgeMessages(): void {
    const origConnect = this.bridge.connect.bind(this.bridge);
    this.bridge.connect = () => {
      origConnect();
      setTimeout(() => {
        const ws = this.bridge.ws;
        if (ws) this._patchWsOnMessage(ws);
      }, 100);
    };
    const ws = this.bridge.ws;
    if (ws) this._patchWsOnMessage(ws);
  }

  _patchWsOnMessage(ws: WebSocket): void {
    const origOnMessage = ws.onmessage;
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const cmd = JSON.parse(event.data);
          if (cmd.type === "exec" || cmd.type === "loadScript") {
            this._handleCommand(cmd);
            return;
          }
        } catch { /* not JSON or not for us */ }
      }
      // Pass through to existing handlers (EvalHarness, DimosBridge)
      if (origOnMessage) (origOnMessage as (e: MessageEvent) => void).call(ws, event);
    };
  }

  _send(msg: Record<string, any>): void {
    if (this.channel) msg.channel = this.channel;
    this.bridge.sendCommand(msg);
  }

  async _handleCommand(cmd: { type: string; code?: string; url?: string; id?: string; channel?: string }): Promise<void> {
    if (this.channel && cmd.channel && cmd.channel !== this.channel) return;

    if (cmd.type === "exec" && cmd.code) {
      await this._execCode(cmd.code, cmd.id);
    } else if (cmd.type === "loadScript" && cmd.url) {
      await this._loadScript(cmd.url, cmd.id);
    }
  }

  // Track colliders created by addCollider so removeCollider can clean up
  _colliderMap: Map<string, any> = new Map(); // mesh.uuid → Rapier collider

  async _execCode(code: string, id?: string): Promise<void> {
    console.log(`[sceneEditor] exec${id ? ` (${id})` : ""}:`, code.slice(0, 100));
    try {
      const g = this.globals;
      const colliderMap = this._colliderMap;

      // loadGLTF: convenience async helper for loading GLTF/GLB models
      const loadGLTF = (url: string): Promise<any> =>
        new Promise((resolve, reject) =>
          g.gltfLoader.load(url, resolve, undefined, reject),
        );

      // addCollider: create a physics collider for a mesh/group
      // shape: "box" (default) | "sphere" | "trimesh"
      const addCollider = (obj: any, shape?: string): any => {
        if (!g.RAPIER || !g.rapierWorld) throw new Error("Rapier not loaded");
        shape = shape || "box";

        // Remove existing collider if any
        removeCollider(obj);

        const bbox = new g.THREE.Box3().setFromObject(obj);
        const size = new g.THREE.Vector3();
        const center = new g.THREE.Vector3();
        bbox.getSize(size);
        bbox.getCenter(center);

        const clamp = (v: number) => Math.max(v, 0.001);
        let desc: any;

        if (shape === "sphere") {
          const r = clamp(Math.max(size.x, size.y, size.z) / 2);
          desc = g.RAPIER.ColliderDesc.ball(r);
          desc.setTranslation(center.x, center.y, center.z);
        } else if (shape === "trimesh") {
          // Build trimesh from all child meshes
          const verts: number[] = [];
          const indices: number[] = [];
          let vertBase = 0;
          obj.traverse((m: any) => {
            if (!m.isMesh) return;
            const geom = m.geometry;
            const posAttr = geom?.attributes?.position;
            if (!posAttr) return;
            const tmpPos = new g.THREE.Vector3();
            for (let i = 0; i < posAttr.count; i++) {
              tmpPos.fromBufferAttribute(posAttr, i).applyMatrix4(m.matrixWorld);
              verts.push(tmpPos.x, tmpPos.y, tmpPos.z);
            }
            if (geom.index) {
              for (let i = 0; i < geom.index.count; i++) indices.push(geom.index.getX(i) + vertBase);
            } else {
              for (let i = 0; i < posAttr.count; i++) indices.push(vertBase + i);
            }
            vertBase += posAttr.count;
          });
          if (verts.length < 9 || indices.length < 3) throw new Error("Not enough geometry for trimesh");
          desc = g.RAPIER.ColliderDesc.trimesh(
            new Float32Array(verts), new Uint32Array(indices)
          );
        } else {
          // box (default)
          desc = g.RAPIER.ColliderDesc.cuboid(
            clamp(size.x / 2), clamp(size.y / 2), clamp(size.z / 2)
          );
          desc.setTranslation(center.x, center.y, center.z);
        }

        desc.setFriction(0.9);
        const collider = g.rapierWorld.createCollider(desc);
        colliderMap.set(obj.uuid, collider);
        return { shape, uuid: obj.uuid, size: { x: +size.x.toFixed(3), y: +size.y.toFixed(3), z: +size.z.toFixed(3) } };
      };

      // removeCollider: remove a previously added collider
      const removeCollider = (obj: any): boolean => {
        const existing = colliderMap.get(obj.uuid);
        if (!existing) return false;
        try {
          g.rapierWorld.removeCollider(existing, true);
        } catch { /* already removed */ }
        colliderMap.delete(obj.uuid);
        return true;
      };

      const fn = new AsyncFunction(
        "scene", "THREE", "RAPIER", "rapierWorld", "renderer", "camera",
        "agent", "playerBody", "assets", "assetsGroup",
        "loadGLTF", "addCollider", "removeCollider",
        code,
      );
      const result = await fn(
        g.scene, g.THREE, g.RAPIER, g.rapierWorld, g.renderer, g.camera,
        g.agent, g.agent, g.assets, g.assetsGroup,
        loadGLTF, addCollider, removeCollider,
      );
      this._send({ type: "execResult", id, success: true, result: _serialize(result) });
    } catch (err: any) {
      console.error("[sceneEditor] exec error:", err);
      this._send({ type: "execResult", id, success: false, error: String(err) });
    }
  }

  async _loadScript(url: string, id?: string): Promise<void> {
    console.log(`[sceneEditor] loadScript${id ? ` (${id})` : ""}:`, url);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      const code = await resp.text();
      await this._execCode(code, id);
    } catch (err: any) {
      console.error("[sceneEditor] loadScript error:", err);
      this._send({ type: "execResult", id, success: false, error: String(err) });
    }
  }

  dispose(): void {
    // No resources to clean up
  }
}

/** Safely serialize a return value for JSON transport. */
function _serialize(val: any): any {
  if (val === undefined || val === null) return val;
  if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") return val;
  if (Array.isArray(val)) return val.map(_serialize);
  // Three.js objects have .toJSON() but it's huge — just return type + id
  if (val.isObject3D) return { _type: "Object3D", type: val.type, name: val.name, uuid: val.uuid };
  if (val.isMesh) return { _type: "Mesh", name: val.name, uuid: val.uuid };
  try { return JSON.parse(JSON.stringify(val)); } catch { return String(val); }
}
