/**
 * road.js — 3D Figure-8 Road Geometry
 *
 * Implements a continuous parametric Figure-8 loop.
 * Passes through the origin (0, 0, 0) at two points in parameter space:
 * t = 0.25 (going top-right to bottom-left) and t = 0.75 (going bottom-right to top-left).
 */

const TWO_PI = Math.PI * 2;

/**
 * Parametric shape: lemniscate-like or two circles.
 * Let's use a Lemniscate of Gerono (which has a clean crossing at 0,0, and is smooth).
 * x(t) = R * cos(t)
 * y(t) = R * sin(t) * cos(t)  (or sin(2t) / 2)
 * We scale x and y to create a proportional Figure-8.
 */
export function getRawPosition(t, R = 110) {
  const angle = t * TWO_PI;
  // Lemniscate of Gerono
  const x = R * Math.sin(angle);
  const y = R * Math.sin(angle) * Math.cos(angle) * 1.2;
  
  // Smoothly distribute elevation change over the entire loop using a cosine wave.
  // At t=0 and t=1, z = H. At t=0.5, z = 0.
  const H = 15.0; // 15 meters clearance at crossing
  const z = (H / 2) * (1 + Math.cos(angle));
  
  return { x, y, z };
}

/**
 * Builds the road polyline parameterised by arc-length.
 */
export function buildRoad(R = 110, N = 800) {
  const rawPoints = [];
  for (let i = 0; i < N; i++) {
    rawPoints.push(getRawPosition(i / N, R));
  }

  // Calculate cumulative arc length in 3D
  const sList = [0];
  for (let i = 1; i < N; i++) {
    const dx = rawPoints[i].x - rawPoints[i - 1].x;
    const dy = rawPoints[i].y - rawPoints[i - 1].y;
    const dz = rawPoints[i].z - rawPoints[i - 1].z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    sList.push(sList[i - 1] + dist);
  }
  // Connect loop end
  const dxEnd = rawPoints[0].x - rawPoints[N - 1].x;
  const dyEnd = rawPoints[0].y - rawPoints[N - 1].y;
  const dzEnd = rawPoints[0].z - rawPoints[N - 1].z;
  const totalLength = sList[N - 1] + Math.sqrt(dxEnd * dxEnd + dyEnd * dyEnd + dzEnd * dzEnd);

  // Build points with tangents and normalise s
  const points = [];
  for (let i = 0; i < N; i++) {
    const p = rawPoints[i];
    const prev = rawPoints[(i - 1 + N) % N];
    const next = rawPoints[(i + 1) % N];
    
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const dz = next.z - prev.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

    points.push({
      x: p.x,
      y: p.y,
      z: p.z,
      tx: dx / len,
      ty: dy / len,
      tz: dz / len,
      s: sList[i]
    });
  }

  // Crossing points are now completely separated by elevation,
  // so yield/crossover logic can be disabled.
  return {
    points,
    totalLength,
    crossingS: [] // Empty to bypass yielding/collision checks at intersection
  };
}

export function getPointAtS(road, s) {
  const { points, totalLength } = road;
  const N = points.length;
  s = ((s % totalLength) + totalLength) % totalLength;

  let lo = 0, hi = N - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].s <= s) lo = mid;
    else hi = mid;
  }

  const a = points[lo];
  const b = points[hi];
  const segmentLength = (b.s - a.s + totalLength) % totalLength || 1;
  const t = (s - a.s) / segmentLength;

  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    tx: a.tx + (b.tx - a.tx) * t,
    ty: a.ty + (b.ty - a.ty) * t,
    tz: a.tz + (b.tz - a.tz) * t
  };
}
