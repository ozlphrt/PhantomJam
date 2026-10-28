/**
 * main.js — 3D Phantom Jam simulation runner
 */

import { buildRoad } from './road.js';
import { DEFAULT_PARAMS, createVehicles, stepVehicles } from './idm.js';
import { Renderer3D } from './renderer3d.js';
const MAX_PHYSICS_DT = 1 / 60; // sub-step ceiling so physics updates smoothly every frame

const road = buildRoad(158, 800);

let params = { ...DEFAULT_PARAMS };
let vehicles = [];
let paused = false;
let simSpeed = 1.0;
let vehicleCount = 300; // default to 300 vehicles

let frameCount = 0;
let lastTime = 0;
let accumulator = 0;

// FPS tracking
let fpsLastTime = 0;
let fpsFrames = 0;

// Renderers
const canvas = document.getElementById('road-canvas');
const renderer3d = new Renderer3D(canvas);
renderer3d.createRoadMesh(road);



function reset() {
  vehicles = createVehicles(vehicleCount, road.totalLength, params);
  accumulator = 0;
  frameCount = 0;
}

reset();
renderer3d.setCameraPreset('jam', vehicles);

/** Manually trigger a hard-brake event on one random car per lane */
function triggerJam() {
  const NUM_LANES = 5;
  for (let lane = 0; lane < NUM_LANES; lane++) {
    const inLane = vehicles.filter(c => c.lane === lane);
    if (inLane.length > 0) {
      const picked = inLane[Math.floor(Math.random() * inLane.length)];
      // Brake starts in 0.1 s and lasts 2.4 s (full-stop seed)
      picked.perturbTimer = 2.5;
    }
  }
}

function updateStats() {
  const braking = vehicles.filter(c => c.braking).length;
  const avgV = vehicles.length > 0
    ? vehicles.reduce((a, c) => a + c.v, 0) / vehicles.length
    : 0;

  document.getElementById('val-cars').textContent = vehicles.length;
  document.getElementById('val-speed').textContent = `${avgV.toFixed(1)} m/s`;
  document.getElementById('val-jams').textContent = braking;

  const badge = document.getElementById('stat-jams');
  if (braking > 4) {
    badge.style.background = 'rgba(255,92,92,0.2)';
    badge.style.borderColor = 'var(--danger)';
  } else {
    badge.style.background = '';
    badge.style.borderColor = '';
  }
}

function tick(now) {
  requestAnimationFrame(tick);

  if (!lastTime) { lastTime = now; fpsLastTime = now; return; }
  const dtWall = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  // Calculate FPS
  fpsFrames++;
  if (now > fpsLastTime + 250) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsLastTime));
    document.getElementById('val-fps').textContent = fps;
    const hudVal = document.getElementById('fps-hud-val');
    const hudDot = document.getElementById('fps-dot');
    if (hudVal) hudVal.textContent = fps;
    if (hudDot) {
      const color = fps >= 50 ? 'var(--success)' : fps >= 30 ? 'var(--accent-2)' : 'var(--danger)';
      hudDot.style.background = color;
      hudDot.style.boxShadow = `0 0 8px ${color}`;
    }
    fpsFrames = 0;
    fpsLastTime = now;
  }

  if (!paused) {
    let remaining = dtWall * simSpeed;
    while (remaining > 0) {
      const stepDt = Math.min(remaining, MAX_PHYSICS_DT);
      stepVehicles(vehicles, params, road, stepDt);
      remaining -= stepDt;
    }

    // Auto-cycle camera: 30s Jam Cam -> 5s Top-Down -> 10s Default Cam
    camAutoCycleTimer += dtWall;
    const currentMode = renderer3d.cameraMode;
    const modeDuration = cameraDurations[currentMode] || 15.0;
    if (camAutoCycleTimer >= modeDuration) {
      const currentIndex = cameraModes.indexOf(currentMode);
      const nextIndex = (currentIndex + 1) % cameraModes.length;
      applyCameraMode(cameraModes[nextIndex]);
    }
  }

  renderer3d.updateCars(vehicles, road, params, dtWall);
  renderer3d.render();

  frameCount++;
  if (frameCount % 10 === 0) {
    updateStats();
  }
}

window.addEventListener('resize', () => { renderer3d.resize(); });
renderer3d.resize();

function bindSlider(id, dispId, format, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  const disp = document.getElementById(dispId);
  if (disp) disp.textContent = format(parseFloat(el.value));
  el.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (disp) disp.textContent = format(v);
    cb(v);
  });
}

bindSlider('ctrl-count', 'disp-count', v => Math.round(v), v => {
  vehicleCount = Math.round(v);
  reset();
});


bindSlider('ctrl-speed', 'disp-speed', v => `${v}x`, v => {
  simSpeed = v;
});

document.getElementById('btn-pause').addEventListener('click', e => {
  paused = !paused;
  e.target.textContent = paused ? '▶ Resume' : '⏸ Pause';
});

document.getElementById('btn-reset').addEventListener('click', () => {
  reset();
  // Reset preset tracked targets if active
  if (renderer3d.cameraMode === 'jam') {
    renderer3d.setCameraPreset(renderer3d.cameraMode, vehicles);
  }
});

const btnJam = document.getElementById('btn-jam');
if (btnJam) btnJam.addEventListener('click', () => triggerJam());

// Lighting & Atmosphere Sliders + Copy Tuning to Clipboard
bindSlider('ctrl-key-int', 'disp-key-int', v => v.toFixed(2), v => {
  renderer3d.updateLightTuning({ keyIntensity: v });
});
bindSlider('ctrl-sun-el', 'disp-sun-el', v => `${Math.round(v)}°`, v => {
  renderer3d.updateLightTuning({ sunElevation: v });
});
bindSlider('ctrl-sun-az', 'disp-sun-az', v => `${Math.round(v)}°`, v => {
  renderer3d.updateLightTuning({ sunAzimuth: v });
});
bindSlider('ctrl-hemi-int', 'disp-hemi-int', v => v.toFixed(2), v => {
  renderer3d.updateLightTuning({ hemiIntensity: v });
});
bindSlider('ctrl-fill-int', 'disp-fill-int', v => v.toFixed(2), v => {
  renderer3d.updateLightTuning({ fillIntensity: v });
});
bindSlider('ctrl-exposure', 'disp-exposure', v => v.toFixed(2), v => {
  renderer3d.updateLightTuning({ exposure: v });
});
bindSlider('ctrl-fog-dist', 'disp-fog-dist', v => `${Math.round(v)}m`, v => {
  renderer3d.updateLightTuning({ fogStartDist: v });
});

const btnCopyTuning = document.getElementById('btn-copy-tuning');
if (btnCopyTuning) {
  btnCopyTuning.addEventListener('click', async () => {
    const payload = {
      ...renderer3d.getLightTuning(),
      vehicleCount,
      simSpeed,
      hexagonsEnabled: Boolean(renderer3d.hexagonsEnabled),
      graphEnabled: Boolean(renderer3d.graphEnabled),
    };
    const jsonText = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(jsonText);
      btnCopyTuning.textContent = '✓ Copied Tuning!';
    } catch {
      btnCopyTuning.textContent = '✓ Ready in Console';
      console.log('Tuning JSON:\n', jsonText);
    }
    setTimeout(() => {
      btnCopyTuning.textContent = '📋 Copy Tuning to Clipboard';
    }, 2000);
  });
}

// Camera Presets & Auto-Cycle (30s Jam Cam -> 5s Top-Down -> 10s Default Cam)
const cameraModes = ['jam', 'top', 'default'];
const cameraDurations = {
  jam: 30.0,
  top: 5.0,
  default: 10.0,
};
const cameraLabels = {
  default: 'Default Cam',
  jam: 'Jam Cam',
  top: 'Top-Down',
};

const cameraCycleBtn = document.getElementById('camera-cycle-btn');
const camActiveName = document.getElementById('cam-active-name');
let camLabelTimeout = null;
let camAutoCycleTimer = 0;

function applyCameraMode(mode) {
  camAutoCycleTimer = 0;
  renderer3d.setCameraPreset(mode, vehicles);
  if (camActiveName) {
    camActiveName.textContent = cameraLabels[mode];
  }
  if (cameraCycleBtn) {
    cameraCycleBtn.classList.add('expanded');
    if (camLabelTimeout) clearTimeout(camLabelTimeout);
    camLabelTimeout = setTimeout(() => {
      cameraCycleBtn.classList.remove('expanded');
    }, 2200);
  }
}

if (cameraCycleBtn) {
  cameraCycleBtn.addEventListener('click', () => {
    const currentMode = renderer3d.cameraMode;
    const currentIndex = cameraModes.indexOf(currentMode);
    const nextIndex = (currentIndex + 1) % cameraModes.length;
    applyCameraMode(cameraModes[nextIndex]);
  });
}

// Keystroke H toggles 3D Hexagonal Congestion Tunnel ON/OFF (starts OFF)
// Keystroke G toggles 3D Population Graph ON/OFF (starts OFF)
// Keystroke C toggles Congestion Center Label ON/OFF (starts ON)
const hexHudBtn = document.getElementById('hex-hud');
const hexHudState = document.getElementById('hex-hud-state');
const graphHudBtn = document.getElementById('graph-hud');
const graphHudState = document.getElementById('graph-hud-state');
const labelHudBtn = document.getElementById('label-hud');
const labelHudState = document.getElementById('label-hud-state');

function toggleHexagons() {
  const enabled = renderer3d.setHexagonsEnabled(!renderer3d.hexagonsEnabled);
  if (hexHudBtn) {
    hexHudBtn.classList.toggle('active', enabled);
  }
  if (hexHudState) {
    hexHudState.textContent = enabled ? 'ON' : 'OFF';
  }
}

function toggleGraph() {
  const enabled = renderer3d.setGraphEnabled(!renderer3d.graphEnabled);
  if (graphHudBtn) {
    graphHudBtn.classList.toggle('active', enabled);
  }
  if (graphHudState) {
    graphHudState.textContent = enabled ? 'ON' : 'OFF';
  }
}

function toggleLabel() {
  const current = renderer3d.labelEnabled !== undefined ? renderer3d.labelEnabled : false;
  const enabled = renderer3d.setLabelEnabled(!current);
  if (labelHudBtn) {
    labelHudBtn.classList.toggle('active', enabled);
  }
  if (labelHudState) {
    labelHudState.textContent = enabled ? 'ON' : 'OFF';
  }
}

if (hexHudBtn) {
  hexHudBtn.addEventListener('click', toggleHexagons);
}
if (graphHudBtn) {
  graphHudBtn.addEventListener('click', toggleGraph);
}
if (labelHudBtn) {
  labelHudBtn.addEventListener('click', toggleLabel);
}

window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  if (e.key === 'h' || e.key === 'H') {
    toggleHexagons();
  } else if (e.key === 'g' || e.key === 'G') {
    toggleGraph();
  } else if (e.key === 'c' || e.key === 'C') {
    toggleLabel();
  }
});


// Auto-hide sidebar logic
const sidebar = document.getElementById('sidebar');
const triggerBtn = document.getElementById('sidebar-trigger');
const closeBtn = document.getElementById('btn-close-sidebar');
let hideTimeout = null;

function showSidebar() {
  if (hideTimeout) clearTimeout(hideTimeout);
  sidebar.classList.remove('collapsed');
  triggerBtn.style.opacity = '0';
  triggerBtn.style.pointerEvents = 'none';
  // Resize WebGL viewport to adjust target aspect ratio
  setTimeout(() => renderer3d.resize(), 500);
}

function hideSidebar() {
  if (hideTimeout) clearTimeout(hideTimeout);
  sidebar.classList.add('collapsed');
  triggerBtn.style.opacity = '1';
  triggerBtn.style.pointerEvents = 'auto';
  setTimeout(() => renderer3d.resize(), 500);
}

// Collapses sidebar 800ms after cursor exits the controls area
sidebar.addEventListener('mouseleave', () => {
  hideTimeout = setTimeout(hideSidebar, 800);
});

sidebar.addEventListener('mouseenter', () => {
  if (hideTimeout) clearTimeout(hideTimeout);
});

triggerBtn.addEventListener('click', showSidebar);
triggerBtn.addEventListener('mouseenter', showSidebar);

if (closeBtn) {
  closeBtn.addEventListener('click', hideSidebar);
}

// Bring sidebar back out if cursor approaches within 20px of the right window margin
document.addEventListener('mousemove', e => {
  const width = window.innerWidth;
  if (width - e.clientX < 20) {
    showSidebar();
  }
});

// Start with the sidebar collapsed on initial startup
hideSidebar();

requestAnimationFrame(tick);
