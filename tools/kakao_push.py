"""카카오톡 '대화 내보내기' 파일을 AI 타워로 올린다 (PC 자동 수집·예약 작업용).

사용법 (윈도우 작업 스케줄러나 cron에 매일 한 번):
    set AI_TOWER_IMPORT_KEY=발급받은키
    python kakao_push.py "C:\\Users\\me\\Documents\\카카오톡 받은 파일\\KakaoTalkChats.txt"

이미 올라간 메시지는 서버가 알아서 건너뛰므로 전체 파일을 매번 올려도 된다.
"""
import json, os, sys, urllib.request

URL = os.environ.get("AI_TOWER_URL", "https://aiintersys-ai-office.vercel.app") + "/api/chat/import"
KEY = os.environ.get("AI_TOWER_IMPORT_KEY", "")

def main(path: str) -> None:
    if not KEY:
        sys.exit("AI_TOWER_IMPORT_KEY 환경 변수를 넣어 주세요.")
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "cp949"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    body = json.dumps({"room": "kriso", "text": text}).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST", headers={"Content-Type": "application/json", "X-Import-Key": KEY})
    with urllib.request.urlopen(req, timeout=60) as res:
        r = json.loads(res.read())
    print(f"새로 쌓인 메시지 {r.get('inserted')}건 / 누적 {r.get('total')}건 ({r.get('first')} ~ {r.get('last')})")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("사용법: python kakao_push.py <KakaoTalkChats.txt 경로>")
    main(sys.argv[1])
