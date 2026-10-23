// 3D 사무실: Three.js로 사무실과 캐릭터를 코드로 직접 모델링한다 (외부 3D 모델 파일 없음).
// app.js는 이 모듈의 공개 메서드(addAgent, setState, showBubble, hideBubble, visit)만 사용한다.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const V = (x, z, y = 0) => new THREE.Vector3(x, y, z);

// 사무실 크기(미터). agents.js의 desk 좌표(0~100%)를 이 크기에 맞춰 변환한다.
const ROOM_W = 18;
const ROOM_D = 13;
const WALL_H = 3;
const MANAGER_ROOM = { x0: -2.9, x1: 2.9, z0: -ROOM_D / 2, z1: -2.4, door: 0.8 };
const DOOR_OUT = V(0, -1.7);
const TABLE = V(0, 0.2);
const TABLE_CLEARANCE = 1.7;
const WALK_SPEED = 2.7;

const STATE_COLOR = {
  idle: 0x64748b,
  thinking: 0x8b5cf6,
  searching: 0x0ea5e9,
  working: 0x10b981,
  waiting: 0xf59e0b,
  done: 0x3b82f6,
  error: 0xef4444,
};

const toWorld = (p) => V((p.x / 100 - 0.5) * ROOM_W, (p.y / 100 - 0.5) * ROOM_D);

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

// 선분 A→B가 회의 테이블과 부딪히면 테이블을 돌아가는 경유점을 넣는다
function avoidTable(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const ab = b.clone().sub(a);
    const t = THREE.MathUtils.clamp(TABLE.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6), 0, 1);
    const p = a.clone().add(ab.multiplyScalar(t));
    const d = p.distanceTo(TABLE);
    if (d < TABLE_CLEARANCE) {
      const n = d > 0.01 ? p.clone().sub(TABLE).normalize() : V(-Math.sign(b.x - a.x) || -1, 0);
      out.push(TABLE.clone().add(n.multiplyScalar(TABLE_CLEARANCE + 0.1)));
    }
    out.push(b);
  }
  return out;
}

export class Office3D {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.agents = new Map();
    this.clock = new THREE.Clock();
    this.tmp = new THREE.Vector3();
    this.active = true;
    this.view = "iso";

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

    // 아이소메트릭(비스듬히 내려다보는) 느낌을 위해 원근 없는 직교 카메라를 쓴다
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minZoom = 0.75;
    this.controls.maxZoom = 3.5;
    this.controls.minPolarAngle = 0.15;
    this.controls.maxPolarAngle = 1.3;
    this.controls.autoRotateSpeed = 0.5;
    this.resetView("iso");

    this.buildLights();
    this.buildRoom();
    this.buildManagerRoom();
    this.buildMeetingArea();
    this.buildZones();
    this.buildDecor();
    this.setupPicking();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // 시점 프리셋: 입체(아이소) / 정면 / 위에서
  resetView(preset = "iso") {
    const views = {
      iso: { dir: [1, 1.08, 1.12], fit: { h: 14.5, w: 26 } },
      front: { dir: [0, 1, 1.25], fit: { h: 15, w: 21.5 } },
      top: { dir: [0.0001, 1, 0.0001], fit: { h: 15.5, w: 21 } },
    };
    const v = views[preset] || views.iso;
    this.view = preset in views ? preset : "iso";
    this.fit = v.fit;
    const d = new THREE.Vector3(...v.dir).normalize().multiplyScalar(60);
    this.controls.target.set(0, 0, 0.3);
    this.camera.position.copy(this.controls.target).add(d);
    this.camera.zoom = 1;
    this.applyFrustum();
    this.controls.update();
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

  // 화면 비율이 달라도(휴대폰 세로 화면 포함) 사무실 전체가 들어오도록 직교 카메라 범위를 맞춘다
  applyFrustum() {
    const { clientWidth: w, clientHeight: h } = this.container;
    const aspect = w && h ? w / h : 1.6;
    // 세로로 좁은 화면에서는 가장자리를 조금 잘라내더라도 사람이 크게 보이도록 더 당겨서 본다
    const fitW = aspect < 1.1 ? this.fit.w * 0.74 : this.fit.w;
    const height = Math.max(this.fit.h, fitW / aspect);
    const width = height * aspect;
    Object.assign(this.camera, { left: -width / 2, right: width / 2, top: height / 2, bottom: -height / 2 });
    this.camera.updateProjectionMatrix();
  }

  // ── 노을 하늘 + 도시 스카이라인 (화면 배경) ──
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
    sun.position.set(11, 10, -7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 12, bottom: -12, near: 1, far: 50 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    // 앞쪽에서 들어오는 은은한 보랏빛 보조광 (그림자 쪽이 너무 어둡지 않게)
    const fill = new THREE.DirectionalLight(0xd9c8ff, 0.7);
    fill.position.set(-6, 8, 12);
    this.scene.add(fill);
  }

  // ── 옥상 사무실 바닥 · 유리 난간 · 기둥 ──────
  buildRoom() {
    const floorTex = canvasTexture(512, 512, (g, w, h) => {
      g.fillStyle = "#d9a06a";
      g.fillRect(0, 0, w, h);
      const plankH = 64;
      for (let row = 0; row < h / plankH; row++) {
        let x = -((row * 173) % 300);
        while (x < w) {
          const len = 220 + ((row * 97 + x) % 160);
          const l = 66 + ((row * 31 + x * 7) % 7);
          g.fillStyle = `hsl(29, 62%, ${l}%)`;
          g.fillRect(x + 1, row * plankH + 1, len - 2, plankH - 2);
          g.strokeStyle = "rgba(150,95,50,0.10)";
          for (let k = 0; k < 4; k++) {
            g.beginPath();
            const yy = row * plankH + 10 + k * 13;
            g.moveTo(x + 4, yy);
            g.bezierCurveTo(x + len * 0.3, yy + 3, x + len * 0.6, yy - 3, x + len - 4, yy + 1);
            g.stroke();
          }
          x += len;
        }
      }
    }, [ROOM_W / 2.4, ROOM_D / 2.4]);
    const floor = mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), mat(0xffffff, { map: floorTex, roughness: 0.6 }), { cast: false });
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // 공중에 떠 있는 듯한 두꺼운 바닥판
    const slab = box(ROOM_W + 0.9, 0.7, ROOM_D + 0.9, mat(0xf4ece1, { roughness: 0.8 }), { y: -0.36 }, 0.18);
    slab.castShadow = false;
    this.scene.add(slab);
    // 바닥 가장자리 테두리 (바닥면보다 살짝 아래)
    this.scene.add(box(ROOM_W + 0.5, 0.06, ROOM_D + 0.5, mat(0xd8c3a8), { y: -0.045 }));

    // 뒤쪽·왼쪽 가장자리 유리 난간 (카메라 쪽은 열어 둔다)
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.22, roughness: 0.05, transmission: 0.5, depthWrite: false });
    const rail = mat(0xe5e7eb, { metalness: 0.6, roughness: 0.3 });
    const H = 1.15;
    const backZ = -ROOM_D / 2 - 0.1;
    const leftX = -ROOM_W / 2 - 0.1;
    const run = (len, cx, cz, rotY) => {
      const pane = mesh(new THREE.BoxGeometry(len, H, 0.03), glass, { x: cx, y: H / 2 + 0.02, z: cz, cast: false });
      pane.rotation.y = rotY;
      this.scene.add(pane);
      const top = mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 10), rail, { x: cx, y: H + 0.03, z: cz });
      top.rotation.z = Math.PI / 2;
      top.rotation.y = rotY;
      this.scene.add(top);
    };
    run(ROOM_W, 0, backZ, 0);
    run(ROOM_D, leftX, 0, Math.PI / 2);
    for (let x = -ROOM_W / 2; x <= ROOM_W / 2 + 0.01; x += ROOM_W / 8) this.scene.add(box(0.06, H, 0.06, rail, { x, y: H / 2, z: backZ }));
    for (let z = -ROOM_D / 2; z <= ROOM_D / 2 + 0.01; z += ROOM_D / 6) this.scene.add(box(0.06, H, 0.06, rail, { x: leftX, y: H / 2, z }));

    // 흰 기둥
    const pillar = mat(0xf8f4ee, { roughness: 0.6 });
    for (const [x, z] of [[-ROOM_W / 2 + 0.35, -ROOM_D / 2 + 0.35], [ROOM_W / 2 - 0.35, -ROOM_D / 2 + 0.35], [-ROOM_W / 2 + 0.35, ROOM_D / 2 - 0.35]]) {
      this.scene.add(mesh(new THREE.CylinderGeometry(0.32, 0.32, 3.4, 28), pillar, { x, y: 1.7, z }));
      this.scene.add(mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.12, 28), mat(0xe7dccd), { x, y: 0.06, z }));
    }
  }

  // ── 팀장실: 유리 벽 + 로고 벽 + 책장 ────────
  buildManagerRoom() {
    const { x0, x1, z0, z1, door } = MANAGER_ROOM;
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xfff1e0, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0, transmission: 0.6, depthWrite: false,
    });
    const frame = mat(0xb08a62, { roughness: 0.5 });
    const h = 2.2;
    const pane = (len, x, z, rotY) => {
      const g = mesh(new THREE.BoxGeometry(len, h, 0.04), glass, { x, y: h / 2, z, cast: false });
      g.rotation.y = rotY;
      this.scene.add(g);
      const top = box(len, 0.06, 0.08, frame, { x, y: h, z });
      top.rotation.y = rotY;
      this.scene.add(top);
      const bottom = box(len, 0.08, 0.08, frame, { x, y: 0.04, z });
      bottom.rotation.y = rotY;
      this.scene.add(bottom);
    };
    const depth = z1 - z0;
    pane(depth, x0, (z0 + z1) / 2, Math.PI / 2);
    pane(depth, x1, (z0 + z1) / 2, Math.PI / 2);
    const side = x1 - door;
    pane(side, -door - side / 2, z1, 0);
    pane(side, door + side / 2, z1, 0);
    for (const px of [x0, x1, -door, door]) this.scene.add(box(0.08, h, 0.08, frame, { x: px, y: h / 2, z: z1 }));

    // 나무 루버 벽 + 로고
    const wallW = x1 - x0 + 0.2;
    const wall = new THREE.Group();
    wall.add(box(wallW, 2.9, 0.16, mat(0xf6efe6, { roughness: 0.9 }), { y: 1.45 }));
    for (let i = 0; i < 26; i++) {
      wall.add(box(0.09, 2.9, 0.06, mat(i % 2 ? 0xc79a6b : 0xb98a5e, { roughness: 0.7 }), { x: -wallW / 2 + 0.12 + i * ((wallW - 0.24) / 25), y: 1.45, z: 0.1 }));
    }
    const logo = canvasTexture(1024, 320, (g, w, hh) => {
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "#1e40af");
      grad.addColorStop(1, "#3b82f6");
      g.fillStyle = grad;
      g.fillRect(0, 0, w, hh);
      g.fillStyle = "#fff";
      g.font = "800 120px Pretendard, 'Malgun Gothic', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("AIINTERSYS", w / 2, hh * 0.42);
      g.font = "600 52px Pretendard, 'Malgun Gothic', sans-serif";
      g.fillStyle = "#bfdbfe";
      g.fillText("A I   O F F I C E", w / 2, hh * 0.78);
    });
    const sign = mesh(new THREE.PlaneGeometry(3, 0.94), new THREE.MeshStandardMaterial({ map: logo, emissive: 0xffffff, emissiveMap: logo, emissiveIntensity: 0.45 }), {
      y: 2.15, z: 0.14, cast: false,
    });
    wall.add(sign);
    wall.position.set(0, 0, z0 - 0.02);
    this.scene.add(wall);

    // 팀장실 러그
    const rug = mesh(roundedRect(x1 - x0 - 0.7, depth - 0.9, 0.3), mat(0x2f4a8a, { roughness: 1, side: THREE.DoubleSide }), { y: 0.005, z: (z0 + z1) / 2 + 0.1, cast: false });
    rug.rotation.x = -Math.PI / 2;
    this.scene.add(rug);
  }

  // ── 회의 테이블 (주황 의자 + 펜던트 조명) ─────
  buildMeetingArea() {
    const rug = mesh(new THREE.CircleGeometry(1.95, 56), mat(0xf3d2b3, { roughness: 1 }), { x: TABLE.x, y: 0.006, z: TABLE.z, cast: false });
    rug.rotation.x = -Math.PI / 2;
    this.scene.add(rug);
    const top = mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.07, 56), mat(0xc58a55, { roughness: 0.45 }), { x: TABLE.x, y: 0.74, z: TABLE.z });
    this.scene.add(top);
    this.scene.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.7, 16), mat(0x5b4636, { roughness: 0.5 }), { x: TABLE.x, y: 0.36, z: TABLE.z }));
    this.scene.add(mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.05, 32), mat(0x5b4636), { x: TABLE.x, y: 0.025, z: TABLE.z }));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.25;
      const chair = this.makeChair(0xf08a4b, 0.8);
      chair.position.set(TABLE.x + Math.sin(a) * 1.28, 0, TABLE.z + Math.cos(a) * 1.28);
      chair.rotation.y = a + Math.PI;
      this.scene.add(chair);
    }
    // 테이블 위 노트북 · 서류 · 화분
    const laptop = new THREE.Group();
    laptop.add(box(0.36, 0.02, 0.25, mat(0xd1d5db, { metalness: 0.6, roughness: 0.3 }), { y: 0.79 }));
    const lid = box(0.36, 0.24, 0.015, mat(0xd1d5db, { metalness: 0.6, roughness: 0.3 }), { y: 0.91, z: -0.12 });
    lid.rotation.x = -0.25;
    laptop.add(lid);
    laptop.position.set(TABLE.x + 0.3, 0, TABLE.z - 0.15);
    this.scene.add(laptop);
    this.scene.add(box(0.28, 0.01, 0.2, mat(0xffffff), { x: TABLE.x - 0.3, y: 0.785, z: TABLE.z + 0.25 }));
    this.addPlant(TABLE.x - 0.1, TABLE.z - 0.25, 0.35, 0.78);
  }

  // ── 팀별 구역: 색깔 러그 + 팀 간판 ─────────
  buildZones() {
    this.zoneSigns = {
      researcher: "리서치팀",
      planner: "기획팀",
      writer: "콘텐츠팀",
      reviewer: "품질검토팀",
    };
  }

  addZone(a) {
    const label = this.zoneSigns?.[a.def.id];
    if (!label) return;
    const team = new THREE.Color(a.def.color);
    const rugColor = new THREE.Color(0xf6dcc0).lerp(team, 0.55);
    const rug = mesh(roundedRect(2.8, 2.7, 0.6), mat(rugColor.getHex(), { roughness: 1, side: THREE.DoubleSide }), { x: a.deskPos.x, y: 0.007, z: a.deskPos.z - 0.45, cast: false });
    rug.rotation.x = -Math.PI / 2;
    this.scene.add(rug);

    // 책상 앞판을 팀 색 간판으로 (카메라 쪽에서 잘 보이고 사람을 가리지 않는다)
    const tex = canvasTexture(512, 128, (g, w, h) => {
      g.fillStyle = a.def.color;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(255,255,255,0.16)";
      g.fillRect(0, 0, w, h * 0.2);
      g.fillStyle = "#fff";
      g.font = "800 66px Pretendard, 'Malgun Gothic', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(label, w / 2, h / 2 + 4);
    });
    const panel = mesh(new THREE.PlaneGeometry(1.6, 0.4), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.2, roughness: 0.6 }), {
      x: a.deskPos.x, y: 0.47, z: a.deskPos.z + 0.44, cast: false,
    });
    this.scene.add(panel);
  }

  addPlant(x, z, s = 1, y = 0) {
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
    this.scene.add(g);
    return g;
  }

  // ── 소품: 라운지 · 게임 코너 · 카페 바 · 책장 ──
  buildDecor() {
    const W = ROOM_W / 2;
    const D = ROOM_D / 2;
    // 가장자리를 따라 화분
    for (const [x, z, s] of [
      [-W + 0.5, -2.2, 1.1], [-W + 0.5, 1.2, 1], [-W + 0.6, D - 1.4, 1.2],
      [-4.2, -D + 0.5, 1], [4.2, -D + 0.5, 1], [W - 0.5, -2.1, 1.1], [W - 0.5, 1.6, 1],
      [-3.4, -2.05, 0.8], [3.4, -2.05, 0.8], [-1.0, D - 0.4, 0.9], [2.6, D - 0.4, 0.9], [W - 0.5, D - 0.5, 1.2],
    ]) this.addPlant(x, z, s);

    // 앞쪽 가장자리 낮은 화단
    const planter = mat(0xc89b6d, { roughness: 0.7 });
    for (const [x0, x1] of [[-3.6, -0.3], [0.8, 5.0]]) {
      const len = x1 - x0;
      this.scene.add(box(len, 0.36, 0.42, planter, { x: (x0 + x1) / 2, y: 0.18, z: D - 0.25 }, 0.05));
      for (let x = x0 + 0.3; x < x1; x += 0.45) {
        const leaf = mesh(new THREE.SphereGeometry(0.2, 10, 8), mat(x % 0.9 < 0.45 ? 0x4c9a52 : 0x6cbf62, { roughness: 0.85 }), { x, y: 0.46, z: D - 0.25 });
        leaf.scale.set(1.1, 0.9, 0.9);
        this.scene.add(leaf);
      }
    }

    // 책장 (왼쪽 뒤)
    const shelf = new THREE.Group();
    const wood = mat(0xb98a5e, { roughness: 0.7 });
    shelf.add(box(0.4, 2.2, 2.4, wood, { y: 1.1 }));
    const bookColors = [0x1e40af, 0xf59e0b, 0x10b981, 0xef4444, 0x8b5cf6, 0xf8fafc, 0x0ea5e9, 0xf08a4b];
    for (let r = 0; r < 4; r++) {
      shelf.add(box(0.42, 0.04, 2.3, mat(0x8a6644), { x: 0.02, y: 0.3 + r * 0.52 }));
      let z = -1.05;
      let i = r * 3;
      while (z < 1.0) {
        const w = 0.07 + ((i * 13) % 5) * 0.015;
        const hgt = 0.3 + ((i * 7) % 4) * 0.04;
        shelf.add(box(0.28, hgt, w, mat(bookColors[i % bookColors.length], { roughness: 0.6 }), { x: 0.08, y: 0.32 + r * 0.52 + hgt / 2, z: z + w / 2 }));
        z += w + 0.01;
        i++;
      }
    }
    shelf.position.set(-W + 0.3, 0, -4.4);
    this.scene.add(shelf);

    // 화이트보드 (스탠드형)
    const board = canvasTexture(512, 256, (g, w, h) => {
      g.fillStyle = "#fbfbf9";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#1e40af";
      g.font = "700 26px Pretendard, sans-serif";
      g.fillText("SPRINT BOARD", 18, 36);
      const notes = ["#fde68a", "#bbf7d0", "#bfdbfe", "#fecaca", "#ddd6fe"];
      for (let i = 0; i < 9; i++) {
        g.fillStyle = notes[i % notes.length];
        g.fillRect(20 + (i % 3) * 160, 60 + Math.floor(i / 3) * 62, 130, 50);
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.fillRect(30 + (i % 3) * 160, 75 + Math.floor(i / 3) * 62, 90, 5);
        g.fillRect(30 + (i % 3) * 160, 88 + Math.floor(i / 3) * 62, 60, 5);
      }
    });
    const wb = new THREE.Group();
    wb.add(box(2.3, 1.2, 0.05, mat(0xd1d5db, { metalness: 0.4 }), { y: 1.55 }));
    wb.add(mesh(new THREE.PlaneGeometry(2.2, 1.1), mat(0xffffff, { map: board, roughness: 0.3 }), { y: 1.55, z: 0.03, cast: false }));
    for (const sx of [-1.05, 1.05]) {
      wb.add(box(0.05, 1.5, 0.05, mat(0x9ca3af, { metalness: 0.5 }), { x: sx, y: 0.75 }));
      wb.add(box(0.06, 0.04, 0.6, mat(0x9ca3af, { metalness: 0.5 }), { x: sx, y: 0.02 }));
    }
    wb.position.set(-5.9, 0, -5.4);
    wb.rotation.y = 0.15;
    this.scene.add(wb);

    // 카페 바: 긴 카운터 + 커피머신 + 주황 스툴
    const bar = new THREE.Group();
    bar.add(box(3.6, 0.95, 0.6, mat(0xf4ece1, { roughness: 0.6 }), { y: 0.475 }, 0.04));
    bar.add(box(3.7, 0.06, 0.7, mat(0xb98a5e, { roughness: 0.4 }), { y: 0.98 }));
    bar.add(box(0.42, 0.5, 0.36, mat(0x1f2937, { metalness: 0.5, roughness: 0.3 }), { x: -1.3, y: 1.26 }, 0.04));
    bar.add(box(0.5, 0.42, 0.4, mat(0xd8e4f0, { metalness: 0.3, roughness: 0.3 }), { x: 1.35, y: 1.22 }, 0.04));
    for (let i = 0; i < 4; i++) bar.add(mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.1, 16), mat([0xffffff, 0x1e40af, 0xf59e0b, 0xf08a4b][i]), { x: -0.6 + i * 0.22, y: 1.06 }));
    for (let i = 0; i < 4; i++) {
      const stool = new THREE.Group();
      stool.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 20), mat(0xf08a4b, { roughness: 0.6 }), { y: 0.72 }));
      stool.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 10), mat(0x9ca3af, { metalness: 0.6 }), { y: 0.36 }));
      stool.add(mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.03, 20), mat(0x9ca3af, { metalness: 0.6 }), { y: 0.02 }));
      stool.position.set(-1.3 + i * 0.85, 0, 0.75);
      bar.add(stool);
    }
    bar.position.set(6.2, 0, -D + 0.55);
    this.scene.add(bar);
    // 바 위 펜던트 조명
    for (let i = 0; i < 3; i++) {
      const x = 5.0 + i * 1.2;
      this.scene.add(mesh(new THREE.CylinderGeometry(0.005, 0.005, 1.0, 4), mat(0x1f2937), { x, y: 2.6, z: -D + 0.55, cast: false }));
      this.scene.add(mesh(new THREE.SphereGeometry(0.13, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false }), { x, y: 2.05, z: -D + 0.55, cast: false }));
    }
    const barLight = new THREE.PointLight(0xffc27a, 8, 6, 1.6);
    barLight.position.set(6.2, 1.9, -D + 0.9);
    this.scene.add(barLight);

    // 정수기
    const cooler = new THREE.Group();
    cooler.add(box(0.4, 1.0, 0.4, mat(0xf8fafc), { y: 0.5 }, 0.03));
    cooler.add(mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.45, 20), new THREE.MeshPhysicalMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.6, roughness: 0.1 }), { y: 1.23 }));
    cooler.position.set(W - 0.5, 0, -3.6);
    this.scene.add(cooler);

    // 라운지 (왼쪽 앞): 크림색 소파 + 쿠션 + 빈백 + 낮은 테이블
    const lounge = mesh(roundedRect(3.6, 3.0, 0.8), mat(0xb9c6e6, { roughness: 1, side: THREE.DoubleSide }), { x: -6.9, y: 0.007, z: 4.4, cast: false });
    lounge.rotation.x = -Math.PI / 2;
    this.scene.add(lounge);
    const sofa = new THREE.Group();
    const fabric = mat(0xf3ebe0, { roughness: 0.95 });
    sofa.add(box(2.3, 0.42, 0.9, fabric, { y: 0.26 }, 0.1));
    sofa.add(box(2.3, 0.6, 0.24, fabric, { y: 0.62, z: -0.34 }, 0.1));
    sofa.add(box(0.22, 0.58, 0.9, fabric, { x: -1.14, y: 0.42 }, 0.1));
    sofa.add(box(0.22, 0.58, 0.9, fabric, { x: 1.14, y: 0.42 }, 0.1));
    sofa.add(box(0.5, 0.36, 0.13, mat(0xf08a4b), { x: -0.6, y: 0.64, z: -0.18 }, 0.06));
    sofa.add(box(0.5, 0.36, 0.13, mat(0x3f8f4f), { x: 0.6, y: 0.64, z: -0.18 }, 0.06));
    sofa.position.set(-8.25, 0, 4.4);
    sofa.rotation.y = Math.PI / 2;
    this.scene.add(sofa);
    this.scene.add(box(1.0, 0.34, 0.7, mat(0xb98a5e), { x: -6.9, y: 0.17, z: 4.4 }, 0.06));
    this.addPlant(-6.95, 4.35, 0.3, 0.34);
    const beanbag = (x, z, color) => {
      const b = mesh(new THREE.SphereGeometry(0.42, 24, 16), mat(color, { roughness: 0.9 }), { x, y: 0.26, z });
      b.scale.set(1, 0.62, 1);
      this.scene.add(b);
    };
    beanbag(-5.6, 5.3, 0xf08a4b);
    beanbag(-5.6, 3.5, 0x6cbf62);

    // 게임 코너 (오른쪽 앞): 오락기 2대 + 테이블 축구
    const arcade = (x, z, color) => {
      const g = new THREE.Group();
      g.add(box(0.7, 1.7, 0.6, mat(color, { roughness: 0.5 }), { y: 0.85 }, 0.04));
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
      g.add(screen);
      g.add(box(0.72, 0.1, 0.35, mat(0x111827), { y: 0.92, z: 0.38 }));
      g.add(mesh(new THREE.SphereGeometry(0.04, 10, 8), mat(0xef4444), { x: -0.15, y: 1.0, z: 0.4 }));
      g.position.set(x, 0, z);
      this.scene.add(g);
    };
    arcade(6.9, 4.5, 0x2563eb);
    arcade(7.75, 4.5, 0xdb2777);
    const fb = new THREE.Group();
    fb.add(box(1.4, 0.2, 0.8, mat(0x8a5a36), { y: 0.82 }, 0.03));
    fb.add(box(1.25, 0.02, 0.68, mat(0x3f9d4a), { y: 0.93 }));
    for (let i = 0; i < 4; i++) {
      const rod = mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.1, 6), mat(0xd1d5db, { metalness: 0.7 }), { x: -0.45 + i * 0.3, y: 0.98 });
      rod.rotation.x = Math.PI / 2;
      fb.add(rod);
    }
    for (const sx of [-0.6, 0.6]) for (const sz of [-0.32, 0.32]) fb.add(box(0.07, 0.75, 0.07, mat(0x5b3a22), { x: sx, y: 0.36, z: sz }));
    fb.position.set(7.3, 0, 5.85);
    this.scene.add(fb);
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

  // ── 책상 ─────────────────────────────────
  buildDesk(a) {
    const g = new THREE.Group();
    const top = mat(0xf6efe6, { roughness: 0.45 });
    const legMat = mat(0xb98a5e, { roughness: 0.6 });
    g.add(box(1.7, 0.05, 0.85, top, { y: 0.74 }, 0.02));
    for (const sx of [-0.78, 0.78]) g.add(box(0.05, 0.72, 0.7, legMat, { x: sx, y: 0.36 }));
    // 모니터 (캐릭터 쪽을 바라봄 = -z)
    g.add(box(0.06, 0.25, 0.06, legMat, { y: 0.88, z: 0.12 }));
    g.add(box(0.22, 0.02, 0.16, legMat, { y: 0.77, z: 0.12 }));
    g.add(box(0.72, 0.44, 0.04, mat(0x111827, { roughness: 0.4 }), { y: 1.13, z: 0.12 }, 0.015));
    a.screenMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, emissive: STATE_COLOR.idle, emissiveIntensity: 0.25, roughness: 0.2 });
    const screen = mesh(new THREE.PlaneGeometry(0.66, 0.38), a.screenMat, { y: 1.13, z: 0.095, cast: false });
    screen.rotation.y = Math.PI;
    g.add(screen);
    // 키보드 · 머그컵 · 서류
    g.add(box(0.45, 0.02, 0.14, mat(0x1f2937), { y: 0.775, z: -0.18 }, 0.008));
    g.add(mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 16), mat(new THREE.Color(a.def.color).getHex()), { x: 0.55, y: 0.82, z: -0.1 }));
    g.add(box(0.22, 0.03, 0.3, mat(0xffffff), { x: -0.55, y: 0.785, z: -0.05 }));
    // 앞쪽(카메라 쪽) 상태 LED 줄
    a.ledMat = new THREE.MeshBasicMaterial({ color: STATE_COLOR.idle, toneMapped: false });
    g.add(mesh(new THREE.BoxGeometry(1.6, 0.03, 0.01), a.ledMat, { y: 0.69, z: 0.44, cast: false }));
    // (모니터 빛은 실제 조명 대신 화면 발광·LED·발밑 링으로 표현한다.
    //  책상마다 조명을 켜면 장면 전체의 그리기 비용이 크게 늘어 휴대폰에서 버벅인다.)

    // 스탠드 조명 (따뜻한 빛)
    g.add(mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.03, 16), mat(0x374151), { x: -0.7, y: 0.78, z: 0.25 }));
    g.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 8), mat(0x374151), { x: -0.7, y: 0.99, z: 0.25 }));
    g.add(mesh(new THREE.ConeGeometry(0.12, 0.14, 20, 1, true), mat(0xf5e6c8, { side: THREE.DoubleSide }), { x: -0.7, y: 1.22, z: 0.25 }));
    g.add(mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe2a8, toneMapped: false }), { x: -0.7, y: 1.17, z: 0.25, cast: false }));

    const chairColor = a.def.id === "manager" ? 0x1f2937 : new THREE.Color(a.def.color).lerp(new THREE.Color(0x1f2937), 0.35).getHex();
    const chair = this.makeChair(chairColor);
    chair.position.set(0, 0, -1.3);
    g.add(chair);

    g.position.copy(a.deskPos);
    this.scene.add(g);
    this.addZone(a);
  }

  // ── 캐릭터 ───────────────────────────────
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
        <span class="card3d-text"><b>${a.def.name}</b><small>${a.def.title}</small></span>
        <i class="dot3d" data-state="idle"></i>
      </button>`;
    el.querySelector(".card3d").addEventListener("click", () => this.onSelect?.(a.def.id));
    const label = new CSS2DObject(el);
    label.position.set(0, 2.2, 0);
    a.parts.root.add(label);
    a.bubbleEl = el.querySelector(".bubble3d");
    a.dotEl = el.querySelector(".dot3d");
  }

  // ── 공개 API ─────────────────────────────
  addAgent(def) {
    const deskPos = toWorld(def.desk);
    const home = deskPos.clone().add(V(0, -0.85));
    const a = { def, deskPos, home, path: [], restYaw: 0, yaw: 0, walkYaw: 0, state: "idle", stateSince: 0, queue: Promise.resolve() };
    a.parts = this.buildCharacter(def);
    a.parts.root.position.copy(home);
    this.scene.add(a.parts.root);
    this.buildDesk(a);
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
    a.ledMat.color.setHex(color);
    a.screenMat.emissive.setHex(color);
    const active = ["thinking", "searching", "working"].includes(state);
    a.screenMat.emissiveIntensity = active ? 1.4 : 0.25;
    a.dotEl.dataset.state = state;
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

  // from이 to의 자리로 서류를 들고 걸어갔다가 돌아온다. 한 사람의 이동은 순서대로 처리한다.
  visit(fromId, toId, carry) {
    const a = this.agents.get(fromId);
    const t = this.agents.get(toId);
    const job = a.queue.then(async () => {
      const path = this.planPath(a, t);
      a.parts.prop.visible = true;
      a.parts.prop.children[0].material = mat(carry === "📄" ? 0xe5e7eb : 0x8b5e34);
      await this.walk(a, path);
      a.restYaw = Math.atan2(t.parts.root.position.x - a.parts.root.position.x, t.parts.root.position.z - a.parts.root.position.z);
      await this.wait(0.35);
      a.parts.prop.visible = false;
      a.handoff = this.clock.elapsedTime;
      await this.wait(0.6);
      await this.walk(a, [...path].reverse().slice(1).concat([a.home.clone()]));
      a.restYaw = 0;
    });
    a.queue = job.catch(() => {});
    return job;
  }

  planPath(a, t) {
    const isMgr = (x) => x.def.id === "manager";
    const pts = [a.parts.root.position.clone()];
    // 자기 책상 옆으로 빠져나온다 (방 가운데 쪽으로)
    const s = isMgr(a) ? Math.sign(t.home.x) || 1 : -Math.sign(a.home.x) || 1;
    pts.push(V(a.home.x + s * 1.05, a.home.z));
    if (isMgr(a)) {
      pts.push(V(s * 1.05, a.deskPos.z + 0.95), DOOR_OUT.clone());
    }
    if (isMgr(t)) {
      // 팀장 책상 앞 (여러 명이 동시에 보고하면 옆으로 나란히 선다)
      const order = ["researcher", "planner", "writer", "reviewer"].indexOf(a.def.id);
      pts.push(DOOR_OUT.clone(), V((order - 1.5) * 0.42, t.deskPos.z + 0.95));
    } else {
      // 팀원 책상 옆 (방 가운데 쪽)에 선다
      const side = -Math.sign(t.home.x) || 1;
      pts.push(V(t.home.x + side * 1.05, t.home.z));
    }
    return avoidTable(pts).slice(1);
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
      const roots = [...this.agents.values()].map((a) => a.parts.root);
      const hit = ray.intersectObjects(roots, true)[0];
      if (hit?.object.userData.agentId) this.onSelect?.(hit.object.userData.agentId);
    });
  }

  // ── 매 프레임 ────────────────────────────
  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const h = this.container.clientHeight;
    for (const a of this.agents.values()) {
      this.animateAgent(a, dt, t);
      // 화면 위쪽에 있는 사람의 말풍선은 잘리지 않도록 이름표 아래로 내린다
      this.tmp.copy(a.parts.root.position).setY(2.2).project(this.camera);
      a.bubbleEl.classList.toggle("below", (1 - this.tmp.y) * 0.5 * h < 150);
    }

    if (!this.active) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  animateAgent(a, dt, t) {
    const p = a.parts;
    const pos = p.root.position;
    let walking = false;

    if (a.path.length) {
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

    const active = a.state !== "idle";
    p.ringMat.opacity = active ? 0.45 + Math.sin(t * 5) * 0.25 : 0.18;
  }
}
