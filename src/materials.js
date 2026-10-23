// 첨부 자료: 브라우저가 파일에서 텍스트를 뽑거나(PDF·Word·hwpx·엑셀·CSV) 이미지를 줄여서 보내면,
// 여기서 검사·정리한 뒤 에이전트가 read_material 도구로 한 부분씩 읽게 한다.

const MAX_FILES = 10;
const MAX_TEXT = 300_000; // 파일 하나당 글자 수 상한
const PART_SIZE = 12_000; // 한 번에 읽어 주는 글자 수
const MAX_IMAGES = 12; // 파일 하나당 이미지(페이지) 수 상한
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const KIND_LABEL = { text: "문서", images: "이미지" };

export function normalizeMaterials(input) {
  if (input == null) return { materials: [] };
  if (!Array.isArray(input)) return { error: "첨부 자료 형식이 올바르지 않습니다." };
  if (input.length > MAX_FILES) return { error: `첨부 자료는 ${MAX_FILES}개까지 올릴 수 있습니다.` };
  const seen = new Set();
  const materials = [];
  for (const raw of input) {
    let name = String(raw?.name || "").replace(/[\r\n"]/g, " ").trim().slice(0, 120) || "자료";
    // 같은 이름이 겹치면 번호를 붙인다
    for (let i = 2; seen.has(name); i++) name = name.replace(/( \(\d+\))?$/, ` (${i})`);
    seen.add(name);
    const source = String(raw?.source || "").slice(0, 40);
    if (raw?.kind === "text") {
      const text = String(raw.text || "").replace(/\u0000/g, "").slice(0, MAX_TEXT);
      if (!text.trim()) continue;
      const parts = Math.max(1, Math.ceil(text.length / PART_SIZE));
      materials.push({ name, kind: "text", kindLabel: source || KIND_LABEL.text, text, parts, preview: preview(text), chars: text.length });
    } else if (raw?.kind === "images") {
      const images = (Array.isArray(raw.images) ? raw.images : [])
        .filter((im) => IMAGE_TYPES.includes(im?.media_type) && typeof im.data === "string" && im.data.length < 2_000_000)
        .slice(0, MAX_IMAGES);
      if (!images.length) continue;
      materials.push({ name, kind: "images", kindLabel: source || KIND_LABEL.images, images, parts: images.length, preview: `이미지 ${images.length}장`, chars: 0 });
    }
  }
  return { materials };
}

function preview(text) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 240 ? t.slice(0, 240) + "…" : t;
}

// 화면·DB에 남길 자료 목록 (내용은 빼고)
export function materialIndex(materials) {
  return materials.map((m) => ({ name: m.name, kind: m.kind, kindLabel: m.kindLabel, parts: m.parts, chars: m.chars }));
}

export function readMaterial(materials, name, part = 1) {
  const m = materials.find((x) => x.name === name);
  if (!m) return { error: `"${name}" 자료가 없습니다. 있는 자료: ${materials.map((x) => x.name).join(", ")}` };
  const p = Math.min(Math.max(1, Number(part) || 1), m.parts);
  const head = `[${m.name} · ${p}/${m.parts}부분]`;
  if (m.kind === "text") {
    const chunk = m.text.slice((p - 1) * PART_SIZE, p * PART_SIZE);
    const more = p < m.parts ? `\n\n(다음 내용은 part ${p + 1}에서 이어집니다)` : "\n\n(자료 끝)";
    return { part: p, parts: m.parts, content: `${head}\n${chunk}${more}` };
  }
  const im = m.images[p - 1];
  return {
    part: p,
    parts: m.parts,
    content: [
      { type: "text", text: `${head}${p < m.parts ? ` (다음 페이지는 part ${p + 1})` : " (마지막 페이지)"}` },
      { type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } },
    ],
  };
}
