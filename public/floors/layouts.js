// 층 사진(AI 일러스트) 위 자리 배치. 좌표 = 사진 가로·세로에 대한 비율(0~1, 왼쪽 위가 0,0).
// 사진은 2688×1520(16:9)으로 만들었고, public/floors/<id>.webp 로 받아 둔다(.github/workflows/floor-images.yml).
const px = (x, y) => [x / 1600, y / 905]; // 1600×905로 줄인 사진에서 잰 값
const PANTRY = ["☕ 커피 한 잔", "물 한 잔 마시고 올게요", "잠깐 쉬는 중", "간식 타임 🍪"];

export const FLOOR_PHOTOS = {
  kriso: {
    src: "floors/kriso.webp", w: 2688, h: 1520,
    seats: { yang: px(760, 318), shin: px(905, 352), leebu: px(1065, 392), leejh: px(1235, 428) },
    deskLook: { yang: px(770, 250), shin: px(915, 285), leebu: px(1075, 325), leejh: px(1245, 360), default: px(1000, 250) },
    tableCenter: px(500, 500),
    table: [px(375, 435), px(565, 420), px(625, 448), px(620, 560), px(450, 548), px(370, 515)],
    aisle: px(720, 470),
    pois: [
      { at: px(330, 410), look: px(300, 330), kind: "pantry", lines: PANTRY },
      { at: px(600, 345), look: px(570, 260), kind: "screen", lines: ["서버 상태 확인 중 🖥️", "적재 배치 돌아가는 중"] },
      { at: px(930, 455), look: px(960, 200), kind: "screen", lines: ["그래프 구조 확인 중", "온톨로지 관계 점검 🔍", "새 노드 들어왔네요"] },
      { at: px(1065, 565), look: px(1000, 640), kind: "lounge", lines: ["잠깐 머리 식히는 중", "자료 읽는 중 📖", "아이디어 정리 중 💡"] },
      { at: px(790, 600), look: px(900, 650), kind: "lounge", lines: ["잠깐 쉬는 중", "커피 식기 전에 ☕"] },
      { at: px(130, 470), look: px(60, 400), kind: "window", lines: ["야경 좋네요 🌃", "통화 중 📞"] },
    ],
  },
  kmold: {
    src: "floors/kmold.webp", w: 2688, h: 1520,
    seats: { shin: px(720, 332) }, deskLook: { default: px(720, 280) },
    tableCenter: px(455, 540),
    table: [px(330, 535), px(380, 582), px(470, 602), px(575, 590), px(590, 545), px(410, 482)],
    aisle: px(720, 520),
    pois: [
      { at: px(330, 405), look: px(300, 340), kind: "pantry", lines: PANTRY },
      { at: px(1020, 395), look: px(1020, 300), kind: "maker", lines: ["시제품 출력 확인 중 🖨️", "금형 샘플 살펴보는 중"] },
      { at: px(1090, 600), look: px(1130, 560), kind: "lecture", lines: ["실습 자리 점검 중", "다음 실습 준비 📝"] },
      { at: px(1300, 480), look: px(1350, 380), kind: "screen", lines: ["강의 자료 점검 중", "AI 로드맵 다시 보는 중"] },
    ],
  },
  topind: {
    src: "floors/topind.webp", w: 2688, h: 1520,
    seats: { shin: px(712, 335) }, deskLook: { default: px(712, 280) },
    tableCenter: px(390, 520),
    table: [px(262, 520), px(302, 592), px(420, 622), px(522, 582), px(530, 500), px(340, 472)],
    aisle: px(700, 520),
    pois: [
      { at: px(370, 385), look: px(370, 300), kind: "pantry", lines: PANTRY },
      { at: px(1060, 415), look: px(1100, 320), kind: "maker", lines: ["로봇 팔 데모 점검 중 🤖", "챗봇 시연 준비"] },
      { at: px(1220, 565), look: px(1230, 520), kind: "lecture", lines: ["실습 자리 점검 중", "다음 실습 준비 📝"] },
      { at: px(1380, 520), look: px(1420, 400), kind: "screen", lines: ["강의 자료 점검 중"] },
    ],
  },
  dnk: {
    src: "floors/dnk.webp", w: 2688, h: 1520,
    seats: { shin: px(710, 335) }, deskLook: { default: px(710, 280) },
    tableCenter: px(510, 490),
    table: [px(380, 482), px(430, 552), px(545, 602), px(630, 562), px(620, 472), px(440, 442)],
    aisle: px(760, 500),
    pois: [
      { at: px(265, 365), look: px(260, 300), kind: "pantry", lines: PANTRY },
      { at: px(1050, 335), look: px(1050, 250), kind: "maker", lines: ["부품 시제품 살펴보는 중 ⚙️", "변속기 구조 확인"] },
      { at: px(1190, 525), look: px(1200, 470), kind: "lecture", lines: ["실습 자리 점검 중", "다음 실습 준비 📝"] },
      { at: px(1400, 440), look: px(1450, 330), kind: "screen", lines: ["공정 데이터 보는 중 📈"] },
    ],
  },
  sbiz: {
    src: "floors/sbiz.webp", w: 2688, h: 1520,
    seats: { shin: px(700, 305) }, deskLook: { default: px(700, 250) },
    tableCenter: px(510, 530),
    table: [px(390, 505), px(480, 582), px(580, 562), px(640, 522), px(630, 452), px(450, 472)],
    aisle: px(760, 470),
    pois: [
      { at: px(245, 340), look: px(230, 260), kind: "pantry", lines: PANTRY },
      { at: px(1150, 445), look: px(1180, 380), kind: "board", lines: ["상담 접수 확인 중", "오늘 방문 일정 보는 중"] },
      { at: px(1140, 565), look: px(1050, 620), kind: "lounge", lines: ["상담 기록 정리 중", "잠깐 쉬는 중"] },
      { at: px(830, 600), look: px(920, 640), kind: "lounge", lines: ["자료 읽는 중 📖"] },
      { at: px(430, 465), look: px(390, 380), kind: "board", lines: ["할 일 정리 중 📝", "전략 보드 업데이트"] },
    ],
  },
};
