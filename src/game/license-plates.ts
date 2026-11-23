// Draws US-style license plates and mounts them on the loaded car models.
import {
  Box3,
  BoxGeometry,
  CanvasTexture,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  SRGBColorSpace,
  Vector3,
  type Object3D,
} from "three";
import {
  getPlateStyle,
  plateMountFor,
  type PlateMount,
  type PlateSetting,
  type PlateStyle,
} from "./plate-rules";

// US plate: 12 x 6 in.
const PLATE_W = 0.305;
const PLATE_H = 0.152;
const PLATE_D = 0.006;
const GROUP_NAME = "license-plates";

let fontsReady: Promise<unknown> | null = null;
function loadFonts() {
  if (!fontsReady && typeof document !== "undefined" && document.fonts) {
    fontsReady = Promise.all([
      document.fonts.load('120px "Bebas Neue"'),
      document.fonts.load('700 40px "Barlow"'),
    ]).catch(() => undefined);
  }
  return fontsReady ?? Promise.resolve();
}

/** Paints a plate onto a 2:1 canvas. Used by the 3D plate and the editor preview. */
export function drawPlate(canvas: HTMLCanvasElement, style: PlateStyle, text: string) {
  const W = 512;
  const H = 256;
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, W, H);
  const r = 22;
  const rr = (x: number, y: number, w: number, h: number, rad: number) => {
    g.beginPath();
    g.moveTo(x + rad, y);
    g.arcTo(x + w, y, x + w, y + h, rad);
    g.arcTo(x + w, y + h, x, y + h, rad);
    g.arcTo(x, y + h, x, y, rad);
    g.arcTo(x, y, x + w, y, rad);
    g.closePath();
  };
  // Base with a subtle reflective sheen.
  rr(0, 0, W, H, r);
  g.fillStyle = style.background;
  g.fill();
  const sheen = g.createLinearGradient(0, 0, W, H);
  sheen.addColorStop(0, "rgba(255,255,255,0.10)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0)");
  sheen.addColorStop(1, "rgba(0,0,0,0.10)");
  g.fillStyle = sheen;
  g.fill();
  // Embossed rim.
  rr(9, 9, W - 18, H - 18, r - 8);
  g.lineWidth = 5;
  g.strokeStyle = style.border;
  g.stroke();
  // Bolt holes.
  g.fillStyle = "rgba(0,0,0,0.55)";
  for (const [x, y] of [
    [92, 34],
    [W - 92, 34],
    [92, H - 30],
    [W - 92, H - 30],
  ] as const) {
    g.beginPath();
    g.ellipse(x, y, 11, 7, 0, 0, Math.PI * 2);
    g.fill();
  }
  // Header.
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = style.header;
  if (style.scriptHeader) {
    g.font = 'italic 700 62px "Brush Script MT", "Segoe Script", "Lucida Handwriting", cursive';
    g.fillText(style.headerText, W / 2, 48);
  } else {
    g.font = '50px "Bebas Neue", "Barlow", Impact, sans-serif';
    g.fillText(style.headerText.split("").join(String.fromCharCode(8202)), W / 2, 46);
  }
  // Serial, embossed: dark shadow then colour.
  const serial = text.trim() || " ";
  let size = 170;
  g.font = `${size}px "Bebas Neue", Impact, "Arial Narrow", sans-serif`;
  const maxW = W - 70;
  const w = g.measureText(serial).width;
  if (w > maxW) {
    size = Math.floor((size * maxW) / w);
    g.font = `${size}px "Bebas Neue", Impact, "Arial Narrow", sans-serif`;
  }
  g.fillStyle = "rgba(0,0,0,0.35)";
  g.fillText(serial, W / 2 + 3, 146 + 4);
  g.fillStyle = style.text;
  g.fillText(serial, W / 2, 146);
  // Footer.
  g.font = '600 24px "Barlow", Arial, sans-serif';
  g.fillStyle = style.header;
  g.fillText(style.footerText, W / 2, H - 30);
}

const frameMat = new MeshStandardMaterial({ color: 0x0b0b0c, metalness: 0.4, roughness: 0.45 });
const edgeMat = new MeshStandardMaterial({ color: 0x8d9096, metalness: 0.9, roughness: 0.35 });

function makePlateMesh(style: PlateStyle, text: string) {
  const canvas = document.createElement("canvas");
  drawPlate(canvas, style, text);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  const face = new MeshStandardMaterial({
    map: tex,
    metalness: 0.25,
    roughness: 0.42,
  });
  // Redraw once the web fonts are available.
  void loadFonts().then(() => {
    drawPlate(canvas, style, text);
    tex.needsUpdate = true;
  });
  const plate = new Mesh(new BoxGeometry(PLATE_W, PLATE_H, PLATE_D), [
    edgeMat,
    edgeMat,
    edgeMat,
    edgeMat,
    face,
    edgeMat,
  ]);
  plate.position.z = PLATE_D / 2 + 0.003;
  const frame = new Mesh(new BoxGeometry(PLATE_W + 0.018, PLATE_H + 0.018, 0.005), frameMat);
  frame.position.z = 0.0025;
  const holder = new Group();
  holder.add(frame, plate);
  holder.userData["dispose"] = () => {
    tex.dispose();
    face.dispose();
    plate.geometry.dispose();
    frame.geometry.dispose();
  };
  return holder;
}

interface MountPoint {
  depth: number; // outward distance along the car axis
  pitch: number;
  y: number;
  x: number;
}

/** Names the car models use for the plates they ship with (hidden, but they mark the real plate spot). */
const MODEL_PLATE_RE = /LicensePlate|ManufacturerPlate|license_plate|number_?plate|^Plate$/i;

function isModelPlate(m: Mesh): boolean {
  if (m.userData["licensePlate"]) return false;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  return MODEL_PLATE_RE.test(m.name) || mats.some((x) => x && MODEL_PLATE_RE.test(x.name));
}

/** Where the model's own plate sits on one side (car-local), if it has one. */
function modelPlateSpot(car: Object3D, side: "rear" | "front") {
  car.updateMatrixWorld(true);
  const toLocal = new Matrix4().copy(car.matrixWorld).invert();
  const box = new Box3();
  car.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !isModelPlate(m)) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox!.clone().applyMatrix4(
      new Matrix4().multiplyMatrices(toLocal, m.matrixWorld),
    );
    const cz = (b.min.z + b.max.z) / 2;
    if ((side === "rear" ? cz > 0.5 : cz < -0.5) && b.max.y - b.min.y < 0.4) box.union(b);
  });
  if (box.isEmpty()) return null;
  const c = box.getCenter(new Vector3());
  return { x: c.x, y: c.y, depth: side === "rear" ? box.max.z : -box.min.z };
}

function isVisible(o: Object3D | null): boolean {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

function solidMeshes(car: Object3D): Mesh[] {
  const out: Mesh[] = [];
  car.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || m.userData["licensePlate"] || m.userData["wheel"]) return;
    if (!isVisible(m)) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.some((x) => x && x.transparent && x.opacity < 0.9)) return;
    out.push(m);
  });
  return out;
}

/** Casts a small grid of rays at the bumper to find where the plate rests. */
function findMount(car: Object3D, side: "rear" | "front", y: number, x = 0): MountPoint {
  car.updateMatrixWorld(true);
  const toLocal = new Matrix4().copy(car.matrixWorld).invert();
  const box = new Box3();
  const meshes = solidMeshes(car);
  for (const m of meshes) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox!.clone().applyMatrix4(
      new Matrix4().multiplyMatrices(toLocal, m.matrixWorld),
    );
    box.union(b);
  }
  const sign = side === "rear" ? 1 : -1;
  const start = (side === "rear" ? box.max.z : box.min.z) + sign * 0.6;
  const dirWorld = new Vector3(0, 0, -sign).transformDirection(car.matrixWorld);
  const ray = new Raycaster();
  ray.far = 3;
  // Sample the whole plate footprint so it never ends up buried in a bumper lip or diffuser.
  const ys = [0.07, 0.035, 0, -0.035, -0.07];
  const hits: { oy: number; d: number }[] = [];
  const rowMedian: (number | null)[] = [];
  const median = (a: number[]) => {
    const s = [...a].sort((p, q) => p - q);
    return s[Math.floor(s.length / 2)]!;
  };
  for (const oy of ys) {
    const row: number[] = [];
    for (const ox of [-0.14, -0.07, 0, 0.07, 0.14]) {
      const origin = car.localToWorld(new Vector3(x + ox, y + oy, start));
      ray.set(origin, dirWorld);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit) continue;
      const d = sign * car.worldToLocal(hit.point.clone()).z;
      row.push(d);
      hits.push({ oy, d });
    }
    rowMedian.push(row.length ? median(row) : null);
  }
  const fallback = side === "rear" ? box.max.z : -box.min.z;
  if (!hits.length) return { depth: fallback, pitch: 0, y, x };
  const m = median(hits.map((h) => h.d));
  const top = rowMedian[0] ?? rowMedian[1] ?? m;
  const bottom = rowMedian[4] ?? rowMedian[3] ?? m;
  const pitch = Math.max(-0.22, Math.min(0.22, Math.atan2(top - bottom, 0.14)));
  const tp = Math.tan(pitch);
  // Plate plane depth at offset oy is depth + oy * tan(pitch); keep it in front of every
  // body hit in its footprint, ignoring far-out parts (wings, fins) and deep holes.
  let depth = m;
  for (const h of hits) if (h.d < m + 0.3 && h.d > m - 0.25) depth = Math.max(depth, h.d - h.oy * tp);
  return { depth, pitch, y, x };
}

/** Hides plates that ship with some models so only ours shows. */
function hideModelPlates(car: Object3D) {
  car.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || m.userData["licensePlate"]) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (isModelPlate(m) || mats.some((x) => x && /LicensePlate|^Plate$/i.test(x.name)))
      m.visible = false;
  });
}

function removePlates(car: Object3D) {
  const old = car.getObjectByName(GROUP_NAME);
  if (!old) return;
  old.traverse((o) => (o.userData["dispose"] as (() => void) | undefined)?.());
  old.removeFromParent();
}

/** Prefers the spot of the plate the model ships with; else the researched height + bumper raycast. */
function mountFor(car: Object3D, side: "rear" | "front", mount: PlateMount): MountPoint {
  const spot = modelPlateSpot(car, side);
  if (spot) {
    const ray = findMount(car, side, spot.y, spot.x);
    // Sit on the model's plate face; never sink behind the bumper the rays found.
    const depth = Math.abs(ray.depth - spot.depth) < 0.08 ? Math.max(ray.depth, spot.depth) : spot.depth;
    return { depth, pitch: ray.pitch, y: spot.y, x: spot.x };
  }
  const y = side === "rear" ? mount.rear : (mount.front as number);
  return findMount(car, side, y);
}

/** Puts (or refreshes) the rear and optional front plate on a car. */
export function applyLicensePlates(car: Object3D, carId: string, setting: PlateSetting) {
  removePlates(car);
  hideModelPlates(car);
  const mount = plateMountFor(carId);
  const cache = (car.userData["plateMounts"] ??= {}) as Record<string, MountPoint>;
  const style = getPlateStyle(setting.style);
  const group = new Group();
  group.name = GROUP_NAME;
  const sides: ("rear" | "front")[] = ["rear"];
  if (setting.front && mount.front !== null) sides.push("front");
  for (const side of sides) {
    const key = `${side}:v4`;
    const point = (cache[key] ??= mountFor(car, side, mount));
    const plate = makePlateMesh(style, setting.text);
    plate.traverse((o) => (o.userData["licensePlate"] = true));
    plate.rotation.order = "YXZ";
    plate.rotation.set(point.pitch, side === "rear" ? 0 : Math.PI, 0);
    plate.position.set(point.x, point.y, (side === "rear" ? 1 : -1) * point.depth);
    group.add(plate);
  }
  car.add(group);
}
