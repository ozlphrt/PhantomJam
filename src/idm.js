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
  v0:    32,    // desired free-flow speed m/s (~115 km/h)
  aMax:  1.35,  // base queue acceleration (boosted up to 3.6 m/s² when open green road is ahead)
  b:     2.2,   // comfortable deceleration (m/s²)
  T:     0.72,  // safe time headway (s) tuned for 300 vehicles across 5 lanes
  s0:    1.6,   // min bumper-to-bumper gap (m)
  delta: 4,
  vehicleLen:    4.6,
  truckLen:      9.6,
  busLen:        11.0,
  minivanLen:    5.0,
  motorcycleLen: 3.6,
};

/** IDM acceleration (Treiber 2000, Eq. 2) with open-road acceleration boost */
export function idmAccel(v, dv, gap, p) {
  const { v0, aMax, b, T, s0, delta } = p;
  gap = Math.max(gap, 0.01);
  const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(aMax * b)));
  const rawRatio = 1 - Math.pow(v / v0, delta) - Math.pow(sStar / gap, 2);
  // When accelerating into open green road ahead (gap > 14m), drivers accelerate briskly (up to ~3.6 m/s²)
  if (rawRatio > 0) {
    const openRoadBoost = Math.max(0, Math.min(1.0, (gap - 14.0) / 20.0));
    const effectiveAMax = aMax + openRoadBoost * 2.25;
    return effectiveAMax * rawRatio;
  }
  return aMax * rawRatio;
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
    const minSpawnGap = Math.min(13.8, (totalLength / perLane) * 0.88);
    for (let iter = 0; iter < 16; iter++) {
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
      const maxLatOffset =
        type === 'truck' || type === 'bus'
          ? 0.32
          : type === 'motorcycle'
          ? 0.85
          : 0.56;

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
        lateralNoise: (Math.random() - 0.5) * maxLatOffset,
        weavePhase: Math.random() * Math.PI * 2,
        weaveSpeed: 0.5 + Math.random() * 0.8,
      });
    }
  }

  // Nucleate a coherent congestion wave around a single road location right at startup
  const seedTargetS = totalLength * 0.22;
  for (let lane = 0; lane < NUM_LANES; lane++) {
    const inLane = vehicles.filter(c => c.lane === lane);
    if (inLane.length > 2) {
      let bestCar = inLane[0];
      let bestDist = Infinity;
      for (const c of inLane) {
        let ds = Math.abs(c.s - seedTargetS);
        if (ds > totalLength * 0.5) ds = totalLength - ds;
        if (ds < bestDist) {
          bestDist = ds;
          bestCar = c;
        }
        // Pre-seed initial slowdown in the 30m upstream of seedTargetS so a red jam exists at t=0
        let upstreamDist = (seedTargetS - c.s + totalLength) % totalLength;
        if (upstreamDist < 32.0) {
          c.v = params.v0 * (0.08 + 0.35 * (upstreamDist / 32.0));
          c.braking = true;
        }
      }
      bestCar.v = 1.5;
      bestCar.perturbTimer = 2.4; // fires immediately at t=0
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

  // 1.5 Safe & Responsive Lane Changing (when adjacent lane is moving faster and has safe clearance)
  for (const ego of vehicles) {
    if (ego.visualLane === undefined) ego.visualLane = ego.lane;
    if (ego.laneChangeCooldown > 0) {
      ego.laneChangeCooldown = Math.max(0, ego.laneChangeCooldown - dt);
    }

    // A stopped or nearly stopped car cannot swerve left or right to change lanes
    if (ego.v < 2.0) continue;

    // Do not start a new lane change while mid-maneuver, on cooldown, or actively seeding a hard-brake event
    if (Math.abs(ego.lane - ego.visualLane) > 0.15) continue;
    if (ego.laneChangeCooldown > 0 || ego.perturbTimer > 0) continue;

    // Evaluate lane-change opportunities ~2.5 times per second per impeded vehicle
    const checkRate = 2.5 * dt;
    if (Math.random() > checkRate) continue;

    const currentLane = ego.lane;
    const currentLaneVehicles = byLane[currentLane];
    if (currentLaneVehicles.length <= 1) continue;

    const egoIdx = currentLaneVehicles.indexOf(ego);
    if (egoIdx === -1) continue;
    const currentLeader = currentLaneVehicles[(egoIdx + 1) % currentLaneVehicles.length];
    let currentGap = currentLeader.s - ego.s - (ego.length / 2) - (currentLeader.length / 2);
    if (currentGap < 0) currentGap += totalLength;

    const myDesiredV = params.v0 * ego.noiseV0;
    const currentLaneSpeed = Math.min(ego.v, currentLeader.v);

    // Driver wants to change lanes if closing in on a slower leader or stuck crawling behind a slow/stopped car
    const isImpeded =
      (currentGap < 42.0 && currentLeader.v < ego.v - 1.5) ||
      (currentGap < 26.0 && currentLeader.v < myDesiredV * 0.72 && ego.v < myDesiredV * 0.75);
    if (!isImpeded) continue;

    const candidates = [];
    if (currentLane > 0) candidates.push(currentLane - 1);
    if (currentLane < NUM_LANES - 1) candidates.push(currentLane + 1);

    let bestLane = -1;
    let bestScore = 0;
    let bestTargetSpeed = 0;

    for (const targetLane of candidates) {
      const laneVehicles = byLane[targetLane];
      let targetLeader = null;
      let targetFollower = null;
      let minLeaderGap = Infinity;
      let minFollowerGap = Infinity;
      let overlapBlocked = false;

      for (const other of vehicles) {
        if (other === ego) continue;
        // Check all vehicles in targetLane OR visually straddling targetLane during a lane change
        const inTarget =
          other.lane === targetLane ||
          Math.abs((other.visualLane ?? other.lane) - targetLane) < 0.65;
        if (!inTarget) continue;

        let signedDiff = other.s - ego.s;
        if (signedDiff > totalLength * 0.5) signedDiff -= totalLength;
        if (signedDiff < -totalLength * 0.5) signedDiff += totalLength;

        const minBodyClearance = (ego.length + other.length) * 0.5 + 4.0;
        if (Math.abs(signedDiff) < minBodyClearance) {
          overlapBlocked = true;
          break;
        }

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

      if (overlapBlocked) continue;

      const leadGap = targetLeader
        ? minLeaderGap - (ego.length / 2) - (targetLeader.length / 2)
        : totalLength;
      const followGap = targetFollower
        ? minFollowerGap - (targetFollower.length / 2) - (ego.length / 2)
        : totalLength;

      const targetSpeed = targetLeader ? targetLeader.v : myDesiredV;

      // 1. Other lane must be moving and appreciably faster (or much clearer) than current lane
      const isOtherLaneMoving =
        targetSpeed > 3.5 &&
        (targetSpeed > currentLaneSpeed + 2.0 ||
          (leadGap > currentGap + 10.0 && targetSpeed > currentLaneSpeed + 0.8));
      if (!isOtherLaneMoving) continue;

      // 2. Enough space ahead & behind to safely merge without cutting off approaching traffic
      const minSafeLeadGap =
        Math.max(6.5, params.s0 + ego.v * 0.50) + Math.max(0, ego.v - targetSpeed) * 0.75;
      const minSafeFollowGap = targetFollower
        ? Math.max(6.5, params.s0 + targetFollower.v * 0.45 + Math.max(0, targetFollower.v - ego.v) * 0.80)
        : 0;

      if (leadGap < minSafeLeadGap || followGap < minSafeFollowGap) continue;

      // MOBIL politeness/safety check: ensure follower in target lane does not have to slam brakes (< -3.6 m/s²)
      if (targetFollower) {
        const mergeSpeed = Math.max(ego.v, Math.min(targetSpeed, 3.2));
        const followerDecel = idmAccel(
          targetFollower.v,
          targetFollower.v - mergeSpeed,
          followGap,
          params
        );
        if (followerDecel < -3.6) continue;
      }

      const score = (targetSpeed - currentLaneSpeed) * 2.5 + Math.min(leadGap, 45.0) * 0.35;
      if (score > bestScore) {
        bestScore = score;
        bestLane = targetLane;
        bestTargetSpeed = targetSpeed;
      }
    }

    if (bestLane !== -1) {
      // Update byLane immediately so two cars never merge into the same gap on the same tick
      currentLaneVehicles.splice(egoIdx, 1);
      ego.lane = bestLane;
      ego.laneChangeCooldown = 2.4 + Math.random() * 1.4;
      const dstLane = byLane[bestLane];
      dstLane.push(ego);
      dstLane.sort((a, b) => a.s - b.s);
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
    car.a = nextA[car.id];
    car.braking = car.a < -0.3 || car.v < 1.5;
    car.v = Math.max(0, car.v + car.a * dt);
    // Lateral lane-change movement requires forward speed — a stopped car cannot slide sideways
    const speedFactor = Math.max(0, Math.min(1.0, (car.v - 0.5) / 4.5));
    car.visualLane += (car.lane - car.visualLane) * (dt * 2.5 * speedFactor);
    car.s = (car.s + car.v * dt + totalLength) % totalLength;
  }

  // 6. Hard physical bumper-to-bumper non-overlapping enforcement (prevents any truck/car from ever passing through its leader)
  for (let l = 0; l < NUM_LANES; l++) {
    const lane = byLane[l];
    const M = lane.length;
    if (M <= 1) continue;

    // Traverse backward from leader to follower twice around the ring so queues pack cleanly with zero overlap
    for (let pass = 0; pass < 2; pass++) {
      for (let i = M - 1; i >= 0; i--) {
        const ego = lane[i];
        const leader = lane[(i + 1) % M];
        const minCenterDist = (ego.length + leader.length) * 0.5 + 1.1;

        let forwardDist = (leader.s - ego.s + totalLength) % totalLength;
        // If ego overshot leader this step, forwardDist wrapped near totalLength (> 0.6 * totalLength)
        if (forwardDist > totalLength * 0.6) {
          forwardDist -= totalLength;
        }

        if (forwardDist < minCenterDist) {
          ego.s = (leader.s - minCenterDist + totalLength) % totalLength;
          if (ego.v > leader.v) {
            ego.v = leader.v * 0.95;
          }
          ego.braking = true;
        }
      }
    }
  }
}
