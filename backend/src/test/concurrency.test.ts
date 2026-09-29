import { describe, expect, it } from "vitest";
import { mapLimited } from "../interpretation/concurrency.js";

describe("mapLimited", () => {
  it("keeps results in the original order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const delays = [30, 5, 20, 1, 15, 10, 2, 25];
    const results = await mapLimited(delays, 3, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return `item-${i}`;
    });
    expect(results).toEqual(delays.map((_, i) => `item-${i}`));
    expect(peak).toBe(3);
  });

  it("handles an empty list", async () => {
    expect(await mapLimited([], 4, async () => 1)).toEqual([]);
  });
});
