// 첨부 자료를 브라우저에서 읽어 서버로 보낼 형태로 바꾼다.
// - 텍스트로 뽑을 수 있는 것: PDF(pdf.js) · Word .docx(mammoth) · 한글 .hwpx(XML) · 엑셀/CSV(SheetJS) · txt/md/json
// - 그림으로 보내는 것: 이미지, 글자가 없는 스캔 PDF (긴 변 1568px JPEG로 줄여서)
// 파일 원본은 서버로 보내지 않는다. Vercel 요청 본문 상한(약 4.5MB) 안에 들어오도록 크기를 맞춘다.

const CDN = "https://cdn.jsdelivr.net/npm";
const LIBS = {
  pdfjs: `${CDN}/pdfjs-dist@4.4.168/build/pdf.min.mjs`,
  pdfWorker: `${CDN}/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs`,
  mammoth: `${CDN}/mammoth@1.8.0/mammoth.browser.min.js`,
  jszip: `${CDN}/jszip@3.10.1/dist/jszip.min.js`,
  xlsx: `${CDN}/xlsx@0.18.5/dist/xlsx.full.min.js`,
};
export const ACCEPT = ".pdf,.docx,.hwpx,.xlsx,.xls,.csv,.txt,.md,.json,image/*";
export const MAX_BODY = 4_200_000; // 이 크기를 넘으면 보내지 않는다
const MAX_SCAN_PAGES = 8;
const IMG_EDGE = 1568;

const loaded = {};
function script(url, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return (loaded[url] ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = () => resolve(window[globalName]);
    s.onerror = () => reject(new Error("자료 변환 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요."));
    document.head.append(s);
  }));
}

async function pdfjs() {
  const lib = await (loaded.pdf ??= import(/* @vite-ignore */ LIBS.pdfjs));
  lib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
  return lib;
}

// 캔버스를 JPEG base64로
function canvasToJpeg(canvas) {
  return canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
}

function fitCanvas(w, h) {
  const k = Math.min(1, IMG_EDGE / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  return { c, k };
}

async function readImage(file) {
  const bmp = await createImageBitmap(file);
  const { c } = fitCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return { kind: "images", source: "이미지", images: [{ media_type: "image/jpeg", data: canvasToJpeg(c) }] };
}

async function readPdf(file) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // 같은 줄(y 좌표)끼리 묶어 줄바꿈을 살린다
    let lastY = null;
    let line = "";
    const lines = [];
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line);
        line = "";
      }
      line += it.str;
      lastY = y;
    }
    lines.push(line);
    pages.push(lines.join("\n").trim());
  }
  const text = pages.map((p, i) => `--- ${i + 1}쪽 ---\n${p}`).join("\n\n");
  const avg = pages.join("").replace(/\s/g, "").length / Math.max(1, doc.numPages);
  if (avg > 40) return { kind: "text", source: `PDF ${doc.numPages}쪽`, text };
  // 글자가 거의 없으면 스캔본으로 보고 앞쪽 페이지를 그림으로 보낸다
  const images = [];
  for (let i = 1; i <= Math.min(doc.numPages, MAX_SCAN_PAGES); i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const scale = Math.min(2, IMG_EDGE / Math.max(vp.width, vp.height));
    const v = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.round(v.width);
    c.height = Math.round(v.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: v }).promise;
    images.push({ media_type: "image/jpeg", data: canvasToJpeg(c) });
  }
  return { kind: "images", source: `스캔 PDF ${images.length}/${doc.numPages}쪽`, images };
}

async function readDocx(file) {
  const mammoth = await script(LIBS.mammoth, "mammoth");
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return { kind: "text", source: "Word", text: value };
}

// 한글 .hwpx = zip 안의 Contents/section*.xml. 문단(hp:p)마다 글자(hp:t)를 모은다.
async function readHwpx(file) {
  const JSZip = await script(LIBS.jszip, "JSZip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const sections = Object.keys(zip.files)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!sections.length) throw new Error("한글 문서 내용을 찾지 못했습니다.");
  const out = [];
  for (const name of sections) {
    const xml = new DOMParser().parseFromString(await zip.file(name).async("string"), "application/xml");
    for (const p of xml.getElementsByTagNameNS("*", "p")) {
      // 표 안 문단의 글자가 바깥 문단에도 중복으로 잡히지 않도록, 가장 가까운 문단이 자신인 글자만 모은다
      const text = [...p.getElementsByTagNameNS("*", "t")]
        .filter((t) => {
          let el = t.parentElement;
          while (el && el.localName !== "p") el = el.parentElement;
          return el === p;
        })
        .map((t) => t.textContent)
        .join("");
      if (text.trim()) out.push(text);
    }
  }
  return { kind: "text", source: "한글 hwpx", text: out.join("\n") };
}

async function readSheet(file) {
  const XLSX = await script(LIBS.xlsx, "XLSX");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const text = wb.SheetNames.map((n) => `## 시트: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}`).join("\n\n");
  return { kind: "text", source: `엑셀 ${wb.SheetNames.length}시트`, text };
}

// 파일 하나 → { name, kind, source, text | images, size(전송 크기) }
export async function readMaterialFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  let out;
  if (file.type.startsWith("image/")) out = await readImage(file);
  else if (ext === "pdf") out = await readPdf(file);
  else if (ext === "docx") out = await readDocx(file);
  else if (ext === "hwpx") out = await readHwpx(file);
  else if (["xlsx", "xls", "csv"].includes(ext)) out = await readSheet(file);
  else if (["txt", "md", "json"].includes(ext)) out = { kind: "text", source: "텍스트", text: await file.text() };
  else if (ext === "hwp") throw new Error("옛 한글(.hwp)은 읽을 수 없어요. 한글에서 .hwpx나 PDF로 저장해 올려 주세요.");
  else if (ext === "doc") throw new Error("옛 Word(.doc)는 읽을 수 없어요. .docx나 PDF로 저장해 올려 주세요.");
  else throw new Error("지원하지 않는 형식이에요. (PDF · Word · hwpx · 엑셀 · CSV · 이미지)");
  if (out.kind === "text" && !out.text.trim()) throw new Error("문서에서 글자를 찾지 못했습니다.");
  const payload = { name: file.name, ...out };
  payload.size = JSON.stringify(payload).length;
  return payload;
}

export function describe(m) {
  const kb = (n) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1000))}KB`);
  return m.kind === "text" ? `${m.source} · ${m.text.length.toLocaleString()}자` : `${m.source} · ${kb(m.size)}`;
}
