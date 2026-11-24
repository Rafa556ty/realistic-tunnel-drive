/**
 * Bugatti Chiron quad-LED headlights: four separate LED projector modules per
 * side in a dark housing, lit day and night (they double as daytime running
 * lights), like the real car. Built once per player model as two merged
 * meshes (LED faces + soft glow) so they cost two draw calls.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Lamp materials of each Chiron model (front lamp glass / emitters). */
const LAMP_MATERIALS: Record<string, RegExp> = {
  chiron: /^ChironMI_(Light1|Glass_Light1)$/,
  "chiron-ss300": /^(CSR2_Light|headlight|Park_light)$/,
};

export const hasQuadLeds = (carKey: string) => carKey in LAMP_MATERIALS;

/** Glow opacity: DRL by day, brighter at night, softer in the lit tunnel. */
export function ledGlow(lightsOn: boolean, inTunnel: boolean, highBeam: boolean) {
  if (highBeam) return 0.55;
  if (!lightsOn) return 0.12;
  return inTunnel ? 0.2 : 0.4;
}

let ledTex: THREE.CanvasTexture | null = null;
let glowTex: THREE.CanvasTexture | null = null;

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const c = cv.getContext("2d");
  if (!c) throw Error("Canvas context unavailable");
  draw(c);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rounded(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function ledTexture() {
  return (ledTex ??= canvasTex(128, 96, (c) => {
    c.clearRect(0, 0, 128, 96);
    // dark chrome bezel
    rounded(c, 6, 8, 116, 80, 20);
    c.fillStyle = "rgba(22,26,32,0.95)";
    c.fill();
    // bright LED face, cool white
    const g = c.createRadialGradient(64, 48, 4, 64, 48, 56);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.55, "#f4f9ff");
    g.addColorStop(1, "#bcd8ff");
    rounded(c, 16, 18, 96, 60, 13);
    c.fillStyle = g;
    c.fill();
    // projector lens ring
    c.strokeStyle = "rgba(150,180,215,0.65)";
    c.lineWidth = 3;
    rounded(c, 22, 24, 84, 48, 10);
    c.stroke();
  }));
}

function glowTexture() {
  return (glowTex ??= canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.3, "rgba(225,238,255,0.35)");
    g.addColorStop(1, "rgba(200,220,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  }));
}

/** Per-side lamp boxes (car-local) from the lamp meshes at the front of the car. */
function lampBoxes(car: THREE.Object3D, mat: RegExp) {
  car.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(car.matrixWorld).invert();
  const all = new THREE.Box3();
  car.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && (m.material as THREE.Material)?.type?.startsWith("MeshStandard"))
      all.union(new THREE.Box3().setFromObject(m).applyMatrix4(inv));
  });
  const L = all.max.z - all.min.z;
  const H = all.max.y - all.min.y;
  const sides = [new THREE.Box3(), new THREE.Box3()];
  const meshes: THREE.Mesh[] = [];
  const v = new THREE.Vector3();
  car.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || /mirror/i.test(m.name)) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (!mats.some((x) => mat.test(x?.name ?? ""))) return;
    const M = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    const pos = m.geometry.getAttribute("position");
    let used = false;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(M);
      if (v.z > all.min.z + L * 0.22 || Math.abs(v.x) < 0.22) continue;
      if (v.y < all.min.y + H * 0.2 || v.y > all.min.y + H * 0.7) continue;
      sides[v.x < 0 ? 0 : 1]!.expandByPoint(v);
      used = true;
    }
    if (used) meshes.push(m);
  });
  return { sides, meshes, inv };
}

export function buildQuadLeds(car: THREE.Object3D, carKey: string) {
  const mat = LAMP_MATERIALS[carKey];
  if (!mat) return null;
  const { sides, meshes, inv } = lampBoxes(car, mat);
  if (sides.some((b) => b.isEmpty())) return null;
  const ray = new THREE.Raycaster();
  const faces: THREE.BufferGeometry[] = [];
  const glows: THREE.BufferGeometry[] = [];
  const toLocal = new THREE.Matrix4();
  for (const b of sides) {
    const sx = Math.sign(b.min.x + b.max.x) || 1;
    const inner = sx > 0 ? b.min.x : b.max.x;
    const outer = sx > 0 ? b.max.x : b.min.x;
    const span = Math.abs(outer - inner);
    const cy = b.min.y + (b.max.y - b.min.y) * 0.5;
    const w = (span / 4) * 0.74;
    const h = Math.min((b.max.y - b.min.y) * 0.6, w * 0.78);
    for (let i = 0; i < 4; i++) {
      const t = 0.08 + ((i + 0.5) / 4) * 0.86;
      const x = inner + (outer - inner) * t;
      const y = cy + (t - 0.5) * 0.03;
      // Put the LED on the front-most lamp surface at (x, y).
      const origin = new THREE.Vector3(x, y, b.min.z - 1).applyMatrix4(car.matrixWorld);
      const dir = new THREE.Vector3(0, 0, 1).transformDirection(car.matrixWorld);
      ray.set(origin, dir);
      const hit = ray.intersectObjects(meshes, false)[0];
      let z = b.min.z + 0.02;
      const n = new THREE.Vector3(0, 0, -1);
      if (hit) {
        toLocal.copy(inv);
        z = hit.point.clone().applyMatrix4(toLocal).z;
        if (hit.face) {
          n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).transformDirection(inv);
          if (n.z > 0) n.negate();
          // keep modules facing mostly forward
          n.lerp(new THREE.Vector3(0, 0, -1), 0.5).normalize();
        }
      }
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      const at = new THREE.Vector3(x, y, z).addScaledVector(n, 0.006);
      const m = new THREE.Matrix4().compose(at, q, new THREE.Vector3(1, 1, 1));
      faces.push(new THREE.PlaneGeometry(w, h).applyMatrix4(m));
      const gm = new THREE.Matrix4().compose(at.clone().addScaledVector(n, 0.01), q, new THREE.Vector3(1, 1, 1));
      glows.push(new THREE.PlaneGeometry(w * 2.6, h * 2.6).applyMatrix4(gm));
    }
  }
  const faceGeo = mergeGeometries(faces);
  const glowGeo = mergeGeometries(glows);
  faces.forEach((g) => g.dispose());
  glows.forEach((g) => g.dispose());
  if (!faceGeo || !glowGeo) return null;
  const faceMat = new THREE.MeshBasicMaterial({
    map: ledTexture(),
    transparent: true,
    toneMapped: false,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    color: 0xe6f0ff,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const group = new THREE.Group();
  group.name = "quad-led-headlights";
  group.userData.noDamage = true;
  const face = new THREE.Mesh(faceGeo, faceMat);
  const glow = new THREE.Mesh(glowGeo, glowMat);
  face.renderOrder = 3;
  glow.renderOrder = 4;
  face.userData.noDamage = glow.userData.noDamage = true;
  group.add(face, glow);
  car.add(group);
  return {
    group,
    sides,
    setGlow(opacity: number) {
      glowMat.opacity = opacity;
      glow.visible = opacity > 0.01;
    },
  };
}
export type QuadLeds = NonNullable<ReturnType<typeof buildQuadLeds>>;
