// Guardrail crash damage for the player's car: dented bodywork, parts that fly
// off and stay on the road, and a bumper left hanging by one mount.
// The crash rules (severity, thresholds) live in vehicle-dynamics.ts.
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type Scene,
} from "three";
import { LOOP } from "./highway-layout";
import { BUMPER_HANGS_AT, DEBRIS_AT, RAIL_INNER_X } from "./vehicle-dynamics";

export const MAX_DEBRIS = 96;
const GRAVITY = 9.8;
const BOUNCE = 0.32;

export interface DebrisPiece {
  x: number;
  y: number;
  /** Absolute distance along the road (same unit as the game's pz). */
  w: number;
  vx: number;
  vy: number;
  /** Forward speed along the road, m/s. */
  vw: number;
  sx: number;
  sy: number;
  sz: number;
  rx: number;
  ry: number;
  rz: number;
  spin: number;
  resting: boolean;
}

/** How many loose parts a hit of this severity throws (0 below the debris threshold). */
export const debrisCount = (severity: number): number =>
  severity < DEBRIS_AT ? 0 : Math.round(5 + severity * 13);

/** One physics step: parts fall, bounce, skid to a stop and then stay put. */
export function stepDebris(p: DebrisPiece, dt: number): void {
  if (p.resting) return;
  p.vy -= GRAVITY * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.w += p.vw * dt;
  const spin = p.spin * dt;
  p.rx += spin;
  p.rz += spin * 0.7;
  const floor = Math.min(p.sx, p.sy, p.sz) / 2 + 0.01;
  // the rails keep the parts on the road
  const lim = RAIL_INNER_X - 0.1;
  if (Math.abs(p.x) > lim) {
    p.x = Math.sign(p.x) * lim;
    p.vx = -p.vx * 0.4;
  }
  if (p.y <= floor) {
    p.y = floor;
    if (Math.abs(p.vy) > 1.1) p.vy = -p.vy * BOUNCE;
    else p.vy = 0;
    const f = Math.exp(-3.2 * dt);
    p.vx *= f;
    p.vw *= f;
    p.spin *= Math.exp(-5 * dt);
    if (p.vy === 0 && Math.abs(p.vx) < 0.25 && Math.abs(p.vw) < 0.4) {
      p.vx = p.vw = p.spin = 0;
      // lie flat on the asphalt
      p.rx = Math.round(p.rx / Math.PI) * Math.PI;
      p.rz = Math.round(p.rz / Math.PI) * Math.PI;
      p.resting = true;
    }
  }
}

/** Road-relative z of a part for the camera (parts reappear every lap). */
export function debrisSceneZ(pz: number, w: number): number {
  let d = (pz - w) % LOOP;
  if (d > LOOP / 2) d -= LOOP;
  if (d < -LOOP / 2) d += LOOP;
  return d;
}

type AnyMesh = Mesh & {
  isInstancedMesh?: boolean;
  isSkinnedMesh?: boolean;
  userData: Record<string, unknown>;
};
type Mat = { transparent?: boolean; depthWrite?: boolean; color?: Color; name?: string };

const solid = (m: unknown): m is Mat => {
  const mat = (Array.isArray(m) ? m[0] : m) as Mat | undefined;
  return !!mat && mat.transparent !== true && mat.depthWrite !== false;
};

// smooth pseudo-noise so vertices sharing a position crumple together
const noise = (x: number, y: number, z: number, s: number) =>
  Math.sin(x * 9.1 + s) * Math.cos(y * 11.3 - s * 1.7) + Math.sin(z * 7.7 + y * 5.1 + s * 0.6) * 0.6;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class CarDamage {
  private car: Object3D | null = null;
  private originals = new Map<AnyMesh, BufferGeometry>();
  private pieces: DebrisPiece[] = [];
  private next = 0;
  private mesh: InstancedMesh;
  private colors: Color[] = [];
  private paint = new Color(0x888888);
  private bumper: Group | null = null;
  private bumperSide = 0;
  private swing = 0;
  private swingV = 0;
  private droop = 0;
  private half = { x: 1, front: -2.3, back: 2.3 };
  private lastHit = 0;
  private lastRun = -1;
  /** Total damage taken this run, 0..1. */
  total = 0;

  private m = new Matrix4();
  private mi = new Matrix4();
  private v = new Vector3();
  private q = new Quaternion();
  private s = new Vector3();
  private dummy = new Object3D();

  constructor(private scene: Scene) {
    this.mesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 }),
      MAX_DEBRIS,
    );
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    scene.add(this.mesh);
  }

  /** Call when the player's car model is (re)placed in the scene. */
  attach(car: Object3D): void {
    this.repair();
    this.car = car;
    car.updateMatrixWorld(true);
    const inv = this.mi.copy(car.matrixWorld).invert();
    let minX = 0,
      maxX = 0,
      minZ = 0,
      maxZ = 0,
      bestArea = 0;
    car.traverse((o) => {
      const mesh = o as AnyMesh;
      if (!this.deformable(mesh)) return;
      const g = mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox;
      if (!b) return;
      this.m.multiplyMatrices(inv, mesh.matrixWorld);
      let lx0 = Infinity,
        lx1 = -Infinity,
        ly0 = Infinity,
        ly1 = -Infinity,
        lz0 = Infinity,
        lz1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        this.v
          .set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)
          .applyMatrix4(this.m);
        lx0 = Math.min(lx0, this.v.x);
        lx1 = Math.max(lx1, this.v.x);
        ly0 = Math.min(ly0, this.v.y);
        ly1 = Math.max(ly1, this.v.y);
        lz0 = Math.min(lz0, this.v.z);
        lz1 = Math.max(lz1, this.v.z);
      }
      if (lx1 - lx0 > 2.6 || lz1 - lz0 > 6) return; // not part of the body
      minX = Math.min(minX, lx0);
      maxX = Math.max(maxX, lx1);
      minZ = Math.min(minZ, lz0);
      maxZ = Math.max(maxZ, lz1);
      // the biggest painted panel gives the colour of the loose parts
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Mat;
      const area = (lx1 - lx0) * (lz1 - lz0) * (ly1 - ly0 + 0.2);
      const c = mat?.color;
      if (c && area > bestArea && /paint|body|car|coach/i.test(`${mat.name ?? ""} ${mesh.name}`)) {
        bestArea = area;
        this.paint.copy(c);
      }
    });
    this.half = {
      x: Math.min(1.15, Math.max(0.85, (maxX - minX) / 2 || 1)),
      front: Math.max(-2.8, Math.min(-1.8, minZ || -2.3)),
      back: Math.min(2.8, Math.max(1.8, maxZ || 2.3)),
    };
  }

  private deformable(mesh: AnyMesh): boolean {
    if (!mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh) return false;
    if (mesh.userData["noDamage"] || mesh.userData["wheel"] || mesh.userData["cabinOnly"]) return false;
    let p: Object3D | null = mesh.parent;
    while (p && p !== this.car) {
      if (p.userData["noDamage"] || p.userData["wheel"]) return false;
      p = p.parent;
    }
    return solid(mesh.material) && !!mesh.geometry?.attributes["position"];
  }

  /**
   * Per-frame update. `hit` is the game's latest guardrail impact
   * ({ id, side, severity }); a new id applies the damage once.
   */
  update(
    run: number,
    hit: { id: number; side: number; severity: number } | null | undefined,
    pz: number,
    speedKmh: number,
    dt: number,
  ): void {
    if (run !== this.lastRun) {
      this.lastRun = run;
      this.repair();
      this.lastHit = hit?.id ?? 0;
    }
    if (hit && hit.id !== this.lastHit) {
      this.lastHit = hit.id;
      this.impact(hit.side, hit.severity, pz, speedKmh);
    }
    this.stepPieces(pz, dt);
    this.stepBumper(speedKmh, dt);
  }

  private impact(side: number, severity: number, pz: number, speedKmh: number): void {
    const car = this.car;
    if (!car || severity <= 0) return;
    this.total = Math.min(1, this.total + severity * 0.6);
    this.dent(side, severity);
    const n = debrisCount(severity);
    const ms = speedKmh / 3.6;
    const cx = car.position.x + side * this.half.x;
    for (let i = 0; i < n; i++) {
      const big = i < 2 && severity > 0.35;
      const kind = Math.random();
      const col =
        big || kind < 0.5 ? this.paint.clone() : kind < 0.8 ? new Color(0x0c0c0d) : new Color(0xb9c4cc);
      if (kind < 0.5 || big) col.multiplyScalar(rnd(0.75, 1));
      this.addPiece(
        {
          x: cx - side * rnd(0, 0.25),
          y: rnd(0.3, 0.8),
          w: pz + rnd(0.6, 2.2),
          vx: -side * rnd(0.5, 4.5) * (0.6 + severity),
          vy: rnd(1.5, 4.5) * (0.6 + severity * 0.7),
          vw: ms * rnd(0.45, 0.92),
          sx: big ? rnd(0.35, 0.7) : rnd(0.05, 0.22),
          sy: big ? rnd(0.02, 0.04) : rnd(0.015, 0.05),
          sz: big ? rnd(0.18, 0.32) : rnd(0.04, 0.16),
          rx: rnd(0, 6.28),
          ry: rnd(0, 6.28),
          rz: rnd(0, 6.28),
          spin: rnd(6, 18),
          resting: false,
        },
        col,
      );
    }
    if (severity >= BUMPER_HANGS_AT && !this.bumper) this.hangBumper(side);
  }

  /** Push the bodywork in around the front corner and side that met the rail. */
  private dent(side: number, severity: number): void {
    const car = this.car;
    if (!car) return;
    car.updateMatrixWorld(true);
    const inv = new Matrix4().copy(car.matrixWorld).invert();
    const depth = 0.1 + severity * 0.22;
    const radius = 1.0 + severity * 0.9;
    const seed = Math.random() * 40;
    // two contact points: the front corner and the door/sill
    const hits: [number, number, number, number][] = [
      [side * this.half.x, 0.5, this.half.front * 0.72, 1],
      [side * this.half.x, 0.5, this.half.back * 0.25, 0.6],
    ];
    const local = new Vector3();
    const toMesh = new Matrix4();
    car.traverse((o) => {
      const mesh = o as AnyMesh;
      if (!this.deformable(mesh)) return;
      const src = mesh.geometry;
      if (!src.boundingSphere) src.computeBoundingSphere();
      const bs = src.boundingSphere;
      if (!bs) return;
      this.m.multiplyMatrices(inv, mesh.matrixWorld);
      this.m.decompose(this.v, this.q, this.s);
      const sc = Math.max(Math.abs(this.s.x), Math.abs(this.s.y), Math.abs(this.s.z));
      local.copy(bs.center).applyMatrix4(this.m);
      const reach = bs.radius * sc + radius;
      if (!hits.some((h) => local.distanceToSquared(this.v.set(h[0], h[1], h[2])) < reach * reach)) return;
      if (!this.originals.has(mesh)) {
        this.originals.set(mesh, src);
        mesh.geometry = src.clone();
      }
      const pos = mesh.geometry.attributes["position"];
      const nor = mesh.geometry.attributes["normal"];
      if (!pos) return;
      toMesh.copy(this.m).invert();
      let touched = false;
      for (let i = 0; i < pos.count; i++) {
        local.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(this.m);
        let push = 0;
        for (const h of hits) {
          const dx = local.x - h[0];
          const dy = (local.y - h[1]) * 0.8;
          const dz = local.z - h[2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < radius) {
            const f = 1 - d / radius;
            push = Math.max(push, f * f * h[3]);
          }
        }
        if (push <= 0.001) continue;
        touched = true;
        const cr = noise(local.x, local.y, local.z, seed);
        const amt = depth * push * (0.75 + 0.45 * cr);
        local.x -= side * amt;
        local.y -= amt * 0.12 * (0.5 + cr);
        local.z += amt * 0.25 * noise(local.z, local.x, local.y, seed + 3);
        // never fold past the car's centre line
        if (side * local.x < 0.15) local.x = side * 0.15;
        local.applyMatrix4(toMesh);
        pos.setXYZ(i, local.x, local.y, local.z);
        if (nor) {
          const k = push * (0.35 + severity * 0.5);
          this.v
            .set(
              nor.getX(i) + k * noise(local.y * 3, local.z * 3, local.x * 3, seed + 1),
              nor.getY(i) + k * noise(local.z * 3, local.x * 3, local.y * 3, seed + 2),
              nor.getZ(i) + k * noise(local.x * 3, local.y * 3, local.z * 3, seed + 5),
            )
            .normalize();
          nor.setXYZ(i, this.v.x, this.v.y, this.v.z);
        }
      }
      if (touched) {
        pos.needsUpdate = true;
        if (nor) nor.needsUpdate = true;
      }
    });
  }

  private hangBumper(side: number): void {
    const car = this.car;
    if (!car) return;
    const w = this.half.x * 1.9;
    const g = new Group();
    // pivot on the mount that held: the corner away from the impact
    g.position.set(-side * this.half.x * 0.92, 0.42, this.half.front + 0.12);
    const mat = new MeshStandardMaterial({
      color: this.paint.clone().multiplyScalar(0.9),
      roughness: 0.45,
      metalness: 0.5,
    });
    const segs = 6;
    for (let i = 0; i < segs; i++) {
      const t = (i + 0.5) / segs;
      const seg = new Mesh(new BoxGeometry(w / segs + 0.01, 0.2 - Math.abs(t - 0.5) * 0.06, 0.06), mat);
      // gentle bow like a bumper skin, kinked near the torn end
      seg.position.set(side * w * t, t > 0.7 ? -(t - 0.7) * 0.12 : 0, Math.pow(Math.abs(t - 0.5) * 2, 2) * 0.22);
      seg.rotation.y = side * (t - 0.5) * -0.5;
      seg.rotation.z = t > 0.7 ? -side * 0.18 : 0;
      g.add(seg);
    }
    const lip = new Mesh(
      new BoxGeometry(w * 0.6, 0.05, 0.1),
      new MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.8 }),
    );
    lip.position.set(side * w * 0.4, -0.12, 0.02);
    g.add(lip);
    g.userData["noDamage"] = true;
    car.add(g);
    this.bumper = g;
    this.bumperSide = side;
    // the free end drops until it nearly scrapes the road
    this.droop = Math.asin(Math.min(0.9, (0.42 - 0.12) / w));
    this.swing = 0;
    this.swingV = 3;
  }

  /** Side (-1 / 1) the bumper's loose end hangs on, 0 while it is still attached. */
  get hanging(): number {
    return this.bumper ? this.bumperSide : 0;
  }

  private stepBumper(speedKmh: number, dt: number): void {
    const b = this.bumper;
    if (!b) return;
    // wind and road bumps keep the loose end flapping
    const buffet = Math.min(1, speedKmh / 200);
    this.swingV += (-34 * this.swing - 3.2 * this.swingV + (Math.random() - 0.5) * 60 * buffet) * dt;
    this.swing += this.swingV * dt;
    const s = this.bumperSide;
    b.rotation.z = -s * (this.droop + this.swing * 0.12);
    b.rotation.y = -s * (0.16 + buffet * 0.1 + this.swing * 0.2);
  }

  private addPiece(p: DebrisPiece, color: Color): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_DEBRIS;
    this.pieces[i] = p;
    this.colors[i] = color;
    this.mesh.setColorAt(i, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
  }

  private stepPieces(pz: number, dt: number): void {
    const n = this.mesh.count;
    if (!n) return;
    const d = this.dummy;
    for (let i = 0; i < n; i++) {
      const p = this.pieces[i];
      if (!p) continue;
      stepDebris(p, dt);
      d.position.set(p.x, p.y, debrisSceneZ(pz, p.w));
      d.rotation.set(p.rx, p.ry, p.rz);
      d.scale.set(p.sx, p.sy, p.sz);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Back to a factory-fresh car and a clean road (new run / new car). */
  repair(): void {
    for (const [mesh, geo] of this.originals) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
    }
    this.originals.clear();
    if (this.bumper) {
      this.bumper.removeFromParent();
      this.bumper.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      this.bumper = null;
    }
    this.bumperSide = 0;
    this.pieces = [];
    this.next = 0;
    this.mesh.count = 0;
    this.total = 0;
  }

  dispose(): void {
    this.repair();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
  }
}
