/**
 * renderer3d.js — Three.js Scene Setup & Visualisation
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getPointAtS } from './road.js';

// ── Module-level geometry cache ──────────────────────────────────────────────
// Every unique shape is created exactly once and shared across all vehicle
// instances. Cloning a cached geometry is O(1) pointer copy of typed arrays.
const _GC = new Map();
const _rbox = (w,h,d,r=0.07) => { const k=`R${w}|${h}|${d}|${r}`; if(!_GC.has(k))_GC.set(k,new RoundedBoxGeometry(w,h,d,1,r)); return _GC.get(k); };
const _bbox = (w,h,d)        => { const k=`B${w}|${h}|${d}`;     if(!_GC.has(k))_GC.set(k,new THREE.BoxGeometry(w,h,d));         return _GC.get(k); };
const _cyl  = (a,b,h,s=14)  => { const k=`C${a}|${b}|${h}|${s}`; if(!_GC.has(k))_GC.set(k,new THREE.CylinderGeometry(a,b,h,s)); return _GC.get(k); };
const _sph  = (r,ws,hs)     => { const k=`S${r}|${ws}|${hs}`;    if(!_GC.has(k))_GC.set(k,new THREE.SphereGeometry(r,ws,hs));    return _GC.get(k); };

// Clone a geometry and bake in position + optional Z/X rotation.
const _t = (geo, px=0,py=0,pz=0, rx=0,ry=0,rz=0) => {
  const g = geo.clone();
  if (rx||ry||rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx,ry,rz)));
  g.translate(px,py,pz);
  return g;
};
// Wheel helper: rotate X by PI/2 (stand wheel upright) then translate.
const _wgeo = (geo,x,y,z) => _t(geo,x,y,z, Math.PI/2,0,0);
// Build a merged mesh from an array of already-transformed BufferGeometries.
// All inputs are normalised to non-indexed to satisfy mergeGeometries requirements
// (RoundedBoxGeometry is indexed; BoxGeometry/CylinderGeometry are not).
const _mm = (geos, mat, shadow=false) => {
  const normalised = geos.map(g => g.index ? g.toNonIndexed() : g);
  const m = new THREE.Mesh(mergeGeometries(normalised), mat);
  m.castShadow = shadow;
  return m;
};

export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2d2d30); // sleek neutral grey
    
    // Fallback if layout hasn't run yet
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
    this.camera.position.set(-230, 90, 100);
    this.camera.lookAt(0, 5, 0);

    // WebGL Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // faster than PCFSoftShadowMap
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap retina resolutions to avoid fill-rate bottlenecks
    this.renderer.setSize(width, height, false);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minPolarAngle = Math.PI / 3; // restrict camera from getting too vertical (max 60 deg from vertical)
    this.controls.maxPolarAngle = Math.PI / 2 + 0.05; // allow looking slightly upwards
    this.controls.minDistance = 20;
    this.controls.maxDistance = 600;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5; // slow, smooth rotation

    this.cameraMode = 'jam';
    this.trackedVehicleId = null;
    this.targetVelocity = new THREE.Vector3();
    this.cameraVelocity = new THREE.Vector3();
    this.trackingAnchor = null;

    this.carMeshes = new Map();
    this.roadLine = null;

    this._setupLights();
    this._setupEnvironment();
  }

  _setupLights() {
    // 1. Hemisphere Light (provides natural sky/ground ambient gradient and soft ambient fill)
    const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x111122, 0.7);
    this.scene.add(hemiLight);

    // 2. Key Light (Main directional light casting soft shadows from top-right)
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
    keyLight.position.set(150, 250, 100);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.near = 10;
    keyLight.shadow.camera.far = 600;
    const d = 160;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0005;
    this.scene.add(keyLight);

    // 3. Fill Light (Opposing directional light to soften shadows with cool tones)
    const fillLight = new THREE.DirectionalLight(0x7799ff, 0.5);
    fillLight.position.set(-150, 150, -100);
    this.scene.add(fillLight);

    // 4. Neon center marker light
    const pointLight = new THREE.PointLight(0x5b8dee, 2.0, 100);
    pointLight.position.set(0, 20, 0);
    this.scene.add(pointLight);
  }

  _setupEnvironment() {
    // Floor grid — subtle greys blending with the background
    const gridHelper = new THREE.GridHelper(500, 50, 0x38383c, 0x242426);
    gridHelper.position.y = -0.5;
    this.scene.add(gridHelper);

    // Shadow catcher floor — placed BELOW road so shadows don't punch through
    const floorGeo = new THREE.PlaneGeometry(1000, 1000);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.0; // well below the road surface
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  /**
   * Generates a 3D ribbon mesh for the road
   */
  createRoadMesh(road) {
    const width = 24.0;
    const steps = 600;
    
    const vertices = [];
    const indices = [];
    
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * road.totalLength;
      const pt = getPointAtS(road, s);
      
      const px = -pt.ty;
      const pz = pt.tx;
      
      const xL = pt.x + px * (width / 2);
      const zL = pt.y + pz * (width / 2);
      const xR = pt.x - px * (width / 2);
      const zR = pt.y - pz * (width / 2);
      
      vertices.push(xL, pt.z, zL);
      vertices.push(xR, pt.z, zR);
      
      if (i < steps) {
        const currL = 2 * i;
        const currR = 2 * i + 1;
        const nextL = 2 * (i + 1);
        const nextR = 2 * (i + 1) + 1;
        
        indices.push(currL, nextL, currR);
        indices.push(currR, nextL, nextR);
      }
    }
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    
    const material = new THREE.MeshStandardMaterial({
      color: 0x1b1b22,
      roughness: 0.8,
      metalness: 0.0,
      side: THREE.DoubleSide
    });
    
    const roadMesh = new THREE.Mesh(geometry, material);
    roadMesh.receiveShadow = true;
    roadMesh.castShadow = true;
    this.scene.add(roadMesh);
    
    // Draw 4 dashed lane lines
    const laneWidth = 4.5;
    for (let l = 1; l <= 4; l++) {
      const offset = (l - 2.5) * laneWidth;
      const linePoints = [];
      for (let i = 0; i <= steps; i++) {
        const s = (i / steps) * road.totalLength;
        const pt = getPointAtS(road, s);
        const px = -pt.ty;
        const pz = pt.tx;
        linePoints.push(new THREE.Vector3(pt.x + px * offset, pt.z + 0.05, pt.y + pz * offset));
      }
      const lineMat = new THREE.LineDashedMaterial({
        color: 0x606070,
        dashSize: 2,
        gapSize: 2
      });
      const lineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
      const line = new THREE.Line(lineGeo, lineMat);
      line.computeLineDistances();
      this.scene.add(line);
    }

    // Draw yellow shoulders
    for (const side of [-1, 1]) {
      const offset = side * (width / 2 - 0.2);
      const linePoints = [];
      for (let i = 0; i <= steps; i++) {
        const s = (i / steps) * road.totalLength;
        const pt = getPointAtS(road, s);
        const px = -pt.ty;
        const pz = pt.tx;
        linePoints.push(new THREE.Vector3(pt.x + px * offset, pt.z + 0.05, pt.y + pz * offset));
      }
      const lineMat = new THREE.LineBasicMaterial({ color: 0x9e802a });
      const lineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
      const line = new THREE.Line(lineGeo, lineMat);
      this.scene.add(line);
    }
  }

  /**
   * Syncs the 3D car meshes with current physical states
   */
  updateCars(vehicles, road, params, dt) {
    const activeIds = new Set();

    // Find current speed extremes for dynamic range
    let minV = Infinity;
    let maxV = -Infinity;
    for (const car of vehicles) {
      if (car.v < minV) minV = car.v;
      if (car.v > maxV) maxV = car.v;
    }
    const range = maxV - minV;
    const hasRange = isFinite(range) && range > 0.1;

    for (const car of vehicles) {
      activeIds.add(car.id);
      let carObj = this.carMeshes.get(car.id);

      if (!carObj) {
        if (car.type === 'truck') {
          carObj = this._buildTruckMesh();
        } else if (car.type === 'bus') {
          carObj = this._buildBusMesh();
        } else if (car.type === 'minivan') {
          carObj = this._buildMinivanMesh();
        } else if (car.type === 'motorcycle') {
          carObj = this._buildMotorcycleMesh();
        } else {
          carObj = this._buildCarMesh(car.id);
        }
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
      const weave = Math.sin((Date.now() / 1000) * weaveSpeed + weavePhase) * 0.18; // 18cm maximum sway
      
      const offset = (visualLane - 2) * laneWidth + latNoise + weave;

      // Normal to road surface: cross product of tangent and world-up approximation
      // Road tangent in world space: (tx, tz, ty) because renderer maps y→z
      // Lateral (right) direction: perpendicular to tangent, lying in road plane
      const txW = pt.tx;
      const tyW = pt.tz; // world Z = road Y
      const tzW = pt.ty;

      // Lateral direction = tangent × up, normalized
      const latX = -tzW;  // -ty in road space
      const latZ = txW;   // tx in road space
      const latLen = Math.sqrt(latX * latX + latZ * latZ) || 1;

      // Set height offset dynamically based on wheel geometry to prevent tires from clipping into the road surface
      let heightOffset = 0.90;
      if (car.type === 'truck' || car.type === 'bus') {
        heightOffset = 0.95;
      }

      carObj.position.set(
        pt.x + (latX / latLen) * offset,
        pt.z + heightOffset,  // sit on top of road surface
        pt.y + (latZ / latLen) * offset
      );

      // Orient the vehicle to align with the 3D road surface (tangent & normal)
      const forward = new THREE.Vector3(pt.tx, pt.tz, pt.ty).normalize();
      const upRef = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(forward, upRef).normalize();
      const up = new THREE.Vector3().crossVectors(right, forward).normalize();

      // Apply steering deflection angle during lane changes for natural yaw steering
      const lateralDiff = car.lane - visualLane;
      const v_lat = lateralDiff * 2.5 * laneWidth;
      const steeringAngle = Math.max(-0.25, Math.min(0.25, Math.atan2(v_lat, Math.max(1.0, car.v))));

      const steeredForward = forward.clone().applyAxisAngle(up, -steeringAngle);
      const steeredRight = new THREE.Vector3().crossVectors(steeredForward, up).normalize();

      const matrix = new THREE.Matrix4();
      matrix.makeBasis(steeredForward, up, steeredRight);
      carObj.quaternion.setFromRotationMatrix(matrix);

      // Map speed HSL colour dynamically: fastest is green (hue = 120/360), slowest is red (hue = 0)
      let frac = 1.0;
      if (hasRange) {
        frac = (car.v - minV) / range;
      } else if (car.v < 1.0) {
        frac = 0.0;
      }
      const hue = (frac * 120) / 360;
      carObj.userData.bodyMaterial.color.setHSL(hue, 0.8, 0.5);
      if (carObj.userData.glowMaterial) {
        carObj.userData.glowMaterial.color.setHSL(hue, 0.8, 0.5);
      }

      // Tail light brightness/brake color
      if (car.braking) {
        carObj.userData.brakeMaterial.color.setHex(0xff0000);
        carObj.userData.brakeMaterial.emissive.setHex(0xff0000);
      } else {
        carObj.userData.brakeMaterial.color.setHex(0x550000);
        carObj.userData.brakeMaterial.emissive.setHex(0x000000);
      }

      // Blinkers (flashing turn signals) when changing lanes
      const isChanging = Math.abs(car.lane - car.visualLane) > 0.05;
      const isLeft = car.lane < car.visualLane;
      const isRight = car.lane > car.visualLane;
      const blinkState = (Date.now() % 500) < 250; // 2Hz flash

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
      if (carObj.userData.beam) {
        carObj.userData.beam.visible = isChanging;
      }
    }

    // Clean up old cars if count reduced
    for (const [id, mesh] of this.carMeshes.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh);
        this.carMeshes.delete(id);
      }
    }

    // Camera preset tracking update
    this._updateTracking(vehicles, dt);
  }

  _updateTracking(vehicles, dt) {
    if (this.cameraMode !== 'jam') {
      return;
    }

    let targetCar = null;
    let targetPos = new THREE.Vector3();
    let offset = new THREE.Vector3();

    // Jam Cam: Track the slowest car (core of the jam)
    targetCar = vehicles.reduce((min, c) => c.v < min.v ? c : min, vehicles[0]);
    if (targetCar) {
      const mesh = this.carMeshes.get(targetCar.id);
      if (mesh) {
        mesh.getWorldPosition(targetPos);
        // Calculate unit vector pointing radially outward from the loop center (0,0)
        const radial = new THREE.Vector3(targetPos.x, 0, targetPos.z).normalize();
        // Position camera 80m outward from the car, and 30m high
        offset.copy(radial).multiplyScalar(80).setY(30);
      }
    }

    let desiredCameraPos = null;
    if (targetCar) {
      desiredCameraPos = targetPos.clone().add(offset);

      if (!this.trackingAnchor) {
        this.trackingAnchor = targetPos.clone();
        this.camera.position.copy(desiredCameraPos);
        this.targetVelocity.set(0, 0, 0);
        this.cameraVelocity.set(0, 0, 0);
      } else {
        // Second-order spring-damper physics for beautiful organic ease-in / ease-out.
        // Critical damping factor zeta = 1.0 (no overshoot).
        const springDt = dt !== undefined ? Math.min(dt, 0.1) : 0.016;
        
        // Jam Cam is slow and majestic
        const omegaTarget = 0.6;
        const omegaCam = 0.5;

        // 1. Update camera target focus anchor
        const deltaTarget = new THREE.Vector3().subVectors(targetPos, this.trackingAnchor);
        const accelTarget = deltaTarget.multiplyScalar(omegaTarget * omegaTarget)
          .addScaledVector(this.targetVelocity, -2 * omegaTarget);
        this.targetVelocity.addScaledVector(accelTarget, springDt);
        this.trackingAnchor.addScaledVector(this.targetVelocity, springDt);

        // 2. Update camera position
        const deltaCam = new THREE.Vector3().subVectors(desiredCameraPos, this.camera.position);
        const accelCam = deltaCam.multiplyScalar(omegaCam * omegaCam)
          .addScaledVector(this.cameraVelocity, -2 * omegaCam);
        this.cameraVelocity.addScaledVector(accelCam, springDt);
        this.camera.position.addScaledVector(this.cameraVelocity, springDt);
      }
      this.controls.target.copy(this.trackingAnchor);
    }
  }

  setCameraPreset(mode, vehicles) {
    this.cameraMode = mode;
    this.trackingAnchor = null; // Clear anchor to allow instant snap on initial click
    this.targetVelocity.set(0, 0, 0);
    this.cameraVelocity.set(0, 0, 0);

    if (mode === 'default') {
      this.controls.minPolarAngle = Math.PI / 3;
      this.controls.autoRotate = true;
      this.camera.position.set(-230, 90, 100);
      this.controls.target.set(0, 5, 0);
    } else if (mode === 'top') {
      this.controls.minPolarAngle = 0; // allow top-down camera view to bypass constraint
      this.controls.autoRotate = false;
      this.camera.position.set(0, 260, 0.01);
      this.controls.target.set(0, 0, 0);
    } else if (mode === 'jam') {
      this.controls.minPolarAngle = Math.PI / 3;
      this.controls.autoRotate = false;
      // Trigger initial update
      this._updateTracking(vehicles);
    }
  }

  _buildCarMesh(carId = 0) {
    const group  = new THREE.Group();
    const variant = carId % 3;

    // ── Per-vehicle materials (body + brake change color each frame) ─────────
    const bodyMat    = new THREE.MeshStandardMaterial({ color: 0x58b88e, roughness: 0.5,  metalness: 0.0 });
    const brakeMat   = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0x000000 });
    const glowMat    = new THREE.MeshBasicMaterial({ color: 0x00ffaa, transparent: true, opacity: 0.45 });
    // ── Shared static materials ───────────────────────────────────────────────
    const chassisMat = new THREE.MeshStandardMaterial({ color: 0x111115, roughness: 0.85, metalness: 0.0 });
    const glassMat   = new THREE.MeshStandardMaterial({ color: 0x050510, roughness: 0.5,  metalness: 0.0, transparent: true, opacity: 0.6 });
    const wheelMat   = new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.85, metalness: 0.0 });
    const rimMat     = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6,  metalness: 0.0 });
    const blinkerMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    // ── 1. Chassis group (all dark underside parts → 1 draw call) ────────────
    const cg = [
      _t(_bbox(4.7,0.18,2.3),    0,-0.45,0),
      _t(_bbox(0.18,0.22,2.28),  2.35,-0.3,0),
      _t(_bbox(0.18,0.22,2.28), -2.35,-0.3,0),
    ];
    if (variant === 0) cg.push(_t(_bbox(0.35,0.1,2.36),  -2.26,-0.02,0));
    if (variant === 1) { cg.push(_t(_bbox(0.1,0.4,0.1),-1.9,0.18,0.82)); cg.push(_t(_bbox(0.1,0.4,0.1),-1.9,0.18,-0.82)); }
    group.add(_mm(cg, chassisMat));

    // ── 2. Body group (paint colour → 1 draw call, casts shadow) ─────────────
    const bg = [
      _t(_rbox(4.5,0.52,2.2,0.08),   0,-0.08,0),
      _t(_rbox(1.2,0.26,2.18,0.06),  1.65,-0.18,0),
      _t(_rbox(2.2,0.52,1.82,0.08), -0.2,0.4,0),
    ];
    if (variant === 1) bg.push(_t(_rbox(0.38,0.09,2.4,0.04), -1.9,0.42,0));
    group.add(_mm(bg, bodyMat, true));

    // ── 3. Glass group → 1 draw call ─────────────────────────────────────────
    const wGeo = _bbox(0.78,0.5,1.76);
    group.add(_mm([
      _t(wGeo,  0.65,0.35,0, 0,0,-0.6),
      _t(wGeo, -1.05,0.35,0, 0,0, 0.6),
      _t(_bbox(1.6,0.35,1.84), -0.2,0.4,0),
    ], glassMat));

    // ── 4. Wheels: 4 tires → 1 draw call, 4 rims → 1 draw call ──────────────
    const tGeo = _cyl(0.45,0.45,0.35,14);
    const rGeo = _cyl(0.22,0.22,0.37,10);
    const wPos = [[1.4,1.1],[1.4,-1.1],[-1.4,1.1],[-1.4,-1.1]];
    group.add(_mm(wPos.map(([x,z])=>_wgeo(tGeo,x,-0.45,z)), wheelMat));
    group.add(_mm(wPos.map(([x,z])=>_wgeo(rGeo,x,-0.45,z)), rimMat));

    // ── 5. Headlights (both lenses + DRL → 1 draw call) ──────────────────────
    const hlg = _bbox(0.12,0.18,0.38), drg = _bbox(0.08,0.04,0.36);
    group.add(_mm([
      _t(hlg,2.27,-0.12,0.72),_t(hlg,2.27,-0.12,-0.72),
      _t(drg,2.27,0.0,0.72),  _t(drg,2.27,0.0,-0.72),
    ], new THREE.MeshBasicMaterial({ color: 0xffffee })));

    // ── 6. Brake lights (separate — emissive is animated) ────────────────────
    group.add(_mm([_t(_bbox(0.12,0.16,0.36),-2.27,-0.1,0.72),_t(_bbox(0.12,0.16,0.36),-2.27,-0.1,-0.72)], brakeMat));

    // ── 7. Underglow (separate — colour is animated) ──────────────────────────
    const underglow = new THREE.Mesh(_bbox(3.2,0.02,1.7), glowMat);
    underglow.position.set(0,-0.54,0);
    group.add(underglow);

    // ── 8. Blinkers (left & right each merged → 2 draw calls) ────────────────
    const bkg = _bbox(0.3,0.3,0.3);
    const leftBlinker  = _mm([_t(bkg,2.26,0.05,-1.12),_t(bkg,-2.26,0.05,-1.12)], blinkerMat);
    const rightBlinker = _mm([_t(bkg,2.26,0.05, 1.12),_t(bkg,-2.26,0.05, 1.12)], blinkerMat);
    group.add(leftBlinker, rightBlinker);

    // ── 9. Headlight beam ─────────────────────────────────────────────────────
    const beam = new THREE.Mesh(_cyl(1.8,0.3,15,16,1,true),
      new THREE.MeshBasicMaterial({ color:0xffaa00, transparent:true, opacity:0.12, side:THREE.DoubleSide, depthWrite:false }));
    beam.position.y = 7.5; beam.visible = false;
    group.add(beam);

    group.userData = { bodyMaterial:bodyMat, brakeMaterial:brakeMat, glowMaterial:glowMat,
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
    const blinkerMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    // ── Chassis dark group ────────────────────────────────────────────────────
    const cg = [_t(_bbox(8.2,0.28,2.4),0,-0.45,0)];
    for (const [mx,mz] of [[-1.7,1.3],[-1.7,-1.3],[-3.1,1.3],[-3.1,-1.3]])
      cg.push(_t(_bbox(0.06,0.5,0.8),mx,-0.22,mz)); // mudflaps
    group.add(_mm(cg, chassisMat));

    // ── Cab + trailer (paint colour) ─────────────────────────────────────────
    const bg = [
      _t(_rbox(2.4,2.0,2.3,0.1),  2.7, 0.55,0),
      _t(_rbox(5.6,2.4,2.4,0.1), -1.0, 0.85,0),
      // roof air deflector
      _t(_bbox(1.5,0.8,2.3), 2.0,1.65,0, 0,0,-0.35),
      // trailer door panels
      _t(_bbox(0.05,1.8,0.9),-3.82,0.85, 0.55),
      _t(_bbox(0.05,1.8,0.9),-3.82,0.85,-0.55),
    ];
    group.add(_mm(bg, cabMat, true));

    // ── Trim / chrome group ───────────────────────────────────────────────────
    const tg = [
      _t(_bbox(0.1,0.8,1.8),   3.91, 0.1, 0),    // grill
      _t(_bbox(0.3,0.3,2.5),   3.9, -0.3, 0),    // bumper
      _t(_bbox(0.9,0.08,0.18), 2.7, -0.55, 1.26), // step L
      _t(_bbox(0.9,0.08,0.18), 2.7, -0.55,-1.26), // step R
      _t(_cyl(0.08,0.08,2.8,8), 1.4,1.3, 0.9, 0,0,Math.PI/2), // exhaust L (rotated to vertical)
      _t(_cyl(0.08,0.08,2.8,8), 1.4,1.3,-0.9, 0,0,Math.PI/2),
      _t(_cyl(0.42,0.42,1.8,8), 0.6,-0.42, 1.25, 0,0,Math.PI/2), // fuel tank L
      _t(_cyl(0.42,0.42,1.8,8), 0.6,-0.42,-1.25, 0,0,Math.PI/2),
    ];
    group.add(_mm(tg, trimMat));

    // ── Glass ─────────────────────────────────────────────────────────────────
    group.add(_mm([
      _t(_bbox(0.5,0.8,2.12), 3.5,1.15,0, 0,0,-0.4),
      _t(_bbox(1.2,0.5,2.34), 2.8,1.1,0),
    ], glassMat));

    // ── Cab running lights ────────────────────────────────────────────────────
    const runLightGeos = [-0.72,-0.36,0,0.36,0.72].map(z=>_t(_bbox(0.08,0.08,0.08),3.82,1.55,z));
    group.add(_mm(runLightGeos, new THREE.MeshBasicMaterial({ color: 0xffcc44 })));

    // ── Wheels: 6 tires → 1, 6 rims → 1 ─────────────────────────────────────
    const tGeo = _cyl(0.55,0.55,0.4,14);
    const rGeo = _cyl(0.28,0.28,0.42,10);
    const wPos = [[2.8,1.2],[2.8,-1.2],[-1.0,1.2],[-1.0,-1.2],[-2.4,1.2],[-2.4,-1.2]];
    group.add(_mm(wPos.map(([x,z])=>_wgeo(tGeo,x,-0.4,z)), wheelMat));
    group.add(_mm(wPos.map(([x,z])=>_wgeo(rGeo,x,-0.4,z)), rimMat));

    // ── Headlights ────────────────────────────────────────────────────────────
    group.add(_mm([_t(_bbox(0.12,0.25,0.42),3.9,-0.1,0.82),_t(_bbox(0.12,0.25,0.42),3.9,-0.1,-0.82)],
      new THREE.MeshBasicMaterial({ color: 0xffffff })));

    // ── Brake lights ─────────────────────────────────────────────────────────
    group.add(_mm([_t(_bbox(0.12,0.4,0.28),-3.87,-0.1,0.82),_t(_bbox(0.12,0.4,0.28),-3.87,-0.1,-0.82)], brakeMat));

    // ── Blinkers ─────────────────────────────────────────────────────────────
    const bkg = _bbox(0.4,0.4,0.4);
    const leftBlinker  = _mm([_t(bkg,3.9,0.4,-1.24),_t(bkg,-3.87,0.4,-1.24)], blinkerMat);
    const rightBlinker = _mm([_t(bkg,3.9,0.4, 1.24),_t(bkg,-3.87,0.4, 1.24)], blinkerMat);
    group.add(leftBlinker, rightBlinker);

    // ── Beam ──────────────────────────────────────────────────────────────────
    const beam = new THREE.Mesh(_cyl(2.5,0.5,20,16,1,true),
      new THREE.MeshBasicMaterial({ color:0xffaa00, transparent:true, opacity:0.12, side:THREE.DoubleSide, depthWrite:false }));
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
    const blinkerMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    // ── Chassis / dark underside ──────────────────────────────────────────────
    group.add(_mm([
      _t(_bbox(10.2,0.28,2.5),  0,-0.45,0),
      _t(_bbox(9.8,0.28,0.06),  0,-0.2, 1.25), // skirt L
      _t(_bbox(9.8,0.28,0.06),  0,-0.2,-1.25), // skirt R
      _t(_rbox(3.5,0.35,1.8,0.06), -0.5,2.15,0), // roof battery
      _t(_rbox(1.2,0.28,0.9,0.05),  2.5,2.12,0), // HVAC unit 2
      _t(_bbox(0.06,0.22,1.6),  5.02,2.05,0),   // destination board
      _t(_bbox(1.2,1.8,0.05),   3.8,0.55,1.22), // entry door
    ], chassisMat));

    // ── Body ──────────────────────────────────────────────────────────────────
    const bg = [_t(_rbox(10.0,2.4,2.4,0.12), 0,0.8,0)];
    // rear fins folded into body colour
    bg.push(_t(_bbox(0.8,0.4,0.08),-4.6,1.8, 1.21, 0, 0.2,0));
    bg.push(_t(_bbox(0.8,0.4,0.08),-4.6,1.8,-1.21, 0,-0.2,0));
    group.add(_mm(bg, bodyMat, true));

    // ── Glass ─────────────────────────────────────────────────────────────────
    const winGeo = _bbox(1.6,0.7,0.05);
    const glassGeos = [_t(_bbox(0.6,1.4,2.38), 4.8,1.3,0, 0,0,-0.4)];
    for (let i=0;i<4;i++) { const x=-3.2+i*2.2; glassGeos.push(_t(winGeo,x,1.1,1.21),_t(winGeo,x,1.1,-1.21)); }
    group.add(_mm(glassGeos, glassMat));

    // ── Wheels: 6 → 1, 6 rims → 1 ───────────────────────────────────────────
    const tGeo = _cyl(0.55,0.55,0.4,14);
    const rGeo = _cyl(0.28,0.28,0.42,10);
    const wPos = [[3.5,1.25],[3.5,-1.25],[-2.5,1.25],[-2.5,-1.25],[-3.8,1.25],[-3.8,-1.25]];
    group.add(_mm(wPos.map(([x,z])=>_wgeo(tGeo,x,-0.4,z)), wheelMat));
    group.add(_mm(wPos.map(([x,z])=>_wgeo(rGeo,x,-0.4,z)), rimMat));

    // ── Headlights ────────────────────────────────────────────────────────────
    group.add(_mm([_t(_bbox(0.12,0.22,0.38),5.02,0.22,0.82),_t(_bbox(0.12,0.22,0.38),5.02,0.22,-0.82)],
      new THREE.MeshBasicMaterial({ color: 0xffffff })));

    // ── Brake lights + rear bar ───────────────────────────────────────────────
    group.add(_mm([
      _t(_bbox(0.12,0.32,0.38),-5.02,0.22,0.82),
      _t(_bbox(0.12,0.32,0.38),-5.02,0.22,-0.82),
      _t(_bbox(0.06,0.12,2.0), -5.02,0.6,0),
    ], brakeMat));

    // ── Blinkers ─────────────────────────────────────────────────────────────
    const bkg = _bbox(0.4,0.4,0.4);
    const leftBlinker  = _mm([_t(bkg,5.0,0.8,-1.24),_t(bkg,-5.0,0.8,-1.24)], blinkerMat);
    const rightBlinker = _mm([_t(bkg,5.0,0.8, 1.24),_t(bkg,-5.0,0.8, 1.24)], blinkerMat);
    group.add(leftBlinker, rightBlinker);

    // ── Beam ──────────────────────────────────────────────────────────────────
    const beam = new THREE.Mesh(_cyl(2.5,0.5,20,16,1,true),
      new THREE.MeshBasicMaterial({ color:0xffaa00, transparent:true, opacity:0.12, side:THREE.DoubleSide, depthWrite:false }));
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
    const blinkerMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    // ── Chassis ───────────────────────────────────────────────────────────────
    group.add(_mm([
      _t(_bbox(5.2,0.18,2.3),  0,-0.45,0),
      _t(_bbox(1.4,0.05,0.04), -0.6,0.32,1.12), // sliding door channel
    ], chassisMat));

    // ── Body (taller silhouette = minivan hallmark) ───────────────────────────
    group.add(_mm([
      _t(_rbox(5.0,1.05,2.2,0.09),   0, 0.15,0),
      _t(_rbox(3.6,0.3, 2.1,0.07),  -0.4,0.82,0), // raised roofline
      _t(_rbox(3.5,0.62,2.0,0.08),  -0.5,0.97,0), // cabin
    ], bodyMat, true));

    // ── Glass ─────────────────────────────────────────────────────────────────
    group.add(_mm([
      _t(_bbox(0.5,0.7,1.96),  1.5,0.8,0, 0,0,-0.55),
      _t(_bbox(3.2,0.45,2.04),-0.5,0.95,0),
    ], glassMat));

    // ── Roof rails (bars + 3 rungs → 1 draw call) ────────────────────────────
    group.add(_mm([
      _t(_bbox(2.8,0.055,0.055),-0.5,1.3, 0.82),
      _t(_bbox(2.8,0.055,0.055),-0.5,1.3,-0.82),
      _t(_bbox(0.055,0.055,1.64),-1.5,1.3,0),
      _t(_bbox(0.055,0.055,1.64),-0.5,1.3,0),
      _t(_bbox(0.055,0.055,1.64), 0.5,1.3,0),
    ], railMat));

    // ── Wheels ────────────────────────────────────────────────────────────────
    const tGeo = _cyl(0.48,0.48,0.35,14);
    const rGeo = _cyl(0.24,0.24,0.37,10);
    const wPos = [[1.5,1.1],[1.5,-1.1],[-1.6,1.1],[-1.6,-1.1]];
    group.add(_mm(wPos.map(([x,z])=>_wgeo(tGeo,x,-0.42,z)), wheelMat));
    group.add(_mm(wPos.map(([x,z])=>_wgeo(rGeo,x,-0.42,z)), rimMat));

    // ── Headlights ────────────────────────────────────────────────────────────
    group.add(_mm([_t(_bbox(0.12,0.2,0.36),2.52,0.15,0.72),_t(_bbox(0.12,0.2,0.36),2.52,0.15,-0.72)],
      new THREE.MeshBasicMaterial({ color: 0xffffee })));

    // ── Brake lights ─────────────────────────────────────────────────────────
    group.add(_mm([_t(_bbox(0.12,0.22,0.32),-2.52,0.15,0.82),_t(_bbox(0.12,0.22,0.32),-2.52,0.15,-0.82)], brakeMat));

    // ── Blinkers ─────────────────────────────────────────────────────────────
    const bkg = _bbox(0.3,0.3,0.3);
    const leftBlinker  = _mm([_t(bkg, 2.5,0.35,-1.12),_t(bkg,-2.5,0.35,-1.12)], blinkerMat);
    const rightBlinker = _mm([_t(bkg, 2.5,0.35, 1.12),_t(bkg,-2.5,0.35, 1.12)], blinkerMat);
    group.add(leftBlinker, rightBlinker);

    // ── Beam ──────────────────────────────────────────────────────────────────
    const beam = new THREE.Mesh(_cyl(2.0,0.4,15,16,1,true),
      new THREE.MeshBasicMaterial({ color:0xffaa00, transparent:true, opacity:0.12, side:THREE.DoubleSide, depthWrite:false }));
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
    const blinkerMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    // ── Bike frame + tank (paint colour) → 1 draw call ───────────────────────
    group.add(_mm([
      _t(_rbox(2.0,0.38,0.36,0.06), 0,-0.12,0),
      _t(_rbox(0.7,0.28,0.32,0.06), 0.1,0.12,0), // fuel tank fairing
    ], frameMat, true));

    // ── Rider body parts → 1 draw call ───────────────────────────────────────
    group.add(_mm([
      _t(_rbox(0.58,0.72,0.38,0.06), -0.18,0.46,0),       // torso
      _t(_rbox(0.42,0.1,0.1,0.04),    0.24,0.52, 0.2, 0,0,0.25), // arm L
      _t(_rbox(0.42,0.1,0.1,0.04),    0.24,0.52,-0.2, 0,0,0.25), // arm R
      _t(_rbox(0.16,0.52,0.12,0.04), -0.18,0.05, 0.2, 0,0,0.1),  // leg L
      _t(_rbox(0.16,0.52,0.12,0.04), -0.18,0.05,-0.2, 0,0,0.1),  // leg R
    ], riderMat));

    // ── Chrome trim parts → 1 draw call ──────────────────────────────────────
    group.add(_mm([
      _t(_cyl(0.035,0.035,0.86,8), 0.42,0.6,0, Math.PI/2,0,0), // handlebars
      _t(_cyl(0.03,0.03,0.72,8),   0.62,-0.1, 0.1, 0,0,0.15),  // fork L
      _t(_cyl(0.03,0.03,0.72,8),   0.62,-0.1,-0.1, 0,0,0.15),  // fork R
      _t(_cyl(0.07,0.07,1.0,8),   -0.58,-0.38,0.28, 0,0,Math.PI/2), // exhaust
    ], trimMat));

    // ── Windscreen ────────────────────────────────────────────────────────────
    group.add(_mm([_t(_bbox(0.06,0.28,0.36), 0.88,0.38,0, 0,0,-0.4)], glassMat));

    // ── Helmet (sphere matches paint) ─────────────────────────────────────────
    const helmet = new THREE.Mesh(_sph(0.22,10,10), frameMat);
    helmet.position.set(-0.18,1.0,0);
    group.add(helmet);
    const visor = new THREE.Mesh(_bbox(0.1,0.09,0.28),
      new THREE.MeshStandardMaterial({ color:0x020202, roughness:0.5, metalness:0.0 }));
    visor.position.set(-0.07,1.02,0);
    group.add(visor);

    // ── Wheels ────────────────────────────────────────────────────────────────
    const tGeo = _cyl(0.45,0.45,0.2,14);
    const rGeo = _cyl(0.25,0.25,0.22,10);
    group.add(_mm([_wgeo(tGeo,0.78,-0.45,0),_wgeo(tGeo,-0.78,-0.45,0)], wheelMat));
    group.add(_mm([_wgeo(rGeo,0.78,-0.45,0),_wgeo(rGeo,-0.78,-0.45,0)], rimMat));

    // ── Headlight ─────────────────────────────────────────────────────────────
    group.add(_mm([_t(_bbox(0.12,0.18,0.18), 1.02,0.12,0)], new THREE.MeshBasicMaterial({ color: 0xffffee })));

    // ── Brake light ───────────────────────────────────────────────────────────
    group.add(_mm([_t(_bbox(0.12,0.12,0.12),-1.02,0.1,0)], brakeMat));

    // ── Blinkers ─────────────────────────────────────────────────────────────
    const bkg = _bbox(0.18,0.18,0.18);
    const leftBlinker  = _mm([_t(bkg,0.9,0.3,-0.3),_t(bkg,-0.9,0.3,-0.3)], blinkerMat);
    const rightBlinker = _mm([_t(bkg,0.9,0.3, 0.3),_t(bkg,-0.9,0.3, 0.3)], blinkerMat);
    group.add(leftBlinker, rightBlinker);

    // ── Beam ──────────────────────────────────────────────────────────────────
    const beam = new THREE.Mesh(_cyl(1.2,0.2,12,16,1,true),
      new THREE.MeshBasicMaterial({ color:0xffaa00, transparent:true, opacity:0.12, side:THREE.DoubleSide, depthWrite:false }));
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
    this.renderer.render(this.scene, this.camera);
  }
}
