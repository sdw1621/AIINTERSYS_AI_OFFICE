// 3D 타워: 프로젝트 하나에 층 하나인 미래형 유리 타워와 실제 구성원 캐릭터를 코드로 모델링한다 (외부 3D 파일 없음).
// 층을 고르면 위층을 걷어내고 그 층을 들여다본다. 사람은 일정에 따라 유리 엘리베이터를 타고 층을 옮긴다.
// app.js는 공개 메서드(addPerson, finishBuild, setState, setLabel, showBubble, hideBubble, moveTo, focusFloor, resetView, setActive)만 쓴다.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const V = (x, z, y = 0) => new THREE.Vector3(x, y, z);

// 층 평면 크기(미터)와 층 높이. agents.js의 desk 좌표(0~100%)를 이 크기에 맞춰 변환한다.
const ROOM_W = 18;
const ROOM_D = 13;
const FLOOR_H = 4.4;
let FLOORS = 5; // 생성자에서 프로젝트 수로 정한다
const floorY = (f) => (f - 1) * FLOOR_H;
let ROOF_Y = floorY(FLOORS + 1);

const AISLE_Z = 0; // 층마다 가운데를 가로지르는 통로
// 유리 엘리베이터 (왼쪽 뒤 구석)
const LIFT = V(-8.0, -4.5);
const LIFT_DOOR = V(-6.7, -4.5);
const TABLE = V(-3.6, 3.6); // 층마다 회의 테이블
const LECTERN = V(2.05, 3.7); // PBL 층 강의 화면 앞
const WALK_SPEED = 2.8;
const LIFT_SPEED = 4.2;

const STATE_COLOR = {
  idle: 0x64748b,
  present: 0x3b82f6,
  meeting: 0x10b981,
  moving: 0xf59e0b,
  thinking: 0x8b5cf6,
  searching: 0x0ea5e9,
  working: 0x10b981,
  waiting: 0xf59e0b,
  done: 0x3b82f6,
  error: 0xef4444,
};

const toWorld = (p, f) => V((p.x / 100 - 0.5) * ROOM_W, (p.y / 100 - 0.5) * ROOM_D, floorY(f));

// ── 재질 · 텍스처 도우미 ───────────────────
const matCache = new Map();
function mat(color, opts = {}) {
  // 텍스처가 들어간 재질은 캐시하지 않는다
  if (Object.values(opts).some((v) => typeof v === "object")) return new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...opts });
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...opts }));
  return matCache.get(key);
}

function canvasTexture(w, h, draw, repeat) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(...repeat);
  }
  return tex;
}

function mesh(geometry, material, { x = 0, y = 0, z = 0, cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

const box = (w, h, d, material, pos, radius = 0) =>
  mesh(radius ? new RoundedBoxGeometry(w, h, d, 3, radius) : new THREE.BoxGeometry(w, h, d), material, pos);

// 바닥 러그용 둥근 사각형 (XY 평면 → 눕혀서 사용)
function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return new THREE.ShapeGeometry(s, 10);
}

function textTexture(text, { w = 512, h = 128, bg = "#1e40af", color = "#fff", size = 64, radius = 24, sub } = {}) {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.beginPath();
    g.roundRect(0, 0, w, h, radius);
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.15)";
    g.fillRect(0, 0, w, h * 0.18);
    g.fillStyle = color;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `800 ${size}px Pretendard, 'Malgun Gothic', sans-serif`;
    g.fillText(text, w / 2, sub ? h * 0.42 : h / 2 + 3);
    if (sub) {
      g.font = `600 ${Math.round(size * 0.45)}px Pretendard, 'Malgun Gothic', sans-serif`;
      g.globalAlpha = 0.8;
      g.fillText(sub, w / 2, h * 0.78);
    }
  });
}

// 움직이지 않는 물체들을 재질별로 하나로 합쳐 그리기 횟수를 줄인다 (층마다 수백 개 → 수십 개)
function bake(group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map();
  const victims = [];
  group.traverse((o) => {
    if (!o.isMesh || o.userData.keep) return;
    const key = `${o.material.uuid}|${o.castShadow ? 1 : 0}|${o.receiveShadow ? 1 : 0}`;
    let g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((g.attributes.position.count) * 2), 2));
    g.clearGroups();
    if (!buckets.has(key)) buckets.set(key, { material: o.material, cast: o.castShadow, receive: o.receiveShadow, geos: [] });
    buckets.get(key).geos.push(g);
    victims.push(o);
  });
  for (const o of victims) o.parent.remove(o);
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false);
    if (!merged) continue;
    const m = new THREE.Mesh(merged, b.material);
    m.castShadow = b.cast;
    m.receiveShadow = b.receive;
    group.add(m);
  }
}

export class Office3D {
  constructor(container, { onSelect, onFloor, projects = [] } = {}) {
    FLOORS = Math.max(1, projects.length);
    ROOF_Y = floorY(FLOORS + 1);
    this.container = container;
    this.onSelect = onSelect;
    this.onFloor = onFloor;
    this.projects = projects;
    this.floorInfo = projects.map((p) => ({ floor: p.floor, name: `${p.floor}F ${p.short}`, project: p }));
    this.agents = new Map();
    this.clock = new THREE.Clock();
    this.tmp = new THREE.Vector3();
    this.active = true;
    this.focus = 0; // 0 = 타워 전체, n = 그 층

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels3d";
    container.append(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = this.makeSky();

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 300);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minZoom = 0.6;
    this.controls.maxZoom = 4;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = 1.35;
    this.controls.autoRotateSpeed = 0.5;

    this.floorGroups = {};
    for (let f = 1; f <= FLOORS; f++) {
      const g = new THREE.Group();
      g.position.y = floorY(f);
      this.scene.add(g);
      this.floorGroups[f] = g;
    }
    this.exterior = new THREE.Group(); // 받침대 (항상 보임)
    this.crown = new THREE.Group(); // 지붕 왕관 (전체 보기에서만)
    this.scene.add(this.exterior, this.crown);

    this.buildLights();
    for (let f = 1; f <= FLOORS; f++) this.buildFloorShell(f);
    for (const info of this.floorInfo) this.buildProjectFloor(info.floor, this.floorGroups[info.floor], info.project);
    this.buildExterior();
    this.buildFloorTags();
    this.setupPicking();

    this.view = "iso";
    this.camGoal = null;
    this.focusFloor(0, true);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // 사람 책상까지 다 만든 뒤 움직이지 않는 물체를 합친다
  finishBuild() {
    for (const g of Object.values(this.floorGroups)) bake(g);
    bake(this.exterior);
    bake(this.crown);
  }

  // ── 카메라 ──────────────────────────────
  // 시점: 입체(아이소) / 위에서. 지금 보고 있는 층은 유지한다.
  resetView(preset = "iso") {
    this.view = preset === "top" ? "top" : "iso";
    this.focusFloor(this.focus, true);
  }

  // 0 = 타워 전체, n = n층. 위층은 걷어내고, 카메라를 그 층으로 옮긴다.
  focusFloor(n, instant = false) {
    this.focus = n;
    // 층 보기에서는 그 층만 보여 준다 (아래층이 비쳐 어수선해지지 않게). 받침대는 전체 보기와 1층에서만.
    for (let f = 1; f <= FLOORS; f++) this.floorGroups[f].visible = n === 0 || f === n;
    this.crown.visible = n === 0;
    this.exterior.visible = n === 0 || n === 1;
    for (const t of this.floorTagObjs || []) t.visible = n === 0;
    const dir = this.view === "top" ? new THREE.Vector3(0.0001, 1, 0.0001) : new THREE.Vector3(1, 1.08, 1.12);
    const extra = Math.max(0, FLOORS - 3);
    const fit = n === 0 ? { h: 34 + extra * 6.2, w: 30 + extra * 2 } : this.view === "top" ? { h: 15.5, w: 21 } : { h: 14.5, w: 26 };
    const target = n === 0 ? V(0, 0.3, 6.4 + extra * 2.2) : V(0, 0.3, floorY(n) + 0.4);
    this.camGoal = { target, dir: dir.normalize(), fit };
    // 그림자 범위도 보는 곳에 맞춘다
    const s = n === 0 ? 22 + extra * 4 : 14;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).add(V(11, -7, 10));
    if (instant || !this.fit) {
      this.fit = { ...fit };
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(dir.clone().multiplyScalar(80));
      this.camera.zoom = 1;
      this.applyFrustum();
      this.controls.update();
    } else {
      this.camera.zoom = 1;
    }
    this.onFloor?.(n);
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }

  // 다른 화면에 있을 때는 그리기를 멈춘다 (캐릭터 이동 계산은 계속)
  setActive(on) {
    this.active = on;
    if (on) this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.applyFrustum();
  }

  // 화면 비율이 달라도(휴대폰 세로 화면 포함) 보려는 범위가 들어오도록 직교 카메라 범위를 맞춘다
  applyFrustum() {
    const { clientWidth: w, clientHeight: h } = this.container;
    const aspect = w && h ? w / h : 1.6;
    const fitW = aspect < 1.1 && this.focus !== 0 ? this.fit.w * 0.74 : this.fit.w;
    const height = Math.max(this.fit.h, fitW / aspect);
    const width = height * aspect;
    Object.assign(this.camera, { left: -width / 2, right: width / 2, top: height / 2, bottom: -height / 2 });
    this.camera.updateProjectionMatrix();
  }

  // 층을 옮길 때 카메라가 부드럽게 따라가게 한다
  moveCamera(dt) {
    const goal = this.camGoal;
    if (!goal) return;
    const k = 1 - Math.exp(-dt * 4);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const prev = this.controls.target.clone();
    this.controls.target.lerp(goal.target, k);
    this.camera.position.add(this.controls.target.clone().sub(prev));
    // 시점(입체/위에서)이 바뀌었으면 방향도 천천히 맞춘다
    const want = goal.dir.clone().multiplyScalar(offset.length());
    if (!this.controls.autoRotate) offset.lerp(want, k * 0.6);
    this.camera.position.copy(this.controls.target).add(offset);
    this.fit.h += (goal.fit.h - this.fit.h) * k;
    this.fit.w += (goal.fit.w - this.fit.w) * k;
    this.applyFrustum();
    if (this.controls.target.distanceTo(goal.target) < 0.01 && Math.abs(this.fit.h - goal.fit.h) < 0.01) this.camGoal = null;
  }

  makeSky() {
    const tex = canvasTexture(1024, 1024, (g, w, h) => {
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#2b2154");
      sky.addColorStop(0.2, "#5a3a86");
      sky.addColorStop(0.38, "#b2558a");
      sky.addColorStop(0.52, "#f0806c");
      sky.addColorStop(0.66, "#fbb072");
      sky.addColorStop(1, "#fcd9a2");
      g.fillStyle = sky;
      g.fillRect(0, 0, w, h);
      // 해와 빛 번짐
      const sun = g.createRadialGradient(w * 0.82, h * 0.5, 10, w * 0.82, h * 0.5, w * 0.45);
      sun.addColorStop(0, "rgba(255,236,190,0.95)");
      sun.addColorStop(0.08, "rgba(255,214,150,0.75)");
      sun.addColorStop(0.35, "rgba(255,170,110,0.25)");
      sun.addColorStop(1, "rgba(255,150,100,0)");
      g.fillStyle = sun;
      g.fillRect(0, 0, w, h);
      // 별 몇 개
      g.fillStyle = "rgba(255,255,255,0.7)";
      for (let i = 0; i < 70; i++) {
        const x = (i * 197) % w;
        const y = (i * 83) % (h * 0.2);
        g.fillRect(x, y, i % 5 === 0 ? 2 : 1, i % 5 === 0 ? 2 : 1);
      }
      // 빌딩 실루엣: 먼 층 → 가까운 층
      const layers = [
        { base: 0.5, min: 0.06, max: 0.2, color: "rgba(150,86,140,0.5)", lit: 0.1 },
        { base: 0.6, min: 0.08, max: 0.28, color: "rgba(92,56,116,0.78)", lit: 0.2 },
        { base: 0.72, min: 0.1, max: 0.34, color: "rgba(48,32,78,0.95)", lit: 0.32 },
      ];
      layers.forEach((L, li) => {
        let x = -20;
        let i = li * 7;
        while (x < w) {
          const bw = 26 + ((i * 37 + li * 11) % 54);
          const bh = h * (L.min + (((i * 53 + li * 29) % 100) / 100) * (L.max - L.min));
          const top = h * L.base - bh;
          g.fillStyle = L.color;
          g.fillRect(x, top, bw, h - top);
          if (i % 4 === 0) g.fillRect(x + bw / 2 - 1, top - 14, 2, 14); // 안테나
          for (let wy = top + 6; wy < h * L.base + 40; wy += 9) {
            for (let wx = x + 4; wx < x + bw - 4; wx += 7) {
              if (((wx * 7 + wy * 13 + i) % 100) / 100 < L.lit) {
                g.fillStyle = (wx + wy) % 3 ? "rgba(255,214,140,0.85)" : "rgba(255,240,200,0.9)";
                g.fillRect(wx, wy, 3, 4);
              }
            }
          }
          x += bw + 2 + ((i * 17) % 6);
          i++;
        }
      });
      // 지평선 아래 도시 불빛 안개
      const haze = g.createLinearGradient(0, h * 0.78, 0, h);
      haze.addColorStop(0, "rgba(40,28,70,0.0)");
      haze.addColorStop(1, "rgba(40,28,70,0.75)");
      g.fillStyle = haze;
      g.fillRect(0, h * 0.78, w, h * 0.22);
    });
    return tex;
  }

  // ── 조명: 해 질 녘 금빛 ───────────────────
  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xffe2cc, 0x6b4a7a, 1.15));
    const sun = new THREE.DirectionalLight(0xffbe86, 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { near: 1, far: 80 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    const fill = new THREE.DirectionalLight(0xd9c8ff, 0.7);
    fill.position.set(-6, 20, 14);
    this.scene.add(fill);
  }

  // ── 층 공통: 바닥판 · 마루 · 유리 커튼월 · 기둥 · 빛 기둥 · 엘리베이터 칸 ──
  buildFloorShell(f) {
    const g = this.floorGroups[f];
    const floorTex = canvasTexture(512, 512, (c, w, h) => {
      c.fillStyle = "#d9a06a";
      c.fillRect(0, 0, w, h);
      const plankH = 64;
      for (let row = 0; row < h / plankH; row++) {
        let x = -((row * 173 + f * 61) % 300);
        while (x < w) {
          const len = 220 + ((row * 97 + x) % 160);
          const l = 66 + ((row * 31 + x * 7) % 7) - (f === 3 ? 4 : 0);
          c.fillStyle = `hsl(${f === 3 ? 26 : 29}, 62%, ${l}%)`;
          c.fillRect(x + 1, row * plankH + 1, len - 2, plankH - 2);
          x += len;
        }
      }
    }, [ROOM_W / 2.4, ROOM_D / 2.4]);
    const floor = mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), mat(0xffffff, { map: floorTex, roughness: 0.6 }), { y: 0.002, cast: false });
    floor.rotation.x = -Math.PI / 2;
    g.add(floor);
    // 바닥판 (아래층의 천장 역할)
    const slab = box(ROOM_W + 0.9, 0.5, ROOM_D + 0.9, mat(0xf4ece1, { roughness: 0.8 }), { y: -0.25 }, 0.12);
    slab.castShadow = f !== 1;
    g.add(slab);
    // 바닥판 앞쪽 모서리 LED 띠
    const led = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, toneMapped: false });
    g.add(mesh(new THREE.BoxGeometry(ROOM_W + 0.92, 0.05, 0.05), led, { y: -0.12, z: ROOM_D / 2 + 0.46, cast: false, receive: false }));
    g.add(mesh(new THREE.BoxGeometry(0.05, 0.05, ROOM_D + 0.92), led, { x: ROOM_W / 2 + 0.46, y: -0.12, cast: false, receive: false }));

    // 뒤쪽·왼쪽 유리 커튼월 (카메라 쪽은 열어 둔다)
    const H = FLOOR_H - 0.5;
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.16, roughness: 0.05, transmission: 0.5, depthWrite: false });
    const frame = mat(0xc9d2e0, { metalness: 0.5, roughness: 0.35 });
    const backZ = -ROOM_D / 2 - 0.15;
    const leftX = -ROOM_W / 2 - 0.15;
    const back = mesh(new THREE.BoxGeometry(ROOM_W, H, 0.04), glass, { y: H / 2, z: backZ, cast: false });
    back.userData.keep = true; // 투명 유리는 합치지 않는다 (그리는 순서 유지)
    g.add(back);
    const left = mesh(new THREE.BoxGeometry(0.04, H, ROOM_D), glass, { x: leftX, y: H / 2, cast: false });
    left.userData.keep = true;
    g.add(left);
    for (let x = -ROOM_W / 2; x <= ROOM_W / 2 + 0.01; x += ROOM_W / 8) g.add(box(0.05, H, 0.06, frame, { x, y: H / 2, z: backZ }));
    for (let z = -ROOM_D / 2; z <= ROOM_D / 2 + 0.01; z += ROOM_D / 6) g.add(box(0.06, H, 0.05, frame, { x: leftX, y: H / 2, z }));
    g.add(box(ROOM_W, 0.05, 0.07, frame, { y: 1.05, z: backZ })); // 난간 높이 가로대
    g.add(box(0.07, 0.05, ROOM_D, frame, { x: leftX, y: 1.05 }));

    // 모서리 기둥 + 빛 기둥
    const pillar = mat(0xf8f4ee, { roughness: 0.6 });
    for (const [x, z] of [[-ROOM_W / 2 + 0.3, ROOM_D / 2 - 0.3], [ROOM_W / 2 - 0.3, -ROOM_D / 2 + 0.3], [ROOM_W / 2 - 0.3, ROOM_D / 2 - 0.3]]) {
      g.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, FLOOR_H - 0.5, 24), pillar, { x, y: (FLOOR_H - 0.5) / 2, z }));
    }
    const fin = new THREE.MeshBasicMaterial({ color: 0x7cc4ff, toneMapped: false });
    g.add(mesh(new THREE.BoxGeometry(0.06, FLOOR_H, 0.06), fin, { x: ROOM_W / 2 + 0.48, y: FLOOR_H / 2 - 0.5, z: ROOM_D / 2 + 0.48, cast: false, receive: false }));
    g.add(mesh(new THREE.BoxGeometry(0.06, FLOOR_H, 0.06), fin, { x: -ROOM_W / 2 - 0.48, y: FLOOR_H / 2 - 0.5, z: ROOM_D / 2 + 0.48, cast: false, receive: false }));
    g.add(mesh(new THREE.BoxGeometry(0.06, FLOOR_H, 0.06), fin, { x: ROOM_W / 2 + 0.48, y: FLOOR_H / 2 - 0.5, z: -ROOM_D / 2 - 0.48, cast: false, receive: false }));

    // 유리 엘리베이터 칸 (층마다 한 칸씩, 쌓이면 하나의 통로가 된다)
    const tube = new THREE.MeshPhysicalMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.22, roughness: 0.05, transmission: 0.6, depthWrite: false, side: THREE.DoubleSide });
    const shaft = mesh(new THREE.CylinderGeometry(0.85, 0.85, FLOOR_H, 32, 1, true, Math.PI * 0.2, Math.PI * 1.6), tube, { x: LIFT.x, y: FLOOR_H / 2 - 0.5, z: LIFT.z, cast: false });
    shaft.rotation.y = Math.PI / 2;
    shaft.userData.keep = true;
    g.add(shaft);
    g.add(mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.08, 32), mat(0xe5e9f0, { metalness: 0.4, roughness: 0.3 }), { x: LIFT.x, y: 0.04, z: LIFT.z }));
    g.add(mesh(new THREE.TorusGeometry(0.9, 0.04, 8, 40), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, toneMapped: false }), { x: LIFT.x, y: FLOOR_H - 0.55, z: LIFT.z, cast: false }));
    g.children.at(-1).rotation.x = Math.PI / 2;
    const liftSign = mesh(new THREE.PlaneGeometry(1.1, 0.3), new THREE.MeshBasicMaterial({ map: textTexture(`${f}F  ▲▼`, { w: 256, h: 72, size: 40, radius: 12, bg: "#1a1f2e" }), toneMapped: false }), {
      x: LIFT.x + 0.95, y: 2.6, z: LIFT.z, cast: false,
    });
    liftSign.rotation.y = Math.PI / 2;
    g.add(liftSign);
    // 가장자리 화분
    for (const [x, z, s] of [[-ROOM_W / 2 + 0.55, 2.5, 1], [ROOM_W / 2 - 0.55, -2.4, 1.05], [ROOM_W / 2 - 0.55, 2.0, 0.95], [-1.0, ROOM_D / 2 - 0.45, 0.85], [2.6, -ROOM_D / 2 + 0.5, 0.9]]) {
      this.addPlant(g, x, z, s);
    }
  }

  addPlant(parent, x, z, s = 1, y = 0) {
    const g = new THREE.Group();
    g.add(mesh(new THREE.CylinderGeometry(0.22 * s, 0.17 * s, 0.42 * s, 20), mat(0xf8f1e7, { roughness: 0.5 }), { y: 0.21 * s }));
    const leafA = mat(0x3f8f4f, { roughness: 0.8 });
    const leafB = mat(0x5aaa5c, { roughness: 0.8 });
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const l = mesh(new THREE.SphereGeometry(0.2 * s, 10, 8), i % 2 ? leafA : leafB, {
        x: Math.sin(a) * 0.17 * s, y: (0.6 + (i % 3) * 0.17) * s, z: Math.cos(a) * 0.17 * s,
      });
      l.scale.set(0.9, 1.7, 0.55);
      l.rotation.set(Math.sin(a) * 0.5, a, Math.cos(a) * 0.5);
      g.add(l);
    }
    g.add(mesh(new THREE.SphereGeometry(0.2 * s, 12, 10), leafB, { y: 1.05 * s }));
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  }

  // ── 프로젝트 층: 뒤쪽 구성원 책상 줄 · 간판 · 왼쪽 앞 회의 테이블 · 프로젝트별 공간 ──
  buildProjectFloor(f, g, p) {
    const color = new THREE.Color(p.color);
    const tint = new THREE.Color(0xf6dcc0).lerp(color, 0.36).getHex();
    const rug = mesh(roundedRect(15.6, 4.4, 0.8), mat(tint, { roughness: 1, side: THREE.DoubleSide }), { x: 1.4, y: 0.005, z: -3.7, cast: false });
    rug.rotation.x = -Math.PI / 2;
    g.add(rug);
    // 뒤쪽 간판
    const sub = p.group ? `${f}F · ${p.group}` : `${f}F · ${p.title || "프로젝트"}`;
    const tex = textTexture(p.short, { w: 1024, h: 230, size: 98, radius: 36, bg: p.color, sub });
    g.add(mesh(new THREE.PlaneGeometry(4.6, 1.03), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.32 }), { x: 1.4, y: 2.85, z: -ROOM_D / 2 + 0.12, cast: false }));
    g.add(box(4.8, 0.08, 0.1, mat(0x2a2f3d), { x: 1.4, y: 2.28, z: -ROOM_D / 2 + 0.1 }));

    // 회의 테이블 (왼쪽 앞)
    const tr = mesh(new THREE.CircleGeometry(1.9, 48), mat(new THREE.Color(0xf3d2b3).lerp(color, 0.15).getHex(), { roughness: 1, side: THREE.DoubleSide }), { x: TABLE.x, y: 0.006, z: TABLE.z, cast: false });
    tr.rotation.x = -Math.PI / 2;
    g.add(tr);
    g.add(mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.07, 48), mat(0xc58a55, { roughness: 0.45 }), { x: TABLE.x, y: 0.74, z: TABLE.z }));
    g.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.7, 16), mat(0x5b4636), { x: TABLE.x, y: 0.36, z: TABLE.z }));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.25;
      const chair = this.makeChair(new THREE.Color(p.color).lerp(new THREE.Color(0xf08a4b), 0.5).getHex(), 0.8);
      chair.position.set(TABLE.x + Math.sin(a) * 1.28, 0, TABLE.z + Math.cos(a) * 1.28);
      chair.rotation.y = a + Math.PI;
      g.add(chair);
    }
    this.addPlant(g, TABLE.x, TABLE.z, 0.35, 0.78);

    if (p.id === "kriso") {
      // 지식그래프 대형 화면 + 자료 책장
      this.addGraphScreen(g, 4.9, 3.5, p.color);
      this.addBookshelf(g, -ROOM_W / 2 + 0.35, 1.0);
    } else if (p.group) {
      // PBL 교육장: 강의 화면 + 교육생 책상 2줄
      this.addLectureArea(g, p);
    } else {
      // 상담 라운지
      this.addSofa(g, 6.8, 5.2, Math.PI);
      g.add(box(1.0, 0.34, 0.7, mat(0xb98a5e), { x: 6.8, y: 0.17, z: 3.9 }, 0.06));
      this.addSofa(g, 6.8, 2.6, 0);
      this.addWhiteboard(g, 2.4, 4.6);
      this.addBookshelf(g, -ROOM_W / 2 + 0.35, 1.0);
    }
  }

  addGraphScreen(g, x, z, color) {
    const tex = canvasTexture(768, 432, (c, w, h) => {
      c.fillStyle = "#0b1726";
      c.fillRect(0, 0, w, h);
      const nodes = [];
      for (let i = 0; i < 26; i++) nodes.push([60 + ((i * 197) % (w - 120)), 70 + ((i * 113) % (h - 120))]);
      c.strokeStyle = "rgba(140,200,255,0.45)";
      c.lineWidth = 2;
      nodes.forEach(([x1, y1], i) => {
        for (const j of [(i * 7 + 3) % nodes.length, (i * 11 + 5) % nodes.length]) {
          c.beginPath();
          c.moveTo(x1, y1);
          c.lineTo(...nodes[j]);
          c.stroke();
        }
      });
      nodes.forEach(([x1, y1], i) => {
        c.fillStyle = i % 5 === 0 ? color : i % 3 ? "#7dd3fc" : "#fbbf24";
        c.beginPath();
        c.arc(x1, y1, i % 5 === 0 ? 12 : 7, 0, Math.PI * 2);
        c.fill();
      });
      c.fillStyle = "#e0f2fe";
      c.font = "700 30px Pretendard, sans-serif";
      c.fillText("MARITIME ONTOLOGY", 24, 40);
    });
    const s = new THREE.Group();
    s.add(box(3.2, 1.9, 0.08, mat(0x111827, { roughness: 0.4 }), { y: 1.65 }, 0.03));
    s.add(mesh(new THREE.PlaneGeometry(3.05, 1.72), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), { y: 1.65, z: 0.045, cast: false }));
    for (const sx of [-1.2, 1.2]) s.add(box(0.06, 0.7, 0.06, mat(0x9ca3af, { metalness: 0.5 }), { x: sx, y: 0.35 }));
    s.add(box(2.8, 0.05, 0.5, mat(0x9ca3af, { metalness: 0.5 }), { y: 0.03 }));
    s.position.set(x, 0, z);
    s.rotation.y = 0.7; // 카메라 쪽을 바라보게
    g.add(s);
  }

  addLectureArea(g, p) {
    // 강의 화면 (교육생 쪽을 바라봄)
    const tex = canvasTexture(640, 360, (c, w, h) => {
      c.fillStyle = "#f8fafc";
      c.fillRect(0, 0, w, h);
      c.fillStyle = p.color;
      c.fillRect(0, 0, w, 64);
      c.fillStyle = "#fff";
      c.font = "700 30px Pretendard, sans-serif";
      c.fillText(`${p.short} AX PBL`, 22, 43);
      c.fillStyle = "#1f2937";
      c.font = "600 22px Pretendard, sans-serif";
      (p.strategies || []).forEach((t, i) => c.fillText(`${i + 1}. ${t}`.slice(0, 30), 26, 112 + i * 52));
    });
    const scr = new THREE.Group();
    scr.add(box(2.6, 1.5, 0.06, mat(0x1f2937), { y: 1.6 }, 0.02));
    scr.add(mesh(new THREE.PlaneGeometry(2.48, 1.38), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), { y: 1.6, z: 0.035, cast: false }));
    for (const sx of [-1.1, 1.1]) scr.add(box(0.05, 0.85, 0.05, mat(0x9ca3af, { metalness: 0.5 }), { x: sx, y: 0.42 }));
    scr.position.set(1.4, 0, 3.7);
    scr.rotation.y = Math.PI / 2;
    g.add(scr);
    // 교육생 책상 2줄 × 3
    const top = mat(0xf6efe6, { roughness: 0.45 });
    const leg = mat(0xb98a5e, { roughness: 0.6 });
    const chairColor = new THREE.Color(p.color).lerp(new THREE.Color(0x1f2937), 0.3).getHex();
    for (const x of [3.6, 5.6, 7.6]) {
      for (const z of [2.5, 4.9]) {
        g.add(box(0.8, 0.05, 1.5, top, { x, y: 0.72, z }, 0.02));
        for (const dz of [-0.62, 0.62]) g.add(box(0.7, 0.7, 0.05, leg, { x, y: 0.35, z: z + dz }));
        for (const dz of [-0.4, 0.4]) {
          g.add(box(0.36, 0.02, 0.26, mat(0x374151), { x: x - 0.05, y: 0.76, z: z + dz }));
          const ch = this.makeChair(chairColor, 0.78);
          ch.position.set(x + 0.62, 0, z + dz);
          ch.rotation.y = -Math.PI / 2;
          g.add(ch);
        }
      }
    }
  }

  addSofa(g, x, z, rot) {
    const s = new THREE.Group();
    const fabric = mat(0xf3ebe0, { roughness: 0.95 });
    s.add(box(2.2, 0.42, 0.9, fabric, { y: 0.26 }, 0.1));
    s.add(box(2.2, 0.6, 0.24, fabric, { y: 0.62, z: -0.34 }, 0.1));
    s.add(box(0.22, 0.58, 0.9, fabric, { x: -1.1, y: 0.42 }, 0.1));
    s.add(box(0.22, 0.58, 0.9, fabric, { x: 1.1, y: 0.42 }, 0.1));
    s.add(box(0.5, 0.36, 0.13, mat(0xf08a4b), { x: -0.55, y: 0.64, z: -0.18 }, 0.06));
    s.add(box(0.5, 0.36, 0.13, mat(0x3f8f4f), { x: 0.55, y: 0.64, z: -0.18 }, 0.06));
    s.position.set(x, 0, z);
    s.rotation.y = rot;
    g.add(s);
  }

  addBookshelf(g, x, z) {
    const shelf = new THREE.Group();
    shelf.add(box(0.4, 2.2, 2.4, mat(0xb98a5e, { roughness: 0.7 }), { y: 1.1 }));
    const colors = [0x1e40af, 0xf59e0b, 0x10b981, 0xef4444, 0x8b5cf6, 0xf8fafc, 0x0ea5e9, 0xf08a4b];
    for (let r = 0; r < 4; r++) {
      shelf.add(box(0.42, 0.04, 2.3, mat(0x8a6644), { x: 0.02, y: 0.3 + r * 0.52 }));
      let zz = -1.05;
      let i = r * 3;
      while (zz < 1.0) {
        const w = 0.07 + ((i * 13) % 5) * 0.015;
        const hh = 0.3 + ((i * 7) % 4) * 0.04;
        shelf.add(box(0.28, hh, w, mat(colors[i % colors.length], { roughness: 0.6 }), { x: 0.08, y: 0.32 + r * 0.52 + hh / 2, z: zz + w / 2 }));
        zz += w + 0.01;
        i++;
      }
    }
    shelf.position.set(x, 0, z);
    g.add(shelf);
  }

  addWhiteboard(g, x, z) {
    const board = canvasTexture(512, 256, (c, w, h) => {
      c.fillStyle = "#fbfbf9";
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#1e40af";
      c.font = "700 26px Pretendard, sans-serif";
      c.fillText("PoC BOARD", 18, 36);
      const notes = ["#fde68a", "#bbf7d0", "#bfdbfe", "#fecaca", "#ddd6fe"];
      for (let i = 0; i < 9; i++) {
        c.fillStyle = notes[i % notes.length];
        c.fillRect(20 + (i % 3) * 160, 60 + Math.floor(i / 3) * 62, 130, 50);
      }
    });
    const wb = new THREE.Group();
    wb.add(box(2.1, 1.1, 0.05, mat(0xd1d5db, { metalness: 0.4 }), { y: 1.5 }));
    wb.add(mesh(new THREE.PlaneGeometry(2.0, 1.0), mat(0xffffff, { map: board, roughness: 0.3 }), { y: 1.5, z: 0.03, cast: false }));
    for (const sx of [-0.95, 0.95]) wb.add(box(0.05, 1.5, 0.05, mat(0x9ca3af, { metalness: 0.5 }), { x: sx, y: 0.75 }));
    wb.position.set(x, 0, z);
    wb.rotation.y = -0.5;
    g.add(wb);
  }

  addArcade(g, x, z, color) {
    const a = new THREE.Group();
    a.add(box(0.7, 1.7, 0.6, mat(color, { roughness: 0.5 }), { y: 0.85 }, 0.04));
    const scr = canvasTexture(128, 128, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, w, h);
      gr.addColorStop(0, "#1e1b4b");
      gr.addColorStop(1, "#7c3aed");
      c.fillStyle = gr;
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#fde047";
      c.fillRect(20, 80, 14, 14);
      c.fillStyle = "#f472b6";
      for (let i = 0; i < 5; i++) c.fillRect(20 + i * 20, 20, 12, 10);
    });
    const screen = mesh(new THREE.PlaneGeometry(0.52, 0.45), new THREE.MeshBasicMaterial({ map: scr, toneMapped: false }), { y: 1.25, z: 0.305, cast: false });
    screen.rotation.x = -0.15;
    a.add(screen);
    a.add(box(0.72, 0.1, 0.35, mat(0x111827), { y: 0.92, z: 0.38 }));
    a.position.set(x, 0, z);
    g.add(a);
  }

  // ── 외관: 받침대(로비) · 지붕 왕관 · 안테나 ──
  buildExterior() {
    // 왕관 유리: 푸른 유리판 + 은은한 세로 빛줄 (금속 반사 대신 자체 발광으로 표현)
    const glassTex = canvasTexture(256, 128, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, "#3b5f9e");
      gr.addColorStop(1, "#22355e");
      c.fillStyle = gr;
      c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 32) {
        c.fillStyle = "rgba(160,210,255,0.35)";
        c.fillRect(x, 0, 2, h);
      }
      c.fillStyle = "rgba(255,255,255,0.12)";
      c.fillRect(0, h * 0.15, w, h * 0.12);
    }, [4, 1]);
    const darkGlass = mat(0xffffff, { map: glassTex, emissive: 0xffffff, emissiveMap: glassTex, emissiveIntensity: 0.55, roughness: 0.3 });
    // 받침대: 불 켜진 창이 있는 짙은 유리 기단
    const winTex = canvasTexture(512, 256, (c, w, h) => {
      c.fillStyle = "#1b2238";
      c.fillRect(0, 0, w, h);
      for (let y = 10; y < h; y += 26) for (let x = 6; x < w; x += 22) {
        c.fillStyle = (x * 7 + y * 3) % 5 === 0 ? "rgba(255,214,140,0.9)" : "rgba(120,160,220,0.35)";
        c.fillRect(x, y, 14, 16);
      }
    }, [3, 2]);
    const podium = box(ROOM_W + 1.6, 9, ROOM_D + 1.6, mat(0xffffff, { map: winTex, emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: 0.35, roughness: 0.4 }), { y: -0.55 - 4.5 });
    this.exterior.add(podium);
    this.exterior.add(box(ROOM_W + 2.2, 0.3, ROOM_D + 2.2, mat(0xf4ece1), { y: -0.62 }, 0.1));
    // 입구 캐노피 + 이름
    const sign = textTexture("AIINTERSYS AI TOWER", { w: 1024, h: 160, size: 84, radius: 20, bg: "#0f172a", color: "#bfe3ff" });
    this.exterior.add(mesh(new THREE.PlaneGeometry(7, 1.1), new THREE.MeshBasicMaterial({ map: sign, toneMapped: false }), { y: -1.6, z: ROOM_D / 2 + 0.81, cast: false }));

    // 지붕 (3F의 천장) + 계단식 유리 왕관
    const c = this.crown;
    c.add(box(ROOM_W + 0.9, 0.5, ROOM_D + 0.9, mat(0xf4ece1, { roughness: 0.8 }), { y: ROOF_Y - 0.25 }, 0.12));
    const band = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, toneMapped: false });
    const tiers = [
      { w: ROOM_W - 1.5, d: ROOM_D - 1.5, h: 1.6 },
      { w: ROOM_W - 6, d: ROOM_D - 4.5, h: 1.8 },
      { w: 5, d: 4, h: 1.8 },
    ];
    let y = ROOF_Y;
    tiers.forEach((t) => {
      c.add(box(t.w, t.h, t.d, darkGlass, { y: y + t.h / 2 }));
      c.add(mesh(new THREE.BoxGeometry(t.w + 0.04, 0.06, t.d + 0.04), band, { y: y + t.h - 0.05, cast: false, receive: false }));
      y += t.h;
    });
    // 왕관 앞면 사인
    const crownSign = textTexture("AIINTERSYS", { w: 1024, h: 200, size: 120, radius: 16, bg: "rgba(0,0,0,0)", color: "#e0f2ff" });
    c.add(mesh(new THREE.PlaneGeometry(9, 1.3), new THREE.MeshBasicMaterial({ map: crownSign, transparent: true, toneMapped: false }), { y: ROOF_Y + 0.8, z: (ROOM_D - 1.5) / 2 + 0.03, cast: false }));
    // 옥상 정원 화분
    for (const [x, z] of [[-7.2, 4.8], [-7.2, -4.8], [7.2, 4.8], [7.2, -4.8]]) this.addPlant(c, x, z, 0.9, ROOF_Y);
    // 안테나 + 불빛
    c.add(mesh(new THREE.CylinderGeometry(0.06, 0.1, 4.5, 10), mat(0xd1d5db, { metalness: 0.7 }), { y: y + 2.25 }));
    const beacon = mesh(new THREE.SphereGeometry(0.22, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff4d4d, toneMapped: false }), { y: y + 4.6, cast: false });
    beacon.userData.keep = true;
    c.add(beacon);
    this.beacon = beacon;
  }

  // 전체 보기에서 층마다 이름표 (누르면 그 층으로)
  buildFloorTags() {
    this.floorTagObjs = [];
    for (const info of this.floorInfo) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "floor-tag3d";
      el.innerHTML = `${info.name}<small>들어가 보기 →</small>`;
      el.addEventListener("click", () => this.focusFloor(info.floor));
      const tag = new CSS2DObject(el);
      tag.position.set(ROOM_W / 2 + 1.2, floorY(info.floor) + 2, ROOM_D / 2 + 1.2);
      this.scene.add(tag);
      this.floorTagObjs.push(tag);
    }
  }

  makeChair(color = 0x1f2937, scale = 1) {
    const g = new THREE.Group();
    const fabric = mat(color, { roughness: 0.85 });
    const metal = mat(0x374151, { metalness: 0.6, roughness: 0.35 });
    g.add(box(0.5, 0.08, 0.48, fabric, { y: 0.48 }, 0.03));
    g.add(box(0.48, 0.55, 0.07, fabric, { y: 0.8, z: -0.22 }, 0.03));
    g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 10), metal, { y: 0.26 }));
    for (let i = 0; i < 5; i++) {
      const leg = box(0.3, 0.03, 0.04, metal, { y: 0.05 });
      leg.rotation.y = (i / 5) * Math.PI * 2;
      leg.translateX(0.15);
      g.add(leg);
    }
    g.scale.setScalar(scale);
    return g;
  }

  // ── 책상 (사람 한 명이 여러 층에 자리를 가질 수 있다) ──
  buildSeat(seat, def) {
    const g = new THREE.Group();
    const top = mat(0xf6efe6, { roughness: 0.45 });
    const legMat = mat(0xb98a5e, { roughness: 0.6 });
    g.add(box(1.7, 0.05, 0.85, top, { y: 0.74 }, 0.02));
    for (const sx of [-0.78, 0.78]) g.add(box(0.05, 0.72, 0.7, legMat, { x: sx, y: 0.36 }));
    g.add(box(0.06, 0.25, 0.06, mat(0x374151), { y: 0.88, z: 0.12 }));
    g.add(box(0.72, 0.44, 0.04, mat(0x111827, { roughness: 0.4 }), { y: 1.13, z: 0.12 }, 0.015));
    seat.screenMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, emissive: STATE_COLOR.idle, emissiveIntensity: 0.25, roughness: 0.2 });
    const screen = mesh(new THREE.PlaneGeometry(0.66, 0.38), seat.screenMat, { y: 1.13, z: 0.095, cast: false });
    screen.rotation.y = Math.PI;
    screen.userData.keep = true;
    g.add(screen);
    g.add(box(0.45, 0.02, 0.14, mat(0x1f2937), { y: 0.775, z: -0.18 }, 0.008));
    g.add(mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 16), mat(new THREE.Color(seat.color).getHex()), { x: 0.55, y: 0.82, z: -0.1 }));
    // 책상 앞판: 이름 + 이 층에서의 역할
    const panelTex = textTexture(`${def.name} ${seat.role}`, { w: 512, h: 128, size: 54, radius: 0, bg: seat.color });
    g.add(mesh(new THREE.PlaneGeometry(1.6, 0.4), new THREE.MeshStandardMaterial({ map: panelTex, emissive: 0xffffff, emissiveMap: panelTex, emissiveIntensity: 0.2, roughness: 0.6 }), { y: 0.47, z: 0.44, cast: false }));
    seat.ledMat = new THREE.MeshBasicMaterial({ color: STATE_COLOR.idle, toneMapped: false });
    const led = mesh(new THREE.BoxGeometry(1.6, 0.03, 0.01), seat.ledMat, { y: 0.69, z: 0.44, cast: false });
    led.userData.keep = true;
    g.add(led);
    const chair = this.makeChair(new THREE.Color(seat.color).lerp(new THREE.Color(0x1f2937), 0.35).getHex());
    chair.position.set(0, 0, -1.3);
    g.add(chair);
    g.position.set(seat.deskPos.x, 0, seat.deskPos.z);
    this.floorGroups[seat.floor].add(g);
  }

  buildCharacter(def) {
    const look = def.look || {};
    const skin = mat(0xf2c9a8, { roughness: 0.6 });
    const outfit = mat(new THREE.Color(look.outfit || def.color).getHex(), { roughness: 0.75 });
    const shirt = mat(new THREE.Color(look.shirt || "#ffffff").getHex(), { roughness: 0.8 });
    const pants = mat(new THREE.Color(look.pants || "#1f2937").getHex(), { roughness: 0.8 });
    const hairMat = mat(new THREE.Color(look.hairColor || "#1a1a1a").getHex(), { roughness: 0.9 });
    const shoe = mat(0x1a1a1a, { roughness: 0.5 });

    const root = new THREE.Group();
    const body = new THREE.Group(); // 걸을 때 위아래로 흔들리는 부분
    root.add(body);

    const limb = (radius, length, material, x, y) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const m = mesh(new THREE.CapsuleGeometry(radius, length, 4, 10), material, { y: -length / 2 - radius * 0.5 });
      pivot.add(m);
      body.add(pivot);
      return pivot;
    };
    const legL = limb(0.075, 0.62, pants, -0.1, 0.82);
    const legR = limb(0.075, 0.62, pants, 0.1, 0.82);
    for (const leg of [legL, legR]) leg.add(box(0.12, 0.07, 0.22, shoe, { y: -0.8, z: 0.04 }, 0.03));

    const torso = mesh(new THREE.CapsuleGeometry(0.21, 0.4, 6, 14), outfit, { y: 1.12 });
    torso.scale.set(1, 1, 0.72);
    body.add(torso);
    // 셔츠 앞섶
    const collar = mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.3, 3), shirt, { y: 1.28, z: 0.12 });
    collar.rotation.x = 0.12;
    collar.rotation.y = Math.PI;
    collar.scale.set(1, 1, 0.4);
    body.add(collar);

    const armL = limb(0.06, 0.5, outfit, -0.28, 1.4);
    const armR = limb(0.06, 0.5, outfit, 0.28, 1.4);
    for (const arm of [armL, armR]) arm.add(mesh(new THREE.SphereGeometry(0.065, 10, 8), skin, { y: -0.66 }));

    const head = new THREE.Group();
    head.position.y = 1.64;
    body.add(head);
    head.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 12), skin, { y: -0.14 }));
    const skull = mesh(new THREE.SphereGeometry(0.17, 24, 18), skin, { y: 0.02 });
    skull.scale.set(0.95, 1.05, 0.98);
    head.add(skull);
    const eye = mat(0x1a1a1a, { roughness: 0.3 });
    for (const ex of [-0.06, 0.06]) head.add(mesh(new THREE.SphereGeometry(0.02, 8, 6), eye, { x: ex, y: 0.04, z: 0.155, cast: false }));
    head.add(mesh(new THREE.SphereGeometry(0.022, 8, 6), mat(0xe0a98a), { y: -0.01, z: 0.168, cast: false }));
    const smile = mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 12, Math.PI), mat(0x9a4a3a), { y: -0.05, z: 0.155, cast: false });
    smile.rotation.z = Math.PI;
    head.add(smile);

    // 머리 모양
    const cap = mesh(new THREE.SphereGeometry(0.18, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat, { y: 0.04 });
    cap.rotation.x = -0.25;
    head.add(cap);
    if (look.hair === "bob") {
      const bob = mesh(new THREE.CylinderGeometry(0.2, 0.21, 0.26, 24, 1, true, Math.PI * 0.14, Math.PI * 1.72), hairMat, { y: -0.04 });
      bob.material = hairMat.clone();
      bob.material.side = THREE.DoubleSide;
      head.add(bob);
    } else if (look.hair === "long") {
      const back = box(0.34, 0.5, 0.1, hairMat, { y: -0.14, z: -0.12 }, 0.05);
      head.add(back);
      for (const sx of [-0.16, 0.16]) head.add(box(0.07, 0.42, 0.12, hairMat, { x: sx, y: -0.12, z: 0.0 }, 0.03));
    } else if (look.hair === "pony") {
      head.add(mesh(new THREE.SphereGeometry(0.06, 10, 8), hairMat, { y: 0.02, z: -0.2 }));
      const tail = mesh(new THREE.CapsuleGeometry(0.045, 0.22, 4, 8), hairMat, { y: -0.14, z: -0.22 });
      tail.rotation.x = 0.2;
      head.add(tail);
    }
    if (look.glasses) {
      const frame = mat(0x2b2b2b, { metalness: 0.3 });
      for (const ex of [-0.06, 0.06]) head.add(mesh(new THREE.TorusGeometry(0.04, 0.006, 6, 16), frame, { x: ex, y: 0.04, z: 0.165, cast: false }));
      head.add(box(0.04, 0.006, 0.006, frame, { y: 0.045, z: 0.17 }));
    }

    // 들고 다니는 서류 (오른손)
    const prop = new THREE.Group();
    prop.add(box(0.22, 0.3, 0.02, mat(0x8b5e34), {}));
    prop.add(box(0.19, 0.25, 0.022, mat(0xffffff), { y: -0.01, z: 0.003 }));
    prop.position.set(0.02, -0.66, 0.1);
    prop.rotation.x = -0.4;
    prop.visible = false;
    armR.add(prop);

    // 발밑 상태 링
    const ringMat = new THREE.MeshBasicMaterial({ color: STATE_COLOR.idle, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false });
    const ring = mesh(new THREE.RingGeometry(0.34, 0.44, 40), ringMat, { y: 0.012, cast: false, receive: false });
    ring.rotation.x = -Math.PI / 2;
    root.add(ring);

    root.traverse((o) => (o.userData.agentId = def.id));
    return { root, body, legL, legR, armL, armR, head, prop, ringMat };
  }

  // ── 이름표 · 말풍선 (HTML 오버레이) ────────
  buildLabel(a) {
    const el = document.createElement("div");
    el.className = "tag3d";
    el.innerHTML = `<div class="bubble3d"></div>
      <button type="button" class="card3d" style="--c:${a.def.color}">
        <img src="${a.def.photo}" alt="" />
        <span class="card3d-text"><b>${a.def.name}</b><small class="sub3d">${a.def.title}</small></span>
        <i class="dot3d" data-state="idle"></i>
      </button>`;
    el.querySelector(".card3d").addEventListener("click", () => this.onSelect?.(a.def.id));
    const label = new CSS2DObject(el);
    label.position.set(0, 2.2, 0);
    a.parts.root.add(label);
    a.label = label;
    a.bubbleEl = el.querySelector(".bubble3d");
    a.dotEl = el.querySelector(".dot3d");
    a.subEl = el.querySelector(".sub3d");
  }

  // ── 공개 API ─────────────────────────────
  // seats: [{floor, desk:{x,y}(%), role, color}] — 그 층에 있는 자기 책상. homeFloor 책상에서 시작한다.
  addPerson(def, seats, homeFloor) {
    const seatAt = {};
    for (const s of seats) {
      const deskPos = toWorld(s.desk, s.floor);
      seatAt[s.floor] = { ...s, deskPos, home: deskPos.clone().add(V(0, -0.85)) };
      this.buildSeat(seatAt[s.floor], def);
    }
    const start = seatAt[homeFloor] || Object.values(seatAt)[0];
    const a = { def, seats: seatAt, spot: { floor: start.floor, kind: "desk" }, spotKey: `${start.floor}|desk|0`, path: [], restYaw: 0, yaw: 0, walkYaw: 0, state: "idle", stateSince: 0, queue: Promise.resolve() };
    a.parts = this.buildCharacter(def);
    a.parts.root.position.copy(start.home);
    this.scene.add(a.parts.root);
    this.buildLabel(a);
    this.agents.set(def.id, a);
  }

  setState(id, state) {
    const a = this.agents.get(id);
    if (!a || a.state === state) return;
    a.state = state;
    a.stateSince = this.clock.elapsedTime;
    const color = STATE_COLOR[state] ?? STATE_COLOR.idle;
    a.parts.ringMat.color.setHex(color);
    a.dotEl.dataset.state = state;
    const seat = a.seats[a.spot.floor];
    for (const s of Object.values(a.seats)) {
      const here = s === seat && a.spot.kind === "desk";
      s.ledMat.color.setHex(here ? color : STATE_COLOR.idle);
      s.screenMat.emissive.setHex(here ? color : STATE_COLOR.idle);
      s.screenMat.emissiveIntensity = here ? 1.1 : 0.2;
    }
  }

  setLabel(id, sub) {
    const a = this.agents.get(id);
    if (a && a.subEl.textContent !== sub) a.subEl.textContent = sub;
  }

  showBubble(id, kind, text) {
    const a = this.agents.get(id);
    if (!a) return;
    a.bubbleEl.className = `bubble3d show ${kind}`;
    a.bubbleEl.textContent = text;
  }

  hideBubble(id) {
    this.agents.get(id)?.bubbleEl.classList.remove("show");
  }

  floorOfPerson(id) {
    const a = this.agents.get(id);
    return a ? a.spot.floor : 0;
  }

  // dest: {floor, kind: "desk" | "meeting", slot} — 걸어서(다른 층이면 엘리베이터 타고) 그 자리로 간다.
  moveTo(id, dest, { instant = false } = {}) {
    const a = this.agents.get(id);
    if (!a) return Promise.resolve();
    const key = `${dest.floor}|${dest.kind}|${dest.slot || 0}`;
    const job = a.queue.then(async () => {
      if (a.spotKey === key) return;
      const target = this.spotPoint(a, dest);
      const kind = this.kindAt(a, dest);
      const yaw = kind === "lecture" ? Math.PI / 2 : kind === "meeting" ? Math.atan2(TABLE.x - target.x, TABLE.z - target.z) : 0;
      if (instant) {
        a.path = [];
        a.parts.root.position.copy(target);
      } else {
        await this.walk(a, this.planPath(a, target, dest));
      }
      a.restYaw = yaw;
      a.spot = { ...dest, kind };
      a.spotKey = key;
    });
    a.queue = job.catch(() => {});
    return job;
  }

  // 그 층에 자리가 없으면 회의 테이블로, 강의 공간이 없는 층이면 회의 테이블로
  kindAt(a, dest) {
    if (dest.kind === "desk") return a.seats[dest.floor] ? "desk" : "meeting";
    if (dest.kind === "lecture") return this.floorInfo.find((f) => f.floor === dest.floor)?.project.group ? "lecture" : "meeting";
    return "meeting";
  }

  spotPoint(a, dest) {
    const kind = this.kindAt(a, dest);
    if (kind === "desk") return a.seats[dest.floor].home.clone();
    if (kind === "lecture") return V(LECTERN.x, LECTERN.z, floorY(dest.floor));
    const ang = ((dest.slot || 0) / 6) * Math.PI * 2 + 0.25;
    return V(TABLE.x + Math.sin(ang) * 1.28, TABLE.z + Math.cos(ang) * 1.28, floorY(dest.floor));
  }

  // 지금 자리 → 통로 → (다른 층이면 엘리베이터) → 통로 → 목적지. 책상·회의 테이블은 돌아서 간다.
  planPath(a, target, dest) {
    const pos = a.parts.root.position;
    const ya = pos.y;
    const yt = floorY(dest.floor);
    const pts = [];
    const tableSide = (p) => {
      const dx = p.x - TABLE.x;
      return dx >= 0 ? 1 : -1;
    };
    const leaveTable = (p, y) => {
      const s = tableSide(p);
      const ang = Math.atan2(p.x - TABLE.x, p.z - TABLE.z);
      pts.push(V(TABLE.x + Math.sin(ang) * 1.95, TABLE.z + Math.cos(ang) * 1.95, y), V(TABLE.x + s * 2.15, TABLE.z + Math.cos(ang) * 1.95, y), V(TABLE.x + s * 2.15, AISLE_Z, y));
    };
    const kind = this.kindAt(a, dest);
    // 출발
    if (a.spot.kind === "desk") pts.push(V(pos.x + 1.05, pos.z, ya), V(pos.x + 1.05, AISLE_Z, ya));
    else if (a.spot.kind === "lecture") pts.push(V(pos.x, AISLE_Z, ya));
    else leaveTable(pos, ya);
    // 층 이동
    if (Math.abs(ya - yt) > 0.01) {
      pts.push(V(LIFT_DOOR.x, AISLE_Z, ya), V(LIFT_DOOR.x, LIFT_DOOR.z, ya), V(LIFT.x, LIFT.z, ya), V(LIFT.x, LIFT.z, yt), V(LIFT_DOOR.x, LIFT_DOOR.z, yt), V(LIFT_DOOR.x, AISLE_Z, yt));
    }
    // 도착
    if (kind === "lecture") {
      pts.push(V(target.x, AISLE_Z, yt), target.clone());
    } else if (kind === "desk") {
      pts.push(V(target.x + 1.05, AISLE_Z, yt), V(target.x + 1.05, target.z, yt), target.clone());
    } else {
      const s = tableSide(target);
      const ang = Math.atan2(target.x - TABLE.x, target.z - TABLE.z);
      pts.push(V(TABLE.x + s * 2.15, AISLE_Z, yt), V(TABLE.x + s * 2.15, TABLE.z + Math.cos(ang) * 1.95, yt), V(TABLE.x + Math.sin(ang) * 1.95, TABLE.z + Math.cos(ang) * 1.95, yt), target.clone());
    }
    return pts;
  }

  walk(a, points) {
    return new Promise((resolve) => {
      a.path = points.map((p) => p.clone());
      a.onArrive = resolve;
    });
  }

  wait(seconds) {
    return new Promise((r) => setTimeout(r, seconds * 1000));
  }

  floorOf(a) {
    return THREE.MathUtils.clamp(Math.round(a.parts.root.position.y / FLOOR_H) + 1, 1, FLOORS);
  }

  get liftBusy() {
    return [...this.agents.values()].some((a) => a.riding);
  }

  // ── 클릭으로 인물 선택 ─────────────────────
  setupPicking() {
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = null;
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const rect = el.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(pointer, this.camera);
      const roots = [...this.agents.values()].filter((a) => a.parts.root.visible).map((a) => a.parts.root);
      const hit = ray.intersectObjects(roots, true)[0];
      if (hit?.object.userData.agentId) {
        this.onSelect?.(hit.object.userData.agentId);
        return;
      }
      // 전체 보기에서 층을 누르면 그 층으로 들어간다
      if (this.focus === 0) {
        const groups = Object.entries(this.floorGroups);
        for (const [f, g] of groups.reverse()) {
          if (ray.intersectObject(g, true)[0]) return this.focusFloor(Number(f));
        }
      }
    });
  }

  // ── 매 프레임 ────────────────────────────
  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const h = this.container.clientHeight;
    for (const a of this.agents.values()) {
      this.animateAgent(a, dt, t);
      // 보고 있는 층의 사람만 보이고, 전체 보기에서는 이름표를 숨긴다
      const f = this.floorOf(a);
      const visible = this.focus === 0 ? true : f === this.focus;
      a.parts.root.visible = visible;
      a.label.visible = visible && this.focus !== 0;
      if (a.label.visible) {
        this.tmp.copy(a.parts.root.position).setY(a.parts.root.position.y + 2.2).project(this.camera);
        a.bubbleEl.classList.toggle("below", (1 - this.tmp.y) * 0.5 * h < 150);
      }
    }
    if (this.beacon) this.beacon.material.color.setHex(Math.sin(t * 3) > 0 ? 0xff4d4d : 0x661a1a);
    if (!this.active) return;
    this.moveCamera(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  animateAgent(a, dt, t) {
    const p = a.parts;
    const pos = p.root.position;
    let walking = false;

    a.riding = false;
    if (a.path.length && Math.abs(a.path[0].y - pos.y) > 0.01) {
      // 엘리베이터: 제자리에서 위아래로만 움직인다
      const target = a.path[0];
      a.riding = true;
      const dy = target.y - pos.y;
      const step = LIFT_SPEED * dt;
      if (Math.abs(dy) <= step) {
        pos.y = target.y;
        a.path.shift();
        if (!a.path.length) {
          a.onArrive?.();
          a.onArrive = null;
        }
      } else {
        pos.y += Math.sign(dy) * step;
      }
    } else if (a.path.length) {
      walking = true;
      const target = a.path[0];
      const to = target.clone().sub(pos);
      to.y = 0;
      const dist = to.length();
      const step = WALK_SPEED * dt;
      if (dist <= step) {
        pos.copy(target);
        a.path.shift();
        if (!a.path.length) {
          walking = false;
          a.onArrive?.();
          a.onArrive = null;
        }
      } else {
        pos.add(to.multiplyScalar(step / dist));
        a.walkYaw = Math.atan2(target.x - pos.x, target.z - pos.z);
      }
    }

    const wantYaw = walking ? a.walkYaw : a.restYaw;
    let diff = wantYaw - a.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    a.yaw += diff * Math.min(1, dt * 10);
    p.root.rotation.y = a.yaw;

    // 자세: 목표 각도로 부드럽게 보간
    const pose = { legL: 0, legR: 0, armL: 0, armR: 0, armLz: -0.08, armRz: 0.08, headX: 0, headY: 0, headZ: 0, bob: 0 };
    const since = t - a.stateSince;
    if (walking) {
      const s = Math.sin(t * 9);
      pose.legL = s * 0.55;
      pose.legR = -s * 0.55;
      pose.armL = -s * 0.45;
      pose.armR = p.prop.visible ? -0.9 : s * 0.45;
      pose.bob = Math.abs(Math.cos(t * 9)) * 0.035;
    } else if (a.handoff && t - a.handoff < 0.9) {
      pose.armR = -1.3; // 서류를 건네는 동작
    } else {
      switch (a.state) {
        case "working":
          pose.armL = -1.05 + Math.sin(t * 19) * 0.07;
          pose.armR = -1.05 + Math.sin(t * 19 + 1.7) * 0.07;
          pose.armLz = 0.25;
          pose.armRz = -0.25;
          pose.headX = 0.15;
          break;
        case "thinking":
          pose.armR = -2.1;
          pose.armRz = -0.55; // 턱을 괸다
          pose.armL = -0.5;
          pose.armLz = 0.5;
          pose.headZ = Math.sin(t * 1.4) * 0.1;
          pose.headX = -0.12;
          break;
        case "searching":
          pose.armL = -0.95;
          pose.armR = -0.95 + Math.sin(t * 6) * 0.1;
          pose.armLz = 0.2;
          pose.armRz = -0.2;
          pose.headY = Math.sin(t * 2.2) * 0.35;
          break;
        case "meeting":
          pose.armR = -0.6 + Math.sin(t * 2.4) * 0.25; // 이야기하며 손짓
          pose.armRz = -0.2;
          pose.headY = Math.sin(t * 0.9) * 0.25;
          pose.headX = Math.sin(t * 1.7) * 0.06;
          break;
        case "waiting":
          pose.armL = -0.35;
          pose.armR = -0.35;
          pose.armLz = 0.6;
          pose.armRz = -0.6;
          pose.headY = Math.sin(t * 0.8) * 0.2;
          break;
        case "done":
          if (since < 1.6) {
            pose.armL = -2.8;
            pose.armR = -2.8;
            pose.bob = Math.abs(Math.sin(since * 7)) * 0.12;
          }
          break;
        default:
          pose.bob = Math.sin(t * 2) * 0.006; // 숨쉬기
      }
    }
    const k = Math.min(1, dt * 12);
    const lerp = (obj, prop, v) => (obj[prop] += (v - obj[prop]) * k);
    lerp(p.legL.rotation, "x", pose.legL);
    lerp(p.legR.rotation, "x", pose.legR);
    lerp(p.armL.rotation, "x", pose.armL);
    lerp(p.armR.rotation, "x", pose.armR);
    lerp(p.armL.rotation, "z", pose.armLz);
    lerp(p.armR.rotation, "z", pose.armRz);
    lerp(p.head.rotation, "x", pose.headX);
    lerp(p.head.rotation, "y", pose.headY);
    lerp(p.head.rotation, "z", pose.headZ);
    p.body.position.y = pose.bob;

    const active = a.state === "meeting" || a.state === "moving" || walking || a.riding;
    p.ringMat.opacity = active ? 0.45 + Math.sin(t * 5) * 0.25 : 0.18;
  }
}
