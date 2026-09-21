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

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels3d";
    container.append(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0b1220, 30, 60);

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 32;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.32;
    this.controls.autoRotateSpeed = 0.6;
    this.resetView();

    this.buildLights();
    this.buildRoom();
    this.buildManagerRoom();
    this.buildMeetingArea();
    this.buildDecor();
    this.setupPicking();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  resetView(preset = "front") {
    const views = {
      front: { pos: [0, 11.5, 14.5], target: [0, 0.4, -0.4] },
      top: { pos: [0, 24, 0.01], target: [0, 0, 0] },
      side: { pos: [15, 8, 9], target: [0, 0.5, -0.5] },
    };
    const v = views[preset] || views.front;
    this.camera.position.set(...v.pos);
    this.controls.target.set(...v.target);
    this.controls.update();
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    // 세로로 긴 화면(휴대폰)에서도 사무실 좌우가 잘리지 않도록 가로 시야각을 유지한다
    const baseV = THREE.MathUtils.degToRad(36);
    const refAspect = 1.6;
    const hfov = 2 * Math.atan(Math.tan(baseV / 2) * refAspect);
    const vfov = w / h < refAspect ? 2 * Math.atan(Math.tan(hfov / 2) / (w / h)) : baseV;
    this.camera.fov = Math.min(THREE.MathUtils.radToDeg(vfov), 80);
    this.camera.updateProjectionMatrix();
  }

  // ── 조명 ────────────────────────────────
  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xfff8ee, 0x6b5a48, 1.1));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
    sun.position.set(6, 12, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 9, bottom: -9, near: 1, far: 40 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    // 창문 쪽에서 들어오는 푸른 빛
    const windowLight = new THREE.PointLight(0x9cc8ff, 12, 14, 1.6);
    windowLight.position.set(5.5, 2.2, -5.6);
    this.scene.add(windowLight);
    const warm = new THREE.PointLight(0xffc98a, 10, 12, 1.8);
    warm.position.set(-6, 2.6, 4.5);
    this.scene.add(warm);
  }

  // ── 바닥 · 벽 · 창문 ────────────────────
  buildRoom() {
    const floorTex = canvasTexture(512, 512, (g, w, h) => {
      g.fillStyle = "#b98d63";
      g.fillRect(0, 0, w, h);
      const plankH = 64;
      for (let row = 0; row < h / plankH; row++) {
        let x = -((row * 173) % 300);
        while (x < w) {
          const len = 220 + ((row * 97 + x) % 160);
          const l = 56 + ((row * 31 + x * 7) % 7);
          g.fillStyle = `hsl(30, 34%, ${l}%)`;
          g.fillRect(x + 1, row * plankH + 1, len - 2, plankH - 2);
          g.strokeStyle = "rgba(90,55,30,0.12)";
          for (let k = 0; k < 5; k++) {
            g.beginPath();
            const yy = row * plankH + 8 + k * 11;
            g.moveTo(x + 4, yy);
            g.bezierCurveTo(x + len * 0.3, yy + 3, x + len * 0.6, yy - 3, x + len - 4, yy + 1);
            g.stroke();
          }
          x += len;
        }
      }
    }, [ROOM_W / 2.2, ROOM_D / 2.2]);
    const floor = mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), mat(0xffffff, { map: floorTex, roughness: 0.55 }), { cast: false });
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // 사무실 바깥 바닥(받침)
    const base = box(ROOM_W + 0.6, 0.3, ROOM_D + 0.6, mat(0x2a3346), { y: -0.16 });
    base.castShadow = false;
    this.scene.add(base);

    const wallMat = mat(0xe9e4dc, { roughness: 0.9 });
    const backZ = -ROOM_D / 2;
    // 뒷벽은 창문 자리를 비워두고 조각으로 만든다
    const winY0 = 0.9;
    const winY1 = 2.5;
    const windows = [
      [-8.2, -3.6], // 왼쪽 창 (x 시작, x 끝)
      [3.6, 8.2],
    ];
    const addBack = (x0, x1, y0, y1) =>
      this.scene.add(box(x1 - x0, y1 - y0, 0.2, wallMat, { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: backZ - 0.1 }));
    addBack(-ROOM_W / 2, ROOM_W / 2, 0, winY0);
    addBack(-ROOM_W / 2, ROOM_W / 2, winY1, WALL_H);
    let cursor = -ROOM_W / 2;
    for (const [x0, x1] of windows) {
      addBack(cursor, x0, winY0, winY1);
      cursor = x1;
    }
    addBack(cursor, ROOM_W / 2, winY0, winY1);

    const skyline = canvasTexture(1024, 256, (g, w, h) => {
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#7fb3ff");
      sky.addColorStop(1, "#d8ecff");
      g.fillStyle = sky;
      g.fillRect(0, 0, w, h);
      let x = 0;
      let i = 0;
      while (x < w) {
        const bw = 40 + ((i * 37) % 60);
        const bh = 60 + ((i * 53) % 150);
        g.fillStyle = `rgba(${60 + (i % 3) * 15}, ${90 + (i % 4) * 10}, 140, 0.55)`;
        g.fillRect(x, h - bh, bw, bh);
        g.fillStyle = "rgba(255,255,255,0.35)";
        for (let wy = h - bh + 8; wy < h - 6; wy += 14) for (let wx = x + 6; wx < x + bw - 6; wx += 12) g.fillRect(wx, wy, 5, 7);
        x += bw + 4;
        i++;
      }
    });
    for (const [x0, x1] of windows) {
      const glass = mesh(new THREE.PlaneGeometry(x1 - x0, winY1 - winY0), new THREE.MeshBasicMaterial({ map: skyline, toneMapped: false }), {
        x: (x0 + x1) / 2, y: (winY0 + winY1) / 2, z: backZ - 0.12, cast: false,
      });
      this.scene.add(glass);
      const frameMat = mat(0x3b4252, { metalness: 0.4, roughness: 0.4 });
      for (let k = 0; k <= 3; k++) {
        const fx = x0 + ((x1 - x0) * k) / 3;
        this.scene.add(box(0.06, winY1 - winY0, 0.12, frameMat, { x: fx, y: (winY0 + winY1) / 2, z: backZ - 0.05 }));
      }
      this.scene.add(box(x1 - x0, 0.08, 0.3, frameMat, { x: (x0 + x1) / 2, y: winY0, z: backZ + 0.02 }));
    }

    // 좌우 벽 (앞쪽은 카메라를 위해 열어 둔다)
    for (const sx of [-1, 1]) {
      this.scene.add(box(0.2, WALL_H, ROOM_D, wallMat, { x: sx * (ROOM_W / 2 + 0.1), y: WALL_H / 2, z: 0 }));
      // 걸레받이
      this.scene.add(box(0.04, 0.12, ROOM_D, mat(0x5b4636), { x: sx * (ROOM_W / 2 - 0.02), y: 0.06, z: 0 }));
    }
    this.scene.add(box(ROOM_W, 0.12, 0.04, mat(0x5b4636), { y: 0.06, z: backZ + 0.02 }));
  }

  // ── 팀장실: 유리 벽 + 회사 로고 ───────────
  buildManagerRoom() {
    const { x0, x1, z0, z1, door } = MANAGER_ROOM;
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xdbeafe, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0, transmission: 0.6, depthWrite: false,
    });
    const frame = mat(0x334155, { metalness: 0.5, roughness: 0.35 });
    const h = 2.4;
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

    // 로고 사인
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
    const sign = mesh(new THREE.PlaneGeometry(3.2, 1), new THREE.MeshStandardMaterial({ map: logo, emissive: 0xffffff, emissiveMap: logo, emissiveIntensity: 0.35 }), {
      y: 2.05, z: z0 + 0.02, cast: false,
    });
    this.scene.add(sign);
    // 팀장실 러그
    const rug = mesh(new THREE.PlaneGeometry(x1 - x0 - 0.6, depth - 0.8), mat(0x1e3a8a, { roughness: 1 }), { y: 0.005, z: (z0 + z1) / 2 + 0.1, cast: false });
    rug.rotation.x = -Math.PI / 2;
    this.scene.add(rug);
  }

  // ── 회의 테이블 ──────────────────────────
  buildMeetingArea() {
    const rug = mesh(new THREE.CircleGeometry(1.9, 48), mat(0x94a3b8, { roughness: 1 }), { x: TABLE.x, y: 0.006, z: TABLE.z, cast: false });
    rug.rotation.x = -Math.PI / 2;
    this.scene.add(rug);
    const top = mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.06, 48), mat(0xf1efe9, { roughness: 0.35 }), { x: TABLE.x, y: 0.74, z: TABLE.z });
    this.scene.add(top);
    this.scene.add(mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.7, 16), mat(0x475569, { metalness: 0.6, roughness: 0.3 }), { x: TABLE.x, y: 0.36, z: TABLE.z }));
    this.scene.add(mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.04, 32), mat(0x475569, { metalness: 0.6 }), { x: TABLE.x, y: 0.02, z: TABLE.z }));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      const chair = this.makeChair(0x60a5fa, 0.8);
      chair.position.set(TABLE.x + Math.sin(a) * 1.25, 0, TABLE.z + Math.cos(a) * 1.25);
      chair.rotation.y = a + Math.PI;
      this.scene.add(chair);
    }
    // 테이블 위 노트북과 서류
    const laptop = new THREE.Group();
    laptop.add(box(0.36, 0.02, 0.25, mat(0x9ca3af, { metalness: 0.6, roughness: 0.3 }), { y: 0.78 }));
    const lid = box(0.36, 0.24, 0.015, mat(0x9ca3af, { metalness: 0.6, roughness: 0.3 }), { y: 0.9, z: -0.12 });
    lid.rotation.x = -0.25;
    laptop.add(lid);
    laptop.position.set(TABLE.x + 0.25, 0, TABLE.z - 0.15);
    this.scene.add(laptop);
    this.scene.add(box(0.28, 0.01, 0.2, mat(0xffffff), { x: TABLE.x - 0.3, y: 0.775, z: TABLE.z + 0.2 }));
  }

  // ── 소품 ─────────────────────────────────
  buildDecor() {
    const plant = (x, z, s = 1) => {
      const g = new THREE.Group();
      g.add(mesh(new THREE.CylinderGeometry(0.22 * s, 0.17 * s, 0.42 * s, 20), mat(0xf8fafc, { roughness: 0.4 }), { y: 0.21 * s }));
      const leaf = mat(0x2f7d4f, { roughness: 0.8 });
      const leaf2 = mat(0x3f9d62, { roughness: 0.8 });
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const l = mesh(new THREE.SphereGeometry(0.2 * s, 10, 8), i % 2 ? leaf : leaf2, {
          x: Math.sin(a) * 0.14 * s, y: (0.62 + (i % 3) * 0.16) * s, z: Math.cos(a) * 0.14 * s,
        });
        l.scale.set(1, 1.5, 0.6);
        l.rotation.y = a;
        g.add(l);
      }
      g.add(mesh(new THREE.SphereGeometry(0.22 * s, 12, 10), leaf2, { y: 1.0 * s }));
      g.position.set(x, 0, z);
      this.scene.add(g);
    };
    plant(-8.4, -5.9, 1.2);
    plant(8.4, 5.9, 1.2);
    plant(-3.35, -2.1, 0.85);
    plant(3.35, -2.1, 0.85);
    plant(-8.4, 2.4);

    // 책장 (왼쪽 벽)
    const shelf = new THREE.Group();
    const wood = mat(0x7a5a3e, { roughness: 0.8 });
    shelf.add(box(0.4, 2.2, 2.4, wood, { y: 1.1 }));
    const bookColors = [0x1e40af, 0xf59e0b, 0x10b981, 0xef4444, 0x8b5cf6, 0xf8fafc, 0x0ea5e9];
    for (let r = 0; r < 4; r++) {
      shelf.add(box(0.42, 0.04, 2.3, mat(0x5b4636), { x: 0.02, y: 0.3 + r * 0.52 }));
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
    shelf.position.set(-8.75, 0, -3.2);
    this.scene.add(shelf);

    // 커피 스테이션 (오른쪽 뒤)
    const counter = new THREE.Group();
    counter.add(box(2.4, 0.9, 0.6, mat(0xf1f5f9, { roughness: 0.5 }), { y: 0.45 }, 0.03));
    counter.add(box(2.45, 0.05, 0.65, mat(0x334155, { roughness: 0.3 }), { y: 0.92 }));
    const machine = box(0.4, 0.5, 0.35, mat(0x111827, { metalness: 0.5, roughness: 0.3 }), { x: -0.6, y: 1.2 }, 0.04);
    counter.add(machine);
    for (let i = 0; i < 3; i++) {
      counter.add(mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.1, 16), mat([0xffffff, 0x1e40af, 0xf59e0b][i]), { x: 0.2 + i * 0.18, y: 1.0 }));
    }
    counter.position.set(6.8, 0, -6.1);
    this.scene.add(counter);

    // 정수기 (오른쪽 벽)
    const cooler = new THREE.Group();
    cooler.add(box(0.4, 1.0, 0.4, mat(0xf8fafc), { y: 0.5 }, 0.03));
    cooler.add(mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.45, 20), new THREE.MeshPhysicalMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.6, roughness: 0.1 }), { y: 1.23 }));
    cooler.position.set(8.5, 0, -3.4);
    this.scene.add(cooler);

    // 라운지: 소파 + 낮은 테이블 (왼쪽 앞)
    const sofa = new THREE.Group();
    const fabric = mat(0x475569, { roughness: 0.95 });
    sofa.add(box(2.2, 0.4, 0.85, fabric, { y: 0.25 }, 0.08));
    sofa.add(box(2.2, 0.55, 0.22, fabric, { y: 0.6, z: -0.33 }, 0.08));
    sofa.add(box(0.2, 0.55, 0.85, fabric, { x: -1.1, y: 0.4 }, 0.08));
    sofa.add(box(0.2, 0.55, 0.85, fabric, { x: 1.1, y: 0.4 }, 0.08));
    sofa.add(box(0.5, 0.35, 0.12, mat(0xf59e0b), { x: -0.6, y: 0.6, z: -0.18 }, 0.05));
    sofa.position.set(-6.3, 0, 5.2);
    sofa.rotation.y = Math.PI;
    this.scene.add(sofa);
    this.scene.add(box(1.1, 0.35, 0.6, mat(0x7a5a3e), { x: -6.3, y: 0.18, z: 4.1 }, 0.03));

    // 화이트보드 (뒷벽, 창문 사이)
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
    this.scene.add(box(2.6, 1.3, 0.05, mat(0x94a3b8, { metalness: 0.4 }), { x: -5.9, y: 1.7, z: -ROOM_D / 2 + 0.03 }));
    // 뒷벽 창문과 겹치지 않게 벽 앞쪽에 붙인다
    this.scene.add(mesh(new THREE.PlaneGeometry(2.5, 1.2), mat(0xffffff, { map: board, roughness: 0.3 }), { x: -5.9, y: 1.7, z: -ROOM_D / 2 + 0.06, cast: false }));

    // 벽시계 (오른쪽 벽)
    const clockFace = canvasTexture(256, 256, (g) => {
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(128, 128, 124, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#111827";
      g.lineWidth = 10;
      g.stroke();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        g.fillStyle = "#111827";
        g.fillRect(128 + Math.sin(a) * 100 - 3, 128 - Math.cos(a) * 100 - 8, 6, 16);
      }
    });
    this.clockHands = new THREE.Group();
    const clock = mesh(new THREE.CircleGeometry(0.35, 32), mat(0xffffff, { map: clockFace }), { cast: false });
    this.clockHands.add(clock);
    this.hourHand = box(0.03, 0.18, 0.01, mat(0x111827), { y: 0.08, z: 0.01 });
    this.minuteHand = box(0.02, 0.27, 0.01, mat(0x111827), { y: 0.12, z: 0.015 });
    const hourPivot = new THREE.Group();
    hourPivot.add(this.hourHand);
    const minutePivot = new THREE.Group();
    minutePivot.add(this.minuteHand);
    this.clockHands.add(hourPivot, minutePivot);
    this.hourPivot = hourPivot;
    this.minutePivot = minutePivot;
    this.clockHands.position.set(ROOM_W / 2 - 0.01, 2.2, 1.5);
    this.clockHands.rotation.y = -Math.PI / 2;
    this.scene.add(this.clockHands);

    // 프린터 (오른쪽 앞)
    const printer = new THREE.Group();
    printer.add(box(0.8, 0.7, 0.6, mat(0x94a3b8), { y: 0.35 }, 0.03));
    printer.add(box(0.7, 0.3, 0.5, mat(0xe2e8f0), { y: 0.85 }, 0.03));
    printer.add(box(0.4, 0.02, 0.3, mat(0xffffff), { y: 1.01, z: 0.1 }));
    printer.position.set(8.2, 0, 3.4);
    printer.rotation.y = -Math.PI / 2;
    this.scene.add(printer);
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
    const top = mat(0xd9b88f, { roughness: 0.5 });
    const legMat = mat(0x374151, { metalness: 0.5, roughness: 0.35 });
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
    g.add(mesh(new THREE.BoxGeometry(1.5, 0.025, 0.01), a.ledMat, { y: 0.7, z: 0.43, cast: false }));
    // 모니터 빛: 캐릭터 얼굴을 상태 색으로 비춘다
    a.screenLight = new THREE.PointLight(STATE_COLOR.idle, 0, 2.2, 2);
    a.screenLight.position.set(0, 1.15, -0.2);
    g.add(a.screenLight);

    const chair = this.makeChair(0x1f2937);
    chair.position.set(0, 0, -1.3);
    g.add(chair);

    g.position.copy(a.deskPos);
    this.scene.add(g);
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
    a.screenMat.emissiveIntensity = active ? 1.1 : 0.25;
    a.screenLight.color.setHex(color);
    a.screenLight.intensity = active ? 2.2 : 0;
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

    const now = new Date();
    this.minutePivot.rotation.z = -(now.getMinutes() / 60) * Math.PI * 2;
    this.hourPivot.rotation.z = -(((now.getHours() % 12) + now.getMinutes() / 60) / 12) * Math.PI * 2;

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
