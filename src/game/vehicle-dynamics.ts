// Player car handling rules that sit on top of the lane-based sim in game.tsx:
// drivetrain (RWD slides / AWD grips), handbrake, rev limiter and guardrail impacts.
// Plain TypeScript (no React / three) so the rules can be unit tested.

export type Drive = "RWD" | "AWD";

export interface DriveProfile {
  drive: Drive;
  /** 0..1 how easily the rear steps out under power. */
  slide: number;
  /** Rear grip: higher snaps back faster. */
  grip: number;
  /** Rev limiter (rpm) and idle (rpm). */
  limiter: number;
  idle: number;
}

/** Real drivetrains: the BMW M4 (rear-drive, S58 straight-six) is the loosest car in the game. */
export const DRIVE_PROFILES: Record<string, DriveProfile> = {
  "m4-competition": { drive: "RWD", slide: 1, grip: 0.45, limiter: 7200, idle: 850 },
  m2: { drive: "RWD", slide: 0.7, grip: 0.6, limiter: 7200, idle: 850 },
  "mustang-rtr": { drive: "RWD", slide: 0.75, grip: 0.6, limiter: 7500, idle: 800 },
  demon: { drive: "RWD", slide: 0.8, grip: 0.55, limiter: 6500, idle: 750 },
  "m8-competition": { drive: "AWD", slide: 0.3, grip: 0.85, limiter: 7200, idle: 800 },
  laferrari: { drive: "RWD", slide: 0.45, grip: 0.8, limiter: 9250, idle: 1000 },
  jesko: { drive: "RWD", slide: 0.4, grip: 0.85, limiter: 8500, idle: 1000 },
  huayra: { drive: "RWD", slide: 0.45, grip: 0.8, limiter: 6500, idle: 900 },
  "utopia-roadster": { drive: "RWD", slide: 0.45, grip: 0.8, limiter: 6700, idle: 900 },
  revuelto: { drive: "AWD", slide: 0.15, grip: 1, limiter: 9500, idle: 1000 },
  svj: { drive: "AWD", slide: 0.2, grip: 1, limiter: 8700, idle: 1000 },
  "huracan-evo": { drive: "AWD", slide: 0.22, grip: 1, limiter: 8500, idle: 1000 },
  chiron: { drive: "AWD", slide: 0.1, grip: 1, limiter: 6700, idle: 900 },
  "chiron-ss300": { drive: "AWD", slide: 0.1, grip: 1, limiter: 6900, idle: 900 },
  "voiture-noire": { drive: "AWD", slide: 0.1, grip: 1, limiter: 6700, idle: 900 },
  tourbillon: { drive: "AWD", slide: 0.1, grip: 1, limiter: 9000, idle: 1000 },
};

const DEFAULT_PROFILE: DriveProfile = { drive: "AWD", slide: 0.2, grip: 1, limiter: 8000, idle: 900 };
export const driveProfileFor = (carId: string): DriveProfile => DRIVE_PROFILES[carId] ?? DEFAULT_PROFILE;

// ---------------------------------------------------------------- slide

/** Largest yaw (rad) the rear can swing out. */
export const MAX_SLIP = 0.62;

export interface SlideState {
  slip: number; // yaw of the body beyond the travel direction (rad, + = nose right)
  slipV: number;
}
export const newSlide = (): SlideState => ({ slip: 0, slipV: 0 });

export interface SlideInput {
  steer: number; // -1..1
  gas: boolean;
  handbrake: boolean;
  speedKmh: number;
  gear: number; // 1-based
}

export interface SlideResult {
  state: SlideState;
  /** 0..1 engine force that reaches the road (wheelspin eats the rest). */
  traction: number;
  /** km/h per second lost to sideways scrub. */
  scrub: number;
  /** 0..1 how hard the tyres are sliding (screech / smoke). */
  skid: number;
  /** Multiplier on how fast the car can move sideways while the tail is out. */
  lateral: number;
}

const gearPunch = (gear: number) => (gear <= 2 ? 1 : gear === 3 ? 0.7 : gear === 4 ? 0.42 : gear === 5 ? 0.24 : 0.12);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Power oversteer (RWD), handbrake turns, fishtail on lift-off and counter-steer recovery. */
export function stepSlide(s: SlideState, inp: SlideInput, p: DriveProfile, dt: number): SlideResult {
  const v = inp.speedKmh;
  const steerMag = Math.abs(inp.steer);
  const dir = Math.sign(inp.steer);
  const window = clamp((v - 12) / 25, 0, 1) * clamp((260 - v) / 80, 0, 1);
  const rwd = p.drive === "RWD" ? 1 : 0.22;
  let excite = 0;
  if (inp.gas && !inp.handbrake && steerMag > 0.12) excite = p.slide * rwd * gearPunch(inp.gear) * steerMag * window;
  if (inp.handbrake && v > 20) excite = Math.max(excite, (steerMag > 0.1 ? 0.95 : 0.25) * clamp(v / 60, 0, 1));
  const target = (dir || Math.sign(s.slip) || 1) * excite * MAX_SLIP * (inp.handbrake ? 1 : 0.85);

  // Loose rear (low grip) = soft, under-damped spring: the tail overshoots and wags back.
  const k = 10 + 22 * p.grip;
  let d = 1.6 + 7 * p.grip;
  // Counter-steering catches the slide.
  if (dir !== 0 && Math.sign(s.slip) === -dir && Math.abs(s.slip) > 0.04) d += 7 * steerMag;
  if (v < 8) d += 20;
  let slipV = s.slipV + (k * ((v < 8 ? 0 : target) - s.slip) - d * s.slipV) * dt;
  let slip = clamp(s.slip + slipV * dt, -0.75, 0.75);
  if (Math.abs(slip) < 1e-4 && Math.abs(slipV) < 1e-3) slip = slipV = 0;

  const abs = Math.abs(slip);
  // Launch wheelspin on rear-drive cars: the M4 lights its tyres in 1st/2nd.
  const spin = inp.gas && !inp.handbrake && inp.gear <= 2 ? p.slide * rwd * 0.32 * clamp(1 - v / 90, 0, 1) : 0;
  const traction = clamp(1 - spin - abs * 0.35, 0.45, 1);
  const scrub = abs > 0.05 ? abs * v * 0.42 : 0;
  const skid = clamp(Math.max(abs / 0.28, spin * 2.2 * (v > 2 ? 1 : 0)), 0, 1);
  const lateral = 1 - 0.45 * clamp(abs / 0.5, 0, 1);
  return { state: { slip, slipV }, traction, scrub, skid, lateral };
}

// ---------------------------------------------------------------- handbrake + rev limiter

/** Rear wheels locked: deceleration in km/h per second while rolling. */
export const HANDBRAKE_DECEL = 26;

export interface RevState {
  rpm: number;
  cut: boolean;
  /** Incremented every time the limiter cuts the fuel. */
  cuts: number;
}
export const newRevs = (p: DriveProfile): RevState => ({ rpm: p.idle, cut: false, cuts: 0 });

/** Rpm the limiter drops before fuel comes back (bounce depth). */
export const LIMITER_DROP = 380;

/** Free-revving engine (handbrake on, car still): climbs to the limiter and bounces on it. */
export function stepRevs(s: RevState, gas: boolean, p: DriveProfile, dt: number): RevState {
  let { rpm, cut, cuts } = s;
  if (gas) {
    if (cut) {
      rpm -= 9000 * dt;
      if (rpm <= p.limiter - LIMITER_DROP) cut = false;
    } else {
      rpm += (rpm < p.limiter * 0.6 ? 11000 : 7000) * dt;
      if (rpm >= p.limiter) {
        rpm = p.limiter;
        cut = true;
        cuts++;
      }
    }
  } else {
    cut = false;
    rpm = Math.max(p.idle, rpm - 5200 * dt);
  }
  return { rpm: clamp(rpm, p.idle, p.limiter), cut, cuts };
}

/** The car can only rev in place when the handbrake holds it (almost) still. */
export const canRevInPlace = (handbrake: boolean, speedKmh: number) => handbrake && speedKmh < 3;

// ---------------------------------------------------------------- guardrail

/** Guardrail (and median barrier face) distance from the road centre, metres. */
export const RAIL_INNER_X = 7.41;
export const CAR_HALF_WIDTH = 1.02;
/** How far the car centre can go before its side touches the rail (no invisible wall). */
export const GUARDRAIL_LIMIT = RAIL_INNER_X - CAR_HALF_WIDTH;

/** 0..1 crash severity from the speed the car hits the rail with (sideways m/s) and road speed. */
export function railImpact(lateralMs: number, speedKmh: number): number {
  const n = Math.abs(lateralMs);
  if (n < 1.2 || speedKmh < 15) return 0;
  return clamp(((n - 1.2) / 6.5) * (0.6 + 0.4 * clamp(speedKmh / 160, 0, 1)), 0, 1);
}

/** Severity at which parts fly off and at which the bumper ends up hanging. */
export const DEBRIS_AT = 0.2;
export const BUMPER_HANGS_AT = 0.45;
