// 실제 프로젝트·사람 배정. 층 하나에 프로젝트 하나 (위에서부터 5F → 1F).
// 일정은 구글 캘린더에서 오고, 일정 제목·설명에 아래 match 단어가 있으면 그 프로젝트 일정으로 본다.

export const PEOPLE = {
  shin: { id: "shin", name: "신동욱", title: "대표 · 교수", color: "#1E40AF", look: { hair: "short", hairColor: "#1a1a1a", outfit: "#1f2a44", shirt: "#ffffff", pants: "#1c2233", glasses: true } },
  yang: { id: "yang", name: "양선희", title: "PM", color: "#0E7490", look: { hair: "long", hairColor: "#2a1d18", outfit: "#e8dccb", shirt: "#ffffff", pants: "#3b3b46" } },
  leebu: { id: "leebu", name: "이부일", title: "미팅일정", color: "#0E7490", look: { hair: "short", hairColor: "#22201e", outfit: "#5b7aa8", shirt: "#ffffff", pants: "#2b2f3a" } },
  leejh: { id: "leejh", name: "이재현", title: "문서정리", color: "#0E7490", look: { hair: "short", hairColor: "#2c2420", outfit: "#7a8f6b", shirt: "#ffffff", pants: "#30343c" } },
};

const ULSAN_PBL = "울산 PBL · 클로드 코드 업무 자동화 구현 및 챗봇 (3주, 1일 4시간)";

export const PROJECTS = [
  {
    id: "kriso", floor: 5, color: "#0E7490",
    name: "선박해양플랜트연구소", short: "KRISO",
    title: "온톨로지 시스템",
    summary: "해양 지식그래프·온톨로지 시스템 구축",
    tags: ["IHO S-100", "Neo4j", "OWL2"],
    members: [
      { id: "yang", role: "PM", duty: "온톨로지 시스템 총괄", desk: { x: 28, y: 26 } },
      { id: "shin", role: "PL", duty: "온톨로지 시스템 개발", desk: { x: 46, y: 26 } },
      { id: "leebu", role: "담당", duty: "미팅일정", desk: { x: 64, y: 26 } },
      { id: "leejh", role: "담당", duty: "문서정리", desk: { x: 82, y: 26 } },
    ],
    match: /kriso|선박해양/i,
  },
  {
    id: "kmold", floor: 4, color: "#2563EB",
    name: "한국몰드", short: "한국몰드", group: "울산 자동차 제조 3사",
    title: "사출금형 및 자동차 내외장재 공정의 AX 기반 생산성 향상 및 업무효율화 기술 AI 역량 내재화",
    summary: ULSAN_PBL, partner: "인리치인재교육원", day: "매주 화요일",
    strategies: ["AI 기반 제조데이터 표준화 및 지식자산 관리", "AI 기반 3D STP 가공시간·원가 예측", "AI 기반 유사금형 검색 및 설계지식 추천"],
    members: [{ id: "shin", role: "교수", duty: "PBL 강의 · AX 실행계획", desk: { x: 46, y: 26 } }],
    match: /한국몰드/,
  },
  {
    id: "topind", floor: 3, color: "#7C3AED",
    name: "탑아이앤디", short: "탑아이앤디", group: "울산 자동차 제조 3사",
    title: "AX기반 프레스 공정 예지보전 및 품질 이상 AI역량 내재화",
    summary: ULSAN_PBL, partner: "인리치인재교육원", day: "매주 수요일",
    strategies: ["AI 기반 제조데이터 자동정제 및 연계관리", "AI 기반 생산관리 통합 모니터링 및 운영위험 탐지", "AI 기반 품질검사 성적서 자동작성 및 데이터 변환"],
    members: [{ id: "shin", role: "교수", duty: "PBL 강의 · AX 실행계획", desk: { x: 46, y: 26 } }],
    match: /탑\s?아이앤디|탑\s?아이엔디/,
  },
  {
    id: "dnk", floor: 2, color: "#DB2777",
    name: "디엔케이모빌리티", short: "DnK모빌리티", group: "울산 자동차 제조 3사",
    title: "AI기반 자동차 부품 제조 공정 지능화 및 현장 맞춤형 AX 인재 양성 프로젝트",
    summary: ULSAN_PBL, partner: "인리치인재교육원", day: "매주 목요일",
    strategies: ["AI 기반 품질데이터 분석 및 공정능력 관리", "생성형 AI 기반 연구사업 기획 및 문서작성", "OCR·AI 기반 연구비 증빙처리 및 사업비 관리"],
    members: [{ id: "shin", role: "교수", duty: "PBL 강의 · AX 실행계획", desk: { x: 46, y: 26 } }],
    match: /dnk|디엔케이/i,
  },
  {
    id: "sbiz", floor: 1, color: "#16A34A",
    name: "소상공인진흥협회", short: "소상공인진흥협회",
    title: "",
    summary: "",
    members: [{ id: "shin", role: "교수", duty: "", desk: { x: 46, y: 26 } }],
    match: /소상공인/,
  },
];

export const projectById = Object.fromEntries(PROJECTS.map((p) => [p.id, p]));

// 일정 제목·설명·장소로 프로젝트를 찾는다. 해당 없으면 null (그 일정은 밖으로 내보내지 않는다).
export function matchProject(ev) {
  const text = `${ev.title || ""} ${ev.description || ""} ${ev.location || ""}`;
  return PROJECTS.find((p) => p.match.test(text))?.id || null;
}

// 화면으로 보내는 형태 (정규식은 빼고)
export function publicProjects() {
  return PROJECTS.map(({ match, ...p }) => p);
}
