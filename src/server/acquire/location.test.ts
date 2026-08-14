import { describe, expect, it } from "vitest";

import {
  distanceBand,
  distanceMeters,
  effectiveAcquisitionRadius,
} from "@/server/acquire/location";

describe("location decision helpers", () => {
  it("returns zero for identical points", () => {
    expect(distanceMeters(
      { latitude: 37.5665, longitude: 126.978 },
      { latitude: 37.5665, longitude: 126.978 },
    )).toBe(0);
  });

  it("calculates a stable great-circle distance", () => {
    const distance = distanceMeters(
      { latitude: 37.5665, longitude: 126.978 },
      { latitude: 37.5651, longitude: 126.98955 },
    );
    expect(distance).toBeGreaterThan(1_000);
    expect(distance).toBeLessThan(1_100);
  });

  it("uses bounded reported accuracy as a forgiving radius buffer", () => {
    expect(effectiveAcquisitionRadius(150, 40, 200)).toBe(190);
    expect(effectiveAcquisitionRadius(150, 500, 200)).toBe(350);
  });

  it("does not reveal exact distance and classifies only near or far", () => {
    expect(distanceBand(300, 200)).toBe("near");
    expect(distanceBand(401, 200)).toBe("far");
  });
});
