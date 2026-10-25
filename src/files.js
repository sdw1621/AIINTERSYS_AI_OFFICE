// 단톡방 자료 이력관리: 단톡방에 올라온 파일을 '문서군(같은 문서의 여러 버전)'으로 묶고 버전 번호를 매긴다.
// 파일 이름에서 날짜·시각·통합·수정·v2·(1) 같은 꼬리를 떼어 낸 '바탕 이름'이 같으면 같은 문서군이다.
// 실제 파일은 구글 드라이브 'AI 타워 자료실/<층>/<분류>/' 에 'v03_2026-10-23_이재현_원래이름' 으로 쌓는다.

export const CATEGORIES = [
  { id: "admin", name: "08 행정서류", re: /착수신고|서명|계약서|신청서|견적|영수증|receipt|invoice|청구|통장|사업자/i },
  { id: "report", name: "01 보고서", re: /보고서|부록|착수보고|중간보고|점검회의|최종본/ },
  { id: "proposal", name: "02 제안·RFP", re: /제안서|proposal|rfp|과업|요구사항|평가표/i },
  { id: "deck", name: "05 발표자료", re: /발표|스크립트/ },
  { id: "meeting", name: "03 회의록·녹음", re: /회의록|미팅|자문|녹음|\.m4a$|\.mp3$|\.wav$/i },
  { id: "law", name: "06 법령·참고자료", re: /법_|법령|핵심정리|용어사전|정책연구|연구\.pdf$|번역본|논문|graph-based ai|survey/i },
  { id: "design", name: "04 온톨로지·설계", re: /온톨로지|ontology|클래스|관계|속성|des-|rrq|ter-|com-|역량질문|cq|bfo|urn|아키텍처|architecture|그래프|graph|neo4j|owl|명세|kg/i },
  { id: "data", name: "07 데이터", re: /\.csv$|\.xlsx?$|\.json$|ais|api조사|데이터/i },
  { id: "etc", name: "09 기타", re: /./ },
];
// 화면·드라이브에서는 번호 순서로 보여 준다
export const CATEGORY_ORDER = ["report", "proposal", "meeting", "design", "deck", "law", "data", "admin", "etc"];

const EXT = (n) => (n.match(/\.([a-z0-9]{1,6})$/i)?.[1] || "").toLowerCase();

// 바탕 이름: 확장자·날짜·시각·버전 꼬리를 떼고 공백·기호를 정리
export function baseName(name) {
  let s = name.replace(/\.[a-z0-9]{1,6}$/i, "");
  s = s.replace(/\.txt$/i, "");
  s = s.replace(/\s*\(\d+\)$/, "");
  s = s.replace(/20\d{2}[-_.]?\d{2}[-_.]?\d{2}([-_ ]?\d{3,4})?/g, " "); // 2026-10-17, 2026_1016_2345, 20260812
  s = s.replace(/20\d{2}[-_]\d{4}([-_]\d{3,4})?/g, " "); // 2026_1016, 2026-1020_2254
  s = s.replace(/(^|[_\s-])\d{4}([-_]\d{3,4})?(?=$|[_\s-])/g, " "); // _1015, _0328_2155
  s = s.replace(/(^|[_\s-])(v\d+|r\d+|ver\d+|최종|최종본|수정|수정본|통합|통합본|중복삭제본|발표체|발표노트|사본|추가|세번째|두번째|첫번째|new)(?=$|[_\s-])/gi, " ");
  s = s.replace(/[_\-·,]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  // 같은 문서를 조금 다르게 부른 것 맞추기
  s = s.replace(/^kriso\s*/, "kriso ").replace(/대화형\s*해사\s*서비스/g, "대화형해사서비스").replace(/대화형\s*해사\s*플랫폼/g, "대화형해사플랫폼");
  return s || name.toLowerCase();
}

export function categoryOf(name) {
  return CATEGORIES.find((c) => c.re.test(name)) || CATEGORIES.at(-1);
}

// 임시파일·자동 저장 파일은 이력에서 뺀다
export const isJunk = (name) => /\.tmp$|^~\$|^kat\d+/i.test(name);

// files: [{chatId?, t, who, person, name}] (시간순) → 문서군·버전이 붙은 목록
export function versionize(files) {
  const fam = new Map();
  const out = [];
  for (const f of [...files].sort((a, b) => a.t.localeCompare(b.t))) {
    if (isJunk(f.name)) { out.push({ ...f, family: null, version: 0, category: "etc", junk: true }); continue; }
    const key = `${baseName(f.name)}|${EXT(f.name)}`;
    const list = fam.get(key) || [];
    // 같은 이름이 다시 올라오면(재공유) 새 버전이 아니라 같은 버전으로 본다
    const same = list.find((x) => x.name === f.name);
    const version = same ? same.version : list.length ? Math.max(...list.map((x) => x.version)) + 1 : 1;
    const row = { ...f, family: key, version, category: categoryOf(f.name).id, reshare: Boolean(same) };
    list.push(row);
    fam.set(key, list);
    out.push(row);
  }
  for (const list of fam.values()) {
    const top = Math.max(...list.map((x) => x.version));
    for (const r of list) r.latest = r.version === top;
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
// 드라이브에 둘 이름: v03_2026-10-23_이재현_원래이름
export function driveTitle(r, names = {}) {
  return `v${pad(r.version)}_${r.t.slice(0, 10)}_${names[r.person] || (r.who || "").replace(/대표님|님/g, "").replace(/^.*_/, "")}_${r.name}`;
}
