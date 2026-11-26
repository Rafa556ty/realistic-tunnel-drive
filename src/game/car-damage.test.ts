import { describe, expect, it } from "vitest";
import { debrisCount, debrisSceneZ, stepDebris, type DebrisPiece } from "./car-damage";
import { GUARDRAIL_LIMIT, railImpact } from "./vehicle-dynamics";

const piece = (): DebrisPiece => ({
  x: 6, y: 0.6, w: 1000, vx: -3, vy: 3, vw: 40,
  sx: 0.2, sy: 0.03, sz: 0.1, rx: 1, ry: 2, rz: 3, spin: 10, resting: false,
});

describe("guardrail crash debris", () => {
  it("a light scrape throws nothing, a hard hit throws many parts", () => {
    expect(debrisCount(railImpact(1, 120))).toBe(0);
    expect(debrisCount(railImpact(8, 200))).toBeGreaterThanOrEqual(12);
  });

  it("parts fall, come to rest on the road and never disappear", () => {
    const p = piece();
    for (let t = 0; t < 20; t += 1 / 60) stepDebris(p, 1 / 60);
    expect(p.resting).toBe(true);
    expect(p.y).toBeLessThan(0.05);
    expect(p.w).toBeGreaterThan(1000);
    const at = { ...p };
    for (let t = 0; t < 600; t += 1 / 30) stepDebris(p, 1 / 30);
    expect(p).toEqual(at);
  });

  it("a part left on the road is passed again on the next lap", () => {
    expect(debrisSceneZ(1000 + 6400 - 50, 1000)).toBeCloseTo(-50);
    expect(debrisSceneZ(1030, 1000)).toBeCloseTo(30);
  });

  it("the car reaches the rail before stopping (no invisible wall)", () => {
    expect(GUARDRAIL_LIMIT).toBeCloseTo(6.39, 2);
  });
});
