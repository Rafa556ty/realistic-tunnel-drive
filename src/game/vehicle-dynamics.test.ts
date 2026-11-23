import { describe, expect, it } from "vitest";
import {
  BUMPER_HANGS_AT,
  DEBRIS_AT,
  GUARDRAIL_LIMIT,
  canRevInPlace,
  driveProfileFor,
  newRevs,
  newSlide,
  railImpact,
  stepRevs,
  stepSlide,
} from "./vehicle-dynamics";

const run = (car: string, seconds: number, inp: Parameters<typeof stepSlide>[1]) => {
  let s = newSlide();
  let peak = 0;
  const p = driveProfileFor(car);
  for (let t = 0; t < seconds; t += 1 / 60) {
    s = stepSlide(s, inp, p, 1 / 60).state;
    peak = Math.max(peak, Math.abs(s.slip));
  }
  return peak;
};

describe("drivetrain", () => {
  it("BMW M4 is rear-wheel drive", () => {
    expect(driveProfileFor("m4-competition").drive).toBe("RWD");
  });

  it("the M4 slides far more than an AWD Bugatti on the same throttle and steering", () => {
    const inp = { steer: 1, gas: true, handbrake: false, speedKmh: 90, gear: 2 };
    expect(run("m4-competition", 1.5, inp)).toBeGreaterThan(run("chiron", 1.5, inp) * 3);
  });

  it("the M4's tail wags past centre after lifting off (fishtail)", () => {
    const p = driveProfileFor("m4-competition");
    let s = newSlide();
    for (let t = 0; t < 1.5; t += 1 / 60) s = stepSlide(s, { steer: 1, gas: true, handbrake: false, speedKmh: 90, gear: 2 }, p, 1 / 60).state;
    let minSlip = 0;
    for (let t = 0; t < 1.5; t += 1 / 60) {
      s = stepSlide(s, { steer: 0, gas: false, handbrake: false, speedKmh: 90, gear: 2 }, p, 1 / 60).state;
      minSlip = Math.min(minSlip, s.slip);
    }
    expect(minSlip).toBeLessThan(-0.02);
  });

  it("M4 loses traction launching in first gear", () => {
    const r = stepSlide(newSlide(), { steer: 0, gas: true, handbrake: false, speedKmh: 10, gear: 1 }, driveProfileFor("m4-competition"), 1 / 60);
    expect(r.traction).toBeLessThan(0.8);
  });
});

describe("handbrake and rev limiter", () => {
  it("revs in place only with the handbrake on and the car stopped", () => {
    expect(canRevInPlace(true, 0)).toBe(true);
    expect(canRevInPlace(false, 0)).toBe(false);
    expect(canRevInPlace(true, 40)).toBe(false);
  });

  it("flooring it with the handbrake on hits the car's limiter and bounces off it", () => {
    const p = driveProfileFor("m4-competition");
    let s = newRevs(p);
    let max = 0;
    for (let t = 0; t < 2; t += 1 / 120) {
      s = stepRevs(s, true, p, 1 / 120);
      max = Math.max(max, s.rpm);
    }
    expect(max).toBe(7200);
    expect(s.cuts).toBeGreaterThan(8);
    expect(s.rpm).toBeGreaterThanOrEqual(7200 - 400);
  });

  it("each car cuts at its own limiter (Revuelto 9500 rpm)", () => {
    const p = driveProfileFor("revuelto");
    let s = newRevs(p);
    for (let t = 0; t < 2; t += 1 / 120) s = stepRevs(s, true, p, 1 / 120);
    expect(Math.round(s.rpm / 100) * 100).toBeGreaterThanOrEqual(9100);
  });
});

describe("guardrail", () => {
  it("car can drive right up to the rail (no invisible wall at the lane edge)", () => {
    // lanes end at 5.4 m; the rail face is at 7.41 m
    expect(GUARDRAIL_LIMIT).toBeGreaterThan(6.3);
    expect(GUARDRAIL_LIMIT + 1.02).toBeCloseTo(7.41, 2);
  });

  it("a gentle scrape does no damage, a hard hit throws parts and leaves the bumper hanging", () => {
    expect(railImpact(1, 120)).toBe(0);
    expect(railImpact(4, 120)).toBeGreaterThan(DEBRIS_AT);
    expect(railImpact(8, 200)).toBeGreaterThan(BUMPER_HANGS_AT);
  });
});
