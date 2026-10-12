# AI-TTS

> 🔗 **배포 주소:** https://ai-tts.hotgarlic.dedyn.io

문장을 입력하면 그 언어 원어민의 억양으로 읽어 주고, MP3/WAV로 내려받을 수 있는 TTS 서비스입니다.
[tts_program_guide.md](tts_program_guide.md)의 로드맵 **1~2단계(최소 동작 → MVP)** 를 구현했습니다.

## 빠른 시작

요구 사항: Node.js 22.13 이상(내장 `node:sqlite` 사용), `ffmpeg`(PATH에 있거나 `FFMPEG_PATH`로 지정)

```bash
npm install
cp apps/api/.env.example apps/api/.env   # 사용할 엔진의 API 키 입력
npm run dev                              # API :3001 + 웹 :5173 (http://localhost:5173)
```

프로덕션: `npm run build && npm start` → API 서버가 빌드된 웹 앱까지 함께 서빙합니다(:3001).

> API 키가 하나도 없으면 **개발용 테스트 톤**(실제 음성이 아닌 비프음) 엔진만 켜집니다.
> 키 없이도 청킹·병합·캐시·다운로드 흐름 전체를 확인할 수 있게 하려는 것입니다. `TTS_MOCK=false`로 끌 수 있습니다.

## 배포 (https://ai-tts.hotgarlic.dedyn.io)

- 앱은 pm2 프로세스 `ai-tts`로 **127.0.0.1:3300**에만 바인딩된다. 외부 접근은 Caddy(HTTPS)만 가능.
  pm2 목록은 `pm2 save`로 저장되어 있어 재부팅 시 `pm2-rudy` 서비스가 다시 띄운다.
- 비밀값·포트는 `apps/api/.env`(권한 600, git 제외). 형식은 `apps/api/.env.example`.
- **TTS 엔진은 무료 모델 서버**(pm2 `ai-tts-models`, 127.0.0.1:8020)를 쓴다 — 아래 '무료 모델 서버' 참고.
  유료 엔진 키를 `.env`에 추가하면 같은 언어의 대체(fallback) 엔진으로 붙는다. 변경 후 `pm2 restart ai-tts`.
- Caddy 설정: `deploy/Caddyfile.ai-tts` (보안 헤더, 요청 본문 512KB 제한).
- 캐시 음성·이력 DB: `apps/api/storage/` (권한 700).

## 무료 모델 서버 (`services/model-server`)

API 요금 없이 이 서버에서 직접 음성을 만든다. Python 3.12 + FastAPI, **CPU 전용**(GPU는 RVC가 쓰고, GTX 1050 Ti는 최신 PyTorch 미지원).

| 언어 | 모델 (라이선스) | 보이스 |
|---|---|---|
| 한국어 | **MeloTTS** (MIT) — 무료 경량 모델 중 사실상 유일한 한국어 원어민 모델 | 여성 1 |
| 영어(미국·영국), 일본어, 중국어, 스페인어, 프랑스어, 포르투갈어(브라질) | **Kokoro-82M** (Apache 2.0) | 언어당 1~4 |

독일어·포르투갈어(포르투갈)·멕시코 스페인어는 무료 원어민 보이스가 없어 화면에서 숨겨진다(유료 키를 넣으면 나타남).

- **메모리**: 모델을 모두 올리면 약 3.5GB(MeloTTS 한국어 ≈1.8GB, Kokoro ≈1.5GB). 이 서버는 여유 RAM이 적어서
  **요청이 오면 그때 로드하고, 10분 동안 안 쓰면 프로세스를 종료해 메모리를 돌려준다**(pm2가 빈 상태 ~230MB로 재시작).
  그래서 쉬다가 첫 요청은 10~30초 더 걸린다. MeloTTS는 언어별 BERT를 모듈 전역에 붙잡아 두어 프로세스 종료 말고는 메모리 회수가 안 된다.
- MeloTTS는 한국어만 켠다(`MELO_LANGS=KR`). 다른 언어를 켜면 언어당 약 1GB가 더 든다.
- 모델 파일은 `setup.sh`가 미리 받아 두고, 운영은 `HF_HUB_OFFLINE=1`이라 재부팅 시 네트워크 없이 뜬다.
- 품질 확인(가이드 10장 방식): 생성 음성을 Whisper로 받아쓴 결과가 영어·일본어는 원문과 일치, 한국어는 연도 한 곳("이천이십육"→"2021")만 달랐다.

```bash
services/model-server/setup.sh                       # 새 서버에 설치 (venv, 의존성, 사전, 모델 다운로드)
pm2 start ecosystem.config.cjs --only ai-tts-models && pm2 save
pm2 logs ai-tts-models
curl -s 127.0.0.1:8020/health                         # 로드된 모델 확인
```

## 회원·관리자 (다른 프로젝트와 동일한 승인제)

- **회원가입**(이메일·이름·비밀번호·가입 메모, 약관 동의) → **승인 대기** 상태가 되고 로그인할 수 없다.
  `ADMIN_NOTIFY_EMAILS`로 승인 요청 메일이 간다(버튼 → `/admin?tab=users`).
  메일은 `SMTP_*` 설정(Gmail 앱 비밀번호, 다른 프로젝트와 같은 계정)이 비어 있으면 건너뛰고, 실패해도 가입은 성공한다.
- **관리자 계정**: 첫 기동 시 `.env`의 `ADMIN_EMAIL`/`ADMIN_PASSWORD`로 자동 생성(AI-Voice-Cover와 같은 계정). 이미 있으면 건드리지 않는다.
- **관리자 페이지** (`/admin`)
  - 대시보드: 승인 대기 수, 회원 수, 오늘 생성·실패·캐시, 엔진 사용 글자 수(전체 한도 대비), 최근 7일, 오늘 상위 회원
  - 회원 관리: 상태별 필터·검색, 승인 / 거절(사유 → 로그인 시 회원에게 표시) / 정지(즉시 로그아웃) / 해제, 승인 대기 일괄 승인,
    회원별 일일 한도 조정, 임시 비밀번호 발급(한 번만 표시), 회원별 최근 생성·로그인 기록
  - 생성 내역: 전체 회원의 생성 기록 검색, 실패 사유, 음성 듣기
  - 감사 로그: 가입·로그인 성공/실패/차단·비밀번호 변경·관리자 조치 전부 (IP 포함)
- **내 정보** (`/me`): 오늘 사용량/한도, 비밀번호 변경(다른 기기 세션 종료)

**보안**

| 항목 | 내용 |
|---|---|
| 비밀번호 | scrypt 해시, 8자 이상 영문+숫자. 없는 계정도 같은 시간으로 검증(계정 존재 노출 방지) |
| 세션 | 랜덤 토큰(DB엔 SHA-256만 저장), `HttpOnly` · `SameSite=Strict` · HTTPS에서 `Secure`, 7일(`SESSION_DAYS`) |
| 로그인 잠금 | 이메일·IP별 5회 실패 시 15분 잠금 + IP별 분당 30회 |
| 가입 제한 | IP별 시간당 10회(`SIGNUP_LIMIT_PER_HOUR`) |
| CSRF | 상태 변경 API는 JSON만 허용 + `Origin` 호스트 검사 + SameSite=Strict |
| 접근 제어 | 음성 생성 API는 승인된 회원만, 이력·음성 파일은 본인 것만(관리자는 전체) |
| 헤더 | CSP·X-Frame-Options·nosniff·Referrer/Permissions-Policy는 앱이, HSTS·`Server` 제거는 Caddy가 |
| 프록시 | `trust proxy: loopback` — Caddy가 넘긴 `X-Forwarded-For/Proto`만 신뢰 |

**비용 보호 장치** (유료 엔진 키 남용 방지)

| 장치 | 기본값 (`.env`) |
|---|---|
| `/api/tts` 회원별 분당 요청 수 | `RATE_LIMIT_PER_MIN=10` |
| 감지·미리보기 회원별 분당 요청 수 | `LIGHT_RATE_LIMIT_PER_MIN=120` |
| 회원별 일일 글자 수 (엔진 실제 호출분만, 캐시 적중 제외, 관리자 페이지에서 회원마다 조정) | `DAILY_CHAR_LIMIT_PER_USER=20000` |
| 서비스 전체 일일 글자 수 (비용 상한, 관리자 포함) | `DAILY_CHAR_LIMIT_GLOBAL=200000` |
| 동시 합성 작업 수 | `MAX_CONCURRENT_JOBS=3` |

```bash
npm run build && pm2 restart ai-tts   # 코드 갱신 후
pm2 logs ai-tts
```

## 구조

```
apps/
├─ api/                      Node.js (Express 5)
│  ├─ src/
│  │  ├─ routes/tts.js       REST 엔드포인트
│  │  ├─ pipeline/
│  │  │  ├─ detectLanguage.js   ① 문자 체계 1차 판별 + franc(라틴 문자권)
│  │  │  ├─ normalize/          ② ko(고유어/한자어 수사 구분), en(US/GB), ja
│  │  │  ├─ chunk.js            ③ Intl.Segmenter 문장 분할 → 쉼표 → 단어 (단어 중간 절단 없음)
│  │  │  └─ mergeAudio.js       ⑥ PCM 통일 → 200ms 무음 삽입 → atempo → loudnorm → MP3/WAV/OGG
│  │  ├─ providers/          ⑤ Azure / Google / ElevenLabs / OpenAI / 로컬 모델 / mock
│  │  ├─ services/
│  │  │  ├─ voices.js        ④ 로케일 → 보이스 매핑, fallback 순서
│  │  │  ├─ store.js         ⑦ 음성 파일 캐시(파일시스템) + 생성 이력(SQLite)
│  │  │  └─ tts.js           파이프라인 오케스트레이션
│  │  └─ config/voices.json  로케일별 원어민 보이스 (재배포 없이 교체 가능)
│  └─ test/                  node:test (정규화·감지·청킹·API E2E)
└─ web/                      React + Vite
```

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 생존 확인 (공개) |
| POST | `/api/auth/signup` · `/login` · `/logout` | 가입 신청 / 로그인 / 로그아웃 |
| GET · PATCH | `/api/auth/me` · `/api/auth/password` | 내 정보·오늘 사용량 / 비밀번호 변경 |
| | `/api/admin/*` | 관리자 전용 (stats, users, generations, audit) |
| GET | `/api/config` | 활성 엔진 목록, 글자 수 한도 |
| GET | `/api/voices` | 로케일별 보이스 (`available`: 엔진 키 설정 여부) |
| POST | `/api/detect` | `{text}` → `{language, locale, confidence, alternatives}` |
| POST | `/api/normalize` | `{text, locale?}` → `{locale, normalized}` (읽는 방식 미리보기) |
| POST | `/api/tts` | `{text, locale?, voiceId?, speed?, format?, normalizedText?}` → `{audioUrl, voice, normalized, cached, fallbackFrom?}` |
| GET | `/api/audio/:key.:format` | 음성 파일 (`?download=1`이면 첨부파일로) |
| GET | `/api/history` | 본인 생성 이력 |

`/api/health`와 `/api/auth/signup·login`을 제외한 모든 API는 승인된 회원의 로그인이 필요합니다.

- `locale`을 생략하면 자동 감지하고, `voiceId`를 생략하면 그 로케일의 첫 번째 활성 보이스를 씁니다.
- `normalizedText`: 사용자가 미리보기에서 직접 고친 텍스트. 있으면 자동 정규화를 건너뜁니다.
- 선택한 엔진이 재시도(지수 백오프) 후에도 실패하면 같은 로케일의 **다른 엔진** 보이스로 자동 대체하고, 응답의 `fallbackFrom`에 원래 보이스를 표시합니다.
- 캐시 키 = `sha256(정규화 텍스트 + locale + 보이스 + 속도 + 포맷)`. 같은 요청은 엔진을 다시 호출하지 않습니다.

## 엔진 설정

`apps/api/.env`에 키가 있는 엔진만 활성화됩니다. 키는 서버에만 두고 프론트엔드에는 절대 넣지 않습니다.

| 엔진 | 환경 변수 | 비고 |
|---|---|---|
| Azure AI Speech | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | SSML `prosody rate`로 속도 조절 |
| Google Cloud TTS | `GOOGLE_TTS_API_KEY` | REST API 키 방식 |
| ElevenLabs | `ELEVENLABS_API_KEY` (`ELEVENLABS_MODEL_ID`) | 속도는 후처리(ffmpeg atempo) |
| OpenAI | `OPENAI_API_KEY` (`OPENAI_TTS_MODEL`) | 로케일별 원어민 보이스 개념이 약해 en-US에만 매핑 |
| 로컬 모델 서버 | `MODEL_SERVER_URL` | 아래 계약을 따르는 Python 서버 |

**로컬 모델 서버 계약** (Kokoro, CosyVoice2 등을 FastAPI로 감쌀 때):
`POST {MODEL_SERVER_URL}/synthesize`, JSON `{text, locale, voice, speed}` → 응답 본문은 오디오 바이트(WAV 권장).

**보이스 교체**: [apps/api/src/config/voices.json](apps/api/src/config/voices.json)을 수정합니다. 목록 순서가 우선순위입니다.
보이스 ID와 엔드포인트는 작성 시점 기준이므로 **각 업체 공식 문서에서 최신 여부를 확인**하세요. 새 엔진은 `BaseProvider`를 상속해 `providers/index.js`에 등록하면 됩니다.

## 테스트

```bash
npm test
```

정규화 테스트 케이스(`apps/api/test/normalize.test.js`)는 가이드 10장의 회귀 테스트 세트의 출발점입니다.
엔진·보이스·규칙을 바꿀 때마다 실행하세요.

## 알려진 한계 / 다음 단계

- **정규화**: 한국어 `번`은 횟수(세 번)로 읽어서 `3번 출구`(삼 번)는 틀립니다. 이런 경우를 위해 UI에서 읽는 방식을 직접 고칠 수 있습니다. 발음 사전(lexicon)은 아직 없습니다.
- **혼합 언어**: 한 문장 안의 여러 언어를 구간별로 처리하지 않습니다(2차 확장).
- **운영 인프라**: 캐시는 로컬 파일시스템, 회원·이력은 SQLite, 요청 제한·로그인 잠금은 프로세스 메모리입니다(재시작 시 초기화, 일일 사용량은 DB라 유지).
  규모가 커지면 S3/R2 + 서명 URL, MySQL/PostgreSQL, Redis, BullMQ 큐로 옮겨야 합니다. 결제·요금제는 아직 없습니다.
- **회원 셀프 서비스**: 비밀번호 찾기·회원 탈퇴는 없습니다(관리자의 임시 비밀번호 발급으로 대응, 탈퇴는 관리자에게 요청).
- **출시 전**: 엔진 약관의 상업 이용·재판매 허용 여부, 원어민 청취 평가, AI 생성물 고지 정책(가이드 11·14장)을 확인하세요.
