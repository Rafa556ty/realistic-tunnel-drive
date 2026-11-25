// Graphics quality levels for the driving scene.
// "original" draws straight to the screen exactly as before; "medium" and
// "best" route the frame through a post-processing chain (HDR + MSAA, bloom,
// colour grade, and ambient occlusion on "best").
import {
  HalfFloatType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";

export type GraphicsLevel = "original" | "medium" | "best";
export const GRAPHICS_LEVELS: readonly GraphicsLevel[] = [
  "original",
  "medium",
  "best",
];
export const GRAPHICS_STORAGE_KEY = "gfx-quality";
export const GRAPHICS_EVENT = "gfx-quality-change";

export interface GraphicsProfile {
  /** false = today's direct rendering, untouched. */
  post: boolean;
  /** Max device pixel ratio on normal / low-end devices. */
  dprCap: number;
  dprCapLow: number;
  msaa: number;
  bloom: number;
  ambientOcclusion: boolean;
  shadowMapSize: number;
  anisotropy: number;
  contrast: number;
  saturation: number;
  vignette: number;
  /** Strength of the speed blur at the screen edges (0 = off). */
  motionBlur: number;
}

export const GRAPHICS_PROFILES: Record<GraphicsLevel, GraphicsProfile> = {
  original: {
    post: false,
    dprCap: 1.5,
    dprCapLow: 1,
    msaa: 0,
    bloom: 0,
    ambientOcclusion: false,
    shadowMapSize: 1024,
    anisotropy: 8,
    contrast: 1,
    saturation: 1,
    vignette: 0,
    motionBlur: 0,
  },
  medium: {
    post: true,
    dprCap: 1.5,
    dprCapLow: 1,
    msaa: 2,
    bloom: 0.16,
    ambientOcclusion: false,
    shadowMapSize: 2048,
    anisotropy: 12,
    contrast: 1.06,
    saturation: 1.08,
    vignette: 0.18,
    motionBlur: 0.5,
  },
  best: {
    post: true,
    dprCap: 2,
    dprCapLow: 1.25,
    msaa: 4,
    bloom: 0.24,
    ambientOcclusion: true,
    shadowMapSize: 4096,
    anisotropy: 16,
    contrast: 1.07,
    saturation: 1.1,
    vignette: 0.26,
    motionBlur: 1,
  },
};

export const isGraphicsLevel = (v: unknown): v is GraphicsLevel =>
  typeof v === "string" && (GRAPHICS_LEVELS as readonly string[]).includes(v);

/** Weak phones keep today's graphics unless the player picks otherwise. */
export const defaultGraphicsLevel = (lowDevice: boolean): GraphicsLevel =>
  lowDevice ? "original" : "best";

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

export function loadGraphicsLevel(
  storage: ReadStorage,
  lowDevice: boolean,
): GraphicsLevel {
  let saved: string | null = null;
  try {
    saved = storage.getItem(GRAPHICS_STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
  return isGraphicsLevel(saved) ? saved : defaultGraphicsLevel(lowDevice);
}

/** Saves the choice and tells the running scene to switch right away. */
export function setGraphicsLevel(
  storage: WriteStorage,
  level: GraphicsLevel,
): void {
  try {
    storage.setItem(GRAPHICS_STORAGE_KEY, level);
  } catch {
    /* storage blocked */
  }
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(GRAPHICS_EVENT, { detail: level }));
}

export function graphicsPixelRatio(
  level: GraphicsLevel,
  devicePixelRatio: number,
  lowDevice: boolean,
): number {
  const p = GRAPHICS_PROFILES[level];
  return Math.min(devicePixelRatio || 1, lowDevice ? p.dprCapLow : p.dprCap);
}

/** 0 below 90 km/h, rising to the level's full strength at 320 km/h. */
export function motionBlurAmount(level: GraphicsLevel, kmh: number): number {
  const t = Math.max(0, Math.min(1, (kmh - 90) / 230));
  return GRAPHICS_PROFILES[level].motionBlur * t * t * (3 - 2 * t);
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1 },
    saturation: { value: 1 },
    vignette: { value: 0 },
    motion: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float contrast;
    uniform float saturation;
    uniform float vignette;
    uniform float motion;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // Speed blur: streak the picture away from the vanishing point, leaving
      // the car and the road ahead sharp, like a racing-game chase camera.
      vec2 toC = vec2(0.5, 0.56) - vUv;
      float edge = smoothstep(0.18, 0.75, length(toC * vec2(1.0, 1.25)));
      float amt = motion * edge * 0.085;
      if (amt > 0.0005) {
        vec3 acc = c.rgb;
        for (int i = 1; i < 8; i++) {
          acc += texture2D(tDiffuse, vUv + toC * amt * (float(i) / 7.0)).rgb;
        }
        c.rgb = acc / 8.0;
      }
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 rgb = mix(vec3(l), c.rgb, saturation);
      rgb = (rgb - 0.5) * contrast + 0.5;
      // soft filmic toe: keep shadows readable instead of crushed
      rgb = max(rgb, vec3(0.0)) * 0.985 + 0.015 * (contrast - 1.0) * 6.0;
      // gentle warm highlights / cool shadows, like a racing-game grade
      rgb += (l - 0.5) * vec3(0.018, 0.004, -0.02);
      vec2 d = vUv - 0.5;
      rgb *= 1.0 - vignette * smoothstep(0.25, 0.9, dot(d, d) * 2.0);
      gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
    }`,
};

type MaterialLike = { transparent?: boolean; depthWrite?: boolean };
const seeThrough = (m: MaterialLike | MaterialLike[] | undefined): boolean =>
  Array.isArray(m)
    ? m.some((x) => seeThrough(x))
    : !!m && (m.transparent === true || m.depthWrite === false);

export class GraphicsPipeline {
  level: GraphicsLevel = "original";
  private composer: EffectComposer | null = null;
  private width = 1;
  private height = 1;
  private grade: ShaderPass | null = null;
  private motion = 0;

  constructor(
    private renderer: WebGLRenderer,
    private scene: Scene,
    private camera: Camera,
  ) {}

  setLevel(level: GraphicsLevel): void {
    this.level = level;
    this.disposeComposer();
    const p = GRAPHICS_PROFILES[level];
    if (!p.post) return;
    const target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: p.msaa,
    });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    if (p.ambientOcclusion) {
      const ao = new GTAOPass(this.scene, this.camera, 1, 1);
      ao.blendIntensity = 0.85;
      ao.updateGtaoMaterial({
        radius: 0.7,
        distanceExponent: 1.4,
        thickness: 1.2,
        scale: 1,
        samples: 12,
        distanceFallOff: 1,
        screenSpaceRadius: false,
      });
      // Glows, smoke, glass and other see-through quads must not cast
      // occlusion; hide them for the pass's own depth/normal render.
      const hooks = ao as unknown as {
        _visibilityCache: Object3D[];
        _overrideVisibility: () => void;
      };
      const scene = this.scene;
      hooks._overrideVisibility = () => {
        const cache = hooks._visibilityCache;
        scene.traverse((o) => {
          if (!o.visible) return;
          const any = o as Object3D & {
            isPoints?: boolean;
            isLine?: boolean;
            isSprite?: boolean;
            material?: MaterialLike | MaterialLike[];
          };
          if (
            any.isPoints ||
            any.isLine ||
            any.isSprite ||
            seeThrough(any.material)
          ) {
            o.visible = false;
            cache.push(o);
          }
        });
      };
      composer.addPass(ao);
    }
    if (p.bloom > 0)
      composer.addPass(new UnrealBloomPass(new Vector2(1, 1), p.bloom, 0.4, 2.2));
    composer.addPass(new OutputPass());
    const grade = new ShaderPass(GradeShader);
    grade.uniforms["contrast"]!.value = p.contrast;
    grade.uniforms["saturation"]!.value = p.saturation;
    grade.uniforms["vignette"]!.value = p.vignette;
    composer.addPass(grade);
    this.grade = grade;
    this.composer = composer;
    this.setSize(this.width, this.height);
  }

  /** Call after the renderer's size or pixel ratio changed. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(this.width, this.height);
  }

  /** Feed the car's speed each frame; drives the edge motion blur. */
  setSpeed(kmh: number, dt: number): void {
    const p = GRAPHICS_PROFILES[this.level];
    const target = motionBlurAmount(this.level, kmh);
    this.motion += (target - this.motion) * Math.min(1, dt * 4);
    if (this.grade && p.motionBlur > 0)
      this.grade.uniforms["motion"]!.value = this.motion;
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private disposeComposer(): void {
    const c = this.composer;
    if (!c) return;
    for (const pass of c.passes) pass.dispose?.();
    c.dispose();
    this.composer = null;
    this.grade = null;
  }

  dispose(): void {
    this.disposeComposer();
  }
}
