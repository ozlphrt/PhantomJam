/**
 * renderer3d.js — Three.js Scene Setup & Visualisation
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getPointAtS } from './road.js';

// ── Module-level geometry & material cache ──────────────────────────────────
const _GC = new Map();
const _rbox = (w,h,d,r=0.07) => { const k=`R${w}|${h}|${d}|${r}`; if(!_GC.has(k))_GC.set(k,new RoundedBoxGeometry(w,h,d,1,r)); return _GC.get(k); };
const _bbox = (w,h,d)        => { const k=`B${w}|${h}|${d}`;     if(!_GC.has(k))_GC.set(k,new THREE.BoxGeometry(w,h,d));         return _GC.get(k); };
const _cyl  = (a,b,h,s=14)  => { const k=`C${a}|${b}|${h}|${s}`; if(!_GC.has(k))_GC.set(k,new THREE.CylinderGeometry(a,b,h,s)); return _GC.get(k); };
const _sph  = (r,ws,hs)     => { const k=`S${r}|${ws}|${hs}`;    if(!_GC.has(k))_GC.set(k,new THREE.SphereGeometry(r,ws,hs));    return _GC.get(k); };

// Shared materials across all vehicles to eliminate per-car shader/uniform overhead
const _BRAKE_OFF_MAT = new THREE.MeshBasicMaterial({ color: 0x4a0000 });
const _BRAKE_ON_MAT  = new THREE.MeshBasicMaterial({ color: 0xff1a1a });
const _BLINKER_MAT   = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
const _BEAM_MAT      = new THREE.MeshBasicMaterial({
  color: 0xffaa00,
  transparent: true,
  opacity: 0.12,
  side: THREE.DoubleSide,
  depthWrite: false,
});

/**
 * Generates a soft dark radial-gradient contact shadow texture for under-car AO.
 */
function _createContactShadowMaterial() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 32, 8, 64, 32, 58);
  grad.addColorStop(0.0, 'rgba(0, 0, 0, 0.78)');
  grad.addColorStop(0.65, 'rgba(0, 0, 0, 0.48)');
  grad.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 64);

  const tex = new THREE.CanvasTexture(canvas);
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

const _CONTACT_SHADOW_MAT = _createContactShadowMaterial();

// Clone a geometry and bake in position + optional Euler rotation.
const _t = (geo, px=0,py=0,pz=0, rx=0,ry=0,rz=0) => {
  const g = geo.clone();
  if (rx||ry||rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx,ry,rz)));
  g.translate(px,py,pz);
  return g;
};

// Transform a geometry by a full Matrix4 (for road-aligned static infrastructure)
const _tm = (geo, mat4) => {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(mat4);
  return g;
};

const _wgeo = (geo,x,y,z) => _t(geo,x,y,z, Math.PI/2,0,0);

const _mm = (geos, mat, shadow=false) => {
  const normalised = geos.map(g => g.index ? g.toNonIndexed() : g);
  const m = new THREE.Mesh(mergeGeometries(normalised), mat);
  m.castShadow = shadow;
  return m;
};

/**
 * Downscales high-res GLTF textures to a compact power-of-two size (256x256)
 * so all vehicle textures fit in <12 MB of GPU cache, darkens solid white window
 * regions masked by the metallicRoughness texture's blue channel, and softens
 * overly neon red-orange paint pixels.
 */
function _optimizeTexture(tex, maxDim = 256, mrTex = null) {
  if (!tex || !tex.image) return tex;
  const img = tex.image;
  const w = img.width || img.videoWidth || 0;
  const h = img.height || img.videoHeight || 0;
  if (!w || !h) return tex;

  const scale = Math.min(1, maxDim / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, nw, nh);

  // Extract window mask from metallicRoughness texture (blue channel > 80 = window glass)
  let mrData = null;
  if (mrTex && mrTex.image) {
    const mrCanvas = document.createElement('canvas');
    mrCanvas.width = nw;
    mrCanvas.height = nh;
    const mrCtx = mrCanvas.getContext('2d');
    mrCtx.drawImage(mrTex.image, 0, 0, nw, nh);
    mrData = mrCtx.getImageData(0, 0, nw, nh).data;
  }

  const imgData = ctx.getImageData(0, 0, nw, nh);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // 1. Only darken solid white car windows masked by magenta (G < 100, B > 120) in metallicRoughness map
    // (Never darken normal metallicRoughness maps where R=G=B=255 such as buses/trucks)
    if (mrData && mrData[i + 2] > 120 && mrData[i + 1] < 100 && r > 175 && g > 175 && b > 175) {
      const blend = Math.min(1, (mrData[i + 2] - 100) / 100);
      data[i]     = Math.round(r * (1 - blend) + 28 * blend);
      data[i + 1] = Math.round(g * (1 - blend) + 32 * blend);
      data[i + 2] = Math.round(b * (1 - blend) + 40 * blend);
      continue;
    }

    // 2. Soften overly neon/saturated red-orange paint pixels present in some pack textures
    if (r > 175 && r > g * 1.75 && g < 115 && b < 90) {
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      data[i]     = Math.round((r * 0.58 + luma * 0.42) * 0.82);
      data[i + 1] = Math.round((g * 0.70 + luma * 0.30) * 0.88);
      data[i + 2] = Math.round((b * 0.75 + luma * 0.25) * 0.92);
    }
  }
  ctx.putImageData(imgData, 0, 0);

  tex.image = canvas;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates a procedural canvas texture for overhead highway signs.
 */
function _createHighwaySignTexture(title, subtitle, speedText) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  // Highway reflective green background
  ctx.fillStyle = '#0b5c36';
  ctx.fillRect(0, 0, 512, 128);

  // White reflective border
  ctx.strokeStyle = '#f0f4f8';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, 496, 112);

  // Title text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px Inter, Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, 26, 52);

  // Subtitle + lane arrows
  ctx.fillStyle = '#cbe8d8';
  ctx.font = '600 22px Inter, Arial, sans-serif';
  ctx.fillText(subtitle, 26, 86);

  ctx.fillStyle = '#ffd147';
  ctx.font = 'bold 26px Inter, Arial, sans-serif';
  ctx.fillText('↓     ↓     ↓     ↓     ↓', 26, 114);

  // Electronic speed limit roundel on right
  ctx.fillStyle = '#111318';
  ctx.fillRect(392, 16, 100, 96);
  ctx.beginPath();
  ctx.arc(442, 64, 40, 0, Math.PI * 2);
  ctx.fillStyle = '#111318';
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#ff3b30';
  ctx.stroke();

  ctx.fillStyle = '#ffcc00';
  ctx.font = 'bold 32px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(speedText, 442, 75);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Generates a tileable worn/weathered road paint texture with frayed edges,
 * asphalt grain speckles, tire-scuff tracks, and patchy fade-outs.
 */
function _createWornLineTexture(rBase, gBase, bBase, isDashed = false) {
  const w = 64;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(w, h);
  const data = imgData.data;

  // Deterministic pseudo-random noise helper
  const hash = (x, y) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };

  for (let y = 0; y < h; y++) {
    const v = y / h;
    // Dash pattern: 48% painted dash, 52% gap with frayed leading/trailing ends
    let dashMask = 1.0;
    if (isDashed) {
      const cycle = (v * 4.0) % 1.0;
      if (cycle > 0.48) {
        dashMask = 0.0;
      } else if (cycle < 0.05) {
        dashMask = cycle / 0.05;
      } else if (cycle > 0.42) {
        dashMask = (0.48 - cycle) / 0.06;
      }
    }

    // Multi-frequency longitudinal wear waves (tire scuffing & faded patches along road)
    const longWear =
      0.68 +
      0.22 * Math.sin(v * Math.PI * 6.0) +
      0.15 * Math.cos(v * Math.PI * 14.0 + 1.3) +
      0.12 * Math.sin(v * Math.PI * 30.0 + 0.7);

    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (dashMask <= 0.01) {
        data[idx + 3] = 0;
        continue;
      }

      // Cross-width coordinate u in [-1, 1]
      const u = (x / (w - 1)) * 2.0 - 1.0;
      const absU = Math.abs(u);

      // Chipped/frayed paint edges
      const edgeNoise = (hash(x * 0.5, Math.floor(y * 0.25)) - 0.5) * 0.28;
      const edgeFade = Math.max(0.0, Math.min(1.0, (0.98 - (absU + edgeNoise)) / 0.22));

      // Asphalt aggregate speckles & micro-cracks poking through the paint
      const grain = hash(x, y);
      const patch = hash(Math.floor(x * 0.25), Math.floor(y * 0.15));
      const scuff = grain < 0.14 ? 0.22 : patch < 0.16 ? 0.48 : 0.92 + (grain - 0.5) * 0.16;

      const alpha = Math.max(0.0, Math.min(1.0, dashMask * edgeFade * longWear * scuff * 0.94));
      const shade = 0.84 + 0.16 * grain;

      data[idx]     = Math.round(rBase * shade);
      data[idx + 1] = Math.round(gBase * shade);
      data[idx + 2] = Math.round(bBase * shade);
      data[idx + 3] = Math.round(alpha * 255);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1f2b14);
    // Linear fog starting 500m away from the Figure-8 highway
    this.scene.fog = new THREE.Fog(0x1f2b14, 650, 1050);

    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, width / height, 1, 1300);
    this.camera.position.set(-230, 90, 100);
    this.camera.lookAt(0, 5, 0);

    // WebGL Renderer — optimized for 60 FPS with crisp shadows & filmic tone mapping
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this._renderTick = 0;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.setSize(width, height, false);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minPolarAngle = Math.PI / 3;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.05;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 600;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;

    this.cameraMode = 'jam';
    this.trackedVehicleId = null;
    this.targetVelocity = new THREE.Vector3();
    this.cameraVelocity = new THREE.Vector3();
    this.trackingAnchor = null;

    this.carMeshes = new Map();
    this.roadLine = null;
    this.modelTemplates = null;

    this._setupLights();
    this._setupEnvironment();
    this._loadExternalCarPack();
  }

  /**
   * Loads and extracts all 60 textured 3D vehicle models across both external packs:
   * - orchids_simulator_traffic_car_pack/scene.gltf (43 vehicles, facing +Z, 1x scale)
   * - traffic_racer_npc_vehicles_pack/scene.gltf (17 vehicles, facing +X, 2x scale)
   */
  _loadExternalCarPack() {
    const loader = new GLTFLoader();
    const templates = {
      car: [],
      minivan: [],
      truck: [],
      bus: [],
      motorcycle: [],
      all: [],
    };

    const convertedMats = new Map();
    const getFastMaterial = (srcMat) => {
      if (!srcMat) return null;
      if (convertedMats.has(srcMat)) return convertedMats.get(srcMat);

      const mrTex = srcMat.metalnessMap || srcMat.roughnessMap || null;
      const map = srcMat.map ? _optimizeTexture(srcMat.map, 256, mrTex) : null;
      const fastMat = new THREE.MeshLambertMaterial({
        color: map ? 0xd8dce4 : srcMat.color ? srcMat.color.clone() : 0xcccccc,
        map,
        side: srcMat.side ?? THREE.FrontSide,
        transparent: Boolean(srcMat.transparent),
        opacity: srcMat.opacity ?? 1.0,
      });
      convertedMats.set(srcMat, fastMat);
      return fastMat;
    };

    const extractPack = (gltf, { forwardAxis = 'z', unitScale = 1.0, isBody }) => {
      gltf.scene.updateMatrixWorld(true);

      const meshItems = [];
      gltf.scene.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        const box = new THREE.Box3().setFromObject(obj);
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        meshItems.push({ mesh: obj, box, center, size });
      });

      const rawBodies = meshItems.filter(isBody);
      rawBodies.sort((a, b) =>
        forwardAxis === 'z' ? b.size.z - a.size.z : b.size.x - a.size.x
      );
      const bodies = [];
      for (const b of rawBodies) {
        const isDuplicate = bodies.some(
          (existing) =>
            Math.hypot(existing.center.x - b.center.x, existing.center.z - b.center.z) < 1.0
        );
        if (!isDuplicate) bodies.push(b);
      }

      const vehicleGroups = bodies.map((b) => ({
        body: b,
        box: b.box.clone(),
        items: [],
      }));

      for (const item of meshItems) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < vehicleGroups.length; i++) {
          const bBox = vehicleGroups[i].body.box;
          const dx = Math.max(0, bBox.min.x - item.center.x, item.center.x - bBox.max.x);
          const dz = Math.max(0, bBox.min.z - item.center.z, item.center.z - bBox.max.z);
          const dist = Math.hypot(dx, dz);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          } else if (dist === 0 && bestDist === 0) {
            const d1 = Math.hypot(
              item.center.x - vehicleGroups[bestIdx].body.center.x,
              item.center.z - vehicleGroups[bestIdx].body.center.z
            );
            const d2 = Math.hypot(
              item.center.x - vehicleGroups[i].body.center.x,
              item.center.z - vehicleGroups[i].body.center.z
            );
            if (d2 < d1) bestIdx = i;
          }
        }
        vehicleGroups[bestIdx].items.push(item);
        vehicleGroups[bestIdx].box.union(item.box);
      }

      const alignRot =
        forwardAxis === 'z'
          ? new THREE.Matrix4().makeRotationY(Math.PI / 2)
          : new THREE.Matrix4().identity();

      for (const vg of vehicleGroups) {
        const vCenter = new THREE.Vector3();
        const vSize = new THREE.Vector3();
        vg.box.getCenter(vCenter);
        vg.box.getSize(vSize);

        // Convert to real-world meters along vehicle (length, width, height)
        const metricLength = (forwardAxis === 'z' ? vSize.z : vSize.x) * unitScale;
        const metricWidth  = (forwardAxis === 'z' ? vSize.x : vSize.z) * unitScale;
        const metricHeight = vSize.y * unitScale;

        let fitScale = 1.1;
        if (metricLength > 12.0) {
          fitScale = 11.0 / metricLength;
        } else if (metricLength > 9.0) {
          fitScale = 1.0;
        }
        const totalScale = unitScale * fitScale;

        const byMaterial = new Map();
        for (const it of vg.items) {
          const rawMat = Array.isArray(it.mesh.material) ? it.mesh.material[0] : it.mesh.material;
          const mat = getFastMaterial(rawMat);
          if (!mat) continue;

          const geo = it.mesh.geometry.clone();
          for (const attrName of Object.keys(geo.attributes)) {
            if (attrName !== 'position' && attrName !== 'normal' && attrName !== 'uv') {
              geo.deleteAttribute(attrName);
            }
          }
          if (!geo.attributes.uv) {
            const count = geo.attributes.position.count;
            geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
          }

          geo.applyMatrix4(it.mesh.matrixWorld);
          geo.translate(-vCenter.x, -vg.box.min.y, -vCenter.z);
          geo.applyMatrix4(alignRot);
          geo.scale(totalScale, totalScale, totalScale);
          geo.translate(0, -0.88, 0);

          if (!byMaterial.has(mat)) byMaterial.set(mat, []);
          byMaterial.get(mat).push(geo);
        }

        const parts = [];
        for (const [mat, geos] of byMaterial.entries()) {
          const allIndexed = geos.every((g) => Boolean(g.index));
          const normGeos = allIndexed ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
          const mergedGeo = normGeos.length === 1 ? normGeos[0] : mergeGeometries(normGeos);
          if (mergedGeo) {
            parts.push({
              geometry: mergedGeo,
              material: mat,
              vertCount: mergedGeo.attributes.position ? mergedGeo.attributes.position.count : 0,
            });
          }
        }
        // Sort parts largest-first so parts[0] is the primary vehicle body for shadow casting
        parts.sort((a, b) => b.vertCount - a.vertCount);

        if (parts.length === 0) continue;

        const length = metricLength * fitScale;
        const width = metricWidth * fitScale;
        const height = metricHeight * fitScale;
        const halfLen = length / 2;
        const halfWid = width / 2;

        const brakeY = -0.88 + Math.min(0.68, height * 0.40);
        const brakeZ = Math.max(0.42, halfWid * 0.62);
        const brakeGeo = mergeGeometries([
          _t(_bbox(0.06, 0.13, 0.28), -halfLen + 0.06, brakeY, brakeZ).toNonIndexed(),
          _t(_bbox(0.06, 0.13, 0.28), -halfLen + 0.06, brakeY, -brakeZ).toNonIndexed(),
        ]);

        const bkg = _bbox(0.26, 0.22, 0.22);
        const blinkY = -0.88 + Math.min(0.70, height * 0.38);
        const leftBlinkGeo = mergeGeometries([
          _t(bkg, halfLen - 0.1, blinkY, -halfWid - 0.04).toNonIndexed(),
          _t(bkg, -halfLen + 0.1, blinkY, -halfWid - 0.04).toNonIndexed(),
        ]);
        const rightBlinkGeo = mergeGeometries([
          _t(bkg, halfLen - 0.1, blinkY, halfWid + 0.04).toNonIndexed(),
          _t(bkg, -halfLen + 0.1, blinkY, halfWid + 0.04).toNonIndexed(),
        ]);

        const shadowGeo = new THREE.PlaneGeometry(length * 1.16, width * 1.22);
        shadowGeo.rotateX(-Math.PI / 2);
        shadowGeo.translate(0, -0.86, 0);

        const tpl = {
          parts,
          length,
          width,
          height,
          brakeGeo,
          leftBlinkGeo,
          rightBlinkGeo,
          shadowGeo,
        };

        templates.all.push(tpl);

        if (metricLength >= 9.0) {
          templates.bus.push(tpl);
        } else if (metricHeight >= 2.25 || metricLength >= 6.0) {
          templates.truck.push(tpl);
        } else if (metricHeight >= 1.65) {
          templates.minivan.push(tpl);
        } else if (metricHeight <= 1.38) {
          templates.motorcycle.push(tpl);
          templates.car.push(tpl);
        } else {
          templates.car.push(tpl);
        }
      }

      for (const key of ['car', 'minivan', 'truck', 'bus', 'motorcycle']) {
        if (templates[key].length === 0) {
          templates[key] = templates.all;
        }
      }

      this.modelTemplates = templates;

      // Refresh spawned vehicles so newly loaded models appear immediately
      for (const [, mesh] of this.carMeshes.entries()) {
        this.scene.remove(mesh);
      }
      this.carMeshes.clear();
    };

    // Pack 1: orchids_simulator_traffic_car_pack (43 vehicles, +Z forward, 1.0x scale)
    loader.load(
      './orchids_simulator_traffic_car_pack/scene.gltf',
      (gltf) => {
        extractPack(gltf, {
          forwardAxis: 'z',
          unitScale: 1.0,
          isBody: (it) => it.size.z > 2.5 && it.size.x > 1.2 && it.size.y > 0.7,
        });
      },
      undefined,
      (err) => console.error('Failed to load orchids_simulator_traffic_car_pack:', err)
    );

    // Pack 2: traffic_racer_npc_vehicles_pack (17 vehicles, +X forward, 0.5x scale)
    loader.load(
      './traffic_racer_npc_vehicles_pack/scene.gltf',
      (gltf) => {
        extractPack(gltf, {
          forwardAxis: 'x',
          unitScale: 0.5,
          isBody: (it) => it.size.x > 6.0 && it.size.z > 2.5 && it.size.y > 2.0,
        });
      },
      undefined,
      (err) => console.error('Failed to load traffic_racer_npc_vehicles_pack:', err)
    );
  }

  _setupLights() {
    this.lightTuning = {
      keyIntensity: 2.25,
      sunAzimuth: -26,
      sunElevation: 42,
      hemiIntensity: 1.52,
      fillIntensity: 0.4,
      exposure: 1.16,
      fogStartDist: 100,
    };

    const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x161820, this.lightTuning.hemiIntensity);
    this.scene.add(hemiLight);
    this.hemiLight = hemiLight;

    const keyLight = new THREE.DirectionalLight(0xfff6e8, this.lightTuning.keyIntensity);
    keyLight.position.set(188, 189, -92);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 20;
    keyLight.shadow.camera.far = 520;
    const d = 185;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.018;
    this.scene.add(keyLight);
    this.keyLight = keyLight;

    const fillLight = new THREE.DirectionalLight(0x7799ff, this.lightTuning.fillIntensity);
    fillLight.position.set(-150, 150, -100);
    this.scene.add(fillLight);
    this.fillLight = fillLight;

    this.updateLightTuning();
  }

  updateLightTuning(partial = {}) {
    Object.assign(this.lightTuning, partial);
    const {
      keyIntensity,
      sunAzimuth,
      sunElevation,
      hemiIntensity,
      fillIntensity,
      exposure,
    } = this.lightTuning;

    if (this.keyLight) {
      this.keyLight.intensity = keyIntensity;
      const elRad = (sunElevation * Math.PI) / 180;
      const azRad = (sunAzimuth * Math.PI) / 180;
      const r = 282;
      const horiz = r * Math.cos(elRad);
      this.keyLight.position.set(
        horiz * Math.cos(azRad),
        r * Math.sin(elRad),
        horiz * Math.sin(azRad)
      );
      this.renderer.shadowMap.needsUpdate = true;
    }
    if (this.hemiLight) {
      this.hemiLight.intensity = hemiIntensity;
    }
    if (this.fillLight) {
      this.fillLight.intensity = fillIntensity;
    }
    if (this.renderer) {
      this.renderer.toneMappingExposure = exposure;
    }
  }

  getLightTuning() {
    return { ...this.lightTuning };
  }

  _createCenterBeacon() {
    const group = new THREE.Group();

    // Procedural radial-bloom canvas texture in neutral white so vertexColors drive the road heatmap color
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = 256;
    glowCanvas.height = 256;
    const gCtx = glowCanvas.getContext('2d');
    const grad = gCtx.createRadialGradient(128, 128, 4, 128, 128, 126);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.26)');
    grad.addColorStop(0.42, 'rgba(255, 255, 255, 0.06)');
    grad.addColorStop(0.54, 'rgba(255, 255, 255, 0.54)');
    grad.addColorStop(0.62, 'rgba(255, 255, 255, 0.08)');
    grad.addColorStop(0.76, 'rgba(255, 255, 255, 0.22)');
    grad.addColorStop(0.86, 'rgba(255, 255, 255, 0.82)');
    grad.addColorStop(0.93, 'rgba(255, 255, 255, 0.25)');
    grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
    gCtx.fillStyle = grad;
    gCtx.fillRect(0, 0, 256, 256);
    const glowTex = new THREE.CanvasTexture(glowCanvas);

    // Subdivided tarmac-conforming mesh so every vertex sits 3.2cm above the curved road (right under the tires)
    const gridSegs = 20;
    const discGeo = new THREE.PlaneGeometry(25.0, 25.0, gridSegs, gridSegs);
    discGeo.rotateX(-Math.PI / 2);

    // Store base local (x, z) offsets and initialize per-vertex color buffer for road heatmap coloring
    const posAttr = discGeo.attributes.position;
    const baseOffsets = new Float32Array(posAttr.count * 2);
    const discColors = new Float32Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
      baseOffsets[i * 2]     = posAttr.getX(i); // along road forward
      baseOffsets[i * 2 + 1] = posAttr.getZ(i); // across road width
      discColors[i * 3]      = 1.0;
      discColors[i * 3 + 1]  = 0.2;
      discColors[i * 3 + 2]  = 0.15;
    }
    discGeo.setAttribute('color', new THREE.BufferAttribute(discColors, 3));

    const discMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.68,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const discMesh = new THREE.Mesh(discGeo, discMat);
    discMesh.frustumCulled = false;
    discMesh.renderOrder = 2;
    this.scene.add(discMesh);

    group.userData = {
      discMesh,
      discGeo,
      baseOffsets,
    };
    group.visible = false;
    discMesh.visible = false;
    this.scene.add(group);
    return group;
  }

  _setupEnvironment() {
    // 1. Seamless surrounding turf floor extending to the horizon
    const turfCanvas = document.createElement('canvas');
    turfCanvas.width = 256;
    turfCanvas.height = 256;
    const tCtx = turfCanvas.getContext('2d');
    const tImg = tCtx.createImageData(256, 256);
    const tData = tImg.data;
    for (let i = 0; i < tData.length; i += 4) {
      const px = (i / 4) % 256;
      const py = Math.floor(i / 4 / 256);
      const n1 = Math.sin(px * 12.9898 + py * 78.233) * 43758.5453;
      const grain = n1 - Math.floor(n1);
      const patch =
        0.5 +
        0.25 * Math.sin((px / 256) * Math.PI * 4) * Math.cos((py / 256) * Math.PI * 4);
      const shade = 0.78 + grain * 0.26 + (patch - 0.5) * 0.16;
      tData[i]     = Math.round(44 * shade);
      tData[i + 1] = Math.round(58 * shade);
      tData[i + 2] = Math.round(24 * shade);
      tData[i + 3] = 255;
    }
    tCtx.putImageData(tImg, 0, 0);
    const turfTex = new THREE.CanvasTexture(turfCanvas);
    turfTex.wrapS = THREE.RepeatWrapping;
    turfTex.wrapT = THREE.RepeatWrapping;
    turfTex.repeat.set(36, 36);
    turfTex.colorSpace = THREE.SRGBColorSpace;

    const outerFloorGeo = new THREE.PlaneGeometry(1600, 1600);
    const outerFloorMat = new THREE.MeshLambertMaterial({ map: turfTex });
    const outerFloor = new THREE.Mesh(outerFloorGeo, outerFloorMat);
    outerFloor.rotation.x = -Math.PI / 2;
    outerFloor.position.y = -0.52;
    outerFloor.receiveShadow = true;
    this.scene.add(outerFloor);

    // 2. Centered 'PHANTOM JAM' turf emblem background directly beneath the Figure-8 highway
    const texLoader = new THREE.TextureLoader();
    texLoader.load('./phantom-jam-bg.jpg?v=4', (rawTex) => {
      const img = rawTex.image;
      const cw = 1024;
      const ch = Math.round((img.height / img.width) * cw) || 610;
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, cw, ch);

      // Feather outer 8% border so the image blends seamlessly into the surrounding turf
      const imgData = ctx.getImageData(0, 0, cw, ch);
      const d = imgData.data;
      const borderX = cw * 0.08;
      const borderY = ch * 0.08;
      for (let y = 0; y < ch; y++) {
        const fy = Math.min(1.0, Math.min(y, ch - 1 - y) / borderY);
        for (let x = 0; x < cw; x++) {
          const fx = Math.min(1.0, Math.min(x, cw - 1 - x) / borderX);
          const f = Math.min(fx, fy);
          if (f < 1.0) {
            const smoothF = f * f * (3 - 2 * f);
            d[(y * cw + x) * 4 + 3] = Math.round(smoothF * 255);
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);

      const bgTex = new THREE.CanvasTexture(canvas);
      bgTex.colorSpace = THREE.SRGBColorSpace;
      bgTex.anisotropy = 4;

      const logoGeo = new THREE.PlaneGeometry(420, 420 * (ch / cw));
      const logoMat = new THREE.MeshLambertMaterial({
        map: bgTex,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const logoMesh = new THREE.Mesh(logoGeo, logoMat);
      logoMesh.rotation.x = -Math.PI / 2;
      // Offset Z by +5.1m so the mural's figure-8 crossing (y=289px of 603px) sits at world origin (0,0)
      logoMesh.position.set(0, -0.49, 5.1);
      logoMesh.renderOrder = 1;
      logoMesh.frustumCulled = false;
      logoMesh.receiveShadow = true;
      logoMesh.updateMatrix();
      logoMesh.matrixAutoUpdate = false;
      this.scene.add(logoMesh);
    });

    // 3D Congestion Center Beacon (Red)
    this.jamMarker = this._createCenterBeacon(0xff3b30, 0xff5c52);
  }

  /**
   * Generates a realistic 3D highway with concrete deck, steel W-beam guardrails,
   * reflective posts, bridge piers, cantilevered streetlights, overhead sign gantries,
   * and roadside warning signs — all merged by material into static draw calls.
   */
  createRoadMesh(road) {
    this.road = road;
    const width = 24.0;
    const halfW = width / 2;
    const steps = 600;

    const vertices = [];
    const indices = [];

    // Road deck slab + concrete side walls
    const deckVertices = [];
    const deckIndices = [];
    const deckThickness = 0.85;

    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * road.totalLength;
      const pt = getPointAtS(road, s);

      const px = -pt.ty;
      const pz = pt.tx;
      const plen = Math.hypot(px, pz) || 1;
      const nx = px / plen;
      const nz = pz / plen;

      const xL = pt.x + nx * halfW;
      const zL = pt.y + nz * halfW;
      const xR = pt.x - nx * halfW;
      const zR = pt.y - nz * halfW;

      vertices.push(xL, pt.z, zL);
      vertices.push(xR, pt.z, zR);

      // Deck side walls (4 vertices per step: topL, botL, topR, botR)
      const wL = pt.x + nx * (halfW + 0.45);
      const wzL = pt.y + nz * (halfW + 0.45);
      const wR = pt.x - nx * (halfW + 0.45);
      const wzR = pt.y - nz * (halfW + 0.45);

      deckVertices.push(
        wL, pt.z + 0.15, wzL,
        wL, pt.z - deckThickness, wzL,
        wR, pt.z + 0.15, wzR,
        wR, pt.z - deckThickness, wzR
      );

      if (i < steps) {
        const currL = 2 * i;
        const currR = 2 * i + 1;
        const nextL = 2 * (i + 1);
        const nextR = 2 * (i + 1) + 1;
        indices.push(currL, nextL, currR);
        indices.push(currR, nextL, nextR);

        const b = 4 * i;
        const nb = 4 * (i + 1);
        // Left outer wall
        deckIndices.push(b, nb, b + 1, b + 1, nb, nb + 1);
        // Right outer wall
        deckIndices.push(b + 2, b + 3, nb + 2, b + 3, nb + 3, nb + 2);
        // Bottom soffit
        deckIndices.push(b + 1, nb + 1, b + 3, b + 3, nb + 1, nb + 3);
      }
    }

    // 1. Asphalt Surface with Dynamic Vertex-Color Traffic Heatmap
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const colorFloats = new Float32Array((steps + 1) * 2 * 3);
    for (let i = 0; i <= steps; i++) {
      const idx = i * 6;
      // Default dark asphalt with subtle flowing green tint
      colorFloats[idx]     = 0.04;
      colorFloats[idx + 1] = 0.09;
      colorFloats[idx + 2] = 0.06;
      colorFloats[idx + 3] = 0.04;
      colorFloats[idx + 4] = 0.09;
      colorFloats[idx + 5] = 0.06;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colorFloats, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const roadMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    const roadMesh = new THREE.Mesh(geometry, roadMaterial);
    roadMesh.receiveShadow = true;
    this.scene.add(roadMesh);

    this.roadGeometry = geometry;
    this.roadSteps = steps;
    this.heatmapBins = 120;
    this.heatmapSmooth = new Float32Array(this.heatmapBins).fill(1.0);

    // 1b. 3D Hexagonal Pipe Congestion Tunnel (true 3D cylindrical pipes: thick near Congestion Center circle, tapering & fading farther out)
    const tunnelRadiusW = halfW + 0.35;
    const tunnelRadiusH = 6.4;
    const totalRoadLen = road.totalLength;

    // Map 2D tunnel surface coordinates (s, theta in [0, PI]) to 3D world space on the arch
    const evalArchPoint = (sVal, thetaVal) => {
      const sWrapped = ((sVal % totalRoadLen) + totalRoadLen) % totalRoadLen;
      const pt = getPointAtS(road, sWrapped);
      const px = -pt.ty;
      const pz = pt.tx;
      const plen = Math.hypot(px, pz) || 1;
      const nx = px / plen;
      const nz = pz / plen;
      const lat = Math.cos(thetaVal) * tunnelRadiusW;
      const hgt = Math.sin(thetaVal) * tunnelRadiusH + 0.10;
      return {
        pos: new THREE.Vector3(pt.x + nx * lat, pt.z + hgt, pt.y + nz * lat),
        s: sWrapped,
      };
    };

    // Generate large hexagonal honeycomb cells around the loop and deduplicate shared pipe struts
    const numCols = 96; // 96 columns around the ~1085m loop (~11.3m per column step)
    const colStepS = totalRoadLen / numCols;
    const hexRadS = colStepS / 1.5; // flat-top hexagon radius along road (~7.5m, 15m full hex width)
    const numRows = 3; // 3 large hexagons spanning across the arch from left curb (0) to right curb (PI)
    const rowStepTheta = Math.PI / numRows;
    const hexRadTheta = rowStepTheta / Math.sqrt(3);

    const uniqueEdges = new Map();
    const uniqueNodes = new Map();
    const quantKey = (sVal, thVal) => {
      const sw = ((sVal % totalRoadLen) + totalRoadLen) % totalRoadLen;
      const si = Math.round((sw / totalRoadLen) * (numCols * 6)) % (numCols * 6);
      const ti = Math.round((thVal / Math.PI) * 180);
      return `${si}_${ti}`;
    };

    for (let col = 0; col < numCols; col++) {
      const centerS = col * colStepS;
      const oddOffset = (col % 2) * 0.5;
      for (let row = 0; row <= numRows; row++) {
        const centerTheta = (row + oddOffset - 0.25) * rowStepTheta;
        const corners = [];
        for (let k = 0; k < 6; k++) {
          const ang = (k * Math.PI) / 3;
          const cs = centerS + hexRadS * Math.cos(ang);
          const cth = Math.max(0.0, Math.min(Math.PI, centerTheta + hexRadTheta * Math.sin(ang)));
          const key = quantKey(cs, cth);
          corners.push({ s: cs, theta: cth, key });
          if (!uniqueNodes.has(key) && cth > 0.01 && cth < Math.PI - 0.01) {
            uniqueNodes.set(key, { s: cs, theta: cth });
          }
        }
        for (let k = 0; k < 6; k++) {
          const c0 = corners[k];
          const c1 = corners[(k + 1) % 6];
          if (c0.key === c1.key) continue;
          // Skip flat curb-hugging segments on the very bottom edges if both lie on curb
          if ((c0.theta <= 0.005 && c1.theta <= 0.005) || (c0.theta >= Math.PI - 0.005 && c1.theta >= Math.PI - 0.005)) {
            continue;
          }
          const eKey = c0.key < c1.key ? `${c0.key}|${c1.key}` : `${c1.key}|${c0.key}`;
          if (!uniqueEdges.has(eKey)) {
            uniqueEdges.set(eKey, [c0, c1]);
          }
        }
      }
    }

    // Build 3D cylindrical tube geometry for every hexagonal pipe strut (inflated along radial normal in vertex shader)
    const pipeSides = 8;
    const pipePos = [];
    const pipeNorm = [];
    const pipeSAttr = [];
    const pipeIndices = [];
    const axisVec = new THREE.Vector3();
    const upTmp = new THREE.Vector3();
    const uBasis = new THREE.Vector3();
    const vBasis = new THREE.Vector3();
    const radNorm = new THREE.Vector3();

    for (const [c0, c1] of uniqueEdges.values()) {
      const a = evalArchPoint(c0.s, c0.theta);
      const b = evalArchPoint(c1.s, c1.theta);
      axisVec.subVectors(b.pos, a.pos);
      const len = axisVec.length();
      if (len < 0.05) continue;
      axisVec.divideScalar(len);

      if (Math.abs(axisVec.y) < 0.9) upTmp.set(0, 1, 0);
      else upTmp.set(1, 0, 0);
      uBasis.crossVectors(axisVec, upTmp).normalize();
      vBasis.crossVectors(axisVec, uBasis).normalize();

      const baseV = pipePos.length / 3;
      for (let end = 0; end < 2; end++) {
        const endPt = end === 0 ? a : b;
        for (let k = 0; k < pipeSides; k++) {
          const phi = (k / pipeSides) * Math.PI * 2;
          const cosP = Math.cos(phi);
          const sinP = Math.sin(phi);
          radNorm
            .set(0, 0, 0)
            .addScaledVector(uBasis, cosP)
            .addScaledVector(vBasis, sinP)
            .normalize();

          pipePos.push(endPt.pos.x, endPt.pos.y, endPt.pos.z);
          pipeNorm.push(radNorm.x, radNorm.y, radNorm.z);
          pipeSAttr.push(endPt.s);
        }
      }

      for (let k = 0; k < pipeSides; k++) {
        const kNext = (k + 1) % pipeSides;
        const i0 = baseV + k;
        const i1 = baseV + kNext;
        const i2 = baseV + pipeSides + k;
        const i3 = baseV + pipeSides + kNext;
        pipeIndices.push(i0, i2, i1, i1, i2, i3);
      }
    }

    const tunnelGeo = new THREE.BufferGeometry();
    tunnelGeo.setAttribute('position', new THREE.Float32BufferAttribute(pipePos, 3));
    tunnelGeo.setAttribute('normal', new THREE.Float32BufferAttribute(pipeNorm, 3));
    tunnelGeo.setAttribute('pipeS', new THREE.Float32BufferAttribute(pipeSAttr, 1));
    tunnelGeo.setIndex(pipeIndices);

    this.tunnelUniforms = {
      uCenterS: { value: 0.0 },
      uHalfWaveLen: { value: 0.0 },
      uTotalLen: { value: totalRoadLen },
      uSeverity: { value: 1.0 },
    };

    const tunnelMat = new THREE.ShaderMaterial({
      uniforms: this.tunnelUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: `
        attribute float pipeS;
        uniform float uCenterS;
        uniform float uHalfWaveLen;
        uniform float uTotalLen;
        uniform float uSeverity;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying float vProximity;

        void main() {
          float ds = abs(pipeS - uCenterS);
          if (ds > uTotalLen * 0.5) ds = uTotalLen - ds;

          float prox = 0.0;
          if (uHalfWaveLen > 5.0 && ds < uHalfWaveLen) {
            float u = ds / uHalfWaveLen;
            prox = pow(1.0 - u, 1.45) * exp(-0.75 * u) * uSeverity;
          }
          vProximity = prox;

          // Inflate 3D cylindrical pipe radius: thick (0.40m radius) near the Congestion Center circle,
          // tapering down to thin pipes (0.02m) as distance from the circle increases
          float pipeRadius = prox > 0.002 ? mix(0.02, 0.40, pow(prox, 1.25)) : 0.0;
          vec3 inflatedPos = position + normal * pipeRadius;

          vec4 mvPosition = modelViewMatrix * vec4(inflatedPos, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vViewDir = normalize(-mvPosition.xyz);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying float vProximity;

        void main() {
          if (vProximity <= 0.003) discard;

          vec3 N = normalize(vNormal);
          vec3 V = normalize(vViewDir);
          vec3 L = normalize(vec3(0.45, 0.82, 0.35));
          vec3 H = normalize(L + V);

          // 3D cylindrical pipe shading: diffuse wrap + glossy ridge highlight + subtle rim
          float diff = abs(dot(N, L)) * 0.55 + 0.45;
          float coreRidge = abs(dot(N, V));
          float spec = pow(max(0.0, abs(dot(N, H))), 18.0) * 0.48;

          vec3 baseRed = vec3(0.88, 0.12, 0.10);
          vec3 highlightRed = vec3(1.0, 0.46, 0.40);
          vec3 col = mix(baseRed * diff, highlightRed, spec + coreRidge * 0.28);

          // Less transparent closer to the circle, progressively more transparent farther out
          float alpha = clamp(pow(vProximity, 0.65) * (0.38 + 0.50 * coreRidge), 0.0, 0.88);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    const tunnelMesh = new THREE.Mesh(tunnelGeo, tunnelMat);
    tunnelMesh.renderOrder = 6;
    tunnelMesh.frustumCulled = false;
    this.hexagonsEnabled = Boolean(this.hexagonsEnabled);
    tunnelMesh.visible = this.hexagonsEnabled;
    this.scene.add(tunnelMesh);
    this.tunnelMesh = tunnelMesh;
    this.tunnelGeometry = tunnelGeo;

    // 1c. 3D Vehicle-Count Graph Over the Road (height = # of cars, colored by road heatmap)
    this.densitySmooth = new Float32Array(this.heatmapBins).fill(2.0);
    const graphBasePos = new Float32Array((steps + 1) * 3);
    const ribbonVerts = new Float32Array((steps + 1) * 2 * 3);
    const ribbonColors = new Float32Array((steps + 1) * 2 * 3);
    const crestVerts = new Float32Array((steps + 1) * 2 * 3);
    const crestColors = new Float32Array((steps + 1) * 2 * 3);
    const baseLineVerts = new Float32Array((steps + 1) * 3);
    const ribbonIndices = [];

    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * road.totalLength;
      const pt = getPointAtS(road, s);
      const baseH = pt.z + 2.8; // baseline floating cleanly above vehicles

      graphBasePos[i * 3]     = pt.x;
      graphBasePos[i * 3 + 1] = baseH;
      graphBasePos[i * 3 + 2] = pt.y;

      baseLineVerts[i * 3]     = pt.x;
      baseLineVerts[i * 3 + 1] = baseH;
      baseLineVerts[i * 3 + 2] = pt.y;

      const vIdx = i * 6;
      // Bottom vertex (at baseline)
      ribbonVerts[vIdx]     = pt.x;
      ribbonVerts[vIdx + 1] = baseH;
      ribbonVerts[vIdx + 2] = pt.y;
      // Top vertex (at baseline + height(# of cars))
      ribbonVerts[vIdx + 3] = pt.x;
      ribbonVerts[vIdx + 4] = baseH + 2.0;
      ribbonVerts[vIdx + 5] = pt.y;

      // Glowing crest band along top of graph
      crestVerts[vIdx]     = pt.x;
      crestVerts[vIdx + 1] = baseH + 1.82;
      crestVerts[vIdx + 2] = pt.y;
      crestVerts[vIdx + 3] = pt.x;
      crestVerts[vIdx + 4] = baseH + 2.12;
      crestVerts[vIdx + 5] = pt.y;

      if (i < steps) {
        const c0 = 2 * i;
        const c1 = 2 * i + 1;
        const n0 = 2 * (i + 1);
        const n1 = 2 * (i + 1) + 1;
        ribbonIndices.push(c0, n0, c1, c1, n0, n1);
      }
    }

    const densityRibbonGeo = new THREE.BufferGeometry();
    densityRibbonGeo.setAttribute('position', new THREE.BufferAttribute(ribbonVerts, 3));
    densityRibbonGeo.setAttribute('color', new THREE.BufferAttribute(ribbonColors, 3));
    densityRibbonGeo.setIndex(ribbonIndices);
    const densityRibbonMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.graphEnabled = Boolean(this.graphEnabled);
    const densityRibbonMesh = new THREE.Mesh(densityRibbonGeo, densityRibbonMat);
    densityRibbonMesh.renderOrder = 4;
    densityRibbonMesh.frustumCulled = false;
    densityRibbonMesh.visible = this.graphEnabled;
    this.scene.add(densityRibbonMesh);

    const densityCrestGeo = new THREE.BufferGeometry();
    densityCrestGeo.setAttribute('position', new THREE.BufferAttribute(crestVerts, 3));
    densityCrestGeo.setAttribute('color', new THREE.BufferAttribute(crestColors, 3));
    densityCrestGeo.setIndex(ribbonIndices);
    const densityCrestMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const densityCrestMesh = new THREE.Mesh(densityCrestGeo, densityCrestMat);
    densityCrestMesh.renderOrder = 5;
    densityCrestMesh.frustumCulled = false;
    densityCrestMesh.visible = this.graphEnabled;
    this.scene.add(densityCrestMesh);

    const baseLineGeo = new THREE.BufferGeometry();
    baseLineGeo.setAttribute('position', new THREE.BufferAttribute(baseLineVerts, 3));
    const baseLineMat = new THREE.LineBasicMaterial({
      color: 0x8b9bb4,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    const densityBaseLine = new THREE.Line(baseLineGeo, baseLineMat);
    densityBaseLine.renderOrder = 3;
    densityBaseLine.frustumCulled = false;
    densityBaseLine.visible = this.graphEnabled;
    this.scene.add(densityBaseLine);

    this.graphBasePos = graphBasePos;
    this.densityRibbonGeo = densityRibbonGeo;
    this.densityCrestGeo = densityCrestGeo;
    this.densityRibbonMesh = densityRibbonMesh;
    this.densityCrestMesh = densityCrestMesh;
    this.densityBaseLine = densityBaseLine;

    // 2. Concrete Deck Underside & Side Coping
    const deckGeo = new THREE.BufferGeometry();
    deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deckVertices, 3));
    deckGeo.setIndex(deckIndices);
    deckGeo.computeVertexNormals();
    const concreteMat = new THREE.MeshLambertMaterial({
      color: 0x454852,
      side: THREE.DoubleSide,
    });
    const deckMesh = new THREE.Mesh(deckGeo, concreteMat);
    deckMesh.castShadow = true;
    deckMesh.receiveShadow = true;
    this.scene.add(deckMesh);

    // 3. Continuous Steel W-Beam Guardrails (Left & Right)
    const railVertices = [];
    const railIndices = [];
    for (const side of [-1, 1]) {
      const baseV = railVertices.length / 3;
      const railOffset = side * (halfW + 0.32);
      for (let i = 0; i <= steps; i++) {
        const s = (i / steps) * road.totalLength;
        const pt = getPointAtS(road, s);
        const px = -pt.ty;
        const pz = pt.tx;
        const plen = Math.hypot(px, pz) || 1;
        const nx = px / plen;
        const nz = pz / plen;

        const rx = pt.x + nx * railOffset;
        const rz = pt.y + nz * railOffset;

        // Upper and lower edges of W-beam rail (height 0.45m to 0.82m above road)
        railVertices.push(rx, pt.z + 0.82, rz);
        railVertices.push(rx, pt.z + 0.45, rz);

        if (i < steps) {
          const c0 = baseV + 2 * i;
          const c1 = baseV + 2 * i + 1;
          const n0 = baseV + 2 * (i + 1);
          const n1 = baseV + 2 * (i + 1) + 1;
          railIndices.push(c0, n0, c1, c1, n0, n1);
        }
      }
    }
    const railGeo = new THREE.BufferGeometry();
    railGeo.setAttribute('position', new THREE.Float32BufferAttribute(railVertices, 3));
    railGeo.setIndex(railIndices);
    railGeo.computeVertexNormals();
    const steelMat = new THREE.MeshLambertMaterial({
      color: 0x8d95a5,
      side: THREE.DoubleSide,
    });
    const railMesh = new THREE.Mesh(railGeo, steelMat);
    railMesh.castShadow = true;
    railMesh.receiveShadow = true;
    this.scene.add(railMesh);

    // 4. Thicker, Worn-Out 3D Painted Road Median & Lane Lines
    const buildLineStripGeo = (offsets, stripWidth, uvTileLen) => {
      const stripVerts = [];
      const stripUvs = [];
      const stripColors = [];
      const stripIndices = [];
      const halfStrip = stripWidth * 0.5;

      for (const offset of offsets) {
        const baseV = stripVerts.length / 3;
        for (let i = 0; i <= steps; i++) {
          const s = (i / steps) * road.totalLength;
          const pt = getPointAtS(road, s);
          const px = -pt.ty;
          const pz = pt.tx;
          const plen = Math.hypot(px, pz) || 1;
          const nx = px / plen;
          const nz = pz / plen;

          const cx = pt.x + nx * offset;
          const cz = pt.y + nz * offset;
          const y = pt.z + 0.05;

          // Match roadMesh winding (+nx first, -nx second) so normals point UP (+Y)
          stripVerts.push(cx + nx * halfStrip, y, cz + nz * halfStrip);
          stripVerts.push(cx - nx * halfStrip, y, cz - nz * halfStrip);

          const vCoord = s / uvTileLen;
          stripUvs.push(0, vCoord, 1, vCoord);

          // Organic large-scale wear modulation along the highway loop
          const wear =
            0.78 +
            0.14 * Math.sin(s * 0.045 + offset) +
            0.08 * Math.cos(s * 0.13 - offset * 1.7);
          stripColors.push(wear, wear, wear, wear, wear, wear);

          if (i < steps) {
            const c0 = baseV + 2 * i;
            const c1 = baseV + 2 * i + 1;
            const n0 = baseV + 2 * (i + 1);
            const n1 = baseV + 2 * (i + 1) + 1;
            stripIndices.push(c0, n0, c1, c1, n0, n1);
          }
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(stripVerts, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(stripUvs, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(stripColors, 3));
      geo.setIndex(stripIndices);
      geo.computeVertexNormals();
      return geo;
    };

    const laneWidth = 4.5;
    const laneOffsets = [1, 2, 3, 4].map((l) => (l - 2.5) * laneWidth);
    const laneStripGeo = buildLineStripGeo(laneOffsets, 0.26, 24.0);
    const laneStripMat = new THREE.MeshLambertMaterial({
      map: _createWornLineTexture(215, 222, 235, true),
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const laneStripMesh = new THREE.Mesh(laneStripGeo, laneStripMat);
    laneStripMesh.receiveShadow = true;
    this.scene.add(laneStripMesh);

    // Left yellow median line & right white shoulder line (thicker, weathered continuous paint)
    const yellowMedianGeo = buildLineStripGeo([-(halfW - 0.42)], 0.30, 28.0);
    const yellowMedianMat = new THREE.MeshLambertMaterial({
      map: _createWornLineTexture(228, 175, 48, false),
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const yellowMedianMesh = new THREE.Mesh(yellowMedianGeo, yellowMedianMat);
    yellowMedianMesh.receiveShadow = true;
    this.scene.add(yellowMedianMesh);

    const whiteEdgeGeo = buildLineStripGeo([halfW - 0.42], 0.30, 28.0);
    const whiteEdgeMat = new THREE.MeshLambertMaterial({
      map: _createWornLineTexture(218, 224, 236, false),
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const whiteEdgeMesh = new THREE.Mesh(whiteEdgeGeo, whiteEdgeMat);
    whiteEdgeMesh.receiveShadow = true;
    this.scene.add(whiteEdgeMesh);

    // 5. Static Highway Infrastructure (Guardrail Posts, Reflectors, Streetlights, Bridge Piers, Signs)
    const steelGeos = [];
    const darkMetalGeos = [];
    const pierGeos = [];
    const reflectorRedGeos = [];
    const reflectorWhiteGeos = [];
    const lampBulbGeos = [];
    const signBoardRedGeos = [];
    const signBoardYellowGeos = [];

    const postGeo = _bbox(0.12, 0.88, 0.12);
    const reflectorGeo = _bbox(0.08, 0.14, 0.04);
    const poleGeo = _cyl(0.11, 0.18, 9.0, 8);
    const armGeo = _bbox(0.12, 0.12, 3.8);
    const fixtureGeo = _bbox(0.45, 0.14, 0.95);
    const bulbGeo = _bbox(0.38, 0.06, 0.75);

    const basisMat = new THREE.Matrix4();
    const itemMat = new THREE.Matrix4();
    const localMat = new THREE.Matrix4();

    // Helper to build a road-aligned world matrix at distance s and lateral offset
    const getRoadFrame = (s, latOffset, yOffset = 0) => {
      const pt = getPointAtS(road, s);
      const forward = new THREE.Vector3(pt.tx, pt.tz, pt.ty).normalize();
      const upRef = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(forward, upRef).normalize();
      const up = new THREE.Vector3().crossVectors(right, forward).normalize();

      const pos = new THREE.Vector3(pt.x, pt.z, pt.y)
        .addScaledVector(right, latOffset)
        .addScaledVector(up, yOffset);

      basisMat.makeBasis(forward, up, right);
      basisMat.setPosition(pos);
      return { pt, basisMat: basisMat.clone() };
    };

    // 5a. Guardrail Posts & Roadside Delineator Reflectors (every 8m)
    const numPosts = Math.floor(road.totalLength / 8.0);
    for (let i = 0; i < numPosts; i++) {
      const s = i * 8.0;
      for (const side of [-1, 1]) {
        const { basisMat: frame } = getRoadFrame(s, side * (halfW + 0.36), 0.44);
        steelGeos.push(_tm(postGeo, frame));

        // Add reflector tab every 16m
        if (i % 2 === 0) {
          const { basisMat: refFrame } = getRoadFrame(s, side * (halfW + 0.30), 0.72);
          if (side === 1) {
            reflectorRedGeos.push(_tm(reflectorGeo, refFrame));
          } else {
            reflectorWhiteGeos.push(_tm(reflectorGeo, refFrame));
          }
        }
      }
    }

    // 5b. Highway Cantilever Streetlights (every 34m, staggered on both sides)
    const numLights = Math.floor(road.totalLength / 34.0);
    for (let i = 0; i < numLights; i++) {
      const s = i * 34.0;
      for (const side of [-1, 1]) {
        const { basisMat: baseFrame } = getRoadFrame(s, side * (halfW + 0.55), 0);

        // Vertical tapered pole
        localMat.makeTranslation(0, 4.5, 0);
        itemMat.multiplyMatrices(baseFrame, localMat);
        darkMetalGeos.push(_tm(poleGeo, itemMat));

        // Overhanging cantilever mast arm reaching inward toward lanes
        const inward = -side;
        localMat.makeRotationX(inward * 0.18);
        localMat.setPosition(0, 8.85, inward * 1.75);
        itemMat.multiplyMatrices(baseFrame, localMat);
        darkMetalGeos.push(_tm(armGeo, itemMat));

        // Lamp housing
        localMat.identity();
        localMat.setPosition(0, 8.95, inward * 3.45);
        itemMat.multiplyMatrices(baseFrame, localMat);
        darkMetalGeos.push(_tm(fixtureGeo, itemMat));

        // Glowing LED bulb
        localMat.identity();
        localMat.setPosition(0, 8.87, inward * 3.45);
        itemMat.multiplyMatrices(baseFrame, localMat);
        lampBulbGeos.push(_tm(bulbGeo, itemMat));
      }
    }

    // 5c. Concrete Bridge Support Piers under elevated sections
    const numPiers = Math.floor(road.totalLength / 28.0);
    for (let i = 0; i < numPiers; i++) {
      const s = i * 28.0;
      const pt = getPointAtS(road, s);
      const distFromOrigin = Math.hypot(pt.x, pt.y);
      // Place piers where road is elevated > 2.2m and clear of the lower crossing at (0,0)
      if (pt.z > 2.2 && distFromOrigin > 22.0) {
        const pierH = pt.z + 0.5 - deckThickness;
        if (pierH > 1.0) {
          const forward = new THREE.Vector3(pt.tx, 0, pt.ty).normalize();
          const up = new THREE.Vector3(0, 1, 0);
          const right = new THREE.Vector3().crossVectors(forward, up).normalize();

          // Crosshead cap beam under deck
          const capFrame = new THREE.Matrix4().makeBasis(forward, up, right);
          capFrame.setPosition(pt.x, pt.z - deckThickness - 0.45, pt.y);
          pierGeos.push(_tm(_bbox(1.8, 0.9, width - 2.0), capFrame));

          // Twin vertical cylindrical concrete columns
          const colGeo = _cyl(0.85, 0.95, pierH, 10);
          for (const side of [-1, 1]) {
            const colPos = new THREE.Vector3(pt.x, -0.5 + pierH / 2, pt.y).addScaledVector(
              right,
              side * 7.2
            );
            const colFrame = new THREE.Matrix4().makeBasis(forward, up, right);
            colFrame.setPosition(colPos);
            pierGeos.push(_tm(colGeo, colFrame));
          }
        }
      }
    }

    // 5d. Overhead Highway Sign Gantries (6 gantries around the loop)
    const gantrySpecs = [
      { frac: 0.08, title: 'I-80 EXPRESSWAY', sub: 'ALL LANES THROUGH', speed: '110' },
      { frac: 0.24, title: 'OVERPASS AHEAD', sub: 'KEEP SAFE HEADWAY', speed: '90' },
      { frac: 0.41, title: 'WEST LOOP MERGE', sub: 'WATCH FOR SLOW TRAFFIC', speed: '100' },
      { frac: 0.58, title: 'PHANTOM JAM ZONE', sub: 'MAINTAIN STEADY SPEED', speed: '80' },
      { frac: 0.74, title: 'UNDERPASS APPROACH', sub: 'STAY IN LANE', speed: '90' },
      { frac: 0.91, title: 'NORTH RING HWY', sub: '5 LANES OPEN', speed: '110' },
    ];

    const gantrySpan = width + 1.6;
    const gantryLegGeo = _cyl(0.24, 0.28, 7.6, 8);
    // Steel beam sits inside the signboard cabinet (-0.16m..+0.16m) so it never blocks front or back signs
    const gantryBeamGeo = _bbox(0.32, 0.42, gantrySpan + 0.6);
    // Double-sided signboard cabinet (-0.30m..+0.30m) encloses the central beam cleanly
    const signBackingGeo = _bbox(0.60, 2.4, 13.5);
    const signFaceGeo = new THREE.PlaneGeometry(13.2, 2.25);

    for (const gSpec of gantrySpecs) {
      const s = gSpec.frac * road.totalLength;
      const { basisMat: centerFrame } = getRoadFrame(s, 0, 0);

      // Left & Right support legs
      for (const side of [-1, 1]) {
        localMat.makeTranslation(0, 3.8, side * (gantrySpan / 2));
        itemMat.multiplyMatrices(centerFrame, localMat);
        steelGeos.push(_tm(gantryLegGeo, itemMat));
      }

      // Overhead horizontal truss beam
      localMat.makeTranslation(0, 7.35, 0);
      itemMat.multiplyMatrices(centerFrame, localMat);
      steelGeos.push(_tm(gantryBeamGeo, itemMat));

      // Signboard backing cabinet wrapping cleanly outside the beam on both front and back
      localMat.makeTranslation(0, 7.35, 0);
      itemMat.multiplyMatrices(centerFrame, localMat);
      darkMetalGeos.push(_tm(signBackingGeo, itemMat));

      // Textured highway sign faces on BOTH Front (-X) and Back (+X), completely clear of the arch beam
      const signTex = _createHighwaySignTexture(gSpec.title, gSpec.sub, gSpec.speed);
      const signMat = new THREE.MeshLambertMaterial({ map: signTex, color: 0xc8d0d8 });

      // Front sign face (facing oncoming traffic: -X local normal at x = -0.32m)
      const frontSignMesh = new THREE.Mesh(signFaceGeo, signMat);
      frontSignMesh.castShadow = true;
      frontSignMesh.receiveShadow = true;
      const rotFront = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
      localMat.makeTranslation(-0.32, 7.35, 0).multiply(rotFront);
      itemMat.multiplyMatrices(centerFrame, localMat);
      frontSignMesh.applyMatrix4(itemMat);
      this.scene.add(frontSignMesh);

      // Back sign face (facing rear camera view: +X local normal at x = +0.32m)
      const backSignMesh = new THREE.Mesh(signFaceGeo, signMat);
      backSignMesh.castShadow = true;
      backSignMesh.receiveShadow = true;
      const rotBack = new THREE.Matrix4().makeRotationY(Math.PI / 2);
      localMat.makeTranslation(0.32, 7.35, 0).multiply(rotBack);
      itemMat.multiplyMatrices(centerFrame, localMat);
      backSignMesh.applyMatrix4(itemMat);
      this.scene.add(backSignMesh);
    }

    // 5e. Roadside Diamond Curve Warning & Speed Signs (every 55m on outer edges, muted & shaded)
    const numSigns = Math.floor(road.totalLength / 55.0);
    const signPostGeo = _cyl(0.055, 0.055, 2.7, 6);
    const diamondBackGeo = _bbox(0.07, 0.96, 0.96);
    const diamondFaceGeo = _bbox(0.05, 0.82, 0.82);
    const roundBackGeo = _cyl(0.54, 0.54, 0.06, 14);
    const roundRimGeo = _cyl(0.50, 0.50, 0.05, 14);
    const roundCenterGeo = _cyl(0.36, 0.36, 0.05, 14);

    for (let i = 0; i < numSigns; i++) {
      const s = (i + 0.5) * 55.0;
      const side = i % 2 === 0 ? 1 : -1;
      const { basisMat: sFrame } = getRoadFrame(s, side * (halfW + 0.95), 0);

      // Sign post
      localMat.makeTranslation(0, 1.35, 0);
      itemMat.multiplyMatrices(sFrame, localMat);
      steelGeos.push(_tm(signPostGeo, itemMat));

      if (i % 2 === 0) {
        // Dark metal backing + muted amber diamond warning face
        localMat.makeRotationX(Math.PI / 4);
        localMat.setPosition(0.02, 2.7, 0);
        itemMat.multiplyMatrices(sFrame, localMat);
        darkMetalGeos.push(_tm(diamondBackGeo, itemMat));

        localMat.makeRotationX(Math.PI / 4);
        localMat.setPosition(-0.02, 2.7, 0);
        itemMat.multiplyMatrices(sFrame, localMat);
        signBoardYellowGeos.push(_tm(diamondFaceGeo, itemMat));
      } else {
        // Dark metal backing + muted crimson rim + muted slate-white speed face
        localMat.makeRotationZ(Math.PI / 2);
        localMat.setPosition(0.03, 2.7, 0);
        itemMat.multiplyMatrices(sFrame, localMat);
        darkMetalGeos.push(_tm(roundBackGeo, itemMat));

        localMat.makeRotationZ(Math.PI / 2);
        localMat.setPosition(-0.01, 2.7, 0);
        itemMat.multiplyMatrices(sFrame, localMat);
        signBoardRedGeos.push(_tm(roundRimGeo, itemMat));

        localMat.makeRotationZ(Math.PI / 2);
        localMat.setPosition(-0.025, 2.7, 0);
        itemMat.multiplyMatrices(sFrame, localMat);
        reflectorWhiteGeos.push(_tm(roundCenterGeo, itemMat));
      }
    }

    // Merge and add static infrastructure batches (minimal draw calls, full shadow casting & receiving)
    const addInfraBatch = (geos, mat, castShadow = true, receiveShadow = true) => {
      if (!geos.length) return;
      const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      this.scene.add(mesh);
    };

    addInfraBatch(steelGeos, steelMat, true, true);
    addInfraBatch(darkMetalGeos, new THREE.MeshLambertMaterial({ color: 0x2a2d35 }), true, true);
    addInfraBatch(pierGeos, concreteMat, true, true);
    addInfraBatch(reflectorRedGeos, new THREE.MeshLambertMaterial({ color: 0x8a322c }), false, true);
    addInfraBatch(reflectorWhiteGeos, new THREE.MeshLambertMaterial({ color: 0x8e95a2 }), false, true);
    addInfraBatch(lampBulbGeos, new THREE.MeshBasicMaterial({ color: 0xd8cba8 }), false, false);
    addInfraBatch(signBoardYellowGeos, new THREE.MeshLambertMaterial({ color: 0x8c7024 }), true, true);
    addInfraBatch(signBoardRedGeos, new THREE.MeshLambertMaterial({ color: 0x7d2c28 }), true, true);
  }

  /**
   * Syncs the 3D car meshes with current physical states
   */
  updateCars(vehicles, road, params, dt) {
    // Wait until external 3D vehicle models are loaded so old procedural car topologies never appear
    if (!this.modelTemplates) {
      return;
    }

    const activeIds = new Set();
    const nowSec = performance.now() * 0.001;
    const blinkState = (performance.now() % 500) < 250;

    // Reusable vectors/matrix to avoid per-frame GC allocations and micro-stutters
    const forward = this._tmpForward || (this._tmpForward = new THREE.Vector3());
    const upRef = this._tmpUpRef || (this._tmpUpRef = new THREE.Vector3(0, 1, 0));
    const right = this._tmpRight || (this._tmpRight = new THREE.Vector3());
    const up = this._tmpUp || (this._tmpUp = new THREE.Vector3());
    const steeredForward = this._tmpSteeredF || (this._tmpSteeredF = new THREE.Vector3());
    const steeredRight = this._tmpSteeredR || (this._tmpSteeredR = new THREE.Vector3());
    const matrix = this._tmpMatrix || (this._tmpMatrix = new THREE.Matrix4());

    for (const car of vehicles) {
      activeIds.add(car.id);
      let carObj = this.carMeshes.get(car.id);

      if (!carObj) {
        carObj = this._buildExternalVehicleMesh(car);
        this.scene.add(carObj);
        this.carMeshes.set(car.id, carObj);
      }

      // Update position/rotation with lane offset
      const pt = getPointAtS(road, car.s);
      const laneWidth = 4.5;
      const visualLane = car.visualLane !== undefined ? car.visualLane : car.lane;
      const latNoise = car.lateralNoise !== undefined ? car.lateralNoise : 0;

      // Dynamic slow-weaving to represent micro-steering adjustments
      const weaveSpeed = car.weaveSpeed !== undefined ? car.weaveSpeed : 0.8;
      const weavePhase = car.weavePhase !== undefined ? car.weavePhase : 0;
      const weave = Math.sin(nowSec * weaveSpeed + weavePhase) * 0.35;

      const offset = (visualLane - 2) * laneWidth + latNoise + weave;

      const txW = pt.tx;
      const tzW = pt.ty;
      const latX = -tzW;
      const latZ = txW;
      const latLen = Math.sqrt(latX * latX + latZ * latZ) || 1;

      let heightOffset = 0.90;
      if (!this.modelTemplates && (car.type === 'truck' || car.type === 'bus')) {
        heightOffset = 0.95;
      }

      carObj.position.set(
        pt.x + (latX / latLen) * offset,
        pt.z + heightOffset,
        pt.y + (latZ / latLen) * offset
      );

      // Orient the vehicle to align with the 3D road surface (tangent & normal)
      forward.set(pt.tx, pt.tz, pt.ty).normalize();
      right.crossVectors(forward, upRef).normalize();
      up.crossVectors(right, forward).normalize();

      const lateralDiff = car.lane - visualLane;
      const v_lat = lateralDiff * 2.5 * laneWidth;
      const steeringAngle = Math.max(-0.25, Math.min(0.25, Math.atan2(v_lat, Math.max(1.0, car.v))));

      steeredForward.copy(forward).applyAxisAngle(up, -steeringAngle);
      steeredRight.crossVectors(steeredForward, up).normalize();

      matrix.makeBasis(steeredForward, up, steeredRight);
      carObj.quaternion.setFromRotationMatrix(matrix);

      // Tail light brake state (show bright red brake pads only when braking)
      if (carObj.userData.brakeMesh) {
        carObj.userData.brakeMesh.visible = Boolean(car.braking);
      }

      // Blinkers (flashing turn signals) when changing lanes
      const isChanging = Math.abs(car.lane - car.visualLane) > 0.05;
      const isLeft = car.lane < car.visualLane;
      const isRight = car.lane > car.visualLane;

      if (carObj.userData.leftBlinkers) {
        for (const b of carObj.userData.leftBlinkers) {
          b.visible = isChanging && isLeft && blinkState;
        }
      }
      if (carObj.userData.rightBlinkers) {
        for (const b of carObj.userData.rightBlinkers) {
          b.visible = isChanging && isRight && blinkState;
        }
      }
    }

    // Clean up old cars if count reduced
    for (const [id, mesh] of this.carMeshes.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh);
        this.carMeshes.delete(id);
      }
    }

    // Update tarmac congestion heatmap (red = congestion, green = flowing)
    this._updateRoadHeatmap(vehicles, road, params, dt);

    // Camera preset tracking update
    this._updateTracking(vehicles, dt);
  }

  /**
   * Updates vertex colors along the road tarmac based on local traffic speed:
   * Red = congested / stopped, Amber = slowing transition, Green = free-flowing.
   */
  _updateRoadHeatmap(vehicles, road, params, dt) {
    if (!this.roadGeometry || !this.heatmapSmooth) return;

    const B = this.heatmapBins;
    const totalLen = road.totalLength;
    const speedSum = this._hmSpeedSum || (this._hmSpeedSum = new Float32Array(B));
    const minSpeed = this._hmMinSpeed || (this._hmMinSpeed = new Float32Array(B));
    const counts = this._hmCounts || (this._hmCounts = new Uint16Array(B));
    const floatCounts = this._hmFloatCounts || (this._hmFloatCounts = new Float32Array(B));
    const blurBufA = this._hmBlurA || (this._hmBlurA = new Float32Array(B));
    const blurBufB = this._hmBlurB || (this._hmBlurB = new Float32Array(B));
    const rawScore = this._hmRawScore || (this._hmRawScore = new Float32Array(B));

    speedSum.fill(0);
    minSpeed.fill(Infinity);
    counts.fill(0);
    floatCounts.fill(0);

    for (const car of vehicles) {
      const pos = ((car.s / totalLen) * B + B) % B;
      let b = Math.floor(pos);
      if (b < 0) b = 0;
      else if (b >= B) b = B - 1;
      speedSum[b] += car.v;
      if (car.v < minSpeed[b]) minSpeed[b] = car.v;
      counts[b]++;

      // Continuous linear splatting across neighboring bins so car movement never causes step jumps
      const b1 = (b + 1) % B;
      const frac = pos - Math.floor(pos);
      floatCounts[b] += 1.0 - frac;
      floatCounts[b1] += frac;
    }

    const refSpeed = (params?.v0 || 28) * 0.62;
    for (let b = 0; b < B; b++) {
      if (counts[b] === 0) {
        rawScore[b] = 1.0; // empty road = flowing green
      } else {
        const avgV = speedSum[b] / counts[b];
        // Blend average speed and slowest lane speed so congestion in any lane registers clearly
        const effectiveV = avgV * 0.55 + minSpeed[b] * 0.45;
        rawScore[b] = Math.max(0.0, Math.min(1.0, effectiveV / refSpeed));
      }
      blurBufA[b] = floatCounts[b];
    }

    // Multi-pass circular Gaussian smoothing for the population graph (6 passes -> wide, silky wave profile)
    for (let pass = 0; pass < 6; pass++) {
      const src = pass % 2 === 0 ? blurBufA : blurBufB;
      const dst = pass % 2 === 0 ? blurBufB : blurBufA;
      for (let b = 0; b < B; b++) {
        const bm2 = (b - 2 + B) % B;
        const bm1 = (b - 1 + B) % B;
        const bp1 = (b + 1) % B;
        const bp2 = (b + 2 + B) % B;
        dst[b] =
          src[bm2] * 0.08 +
          src[bm1] * 0.24 +
          src[b]   * 0.36 +
          src[bp1] * 0.24 +
          src[bp2] * 0.08;
      }
    }

    // Spatial 5-tap circular smoothing + temporal smoothing for organic wave motion
    const alpha = Math.min(1.0, (dt || 0.016) * 6.0);
    const alphaGraph = Math.min(1.0, (dt || 0.016) * 3.0);
    for (let b = 0; b < B; b++) {
      const bm2 = (b - 2 + B) % B;
      const bm1 = (b - 1 + B) % B;
      const bp1 = (b + 1) % B;
      const bp2 = (b + 2) % B;
      const spatial =
        rawScore[bm2] * 0.12 +
        rawScore[bm1] * 0.23 +
        rawScore[b] * 0.30 +
        rawScore[bp1] * 0.23 +
        rawScore[bp2] * 0.12;
      this.heatmapSmooth[b] += (spatial - this.heatmapSmooth[b]) * alpha;

      if (this.densitySmooth) {
        this.densitySmooth[b] += (blurBufA[b] - this.densitySmooth[b]) * alphaGraph;
      }
    }

    const colorAttr = this.roadGeometry.attributes.color;
    const arr = colorAttr.array;
    const steps = this.roadSteps;
    const tmpCol = this._hmColor || (this._hmColor = new THREE.Color());
    const topCol = this._hmTopColor || (this._hmTopColor = new THREE.Color());
    const botCol = this._hmBotColor || (this._hmBotColor = new THREE.Color());

    const rPosAttr = this.densityRibbonGeo ? this.densityRibbonGeo.attributes.position : null;
    const rColAttr = this.densityRibbonGeo ? this.densityRibbonGeo.attributes.color : null;
    const cPosAttr = this.densityCrestGeo ? this.densityCrestGeo.attributes.position : null;
    const cColAttr = this.densityCrestGeo ? this.densityCrestGeo.attributes.color : null;
    const rPos = rPosAttr ? rPosAttr.array : null;
    const rCol = rColAttr ? rColAttr.array : null;
    const cPos = cPosAttr ? cPosAttr.array : null;
    const cCol = cColAttr ? cColAttr.array : null;
    const basePos = this.graphBasePos;

    for (let i = 0; i <= steps; i++) {
      const posFrac = (i / steps) * B;
      const b0 = Math.floor(posFrac) % B;
      const b1 = (b0 + 1) % B;
      const t = posFrac - Math.floor(posFrac);
      const val = this.heatmapSmooth[b0] * (1 - t) + this.heatmapSmooth[b1] * t;

      // Dark asphalt base subtly tinted from deep crimson (0.00) to muted emerald (0.36)
      const hue = val * 0.36;
      const sat = 0.58 - val * 0.14;
      const lig = 0.075 - val * 0.025;
      tmpCol.setHSL(hue, sat, lig);

      const idx = i * 6;
      arr[idx]     = tmpCol.r;
      arr[idx + 1] = tmpCol.g;
      arr[idx + 2] = tmpCol.b;
      arr[idx + 3] = tmpCol.r;
      arr[idx + 4] = tmpCol.g;
      arr[idx + 5] = tmpCol.b;

      // Update 3D # of cars graph over the road (height = # of cars, colored by road heatmap, Catmull-Rom spline smoothed)
      if (this.graphEnabled && rPos && rCol && cPos && cCol && basePos && this.densitySmooth) {
        const bm1 = (b0 - 1 + B) % B;
        const bp2 = (b1 + 1) % B;
        const p0 = this.densitySmooth[bm1];
        const p1 = this.densitySmooth[b0];
        const p2 = this.densitySmooth[b1];
        const p3 = this.densitySmooth[bp2];
        const t2 = t * t;
        const t3 = t2 * t;
        const carCount = Math.max(
          0.0,
          0.5 *
            (2.0 * p1 +
              (-p0 + p2) * t +
              (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
              (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
        );
        const excess = Math.max(0.0, carCount - 1.1);
        const graphH = Math.max(0.8, Math.min(48.0, carCount * 4.5 + Math.pow(excess, 1.45) * 4.2));
        const baseY = basePos[i * 3 + 1];

        rPos[idx + 1] = baseY;
        rPos[idx + 4] = baseY + graphH;

        cPos[idx + 1] = baseY + Math.max(0.0, graphH - 0.28);
        cPos[idx + 4] = baseY + graphH + 0.28;

        botCol.setHSL(hue, 0.78, 0.22);
        topCol.setHSL(hue, 0.95, 0.56);

        rCol[idx]     = botCol.r;
        rCol[idx + 1] = botCol.g;
        rCol[idx + 2] = botCol.b;
        rCol[idx + 3] = topCol.r;
        rCol[idx + 4] = topCol.g;
        rCol[idx + 5] = topCol.b;

        cCol[idx]     = topCol.r;
        cCol[idx + 1] = topCol.g;
        cCol[idx + 2] = topCol.b;
        cCol[idx + 3] = topCol.r;
        cCol[idx + 4] = topCol.g;
        cCol[idx + 5] = topCol.b;
      }
    }

    colorAttr.needsUpdate = true;
    if (this.graphEnabled && rPosAttr && rColAttr && cPosAttr && cColAttr) {
      rPosAttr.needsUpdate = true;
      rColAttr.needsUpdate = true;
      cPosAttr.needsUpdate = true;
      cColAttr.needsUpdate = true;
    }

    // Locate the primary Congestion Center (lowest smoothed speed bin) and Green Flow Center (highest smoothed speed bin)
    const frameDt = Math.min(0.1, dt || 0.016);
    const binLen = totalLen / B;

    // 1. Congestion Center (Red) with locality hysteresis so it never snaps abruptly between bins
    let minBin = 0;
    let bestJamMetric = Infinity;
    for (let b = 0; b < B; b++) {
      let metric = this.heatmapSmooth[b];
      if (this.jamCenterS !== undefined) {
        const binS = ((b + 0.5) / B) * totalLen;
        let ds = Math.abs(binS - this.jamCenterS);
        if (ds > totalLen / 2) ds = totalLen - ds;
        // Gentle locality bias keeps tracker locked onto the active wave unless another is much stronger
        metric += (ds / totalLen) * 0.18;
      }
      if (metric < bestJamMetric) {
        bestJamMetric = metric;
        minBin = b;
      }
    }
    const minVal = this.heatmapSmooth[minBin];

    // Measure contiguous congested bins around minBin (threshold < 0.52 = red/orange only, never green)
    const jamThreshold = 0.52;
    let spanBins = 0;
    let sumWeightedS = 0;
    let sumWeight = 0;
    const centerRefS = ((minBin + 0.5) / B) * totalLen;

    for (let offset = -Math.floor(B / 3); offset <= Math.floor(B / 3); offset++) {
      const b = (minBin + offset + B) % B;
      const val = this.heatmapSmooth[b];
      if (val < jamThreshold) {
        spanBins++;
        const w = (jamThreshold - val) * (jamThreshold - val) + 0.01;
        sumWeightedS += (centerRefS + offset * binLen) * w;
        sumWeight += w;
      }
    }

    const targetJamS =
      sumWeight > 0
        ? ((sumWeightedS / sumWeight) % totalLen + totalLen) % totalLen
        : centerRefS;

    if (this.jamCenterS === undefined || !this.jamStats?.active) {
      this.jamCenterS = targetJamS;
      this._smoothBeaconS = targetJamS;
    } else {
      let diff = targetJamS - this.jamCenterS;
      if (diff > totalLen / 2) diff -= totalLen;
      if (diff < -totalLen / 2) diff += totalLen;
      // Rate-limit and smoothly damp circular road coordinate s
      const maxStep = 22.0 * frameDt;
      const dampedStep = Math.max(-maxStep, Math.min(maxStep, diff * Math.min(1.0, frameDt * 1.8)));
      this.jamCenterS = (this.jamCenterS + dampedStep + totalLen) % totalLen;
    }

    // Gather live vehicle stats inside the congestion wave (strictly slow vehicles < 9.0 m/s)
    const jamWindowRadius = Math.max(45.0, spanBins * binLen * 0.6);
    let queuedCars = 0;
    let speedAccum = 0;
    let slowestInJam = Infinity;

    for (const car of vehicles) {
      let ds = Math.abs(car.s - this.jamCenterS);
      if (ds > totalLen / 2) ds = totalLen - ds;
      if (ds <= jamWindowRadius && car.v < 9.0) {
        queuedCars++;
        speedAccum += car.v;
        if (car.v < slowestInJam) slowestInJam = car.v;
      }
    }

    // Require genuine red/orange congestion (minVal < 0.50 and slow queued cars) so circle never wanders on green road
    const isJamActive = queuedCars >= 3 && minVal < 0.50 && slowestInJam < 6.5;
    this.jamStats = {
      active: isJamActive,
      queuedCars,
      coreSpeed: isFinite(slowestInJam) ? slowestInJam : 0,
      avgJamSpeed: queuedCars > 0 ? speedAccum / queuedCars : 0,
      waveLength: Math.round(Math.max(spanBins * binLen, (queuedCars / 5) * 6.5)),
      minVal,
    };

    // Smoothly position the 3D Congestion Center beacon and conform its glowing circle to the curved tarmac under the tires
    const updateBeaconTransform = (marker, sCoord, isActive, worldPosKey, phaseOffset) => {
      if (!marker) return;
      marker.visible = isActive;
      const { discMesh, discGeo, baseOffsets } = marker.userData;
      if (discMesh) discMesh.visible = isActive;
      if (!isActive) return;

      if (this._smoothBeaconS === undefined) {
        this._smoothBeaconS = sCoord;
      } else {
        let ds = sCoord - this._smoothBeaconS;
        if (ds > totalLen * 0.5) ds -= totalLen;
        if (ds < -totalLen * 0.5) ds += totalLen;
        this._smoothBeaconS = (this._smoothBeaconS + ds * Math.min(1.0, frameDt * 5.0) + totalLen) % totalLen;
      }

      const centerPt = getPointAtS(road, this._smoothBeaconS);
      const targetPos = new THREE.Vector3(centerPt.x, centerPt.z, centerPt.y);
      if (!this[worldPosKey]) {
        this[worldPosKey] = targetPos.clone();
      } else {
        this[worldPosKey].copy(targetPos);
      }
      marker.position.copy(this[worldPosKey]);

      if (discGeo && baseOffsets) {
        const tNow = performance.now() * 0.001 + phaseOffset;
        const pulse = 1.0 + Math.sin(tNow * 3.2) * 0.05;
        const posAttr = discGeo.attributes.position;
        const colAttr = discGeo.attributes.color;
        const arr = posAttr.array;
        const cArr = colAttr ? colAttr.array : null;
        const count = posAttr.count;

        for (let i = 0; i < count; i++) {
          const dForward = baseOffsets[i * 2] * pulse;
          const dLat = baseOffsets[i * 2 + 1] * pulse;
          const vS = (this._smoothBeaconS + dForward + totalLen) % totalLen;
          const pt = getPointAtS(road, vS);
          const px = -pt.ty;
          const pz = pt.tx;
          const plen = Math.hypot(px, pz) || 1;
          const nx = px / plen;
          const nz = pz / plen;

          const idx = i * 3;
          arr[idx]     = pt.x + nx * dLat;
          arr[idx + 1] = pt.z + 0.032; // 3.2cm above asphalt, right beneath car tires (0.05m)
          arr[idx + 2] = pt.y + nz * dLat;

          if (cArr) {
            const posFrac = (vS / totalLen) * B;
            const b0 = Math.floor(posFrac) % B;
            const b1 = (b0 + 1) % B;
            const t = posFrac - Math.floor(posFrac);
            const vVal = this.heatmapSmooth[b0] * (1 - t) + this.heatmapSmooth[b1] * t;
            // Match road heatmap hue (0.00 crimson -> 0.12 amber -> 0.36 emerald)
            tmpCol.setHSL(vVal * 0.36, 0.94 - vVal * 0.12, 0.52 - vVal * 0.05);
            cArr[idx]     = tmpCol.r;
            cArr[idx + 1] = tmpCol.g;
            cArr[idx + 2] = tmpCol.b;
          }
        }
        posAttr.needsUpdate = true;
        if (colAttr) colAttr.needsUpdate = true;
      }
    };

    updateBeaconTransform(this.jamMarker, this.jamCenterS, isJamActive, '_jamWorldPos', 0.0);

    // Update the 3D Hexagonal Pipe Congestion Tunnel uniforms (length = waveLength, pipes thickest at circle)
    if (this.tunnelMesh) {
      this.tunnelMesh.visible = Boolean(this.hexagonsEnabled) && isJamActive;
    }
    if (this.tunnelUniforms && this.hexagonsEnabled) {
      const targetLen = isJamActive ? Math.max(40, this.jamStats.waveLength) : 0;
      if (this._smoothTunnelLen === undefined) {
        this._smoothTunnelLen = targetLen;
      } else {
        this._smoothTunnelLen += (targetLen - this._smoothTunnelLen) * Math.min(1.0, frameDt * 3.5);
      }

      const centerS = this._smoothBeaconS !== undefined ? this._smoothBeaconS : this.jamCenterS;
      const severityBoost = Math.min(1.0, Math.max(0.85, (0.82 - minVal) / 0.45));

      this.tunnelUniforms.uCenterS.value = centerS;
      this.tunnelUniforms.uHalfWaveLen.value = this._smoothTunnelLen * 0.5;
      this.tunnelUniforms.uTotalLen.value = totalLen;
      this.tunnelUniforms.uSeverity.value = severityBoost;
    }
  }

  /**
   * Toggles the 3D Hexagonal Pipe Congestion Tunnel ON or OFF (default OFF, toggled with keystroke H)
   */
  setHexagonsEnabled(enabled) {
    this.hexagonsEnabled = Boolean(enabled);
    if (this.tunnelMesh) {
      this.tunnelMesh.visible = this.hexagonsEnabled && Boolean(this.jamStats?.active);
    }
    return this.hexagonsEnabled;
  }

  /**
   * Toggles the 3D Vehicle-Count Population Graph ON or OFF (default OFF, toggled with keystroke G)
   */
  setGraphEnabled(enabled) {
    this.graphEnabled = Boolean(enabled);
    if (this.densityRibbonMesh) this.densityRibbonMesh.visible = this.graphEnabled;
    if (this.densityCrestMesh) this.densityCrestMesh.visible = this.graphEnabled;
    if (this.densityBaseLine) this.densityBaseLine.visible = this.graphEnabled;
    return this.graphEnabled;
  }

  /**
   * Builds a vehicle instance from the extracted external 3D car pack templates
   * using shared geometries and shared materials for maximum FPS (no base plate underglow).
   */
  _buildExternalVehicleMesh(car) {
    const group = new THREE.Group();
    const bucket = this.modelTemplates[car.type] || this.modelTemplates.car;
    // Use prime multiplicative hash to avoid modulo resonance with car.id % 15
    const hashIdx = ((car.id * 2654435761) >>> 0) % bucket.length;
    const tpl = bucket[hashIdx];

    // Preserve at least the category IDM length so traffic density stays in the critical phantom-jam regime
    car.length = Math.max(car.length, tpl.length);

    for (let pIdx = 0; pIdx < tpl.parts.length; pIdx++) {
      const part = tpl.parts[pIdx];
      const mesh = new THREE.Mesh(part.geometry, part.material);
      // Primary vehicle body (pIdx === 0) casts directional shadow; skip tiny trim sub-meshes to double shadow FPS
      mesh.castShadow = pIdx === 0;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }

    // Soft ambient-occlusion contact shadow directly under the car
    const contactShadow = new THREE.Mesh(tpl.shadowGeo, _CONTACT_SHADOW_MAT);
    contactShadow.matrixAutoUpdate = false;
    group.add(contactShadow);

    const brakeMesh = new THREE.Mesh(tpl.brakeGeo, _BRAKE_ON_MAT);
    brakeMesh.visible = false;
    brakeMesh.matrixAutoUpdate = false;
    group.add(brakeMesh);

    const leftBlinker = new THREE.Mesh(tpl.leftBlinkGeo, _BLINKER_MAT);
    const rightBlinker = new THREE.Mesh(tpl.rightBlinkGeo, _BLINKER_MAT);
    leftBlinker.visible = false;
    rightBlinker.visible = false;
    leftBlinker.matrixAutoUpdate = false;
    rightBlinker.matrixAutoUpdate = false;
    group.add(leftBlinker, rightBlinker);

    group.userData = {
      bodyMaterial: null,
      brakeMesh,
      leftBlinkers: [leftBlinker],
      rightBlinkers: [rightBlinker],
    };
    return group;
  }

  _getDesiredCameraState(dt = 0.016) {
    if (this.cameraMode === 'top') {
      return {
        pos: new THREE.Vector3(0, 310, 0.01),
        target: new THREE.Vector3(0, 0, 0),
      };
    }

    if (this.cameraMode === 'default') {
      this._defaultOrbitAngle = (this._defaultOrbitAngle ?? Math.atan2(100, -230)) + dt * 0.09;
      const radius = 285.0;
      return {
        pos: new THREE.Vector3(
          Math.cos(this._defaultOrbitAngle) * radius,
          105,
          Math.sin(this._defaultOrbitAngle) * radius
        ),
        target: new THREE.Vector3(0, 5, 0),
      };
    }

    // 'jam' mode: always target the Congestion Center
    let targetPos = null;
    if (this._jamWorldPos) {
      targetPos = this._jamWorldPos.clone();
    } else if (this.road && this.jamCenterS !== undefined) {
      const pt = getPointAtS(this.road, this.jamCenterS);
      targetPos = new THREE.Vector3(pt.x, pt.z, pt.y);
    } else if (this.road) {
      const pt = getPointAtS(this.road, 0);
      targetPos = new THREE.Vector3(pt.x, pt.z, pt.y);
    } else {
      targetPos = new THREE.Vector3(0, 0, 0);
    }

    const radial = new THREE.Vector3(targetPos.x, 0, targetPos.z);
    if (radial.lengthSq() < 1.0) radial.set(1, 0, 0);
    else radial.normalize();

    const offset = radial.multiplyScalar(82).setY(32);
    return {
      pos: targetPos.clone().add(offset),
      target: targetPos,
    };
  }

  _updateTracking(vehicles, dt) {
    const frameDt = dt !== undefined ? Math.min(dt, 0.1) : 0.016;
    const desired = this._getDesiredCameraState(frameDt);

    if (!this.trackingAnchor) {
      this.trackingAnchor = desired.target.clone();
      this.camera.position.copy(desired.pos);
      this.controls.target.copy(this.trackingAnchor);
      this.targetVelocity.set(0, 0, 0);
      this.cameraVelocity.set(0, 0, 0);
      return;
    }

    // If a camera preset switch is in progress, smoothly glide over 4.0 seconds (quintic ease-in-out)
    if (this._camTransition) {
      this._camTransition.elapsed += frameDt;
      const rawT = Math.min(1.0, this._camTransition.elapsed / this._camTransition.duration);
      // Quintic smootherstep: 6t^5 - 15t^4 + 10t^3 (zero velocity & acceleration at both ends)
      const ease = rawT * rawT * rawT * (rawT * (rawT * 6 - 15) + 10);

      this.camera.position.lerpVectors(this._camTransition.startPos, desired.pos, ease);
      this.trackingAnchor.lerpVectors(this._camTransition.startTarget, desired.target, ease);
      this.controls.target.copy(this.trackingAnchor);
      this.targetVelocity.set(0, 0, 0);
      this.cameraVelocity.set(0, 0, 0);

      if (rawT >= 1.0) {
        this._camTransition = null;
        this.controls.minPolarAngle = this.cameraMode === 'top' ? 0 : Math.PI / 3;
      }
      return;
    }

    if (this.cameraMode === 'jam') {
      // Smooth critically-damped spring tracking the Congestion Center
      const omegaTarget = 0.95;
      const omegaCam = 0.80;

      const deltaTarget = new THREE.Vector3().subVectors(desired.target, this.trackingAnchor);
      const accelTarget = deltaTarget
        .multiplyScalar(omegaTarget * omegaTarget)
        .addScaledVector(this.targetVelocity, -2 * omegaTarget);
      this.targetVelocity.addScaledVector(accelTarget, frameDt);
      this.trackingAnchor.addScaledVector(this.targetVelocity, frameDt);

      const deltaCam = new THREE.Vector3().subVectors(desired.pos, this.camera.position);
      const accelCam = deltaCam
        .multiplyScalar(omegaCam * omegaCam)
        .addScaledVector(this.cameraVelocity, -2 * omegaCam);
      this.cameraVelocity.addScaledVector(accelCam, frameDt);
      this.camera.position.addScaledVector(this.cameraVelocity, frameDt);

      this.controls.target.copy(this.trackingAnchor);
    } else if (this.cameraMode === 'default') {
      this.camera.position.lerp(desired.pos, Math.min(1.0, frameDt * 3.0));
      this.trackingAnchor.lerp(desired.target, Math.min(1.0, frameDt * 3.0));
      this.controls.target.copy(this.trackingAnchor);
    } else if (this.cameraMode === 'top') {
      this.camera.position.lerp(desired.pos, Math.min(1.0, frameDt * 3.0));
      this.trackingAnchor.lerp(desired.target, Math.min(1.0, frameDt * 3.0));
      this.controls.target.copy(this.trackingAnchor);
    }
  }

  setCameraPreset(mode, vehicles) {
    const prevMode = this.cameraMode;
    this.cameraMode = mode;
    this.controls.autoRotate = false; // handled smoothly by _updateTracking

    if (!this._camInitialized) {
      this._camInitialized = true;
      this.controls.minPolarAngle = mode === 'top' ? 0 : Math.PI / 3;
      const initial = this._getDesiredCameraState(0);
      this.trackingAnchor = initial.target.clone();
      this.camera.position.copy(initial.pos);
      this.controls.target.copy(this.trackingAnchor);
      this.targetVelocity.set(0, 0, 0);
      this.cameraVelocity.set(0, 0, 0);
      return;
    }

    // Unlock polar angle during transition so OrbitControls never snaps pitch
    this.controls.minPolarAngle = 0;

    if (mode === 'default' && prevMode !== 'default') {
      // Start default orbit angle from current camera azimuth for shortest, smoothest path
      this._defaultOrbitAngle = Math.atan2(this.camera.position.z, this.camera.position.x);
    }

    // Smooth 4.0-second cinematic transition from current camera pose to new preset
    this._camTransition = {
      elapsed: 0,
      duration: 4.0,
      startPos: this.camera.position.clone(),
      startTarget: this.controls.target.clone(),
    };
  }

  _buildCarMesh(carId = 0) {
    const group  = new THREE.Group();
    const variant = carId % 3;

    const bodyMat    = new THREE.MeshStandardMaterial({ color: 0x58b88e, roughness: 0.5,  metalness: 0.0 });
    const brakeMat   = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0x000000 });
    const chassisMat = new THREE.MeshStandardMaterial({ color: 0x111115, roughness: 0.85, metalness: 0.0 });
    const glassMat   = new THREE.MeshStandardMaterial({ color: 0x050510, roughness: 0.5,  metalness: 0.0, transparent: true, opacity: 0.6 });
    const wheelMat   = new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.85, metalness: 0.0 });
    const rimMat     = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6,  metalness: 0.0 });

    const cg = [
      _t(_bbox(4.7,0.18,2.3),    0,-0.45,0),
      _t(_bbox(0.18,0.22,2.28),  2.35,-0.3,0),
      _t(_bbox(0.18,0.22,2.28), -2.35,-0.3,0),
    ];
    if (variant === 0) cg.push(_t(_bbox(0.35,0.1,2.36),  -2.26,-0.02,0));
    if (variant === 1) { cg.push(_t(_bbox(0.1,0.4,0.1),-1.9,0.18,0.82)); cg.push(_t(_bbox(0.1,0.4,0.1),-1.9,0.18,-0.82)); }
    group.add(_mm(cg, chassisMat));

    const bg = [
      _t(_rbox(4.5,0.52,2.2,0.08),   0,-0.08,0),
      _t(_rbox(1.2,0.26,2.18,0.06),  1.65,-0.18,0),
      _t(_rbox(2.2,0.52,1.82,0.08), -0.2,0.4,0),
    ];
    if (variant === 1) bg.push(_t(_rbox(0.38,0.09,2.4,0.04), -1.9,0.42,0));
    group.add(_mm(bg, bodyMat));

    const wGeo = _bbox(0.78,0.5,1.76);
    group.add(_mm([
      _t(wGeo,  0.65,0.35,0, 0,0,-0.6),
      _t(wGeo, -1.05,0.35,0, 0,0, 0.6),
      _t(_bbox(1.6,0.35,1.84), -0.2,0.4,0),
    ], glassMat));

    const tGeo = _cyl(0.45,0.45,0.35,14);
    const rGeo = _cyl(0.22,0.22,0.37,10);
    const wPos = [[1.4,1.1],[1.4,-1.1],[-1.4,1.1],[-1.4,-1.1]];
    group.add(_mm(wPos.map(([x,z])=>_wgeo(tGeo,x,-0.45,z)), wheelMat));
    group.add(_mm(wPos.map(([x,z])=>_wgeo(rGeo,x,-0.45,z)), rimMat));

    const hlg = _bbox(0.12,0.18,0.38), drg = _bbox(0.08,0.04,0.36);
    group.add(_mm([
      _t(hlg,2.27,-0.12,0.72),_t(hlg,2.27,-0.12,-0.72),
      _t(drg,2.27,0.0,0.72),  _t(drg,2.27,0.0,-0.72),
    ], new THREE.MeshBasicMaterial({ color: 0xffffee })));

    group.add(_mm([_t(_bbox(0.12,0.16,0.36),-2.27,-0.1,0.72),_t(_bbox(0.12,0.16,0.36),-2.27,-0.1,-0.72)], brakeMat));

    const bkg = _bbox(0.3,0.3,0.3);
    const leftBlinker  = _mm([_t(bkg,2.26,0.05,-1.12),_t(bkg,-2.26,0.05,-1.12)], _BLINKER_MAT);
    const rightBlinker = _mm([_t(bkg,2.26,0.05, 1.12),_t(bkg,-2.26,0.05, 1.12)], _BLINKER_MAT);
    group.add(leftBlinker, rightBlinker);

    const beam = new THREE.Mesh(_cyl(1.8,0.3,15,16,1,true), _BEAM_MAT);
    beam.position.y = 7.5; beam.visible = false;
    group.add(beam);

    group.userData = { bodyMaterial:bodyMat, brakeMaterial:brakeMat,
      leftBlinkers:[leftBlinker], rightBlinkers:[rightBlinker], beam };
    return group;
  }

  _buildTruckMesh() {
    const group = new THREE.Group();

    const cabMat     = new THREE.MeshStandardMaterial({ color: 0xe05a5a, roughness: 0.5, metalness: 0.0 });
    const brakeMat   = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0x000000 });
    const chassisMat = new THREE.MeshStandardMaterial({ color: 0x1a1a20, roughness: 0.75, metalness: 0.0 });
    const trimMat    = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.65, metalness: 0.0 });
    const glassMat   = new THREE.MeshStandardMaterial({ color: 0x050510, roughness: 0.5,  metalness: 0.0, transparent: true, opacity: 0.6 });
    const wheelMat   = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.85, metalness: 0.0 });
    const rimMat     = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.6,  metalness: 0.0 });

    const cg = [_t(_bbox(8.2,0.28,2.4),0,-0.45,0)];
    for (const [mx,mz] of [[-1.7,1.3],[-1.7,-1.3],[-3.1,1.3],[-3.1,-1.3]])
      cg.push(_t(_bbox(0.06,0.5,0.8),mx,-0.22,mz));
    group.add(_mm(cg, chassisMat));

    const bg = [
      _t(_rbox(2.4,2.0,2.3,0.1),  2.7, 0.55,0),
      _t(_rbox(5.6,2.4,2.4,0.1), -1.0, 0.85,0),
      _t(_bbox(1.5,0.8,2.3), 2.0,1.65,0, 0,0,-0.35),
      _t(_bbox(0.05,1.8,0.9),-3.82,0.85, 0.55),
      _t(_bbox(0.05,1.8,0.9),-3.82,0.85,-0.55),
    ];
    group.add(_mm(bg, cabMat));

    const tg = [
      _t(_bbox(0.1,0.8,1.8),   3.91, 0.1, 0),
      _t(_bbox(0.3,0.3,2.5),   3.9, -0.3, 0),
      _t(_bbox(0.9,0.08,0.18), 2.7, -0.55, 1.26),
      _t(_bbox(0.9,0.08,0.18), 2.7, -0.55,-1.26),
      _t(_cyl(0.08,0.08,2.8,8), 1.4,1.3, 0.9, 0,0,Math.PI/2),
      _t(_cyl(0.08,0.08,2.8,8), 1.4,1.3,-0.9, 0,0,Math.PI/2),
      _t(_cyl(0.42,0.42,1.8,8), 0.6,-0.42, 1.25, 0,0,Math.PI/2),
      _t(_cyl(0.42,0.42,1.8,8), 0.6,-0.42,-1.25, 0,0,Math.PI/2),
    ];
    group.add(_mm(tg, trimMat));

    group.add(_mm([
      _t(_bbox(0.5,0.8,2.12), 3.5,1.15,0, 0,0,-0.4),
      _t(_bbox(1.2,0.5,2.34), 2.8,1.1,0),
    ], glassMat));

    const runLightGeos = [-0.72,-0.36,0,0.36,0.72].map(z=>_t(_bbox(0.08,0.08,0.08),3.82,1.55,z));
    group.add(_mm(runLightGeos, new THREE.MeshBasicMaterial({ color: 0xffcc44 })));

    const tGeo = _cyl(0.55,0.55,0.4,14);
    const rGeo = _cyl(0.28,0.28,0.42,10);
    const wPos = [[2.8,1.2],[2.8,-1.2],[-1.0,1.2],[-1.0,-1.2],[-2.4,1.2],[-2.4,-1.2]];
    group.add(_mm(wPos.map(([x,z])=>_wgeo(tGeo,x,-0.4,z)), wheelMat));
    group.add(_mm(wPos.map(([x,z])=>_wgeo(rGeo,x,-0.4,z)), rimMat));

    group.add(_mm([_t(_bbox(0.12,0.25,0.42),3.9,-0.1,0.82),_t(_bbox(0.12,0.25,0.42),3.9,-0.1,-0.82)],
      new THREE.MeshBasicMaterial({ color: 0xffffff })));

    group.add(_mm([_t(_bbox(0.12,0.4,0.28),-3.87,-0.1,0.82),_t(_bbox(0.12,0.4,0.28),-3.87,-0.1,-0.82)], brakeMat));

    const bkg = _bbox(0.4,0.4,0.4);
    const leftBlinker  = _mm([_t(bkg,3.9,0.4,-1.24),_t(bkg,-3.87,0.4,-1.24)], _BLINKER_MAT);
    const rightBlinker = _mm([_t(bkg,3.9,0.4, 1.24),_t(bkg,-3.87,0.4, 1.24)], _BLINKER_MAT);
    group.add(leftBlinker, rightBlinker);

    const beam = new THREE.Mesh(_cyl(2.5,0.5,20,16,1,true), _BEAM_MAT);
    beam.position.y = 10; beam.visible = false;
    group.add(beam);

    group.userData = { bodyMaterial:cabMat, brakeMaterial:brakeMat,
      leftBlinkers:[leftBlinker], rightBlinkers:[rightBlinker], beam };
    return group;
  }

  _buildBusMesh() {
    const group = new THREE.Group();

    const bodyMat    = new THREE.MeshStandardMaterial({ color: 0x2288ee, roughness: 0.5,  metalness: 0.0 });
    const brakeMat   = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0x000000 });
    const chassisMat = new THREE.MeshStandardMaterial({ color: 0x15151c, roughness: 0.85, metalness: 0.0 });
    const glassMat   = new THREE.MeshStandardMaterial({ color: 0x050510, roughness: 0.5,  metalness: 0.0, transparent: true, opacity: 0.6 });
    const wheelMat   = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.85, metalness: 0.0 });
    const rimMat     = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6,  metalness: 0.0 });

    group.add(_mm([
      _t(_bbox(10.2,0.28,2.5),  0,-0.45,0),
      _t(_bbox(9.8,0.28,0.06),  0,-0.2, 1.25),
      _t(_bbox(9.8,0.28,0.06),  0,-0.2,-1.25),
      _t(_rbox(3.5,0.35,1.8,0.06), -0.5,2.15,0),
      _t(_rbox(1.2,0.28,0.9,0.05),  2.5,2.12,0),
      _t(_bbox(0.06,0.22,1.6),  5.02,2.05,0),
      _t(_bbox(1.2,1.8,0.05),   3.8,0.55,1.22),
    ], chassisMat));

    const bg = [_t(_rbox(10.0,2.4,2.4,0.12), 0,0.8,0)];
    bg.push(_t(_bbox(0.8,0.4,0.08),-4.6,1.8, 1.21, 0, 0.2,0));
    bg.push(_t(_bbox(0.8,0.4,0.08),-4.6,1.8,-1.21, 0,-0.2,0));
    group.add(_mm(bg, bodyMat));

    const winGeo = _bbox(1.6,0.7,0.05);
    const glassGeos = [_t(_bbox(0.6,1.4,2.38), 4.8,1.3,0, 0,0,-0.4)];
    for (let i=0;i<4;i++) { const x=-3.2+i*2.2; glassGeos.push(_t(winGeo,x,1.1,1.21),_t(winGeo,x,1.1,-1.21)); }
    group.add(_mm(glassGeos, glassMat));

    const tGeo = _cyl(0.55,0.55,0.4,14);
    const rGeo = _cyl(0.28,0.28,0.42,10);
    const wPos = [[3.5,1.25],[3.5,-1.25],[-2.5,1.25],[-2.5,-1.25],[-3.8,1.25],[-3.8,-1.25]];
    group.add(_mm(wPos.map(([x,z])=>_wgeo(tGeo,x,-0.4,z)), wheelMat));
    group.add(_mm(wPos.map(([x,z])=>_wgeo(rGeo,x,-0.4,z)), rimMat));

    group.add(_mm([_t(_bbox(0.12,0.22,0.38),5.02,0.22,0.82),_t(_bbox(0.12,0.22,0.38),5.02,0.22,-0.82)],
      new THREE.MeshBasicMaterial({ color: 0xffffff })));

    group.add(_mm([
      _t(_bbox(0.12,0.32,0.38),-5.02,0.22,0.82),
      _t(_bbox(0.12,0.32,0.38),-5.02,0.22,-0.82),
      _t(_bbox(0.06,0.12,2.0), -5.02,0.6,0),
    ], brakeMat));

    const bkg = _bbox(0.4,0.4,0.4);
    const leftBlinker  = _mm([_t(bkg,5.0,0.8,-1.24),_t(bkg,-5.0,0.8,-1.24)], _BLINKER_MAT);
    const rightBlinker = _mm([_t(bkg,5.0,0.8, 1.24),_t(bkg,-5.0,0.8, 1.24)], _BLINKER_MAT);
    group.add(leftBlinker, rightBlinker);

    const beam = new THREE.Mesh(_cyl(2.5,0.5,20,16,1,true), _BEAM_MAT);
    beam.position.y = 10; beam.visible = false;
    group.add(beam);

    group.userData = { bodyMaterial:bodyMat, brakeMaterial:brakeMat,
      leftBlinkers:[leftBlinker], rightBlinkers:[rightBlinker], beam };
    return group;
  }

  _buildMinivanMesh() {
    const group = new THREE.Group();

    const bodyMat    = new THREE.MeshStandardMaterial({ color: 0xffaa00, roughness: 0.5,  metalness: 0.0 });
    const brakeMat   = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0x000000 });
    const chassisMat = new THREE.MeshStandardMaterial({ color: 0x111115, roughness: 0.85, metalness: 0.0 });
    const glassMat   = new THREE.MeshStandardMaterial({ color: 0x050510, roughness: 0.5,  metalness: 0.0, transparent: true, opacity: 0.6 });
    const railMat    = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.7,  metalness: 0.0 });
    const wheelMat   = new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.85, metalness: 0.0 });
    const rimMat     = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.6,  metalness: 0.0 });

    group.add(_mm([
      _t(_bbox(5.2,0.18,2.3),  0,-0.45,0),
      _t(_bbox(1.4,0.05,0.04), -0.6,0.32,1.12),
    ], chassisMat));

    group.add(_mm([
      _t(_rbox(5.0,1.05,2.2,0.09),   0, 0.15,0),
      _t(_rbox(3.6,0.3, 2.1,0.07),  -0.4,0.82,0),
      _t(_rbox(3.5,0.62,2.0,0.08),  -0.5,0.97,0),
    ], bodyMat));

    group.add(_mm([
      _t(_bbox(0.5,0.7,1.96),  1.5,0.8,0, 0,0,-0.55),
      _t(_bbox(3.2,0.45,2.04),-0.5,0.95,0),
    ], glassMat));

    group.add(_mm([
      _t(_bbox(2.8,0.055,0.055),-0.5,1.3, 0.82),
      _t(_bbox(2.8,0.055,0.055),-0.5,1.3,-0.82),
      _t(_bbox(0.055,0.055,1.64),-1.5,1.3,0),
      _t(_bbox(0.055,0.055,1.64),-0.5,1.3,0),
      _t(_bbox(0.055,0.055,1.64), 0.5,1.3,0),
    ], railMat));

    const tGeo = _cyl(0.48,0.48,0.35,14);
    const rGeo = _cyl(0.24,0.24,0.37,10);
    const wPos = [[1.5,1.1],[1.5,-1.1],[-1.6,1.1],[-1.6,-1.1]];
    group.add(_mm(wPos.map(([x,z])=>_wgeo(tGeo,x,-0.42,z)), wheelMat));
    group.add(_mm(wPos.map(([x,z])=>_wgeo(rGeo,x,-0.42,z)), rimMat));

    group.add(_mm([_t(_bbox(0.12,0.2,0.36),2.52,0.15,0.72),_t(_bbox(0.12,0.2,0.36),2.52,0.15,-0.72)],
      new THREE.MeshBasicMaterial({ color: 0xffffee })));

    group.add(_mm([_t(_bbox(0.12,0.22,0.32),-2.52,0.15,0.82),_t(_bbox(0.12,0.22,0.32),-2.52,0.15,-0.82)], brakeMat));

    const bkg = _bbox(0.3,0.3,0.3);
    const leftBlinker  = _mm([_t(bkg, 2.5,0.35,-1.12),_t(bkg,-2.5,0.35,-1.12)], _BLINKER_MAT);
    const rightBlinker = _mm([_t(bkg, 2.5,0.35, 1.12),_t(bkg,-2.5,0.35, 1.12)], _BLINKER_MAT);
    group.add(leftBlinker, rightBlinker);

    const beam = new THREE.Mesh(_cyl(2.0,0.4,15,16,1,true), _BEAM_MAT);
    beam.position.y = 7.5; beam.visible = false;
    group.add(beam);

    group.userData = { bodyMaterial:bodyMat, brakeMaterial:brakeMat,
      leftBlinkers:[leftBlinker], rightBlinkers:[rightBlinker], beam };
    return group;
  }

  _buildMotorcycleMesh() {
    const group = new THREE.Group();

    const frameMat   = new THREE.MeshStandardMaterial({ color: 0xff0055, roughness: 0.5,  metalness: 0.0 });
    const brakeMat   = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0x000000 });
    const riderMat   = new THREE.MeshStandardMaterial({ color: 0x111116, roughness: 0.75, metalness: 0.0 });
    const trimMat    = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.65, metalness: 0.0 });
    const glassMat   = new THREE.MeshStandardMaterial({ color: 0x050520, roughness: 0.4,  metalness: 0.0, transparent: true, opacity: 0.55 });
    const wheelMat   = new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.9,  metalness: 0.0 });
    const rimMat     = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.6,  metalness: 0.0 });

    group.add(_mm([
      _t(_rbox(2.0,0.38,0.36,0.06), 0,-0.12,0),
      _t(_rbox(0.7,0.28,0.32,0.06), 0.1,0.12,0),
    ], frameMat));

    group.add(_mm([
      _t(_rbox(0.58,0.72,0.38,0.06), -0.18,0.46,0),
      _t(_rbox(0.42,0.1,0.1,0.04),    0.24,0.52, 0.2, 0,0,0.25),
      _t(_rbox(0.42,0.1,0.1,0.04),    0.24,0.52,-0.2, 0,0,0.25),
      _t(_rbox(0.16,0.52,0.12,0.04), -0.18,0.05, 0.2, 0,0,0.1),
      _t(_rbox(0.16,0.52,0.12,0.04), -0.18,0.05,-0.2, 0,0,0.1),
    ], riderMat));

    group.add(_mm([
      _t(_cyl(0.035,0.035,0.86,8), 0.42,0.6,0, Math.PI/2,0,0),
      _t(_cyl(0.03,0.03,0.72,8),   0.62,-0.1, 0.1, 0,0,0.15),
      _t(_cyl(0.03,0.03,0.72,8),   0.62,-0.1,-0.1, 0,0,0.15),
      _t(_cyl(0.07,0.07,1.0,8),   -0.58,-0.38,0.28, 0,0,Math.PI/2),
    ], trimMat));

    group.add(_mm([_t(_bbox(0.06,0.28,0.36), 0.88,0.38,0, 0,0,-0.4)], glassMat));

    const helmet = new THREE.Mesh(_sph(0.22,10,10), frameMat);
    helmet.position.set(-0.18,1.0,0);
    group.add(helmet);
    const visor = new THREE.Mesh(_bbox(0.1,0.09,0.28),
      new THREE.MeshStandardMaterial({ color:0x020202, roughness:0.5, metalness:0.0 }));
    visor.position.set(-0.07,1.02,0);
    group.add(visor);

    const tGeo = _cyl(0.45,0.45,0.2,14);
    const rGeo = _cyl(0.25,0.25,0.22,10);
    group.add(_mm([_wgeo(tGeo,0.78,-0.45,0),_wgeo(tGeo,-0.78,-0.45,0)], wheelMat));
    group.add(_mm([_wgeo(rGeo,0.78,-0.45,0),_wgeo(rGeo,-0.78,-0.45,0)], rimMat));

    group.add(_mm([_t(_bbox(0.12,0.18,0.18), 1.02,0.12,0)], new THREE.MeshBasicMaterial({ color: 0xffffee })));

    group.add(_mm([_t(_bbox(0.12,0.12,0.12),-1.02,0.1,0)], brakeMat));

    const bkg = _bbox(0.18,0.18,0.18);
    const leftBlinker  = _mm([_t(bkg,0.9,0.3,-0.3),_t(bkg,-0.9,0.3,-0.3)], _BLINKER_MAT);
    const rightBlinker = _mm([_t(bkg,0.9,0.3, 0.3),_t(bkg,-0.9,0.3, 0.3)], _BLINKER_MAT);
    group.add(leftBlinker, rightBlinker);

    const beam = new THREE.Mesh(_cyl(1.2,0.2,12,16,1,true), _BEAM_MAT);
    beam.position.y = 6.0; beam.visible = false;
    group.add(beam);

    group.userData = { bodyMaterial:frameMat, brakeMaterial:brakeMat,
      leftBlinkers:[leftBlinker], rightBlinkers:[rightBlinker], beam };
    return group;
  }

  resize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  render() {
    this.controls.update();
    if (this.scene.fog) {
      const distToOrigin = Math.hypot(this.camera.position.x, this.camera.position.z);
      const fogOffset = this.lightTuning?.fogStartDist ?? 500;
      this.scene.fog.near = distToOrigin + fogOffset;
      this.scene.fog.far = this.scene.fog.near + 420;
    }
    this._renderTick = (this._renderTick + 1) | 0;
    if ((this._renderTick & 1) === 0) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.renderer.render(this.scene, this.camera);
    this._updateJamCalloutOverlay();
  }

  _updateJamCalloutOverlay() {
    const jamCallout = this._calloutEl || (this._calloutEl = document.getElementById('jam-callout'));
    const leaderSvg = this._leaderSvgEl || (this._leaderSvgEl = document.getElementById('jam-leader-svg'));
    if (!jamCallout) return;

    if (!this.jamStats || !this.jamStats.active || !this.jamMarker) {
      jamCallout.style.opacity = '0';
      if (leaderSvg) leaderSvg.style.opacity = '0';
      return;
    }

    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const projTop = this._tmpProjVec || (this._tmpProjVec = new THREE.Vector3());
    const projBase = this._tmpProjBase || (this._tmpProjBase = new THREE.Vector3());

    // Project tarmac circle center
    projBase.copy(this.jamMarker.position);
    projBase.y += 0.35;
    projBase.project(this.camera);

    // Project callout anchor above the tunnel
    projTop.copy(this.jamMarker.position);
    projTop.y += 11.2;
    projTop.project(this.camera);

    if (projTop.z > 1.0 || projBase.z > 1.0) {
      jamCallout.style.opacity = '0';
      if (leaderSvg) leaderSvg.style.opacity = '0';
      return;
    }

    const rawBaseX = (projBase.x * 0.5 + 0.5) * w;
    const rawBaseY = (-projBase.y * 0.5 + 0.5) * h;
    const rawCardX = Math.max(155, Math.min(w - 155, (projTop.x * 0.5 + 0.5) * w));
    const rawCardY = Math.max(115, Math.min(h - 55, (-projTop.y * 0.5 + 0.5) * h - 18));

    if (!this._jamScreenPos) {
      this._jamScreenPos = { x: rawCardX, y: rawCardY, bx: rawBaseX, by: rawBaseY };
    } else {
      this._jamScreenPos.x += (rawCardX - this._jamScreenPos.x) * 0.14;
      this._jamScreenPos.y += (rawCardY - this._jamScreenPos.y) * 0.14;
      this._jamScreenPos.bx += (rawBaseX - this._jamScreenPos.bx) * 0.18;
      this._jamScreenPos.by += (rawBaseY - this._jamScreenPos.by) * 0.18;
    }

    const { x, y, bx, by } = this._jamScreenPos;
    jamCallout.style.opacity = '1';
    jamCallout.style.left = `${x.toFixed(1)}px`;
    jamCallout.style.top = `${y.toFixed(1)}px`;

    if (leaderSvg) {
      leaderSvg.style.opacity = '1';
      const lineEl = this._leaderLineEl || (this._leaderLineEl = document.getElementById('jam-leader-line'));
      const dashEl = this._leaderDashEl || (this._leaderDashEl = document.getElementById('jam-leader-dash'));
      const ringEl = this._leaderRingEl || (this._leaderRingEl = document.getElementById('jam-anchor-ring'));
      const dotEl = this._leaderDotEl || (this._leaderDotEl = document.getElementById('jam-anchor-dot'));

      if (lineEl) {
        lineEl.setAttribute('x1', x.toFixed(1));
        lineEl.setAttribute('y1', y.toFixed(1));
        lineEl.setAttribute('x2', bx.toFixed(1));
        lineEl.setAttribute('y2', by.toFixed(1));
      }
      if (dashEl) {
        dashEl.setAttribute('x1', x.toFixed(1));
        dashEl.setAttribute('y1', y.toFixed(1));
        dashEl.setAttribute('x2', bx.toFixed(1));
        dashEl.setAttribute('y2', by.toFixed(1));
        dashEl.setAttribute('stroke-dashoffset', `${-((performance.now() * 0.025) % 20).toFixed(1)}`);
      }
      if (ringEl) {
        ringEl.setAttribute('cx', bx.toFixed(1));
        ringEl.setAttribute('cy', by.toFixed(1));
      }
      if (dotEl) {
        dotEl.setAttribute('cx', bx.toFixed(1));
        dotEl.setAttribute('cy', by.toFixed(1));
      }
    }

    // Throttle DOM text updates to ~10 Hz
    const now = performance.now();
    if (!this._lastCalloutTextUpdate || now - this._lastCalloutTextUpdate > 100) {
      this._lastCalloutTextUpdate = now;

      const { queuedCars, avgJamSpeed, waveLength } = this.jamStats;
      const carsEl = document.getElementById('jam-stat-cars');
      const speedEl = document.getElementById('jam-stat-speed');
      const lenEl = document.getElementById('jam-stat-len');
      const sevEl = document.getElementById('jam-severity');

      if (carsEl) carsEl.textContent = `${queuedCars} cars`;
      if (speedEl) speedEl.textContent = `${avgJamSpeed.toFixed(1)} m/s`;
      if (lenEl) lenEl.textContent = `${waveLength} m`;
      if (sevEl) {
        if (avgJamSpeed < 2.2) {
          sevEl.textContent = 'GRIDLOCK';
        } else if (avgJamSpeed < 4.5) {
          sevEl.textContent = 'SEVERE';
        } else {
          sevEl.textContent = 'MODERATE';
        }
      }
    }
  }
}
