// promptfoo transform: parse LLM output (certitude, ubiquity[, evolution]) → JSON
// Inlines the S-curve math because promptfoo's VM sandbox does not support dynamic import().
// Parameters must stay in sync with scripts/s-curve.mjs DEFAULT_PARAMS.

const P = {
  kUpper: 8.5,  x0Upper: 0.28, yMinUpper: 0, yMaxUpper: 1,    nuUpper: 2.1,
  kLower: 7,    x0Lower: 0.54, yMinLower: 0, yMaxLower: 0.98, nuLower: 1.7,
};

function sigmoid(c, k, x0) {
  return 1 / (1 + Math.exp(-k * (c - x0)));
}

function gsigmoid(c, k, x0, yMin, yMax, nu) {
  return yMin + (yMax - yMin) * Math.pow(sigmoid(c, k, x0), nu);
}

function bandUpper(c) {
  return gsigmoid(c, P.kUpper, P.x0Upper, P.yMinUpper, P.yMaxUpper, P.nuUpper);
}

function bandLower(c) {
  return gsigmoid(c, P.kLower, P.x0Lower, P.yMinLower, P.yMaxLower, P.nuLower);
}

function centerCurve(c) {
  return (bandUpper(c) + bandLower(c)) / 2;
}

function projectOnCurve(c, u) {
  let bestT = 0, bestDist = Infinity;
  for (let t = 0; t <= 1; t += 0.001) {
    const pu = centerCurve(t);
    const dist = (t - c) ** 2 + (pu - u) ** 2;
    if (dist < bestDist) { bestDist = dist; bestT = t; }
  }
  return Math.round(bestT * 1000) / 1000;
}

function classifyZone(c, u) {
  const up = bandUpper(c), lo = bandLower(c);
  return (u >= lo && u <= up) ? 'competitive' : 'extra-competitive-market';
}

function bandDistance(c, u) {
  const up = bandUpper(c), lo = bandLower(c);
  if (u > up) return -(u - up);
  if (u < lo) return -(lo - u);
  return Math.min(u - lo, up - u);
}

// Publication type centroids — must stay in sync with s-curve.mjs PUB_TYPE_CENTROIDS
const PUB_CENTROIDS = { wonder: 0.09, build: 0.22, operate: 0.48, usage: 0.85 };

function pubEvolution(wonder, build, operate, usage) {
  const C = PUB_CENTROIDS;
  const sum = wonder + build + operate + usage;
  if (sum === 0) return null;
  const w = wonder / sum, b = build / sum, o = operate / sum, u = usage / sum;
  return Math.round((w * C.wonder + b * C.build + o * C.operate + u * C.usage) * 1000) / 1000;
}

function computeEvolution(certitude, ubiquity) {
  const upper = bandUpper(certitude);
  const lower = bandLower(certitude);
  const inBand = ubiquity >= lower && ubiquity <= upper;

  let evolution;
  if (inBand) {
    evolution = projectOnCurve(certitude, ubiquity);
  } else if (ubiquity > upper) {
    evolution = 1 + (ubiquity - upper);
  } else {
    evolution = -(lower - ubiquity);
  }

  return Math.round(evolution * 1000) / 1000;
}

module.exports = function (output, context) {
  const cMatch = output.match(/certitude[:\s=]*([\d.]+)/i);
  const uMatch = output.match(/ubiquit[éy][:\s=]*([\d.]+)/i);

  if (!cMatch || !uMatch) return output;

  const c = parseFloat(cMatch[1]);
  const u = parseFloat(uMatch[1]);

  // Optional: parse LLM's direct evolution estimate (prompt E)
  const evoMatch = output.match(/evolution[:\s=]*([\d.]+)/i);
  const llmEvolution = evoMatch ? parseFloat(evoMatch[1]) : null;

  // Optional: parse publication type proportions
  const pwMatch = output.match(/pub_wonder[:\s=]*([\d.]+)/i);
  const pbMatch = output.match(/pub_build[:\s=]*([\d.]+)/i);
  const poMatch = output.match(/pub_operate[:\s=]*([\d.]+)/i);
  const puMatch = output.match(/pub_usage[:\s=]*([\d.]+)/i);

  let pub_evolution = null;
  let pub_proportions = null;
  if (pwMatch && pbMatch && poMatch && puMatch) {
    const pw = parseFloat(pwMatch[1]);
    const pb = parseFloat(pbMatch[1]);
    const po = parseFloat(poMatch[1]);
    const pu = parseFloat(puMatch[1]);
    pub_proportions = { wonder: pw, build: pb, operate: po, usage: pu };
    pub_evolution = pubEvolution(pw, pb, po, pu);
  }

  return JSON.stringify({
    scurve_evolution: computeEvolution(c, u),
    llm_evolution: llmEvolution,
    pub_evolution,
    pub_proportions,
    zone: classifyZone(c, u),
    band_distance: Math.round(bandDistance(c, u) * 1000) / 1000,
  });
};
