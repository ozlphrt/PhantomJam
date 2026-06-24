/**
 * renderer.js — Road and vehicle rendering
 *
 * Draws:
 *   1. Road surface (thick grey path)
 *   2. Speed heatmap overlay on the road
 *   3. Vehicle rectangles (colour = speed)
 */

import { roadPointAtS } from './road.js';

const ROAD_WIDTH  = 28;  // px
const VEHICLE_W   = 10;  // px (visual width)
const VEHICLE_H   = 5;   // px (visual height)
const SEGMENT_COUNT = 200;

/**
 * Map a normalised speed fraction (0=stopped, 1=free flow) to a CSS colour.
 * 0 → red (#e05a5a), 0.5 → amber (#f6c94e), 1 → green (#58b88e)
 */
function speedColor(frac) {
  frac = Math.max(0, Math.min(1, frac));
  if (frac < 0.5) {
    // red → amber
    const t = frac * 2;
    const r = Math.round(224 + (246 - 224) * t);
    const g = Math.round(90  + (201 - 90)  * t);
    const b = Math.round(90  + (78  - 90)  * t);
    return `rgb(${r},${g},${b})`;
  } else {
    // amber → green
    const t = (frac - 0.5) * 2;
    const r = Math.round(246 + (88  - 246) * t);
    const g = Math.round(201 + (184 - 201) * t);
    const b = Math.round(78  + (142 - 78)  * t);
    return `rgb(${r},${g},${b})`;
  }
}

/**
 * Compute mean vehicle speed per road segment.
 * @returns {Float32Array} length SEGMENT_COUNT, values = mean speed (or -1 if empty)
 */
function segmentSpeeds(vehicles, totalLength) {
  const sums  = new Float32Array(SEGMENT_COUNT);
  const counts = new Int32Array(SEGMENT_COUNT);
  for (const car of vehicles) {
    const idx = Math.floor((car.s / totalLength) * SEGMENT_COUNT) % SEGMENT_COUNT;
    sums[idx]   += car.v;
    counts[idx] += 1;
  }
  const result = new Float32Array(SEGMENT_COUNT);
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    result[i] = counts[i] > 0 ? sums[i] / counts[i] : -1;
  }
  return result;
}

/**
 * Draw a thick coloured road segment between two waypoints.
 */
function drawRoadSegment(ctx, p1, p2, color, width) {
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  ctx.stroke();
}

/**
 * Full render pass.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} road        - { points, totalLength }
 * @param {Array}  vehicles    - IDM vehicle array
 * @param {object} params      - IDM params (for v0 reference)
 * @param {object} transform   - { cx, cy, scale } — world-to-canvas
 */
export function render(ctx, road, vehicles, params, transform) {
  const { canvas } = ctx;
  const { cx, cy, scale } = transform;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Helper: world → canvas
  const wx = (x) => cx + x * scale;
  const wy = (y) => cy + y * scale;

  const { points, totalLength } = road;
  const N = points.length;

  // ── 1. Draw road surface (base grey) ──
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(wx(points[0].x), wy(points[0].y));
  for (let i = 1; i < N; i++) {
    ctx.lineTo(wx(points[i].x), wy(points[i].y));
  }
  ctx.closePath();
  ctx.strokeStyle = '#cccbc3';
  ctx.lineWidth   = ROAD_WIDTH * scale;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.stroke();
  ctx.restore();

  // ── 2. Speed heatmap overlay ──
  const speeds  = segmentSpeeds(vehicles, totalLength);
  const segStep = totalLength / SEGMENT_COUNT;

  for (let i = 0; i < SEGMENT_COUNT; i++) {
    if (speeds[i] < 0) continue;
    const frac = speeds[i] / params.v0;
    const color = speedColor(frac);

    const s1 = i * segStep;
    const s2 = (i + 1) * segStep;
    const p1 = { x: wx(roadPointAtS(road, s1).x), y: wy(roadPointAtS(road, s1).y) };
    const p2 = { x: wx(roadPointAtS(road, s2).x), y: wy(roadPointAtS(road, s2).y) };
    drawRoadSegment(ctx, p1, p2, color, (ROAD_WIDTH - 6) * scale);
  }

  // ── 3. Centre line dashes ──
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(wx(points[0].x), wy(points[0].y));
  for (let i = 1; i < N; i++) {
    ctx.lineTo(wx(points[i].x), wy(points[i].y));
  }
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth   = 1.5 * scale;
  ctx.setLineDash([10 * scale, 14 * scale]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // ── 4. Vehicles ──
  for (const car of vehicles) {
    const pt    = roadPointAtS(road, car.s);
    const frac  = car.v / params.v0;
    const color = speedColor(frac);

    const x  = wx(pt.x);
    const y  = wy(pt.y);
    const tx = pt.tx;
    const ty = pt.ty;
    const angle = Math.atan2(ty, tx);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    const vw = VEHICLE_W * scale;
    const vh = VEHICLE_H * scale;

    // Shadow
    ctx.shadowColor   = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur    = 4 * scale;
    ctx.shadowOffsetY = 1 * scale;

    // Body
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-vw / 2, -vh / 2, vw, vh, 2 * scale);
    ctx.fill();

    // Windshield highlight
    ctx.shadowColor = 'transparent';
    ctx.fillStyle   = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.roundRect(vw * 0.1, -vh * 0.35, vw * 0.3, vh * 0.7, 1 * scale);
    ctx.fill();

    ctx.restore();
  }
}

/**
 * Compute a transform so the figure-8 fits nicely in the canvas.
 * R is the loop radius in world units.
 */
export function computeTransform(canvasW, canvasH, R) {
  // The figure-8 spans ±R horizontally and ±2R vertically
  const margin  = 40;
  const scaleX  = (canvasW - margin * 2) / (2 * R);
  const scaleY  = (canvasH - margin * 2) / (4 * R);
  const scale   = Math.min(scaleX, scaleY);
  return {
    cx:    canvasW / 2,
    cy:    canvasH / 2,
    scale,
  };
}

export { speedColor, segmentSpeeds, SEGMENT_COUNT };
