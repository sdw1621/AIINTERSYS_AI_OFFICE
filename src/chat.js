// 카카오톡 '대화 내보내기' 텍스트 → 메시지 목록.
// 모바일 형식:  2026년 2월 4일 오후 5:43, 이름 : 내용
// PC 형식:     --------------- 2026년 2월 4일 수요일 ---------------  /  [이름] [오후 5:43] 내용
// 여러 줄 메시지는 앞 메시지에 이어 붙인다.

import { PEOPLE } from "./projects.js";

const MOBILE = /^(\d{4})년 (\d{1,2})월 (\d{1,2})일 (오전|오후) (\d{1,2}):(\d{2}), (.+?) : (.*)$/;
const MOBILE_SYS = /^(\d{4})년 (\d{1,2})월 (\d{1,2})일 (오전|오후) (\d{1,2}):(\d{2}), (.*)$/;
const MOBILE_DATE = /^(\d{4})년 (\d{1,2})월 (\d{1,2})일 (오전|오후) (\d{1,2}):(\d{2})$/;
const PC_DATE = /^-+ (\d{4})년 (\d{1,2})월 (\d{1,2})일 .*-+$/;
const PC_MSG = /^\[(.+?)\] \[(오전|오후) (\d{1,2}):(\d{2})\] (.*)$/;

function iso(y, mo, d, ap, h, mi) {
  let hh = Number(h) % 12;
  if (ap === "오후") hh += 12;
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(hh)}:${p(mi)}:00+09:00`;
}

export function kindOf(text) {
  if (text.startsWith("파일: ")) return "file";
  if (/^[0-9a-f]{64}\.(png|jpe?g|gif|webp)$/i.test(text) || /^<사진 읽지 않음>$|^사진$|^이모티콘$/.test(text)) return "photo";
  if (text === "메시지가 삭제되었습니다.") return "deleted";
  if (/^https?:\/\/\S+$/.test(text)) return "link";
  return "text";
}

// 대화방 표시 이름 → 프로젝트 인원 id (PEOPLE.chatNames)
const NAME_MAP = new Map(Object.values(PEOPLE).flatMap((p) => (p.chatNames || []).map((n) => [n, p.id])));
export const personOf = (who) => NAME_MAP.get(who) || null;

export function parseKakao(raw) {
  const lines = String(raw).replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let pcDate = null;
  const title = (lines[0] || "").replace(/ 카카오톡 대화$|님과 카카오톡 대화$/, "").trim();
  for (const ln of lines.slice(1)) {
    let m;
    if ((m = ln.match(MOBILE))) {
      const [, y, mo, d, ap, h, mi, who, text] = m;
      out.push({ t: iso(y, mo, d, ap, h, mi), who: who.trim(), text });
    } else if (MOBILE_DATE.test(ln)) {
      continue;
    } else if ((m = ln.match(MOBILE_SYS)) && !ln.includes(" : ")) {
      const [, y, mo, d, ap, h, mi, text] = m;
      out.push({ t: iso(y, mo, d, ap, h, mi), who: "", text, system: true });
    } else if ((m = ln.match(PC_DATE))) {
      pcDate = m.slice(1, 4);
    } else if (pcDate && (m = ln.match(PC_MSG))) {
      const [, who, ap, h, mi, text] = m;
      out.push({ t: iso(...pcDate, ap, h, mi), who: who.trim(), text });
    } else if (out.length && !out.at(-1).system && !/^저장한 날짜 : /.test(ln)) {
      out.at(-1).text += "\n" + ln;
    }
  }
  for (const m of out) {
    m.text = m.text.replace(/\s+$/, "");
    m.kind = m.system ? "system" : kindOf(m.text);
    m.person = personOf(m.who);
  }
  return { title, messages: out.filter((m) => m.text) };
}
