/**
 * main.js — 3D Phantom Jam simulation runner
 */

import { buildRoad } from './road.js';
import { DEFAULT_PARAMS, createVehicles, stepVehicles } from './idm.js';
import { Renderer3D } from './renderer3d.js';
const DT = 0.05;         // 50 ms fixed physics step (20 Hz)

const road = buildRoad(110, 800);

let params = { ...DEFAULT_PARAMS };
let vehicles = [];
let paused = false;
let simSpeed = 1.0;
let vehicleCount = 150; // default to 150 vehicles

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
      // Brake starts in 0.1 s and lasts 1.2 s
      picked.perturbTimer = 1.3;
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
  if (now > fpsLastTime + 500) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsLastTime));
    document.getElementById('val-fps').textContent = fps;
    fpsFrames = 0;
    fpsLastTime = now;
  }

  if (!paused) {
    accumulator += dtWall * simSpeed;
    while (accumulator >= DT) {
      stepVehicles(vehicles, params, road, DT);
      accumulator -= DT;
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

// Camera Presets wiring
const cameraModes = ['default', 'jam', 'top'];
const cameraLabels = {
  'default': 'Default Cam',
  'jam': 'Jam Cam',
  'top': 'Top-Down'
};

const cameraCycleBtn = document.getElementById('camera-cycle-btn');
const camActiveName = document.getElementById('cam-active-name');

if (cameraCycleBtn) {
  cameraCycleBtn.addEventListener('click', () => {
    const currentMode = renderer3d.cameraMode;
    const currentIndex = cameraModes.indexOf(currentMode);
    const nextIndex = (currentIndex + 1) % cameraModes.length;
    const nextMode = cameraModes[nextIndex];
    
    renderer3d.setCameraPreset(nextMode, vehicles);
    if (camActiveName) {
      camActiveName.textContent = cameraLabels[nextMode];
    }
  });
}


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
