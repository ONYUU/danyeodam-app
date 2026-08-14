const earthRadiusMeters = 6_371_008.8;

type Point = {
  latitude: number;
  longitude: number;
};

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function distanceMeters(first: Point, second: Point): number {
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude)
      * Math.cos(secondLatitude)
      * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function effectiveAcquisitionRadius(
  configuredRadiusMeters: number,
  accuracyMeters: number,
  accuracyThresholdMeters: number,
): number {
  return configuredRadiusMeters + Math.min(accuracyMeters, accuracyThresholdMeters);
}

export function distanceBand(distance: number, allowedRadius: number): "near" | "far" {
  return distance <= allowedRadius * 2 ? "near" : "far";
}
