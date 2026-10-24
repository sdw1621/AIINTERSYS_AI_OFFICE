// 음성 알림: 단계가 끝날 때 짧은 알림음 + 한국어 음성으로 "무엇을 마쳤는지"를 요약해 읽어 준다.
// 브라우저 내장 음성 합성(Web Speech API)을 쓰므로 추가 비용이 없다.
// 브라우저는 사용자가 한 번 클릭/입력해야 소리를 낼 수 있어서, 업무 지시 버튼을 누를 때 unlock()을 호출한다.

const PREF_KEY = "aiOffice.voice";
// 여성 한국어 음성 이름 (OS·브라우저별). 없으면 아무 한국어 음성이나 쓴다.
const FEMALE_HINTS = ["sunhi", "선희", "yuna", "유나", "heami", "해미", "jimin", "지민", "seoyeon", "서연", "google 한국", "female", "여성"];
const MALE_HINTS = ["injoon", "인준", "hyunsu", "현수", "bongjin", "male", "남성"];

let enabled = readPref();
let audio = null;
let voice = null;

function readPref() {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function isVoiceEnabled() {
  return enabled;
}

export function setVoiceEnabled(on) {
  enabled = on;
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* 무시 */
  }
  if (!on) window.speechSynthesis?.cancel();
}

export function voiceSupported() {
  return "speechSynthesis" in window;
}

function pickVoice() {
  const all = window.speechSynthesis?.getVoices() || [];
  const ko = all.filter((v) => /^ko/i.test(v.lang));
  const name = (v) => v.name.toLowerCase();
  voice =
    ko.find((v) => FEMALE_HINTS.some((h) => name(v).includes(h))) ||
    ko.find((v) => !MALE_HINTS.some((h) => name(v).includes(h))) ||
    ko[0] ||
    null;
}
if (voiceSupported()) {
  pickVoice();
  window.speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}

// 사용자 동작(클릭) 안에서 한 번 호출해 두면 이후 자동 알림이 소리를 낼 수 있다
export function unlock() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch {
    audio = null;
  }
  if (voiceSupported()) {
    // 빈 발화를 한 번 보내 음성 엔진을 깨운다 (iOS Safari 대응)
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }
}

// 딩동 두 음
function chime(kind) {
  if (!audio) return;
  const notes = kind === "final" ? [660, 880, 1320] : kind === "error" ? [440, 330] : [784, 1047];
  const t0 = audio.currentTime + 0.02;
  notes.forEach((f, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    const t = t0 + i * 0.14;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
}

// kind: "step" | "final" | "error". 여러 알림이 겹치면 순서대로 읽는다.
export function announce(text, kind = "step") {
  if (!enabled) return;
  chime(kind);
  if (!voiceSupported() || !text) return;
  if (!voice) pickVoice();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR";
  if (voice) u.voice = voice;
  u.rate = 1.05;
  u.pitch = 1.05;
  // 알림음이 먼저 들리도록 살짝 늦춰서 읽는다
  setTimeout(() => window.speechSynthesis.speak(u), 450);
}

// 소리 내어 읽기 어색한 기호를 말로 바꾼다
function speakable(text) {
  return text
    .replace(/\s*[→⇒➜>]\s*/g, ", ")
    .replace(/(\d+)\s*\/\s*(\d+)/g, "$2점 중 $1점")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 마크다운 결과에서 읽어 줄 한두 문장을 뽑는다 (제목·표·기호 제거)
export function summarize(md, max = 90) {
  const raw = String(md || "").split("\n").map((l) => l.trim());
  const lines = raw
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !l.startsWith("|") && !/^[-*_]{3,}$/.test(l) && !l.startsWith(">"))
    .map((l) =>
      l
        .replace(/^[-*+]\s+|^\d+[.)]\s+/, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~#]/g, "")
        .replace(/\(데모 데이터\)/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => l.length > 3);
  // 표만 있는 결과(예: 기획안)는 표의 내용 칸을 이어서 읽는다
  if (!lines.length) {
    const rows = raw.filter((l) => l.startsWith("|") && !/^\|[\s:|-]+\|?$/.test(l)).slice(1);
    const cells = rows.map((r) => r.split("|").map((c) => c.replace(/[*_`]/g, "").trim()).filter((c) => c && !/^\d+$/.test(c)));
    const picked = cells.map((c) => c.slice(0, 2).join(", ")).filter(Boolean);
    if (picked.length) lines.push(picked.join(". "));
  }
  let out = "";
  for (const l of lines) {
    const next = out ? `${out}. ${l.replace(/[.。]$/, "")}` : l.replace(/[.。]$/, "");
    if (next.length > max && out) break;
    out = next;
    if (out.length >= max * 0.6) break;
  }
  out = speakable(out);
  return out.length > max ? out.slice(0, max) + "…" : out;
}

// ── AI 음성 회의: 사람마다 다른 목소리(성별 음성 + 높낮이·빠르기)로 한 줄씩 읽는다 ──
function voiceFor(gender, index = 0) {
  const ko = (window.speechSynthesis?.getVoices() || []).filter((v) => /^ko/i.test(v.lang));
  const name = (v) => v.name.toLowerCase();
  const female = ko.filter((v) => FEMALE_HINTS.some((h) => name(v).includes(h)));
  const male = ko.filter((v) => MALE_HINTS.some((h) => name(v).includes(h)));
  const pool = gender === "f" ? (female.length ? female : ko) : male.length ? male : ko.filter((v) => !female.includes(v)).length ? ko.filter((v) => !female.includes(v)) : ko;
  return pool.length ? pool[index % pool.length] : null;
}

// 다 읽으면 끝나는 Promise. 음성이 없거나 막히면 글자 수만큼 기다렸다 끝낸다.
export function speakAs(person, text, { index = 0 } = {}) {
  const fallback = Math.min(9000, 1200 + text.length * 85);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (!voiceSupported()) return setTimeout(finish, fallback);
    const u = new SpeechSynthesisUtterance(text.replace(/[📌☕🎮📖💡📝🖨️👍📈🔍]/gu, ""));
    const v = person?.voice || {};
    u.lang = "ko-KR";
    u.voice = voiceFor(v.gender, index);
    u.pitch = v.pitch ?? 1;
    u.rate = v.rate ?? 1;
    u.onend = finish;
    u.onerror = finish;
    window.speechSynthesis.speak(u);
    setTimeout(finish, fallback + 4000); // onend가 오지 않는 브라우저 대비
  });
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
}
