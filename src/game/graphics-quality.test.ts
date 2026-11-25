import { describe, expect, it } from "vitest";
import {
  GRAPHICS_PROFILES,
  defaultGraphicsLevel,
  graphicsPixelRatio,
  loadGraphicsLevel,
  motionBlurAmount,
} from "./graphics-quality";

const store = (v: string | null) => ({ getItem: () => v });

describe("graphics quality options", () => {
  it("offers best, medium and original", () => {
    expect(Object.keys(GRAPHICS_PROFILES).sort()).toEqual([
      "best",
      "medium",
      "original",
    ]);
  });
  it("original keeps today's rendering: no effects, same resolution and shadows", () => {
    const o = GRAPHICS_PROFILES.original;
    expect(o.post).toBe(false);
    expect(o.shadowMapSize).toBe(1024);
    expect(graphicsPixelRatio("original", 3, false)).toBe(1.5);
    expect(graphicsPixelRatio("original", 3, true)).toBe(1);
  });
  it("weak phones (Galaxy A11) start on original, others on best", () => {
    expect(defaultGraphicsLevel(true)).toBe("original");
    expect(defaultGraphicsLevel(false)).toBe("best");
  });
  it("remembers the player's choice and ignores junk", () => {
    expect(loadGraphicsLevel(store("medium"), false)).toBe("medium");
    expect(loadGraphicsLevel(store("best"), true)).toBe("best");
    expect(loadGraphicsLevel(store("ultra"), true)).toBe("original");
  });
  it("speed blur: none on original or when slow, full on best at 320 km/h", () => {
    expect(motionBlurAmount("original", 350)).toBe(0);
    expect(motionBlurAmount("best", 60)).toBe(0);
    expect(motionBlurAmount("best", 320)).toBe(1);
    expect(motionBlurAmount("medium", 320)).toBe(0.5);
  });
});
