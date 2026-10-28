/**
 * idm.js — Intelligent Driver Model (IDM)
 *
 * Parameters from Treiber, Hennecke & Helbing (2000) — the paper that
 * first described phantom jams. These exact values produce backward-propagating
 * stop-and-go waves at critical density.
 *
 * KEY INSIGHT for phantom jams:
 *   aMax must be LOW (~0.73 m/s²). This means drivers accelerate slowly after
 *   a jam clears. If the car behind brakes, then slowly accelerates, the car
 *   behind IT brakes harder/longer — the disturbance AMPLIFIES and propagates
 *   backward against traffic. High aMax dissolves the wave; low aMax grows it.
 *
 *   Lane changes are DISABLED: they let impeded vehicles escape, preventing the
 *   wave from building. Each lane is an independent 1D ring — jams form cleanly.
 */

export const DEFAULT_PARAMS = {
  v0:    28,    // desired speed m/s (~100 km/h)
  aMax:  0.75,  // Treiber (2000) low max acceleration — amplifies stop-and-go phantom waves
  b:     2.0,   // comfortable deceleration (m/s²)
  T:     0.75,  // safe time headway (s) tuned for 300 vehicles across 5 lanes
  s0:    1.5,   // min bumper-to-bumper gap (m)
  delta: 4,
  vehicleLen:    4.3,
  truckLen:      6.2,
  busLen:        10.2,
  minivanLen:    4.7,
  motorcycleLen: 3.8,
};

/** IDM acceleration (Treiber 2000, Eq. 2) */
export function idmAccel(v, dv, gap, p) {
  const { v0, aMax, b, T, s0, delta } = p;
  gap = Math.max(gap, 0.01);
  const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(aMax * b)));
  return aMax * (1 - Math.pow(v / v0, delta) - Math.pow(sStar / gap, 2));
}

/**
 * Distribute N vehicles evenly across 5 lanes.
 * Vehicle types are balanced (cars, trucks, buses, minivans, motorcycles).
 * All start at 80% speed so the system isn't in free-flow equilibrium.
 * One car per lane gets a delayed hard-brake event to seed the phantom wave.
 */
export function createVehicles(count, totalLength, params) {
  const NUM_LANES = 5;
  const vehicles = [];
  let id = 0;

  for (let lane = 0; lane < NUM_LANES; lane++) {
    const perLane = Math.max(1, Math.round(count / NUM_LANES));

    // Generate random positions along the lane
    const positions = [];
    for (let k = 0; k < perLane; k++) {
      positions.push(Math.random() * totalLength);
    }
    positions.sort((a, b) => a - b);

    // Resolve spawn overlaps using relaxation steps scaled to lane density
    const minSpawnGap = Math.min(12.0, (totalLength / perLane) * 0.85);
    for (let iter = 0; iter < 10; iter++) {
      for (let i = 0; i < perLane; i++) {
        const nextIdx = (i + 1) % perLane;
        let gap = positions[nextIdx] - positions[i];
        if (gap < 0) gap += totalLength;
        if (gap < minSpawnGap) {
          positions[nextIdx] = (positions[i] + minSpawnGap) % totalLength;
        }
      }
      positions.sort((a, b) => a - b);
    }

    for (let k = 0; k < perLane && id < count; k++, id++) {
      let type = 'car';
      let len = params.vehicleLen;
      let noiseV0 = 1.0;

      const rem = id % 15;
      if (rem === 0) {
        type = 'truck';
        len = params.truckLen;
        noiseV0 = 0.80;
      } else if (rem === 3) {
        type = 'bus';
        len = params.busLen;
        noiseV0 = 0.75;
      } else if (rem === 6) {
        type = 'motorcycle';
        len = params.motorcycleLen;
        noiseV0 = 1.10;
      } else if (rem === 9) {
        type = 'minivan';
        len = params.minivanLen;
        noiseV0 = 0.95;
      }

      const s = positions[k];

      vehicles.push({
        id,
        s,
        v: params.v0 * 0.80,   // start below equilibrium speed
        a: 0,
        length: len,
        noiseV0,
        braking: false,
        lane,
        type,
        isTruck: type === 'truck', // legacy compatibility
        perturbTimer: -1,       // -1 = no pending perturbation
        lateralNoise: type === 'motorcycle'
          ? (Math.random() - 0.5) * 3.6  // motorcycles drift up to 1.8m left/right
          : (Math.random() - 0.5) * 2.6, // other vehicles drift up to 1.3m
        weavePhase: Math.random() * Math.PI * 2,
        weaveSpeed: 0.5 + Math.random() * 0.8,
      });
    }
  }

  // One hard-brake seed per lane, staggered so phantom waves form and propagate cleanly
  for (let lane = 0; lane < NUM_LANES; lane++) {
    const inLane = vehicles.filter(c => c.lane === lane);
    if (inLane.length > 2) {
      const seed = inLane[Math.floor(inLane.length / 2)]; // middle car
      seed.perturbTimer = 3.0 + lane * 1.5; // fires early to nucleate stop-and-go waves
    }
  }

  return vehicles;
}

/**
 * Single fixed-timestep physics update.
 *
 * Steps:
 *  1. Group vehicles by lane, sort by arc-position s.
 *  2. For each vehicle: find immediate leader (next in sorted order, wraps around ring).
 *  3. Compute IDM acceleration.
 *  4. Apply any pending perturbation (hard brake for 1.2 s).
 *  5. Euler-integrate v and s.
 */
export function stepVehicles(vehicles, params, road, dt) {
  const N = vehicles.length;
  if (N === 0) return;

  const totalLength = road.totalLength;
  const NUM_LANES = 5;

  // 1. Group by lane and sort
  let byLane = Array.from({ length: NUM_LANES }, () => []);
  for (const car of vehicles) {
    byLane[car.lane].push(car);
  }
  for (let l = 0; l < NUM_LANES; l++) {
    byLane[l].sort((a, b) => a.s - b.s);
  }

  // 1.5 Conservative Lane Changing (rare & strict so phantom jam queues do not dissolve)
  for (const ego of vehicles) {
    if (ego.visualLane === undefined) ego.visualLane = ego.lane;

    // Only allow occasional lane changes before a car is locked in a braking queue
    if (ego.v < 4.0 || ego.a < -0.25) continue;
    const checkRate = 0.008 * Math.min(1.0, dt / 0.05);
    if (Math.random() > checkRate) continue;

    const currentLane = ego.lane;

    // Find current leader and gap
    const currentLaneVehicles = byLane[currentLane];
    const egoIdx = currentLaneVehicles.indexOf(ego);
    const currentLeader = currentLaneVehicles[(egoIdx + 1) % currentLaneVehicles.length];
    let currentGap = currentLeader.s - ego.s - (ego.length / 2) - (currentLeader.length / 2);
    if (currentGap < 0) currentGap += totalLength;

    const approachingCongestion =
      currentGap < 35.0 && currentLeader.v < ego.v - 3.0;
    if (!approachingCongestion) continue;

    const candidates = [];
    if (currentLane > 0) candidates.push(currentLane - 1);
    if (currentLane < NUM_LANES - 1) candidates.push(currentLane + 1);

    for (const targetLane of candidates) {
      const laneVehicles = byLane[targetLane];
      let targetLeader = null;
      let targetFollower = null;
      let minLeaderGap = Infinity;
      let minFollowerGap = Infinity;

      for (const other of laneVehicles) {
        let gap = other.s - ego.s;
        if (gap < 0) gap += totalLength;
        if (gap < minLeaderGap) {
          minLeaderGap = gap;
          targetLeader = other;
        }

        let followGap = ego.s - other.s;
        if (followGap < 0) followGap += totalLength;
        if (followGap < minFollowerGap) {
          minFollowerGap = followGap;
          targetFollower = other;
        }
      }

      let leadGap = minLeaderGap;
      let followGap = minFollowerGap;

      if (targetLeader) {
        leadGap = minLeaderGap - (ego.length / 2) - (targetLeader.length / 2);
      }
      if (targetFollower) {
        followGap = minFollowerGap - (targetFollower.length / 2) - (ego.length / 2);
      }

      // Require generous clearance so lane changes never disrupt jam wave formation
      if (leadGap < 25.0 || followGap < 18.0) continue;

      const targetLaneBetter =
        !targetLeader ||
        (leadGap > currentGap + 12.0 && targetLeader.v > currentLeader.v + 4.0);

      if (targetLaneBetter) {
        ego.lane = targetLane;
        break;
      }
    }
  }

  // Re-group after lane changes
  byLane = Array.from({ length: NUM_LANES }, () => []);
  for (const car of vehicles) {
    byLane[car.lane].push(car);
  }
  for (let l = 0; l < NUM_LANES; l++) {
    byLane[l].sort((a, b) => a.s - b.s);
  }

  // 2 & 3. IDM accelerations — computed simultaneously before any integration
  const nextA = new Float32Array(N); // indexed by car.id

  for (let l = 0; l < NUM_LANES; l++) {
    const lane = byLane[l];
    const M = lane.length;
    if (M === 0) continue;

    for (let i = 0; i < M; i++) {
      const ego    = lane[i];
      const leader = lane[(i + 1) % M]; // wraps: last follows first (closed ring)

      // Gap = bumper-to-bumper distance, handles ring wrap-around
      let gap = leader.s - ego.s - (ego.length / 2) - (leader.length / 2);
      if (gap < 0) gap += totalLength;

      const dv = ego.v - leader.v; // positive when closing

      const myV0 = params.v0 * ego.noiseV0;
      nextA[ego.id] = idmAccel(ego.v, dv, gap, { ...params, v0: myV0 });
    }
  }

  // 4. Perturbation events (hard brake for 2.4s to bring seed vehicle to a full stop)
  for (const car of vehicles) {
    if (car.perturbTimer > 0) {
      car.perturbTimer -= dt;
      if (car.perturbTimer <= 2.4) {
        nextA[car.id] = -8.0;
      }
    }
  }

  // 5. Integrate & update visual lane interpolation
  for (const car of vehicles) {
    if (car.visualLane === undefined) car.visualLane = car.lane;
    car.visualLane += (car.lane - car.visualLane) * (dt * 2.5); // smooth visual shift
    car.a = nextA[car.id];
    car.braking = car.a < -0.3 || car.v < 1.5;
    car.v = Math.max(0, car.v + car.a * dt);
    car.s = (car.s + car.v * dt + totalLength) % totalLength;
  }
}
