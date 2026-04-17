// S-curve model: (certitude, ubiquity) → { zone, evolution }
// Based on Wardley's evolution model with binary zone classification
//
// The band is defined by two independent generalized sigmoids:
//   upper boundary: rises earlier, gentler slope
//   lower boundary: rises later, steeper slope
// Inside the band = competitive market (classic Wardley evolution)
// Outside the band = still projected geometrically (zone is informational, confidence degrades)
// This naturally creates three visual stages:
//   Foot (thin) → Belly (thick) → Top (medium)
//
// Each boundary: f(c) = yMin + (yMax - yMin) * sigmoid(c, k, x0)^nu
//   yMin/yMax — asymptotic range (instead of fixed 0→1)
//   nu — skew: 1=standard, >1=stays low longer, <1=rises early

// Calibratable parameters — two independent generalized sigmoids
export const DEFAULT_PARAMS = {
  kUpper: 8.5,  x0Upper: 0.28, yMinUpper: 0, yMaxUpper: 1,    nuUpper: 2.1,
  kLower: 7,    x0Lower: 0.54, yMinLower: 0, yMaxLower: 0.98, nuLower: 1.7,
};

// Raw sigmoid (0→1)
export function sigmoid(c: number, k: number, x0: number): number {
  return 1 / (1 + Math.exp(-k * (c - x0)));
}

// Generalized sigmoid with range and skew
function gsigmoid(c: number, k: number, x0: number, yMin: number, yMax: number, nu: number): number {
  return yMin + (yMax - yMin) * Math.pow(sigmoid(c, k, x0), nu);
}

// Band boundaries — two independent generalized sigmoids
export interface BandParams {
  kUpper: number; x0Upper: number; yMinUpper: number; yMaxUpper: number; nuUpper: number;
  kLower: number; x0Lower: number; yMinLower: number; yMaxLower: number; nuLower: number;
}

export function bandUpper(c: number, params: BandParams = DEFAULT_PARAMS): number {
  return gsigmoid(c, params.kUpper, params.x0Upper, params.yMinUpper, params.yMaxUpper, params.nuUpper);
}

export function bandLower(c: number, params: BandParams = DEFAULT_PARAMS): number {
  return gsigmoid(c, params.kLower, params.x0Lower, params.yMinLower, params.yMaxLower, params.nuLower);
}

// Center of the band — used for geometric projection
export function centerCurve(c: number, params: BandParams = DEFAULT_PARAMS): number {
  return (bandUpper(c, params) + bandLower(c, params)) / 2;
}

// Is the point inside the evolution band?
export function isInBand(c: number, u: number, params: BandParams = DEFAULT_PARAMS): boolean {
  return u >= bandLower(c, params) && u <= bandUpper(c, params);
}

// Classify zone: competitive (inside band) / extra-competitive-market (outside band)
export function classifyZone(c: number, u: number, params: BandParams = DEFAULT_PARAMS): string {
  return isInBand(c, u, params) ? 'competitive' : 'extra-competitive-market';
}

// Signed distance from band boundary: positive = inside, negative = outside
export function bandDistance(c: number, u: number, params: BandParams = DEFAULT_PARAMS): number {
  const upper = bandUpper(c, params);
  const lower = bandLower(c, params);
  if (u > upper) return -(u - upper);
  if (u < lower) return -(lower - u);
  return Math.min(u - lower, upper - u);
}

// Geometric projection onto the center curve → { evolution: t* ∈ [0, 1], distToCenter }
export function projectOnCurve(c: number, u: number, params: BandParams = DEFAULT_PARAMS): { evolution: number; distToCenter: number } {
  let bestT = 0;
  let bestDist = Infinity;
  for (let t = 0; t <= 1; t += 0.001) {
    const pu = centerCurve(t, params);
    const dist = (t - c) ** 2 + (pu - u) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestT = t;
    }
  }
  return {
    evolution: Math.round(bestT * 1000) / 1000,
    distToCenter: Math.round(Math.sqrt(bestDist) * 1000) / 1000,
  };
}

// Main function: (certitude, ubiquity) → { zone, evolution, phase, bandDistance }
// any: returns a heterogeneous result bag (zone, evolution, phase, bandDistance, distToCenter)
export function computeEvolution(certitude: number, ubiquity: number, params: BandParams = DEFAULT_PARAMS): any {
  const zone = classifyZone(certitude, ubiquity, params);
  const bd = bandDistance(certitude, ubiquity, params);

  // Always project geometrically onto center curve — evolution is always in [0, 1].
  // distToCenter = Euclidean distance from point to nearest point on center sigmoid.
  const proj = projectOnCurve(certitude, ubiquity, params);

  const phase =
    proj.evolution <= 0.18 ? 'Genesis' :
    proj.evolution <= 0.40 ? 'Custom' :
    proj.evolution <= 0.70 ? 'Product' :
    'Commodity';

  return {
    zone,
    evolution: proj.evolution,
    phase,
    bandDistance: Math.round(bd * 1000) / 1000,
    distToCenter: proj.distToCenter,
  };
}
