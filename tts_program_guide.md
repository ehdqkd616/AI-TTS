# 다국어 원어민 억양 TTS 프로그램 제작 지침서

> 목표: 문장을 입력하면 해당 언어 원어민의 자연스러운 억양으로 읽어 주고, 음성 파일(MP3/WAV)로 내려받을 수 있는 프로그램(ElevenLabs 유사 서비스)을 만든다.
>
> 작성일: 2026-10-11
> ⚠️ TTS 시장은 변화가 매우 빠릅니다. 이 문서에 나오는 모델·서비스 이름은 작성 시점에 조사한 것이고, **가격·지원 언어 수·요청 한도 같은 수치는 일부러 적지 않았습니다.** 개발 착수 전에 반드시 각 공식 문서에서 최신 정보를 확인하세요.

---

## 목차

1. 핵심 개념: "원어민 억양"은 어떻게 만들어지나
2. 구현 방식 선택 (상용 API / 오픈소스 / 하이브리드)
3. TTS 엔진 후보
4. 전체 아키텍처
5. 기능 명세 (MVP → 확장)
6. 핵심 처리 파이프라인 상세
7. 코드 골격 예시 (Node.js)
8. 데이터베이스 설계
9. 단계별 개발 로드맵
10. 품질 평가 방법
11. 법적·윤리적 주의사항
12. 비용 관리
13. 배포
14. 최종 체크리스트

---

## 1. 핵심 개념: "원어민 억양"은 어떻게 만들어지나

"그 나라 사람의 억양"이 나오려면 아래 세 가지가 맞아떨어져야 합니다.

| 요소 | 설명 | 실패하면 생기는 일 |
|---|---|---|
| **언어 식별** | 입력 문장이 어떤 언어인지 정확히 판단 | 일본어 한자를 중국어로 읽는 등 오독 |
| **언어에 맞는 보이스** | 해당 언어 원어민 데이터로 학습된 화자(voice) 선택 | 영어 화자가 한국어를 읽는 "외국인 억양" |
| **텍스트 정규화** | 숫자·날짜·약어·기호를 그 언어 방식으로 풀어 읽기 | "2026" → 한국어 "이천이십육" vs 영어 "twenty twenty-six" |

**중요한 설계 원칙**

- 다국어 모델 하나에 같은 화자로 여러 언어를 읽히면, 화자의 원래 언어 억양이 섞이는 경우가 많습니다. **"원어민 억양"이 핵심 가치라면 언어마다 그 언어 원어민 보이스를 따로 매핑**하는 구조가 안전합니다.
- 지역 억양(미국/영국/호주 영어, 스페인/멕시코 스페인어, 브라질/포르투갈 포르투갈어 등)까지 구분하려면 언어 코드를 `en`이 아니라 `en-US`, `en-GB` 같은 **로케일 단위**로 다뤄야 합니다.

---

## 2. 구현 방식 선택

| 방식 | 장점 | 단점 | 추천 상황 |
|---|---|---|---|
| **A. 상용 API 래핑** (ElevenLabs, Azure, Google, OpenAI 등) | 개발 빠름, 품질 높음, 언어·보이스 많음, GPU 불필요 | 사용량 비례 비용, 업체 약관 종속, 재판매 조건 확인 필요 | MVP, 1인 개발, 빠른 검증 |
| **B. 오픈소스 모델 셀프호스팅** (Kokoro, CosyVoice2 등) | 요청당 비용 없음, 데이터 외부 유출 없음, 커스터마이징 자유 | GPU 서버 필요, 운영 부담, 언어별 품질 편차 | 사용량이 많아진 뒤, 특정 언어 집중 |
| **C. 하이브리드** | 언어별로 가장 좋은 엔진 선택, 비용·품질 균형 | 구조가 복잡해짐 | 서비스가 안정된 이후 |

**권장 경로:** A로 MVP를 만들되, 처음부터 **엔진을 갈아끼울 수 있는 Provider 인터페이스 구조**로 설계 → 사용량·비용 데이터가 쌓이면 일부 언어를 B로 이전(C).

---

## 3. TTS 엔진 후보 (2026년 조사 기준, 확인 필요)

### 3-1. 상용 API

| 서비스 | 특징 (조사 시점 기준) |
|---|---|
| **ElevenLabs** | 자연스러움 면에서 업계 기준점으로 자주 언급됨. 보이스 복제, 스트리밍 지원. 구독형 과금 |
| **Microsoft Azure AI Speech** | 언어·로케일 커버리지가 넓고 SSML 지원이 강함. 기업용 커스텀 보이스 |
| **Google Cloud Text-to-Speech** | 언어 폭이 넓고 대량 처리 비용 효율이 좋다는 평가. 월 무료 할당량 존재(규모는 확인 필요) |
| **OpenAI TTS** | API 연동이 가장 단순. 대신 기본 보이스 수가 적고 로케일별 원어민 보이스 개념이 약함 |
| **Amazon Polly, Cartesia, Deepgram Aura, Fish Audio** | 각각 저비용·저지연·실시간 등 특화 포인트가 있음 |

> 💡 **"원어민 억양" 목적에는** 로케일별 전용 원어민 보이스가 풍부한 Azure / Google이 구조적으로 잘 맞고, 최고 자연스러움이 필요하면 ElevenLabs가 후보입니다. 이 판단은 일반적인 평가를 정리한 것이므로, **직접 같은 문장으로 비교 청취해서 결정하세요.**

### 3-2. 오픈소스 모델

| 모델 | 특징 | 라이선스 주의 |
|---|---|---|
| **Kokoro** | 약 8,200만 파라미터의 경량 모델, 품질 대비 가벼움 | Apache 2.0 |
| **CosyVoice2** (Alibaba) | 다국어 합성에 강점 | Apache 2.0 |
| **Chatterbox** | 보이스 복제 특화, 일부 다국어 변형(한국어 포함) 공개 | MIT |
| **Fish Speech / Fish Audio** | 다국어 품질 평가가 좋음 | ⚠️ 오픈 웨이트라도 **상업 이용 시 유료 라이선스 필요**하다고 안내됨 |
| **IndexTTS-2, Orpheus, Dia 등** | 감정 표현·대화형 등 특화 | 모델마다 개별 확인 |

> ⚠️ **한국어 품질은 모델마다 편차가 큽니다.** 오픈소스 모델은 영어·중국어 중심으로 학습된 경우가 많으니, 지원하려는 언어 각각에 대해 직접 테스트가 필수입니다.
> ⚠️ "오픈소스"라도 상업적 이용 가능 여부는 라이선스마다 다릅니다. 모델 카드의 라이선스를 반드시 읽으세요.

---

## 4. 전체 아키텍처

본인 주력 스택(Node.js, React/React Native, RDBMS)을 그대로 활용하는 구성입니다.

```
┌─────────────────────┐
│  Frontend (React)    │  텍스트 입력 / 언어·보이스 선택 / 재생 / 다운로드
│  (추후 React Native) │
└──────────┬──────────┘
           │ REST (+ 스트리밍)
┌──────────▼──────────┐
│  API 서버 (Node.js)  │  인증, 요청 검증, 사용량 제한, 캐시 조회
│  Express / Fastify   │
└──────────┬──────────┘
           │
┌──────────▼──────────────────────────────┐
│  TTS 처리 파이프라인                       │
│  ① 언어 감지 → ② 텍스트 정규화             │
│  ③ 문장 분할 → ④ 보이스 매핑               │
│  ⑤ Provider 호출 → ⑥ 오디오 병합·변환(ffmpeg)│
└───┬───────────────┬──────────────┬───────┘
    │               │              │
┌───▼────┐   ┌──────▼─────┐  ┌─────▼──────────────┐
│상용 API │   │오픈소스 모델 │  │ 작업 큐 (BullMQ+Redis)│
│Provider│   │Python 서버  │  │ 긴 텍스트 비동기 처리  │
└────────┘   │(FastAPI+GPU)│  └────────────────────┘
             └────────────┘
    │
┌───▼──────────────────────────┐
│ 저장소                        │
│ DB(MySQL/PostgreSQL): 사용자·이력│
│ 오브젝트 스토리지(S3 호환): 음성파일│
│ Redis: 캐시·큐                  │
└──────────────────────────────┘
```

- 오픈소스 모델은 대부분 Python 생태계이므로, **모델 서빙만 Python(FastAPI) 마이크로서비스로 분리**하고 Node.js 서버가 HTTP로 호출하는 구조를 권장합니다.

---

## 5. 기능 명세

### 5-1. MVP (1차 목표)

- [ ] 텍스트 입력 (글자 수 제한 포함)
- [ ] 언어 자동 감지 + 수동 선택 드롭다운
- [ ] 언어(로케일)별 원어민 보이스 목록 및 선택
- [ ] 미리 듣기 (브라우저 재생)
- [ ] MP3 / WAV 다운로드
- [ ] 속도 조절 (예: 0.5x ~ 2.0x)
- [ ] 생성 이력 목록

### 5-2. 2차 확장

- [ ] 스트리밍 재생 (생성 완료 전 재생 시작)
- [ ] 한 문장 안에 여러 언어가 섞인 경우 구간별 언어 처리
- [ ] 피치·감정·강조 조절 (SSML 기반)
- [ ] 발음 사전 (고유명사·브랜드명 읽는 법 지정)
- [ ] 긴 문서(TXT/PDF) 업로드 → 오디오북 생성
- [ ] 회원가입, 요금제, 사용량 대시보드
- [ ] 공개 API 제공 (API 키 발급)

### 5-3. 3차 (선택)

- [ ] 보이스 복제 (본인 동의 절차 필수, 11장 참고)
- [ ] 번역 + 낭독 ("한국어 입력 → 일본어 원어민 음성")
- [ ] 자막(SRT) 동시 생성, 단어별 타임스탬프
- [ ] 모바일 앱 (React Native)

---

## 6. 핵심 처리 파이프라인 상세

### ① 언어 감지

- 짧은 문장일수록 오감지가 많습니다. **감지 결과는 "추천값"으로만 쓰고, 사용자가 바꿀 수 있게** 하세요.
- 라이브러리 후보: `franc`(Node), `cld3` 바인딩, `fastText lid` 모델(Python), `lingua`(Python/Rust 계열, 짧은 텍스트 정확도가 좋다고 알려짐)
- 문자 체계로 1차 판별하면 정확도가 올라갑니다: 한글 → ko, 가나 포함 → ja, 한자만 → zh 후보 (단, 일본어 문장이 한자만으로 끝날 수도 있으니 주의)

### ② 텍스트 정규화

언어별 규칙 모듈을 따로 둡니다.

| 대상 | 한국어 예 | 영어 예 |
|---|---|---|
| 숫자 | 3개 → 세 개 / 3층 → 삼 층 | 3 → three |
| 날짜 | 2026-10-11 → 이천이십육 년 시월 십일 일 | → October eleventh, twenty twenty-six |
| 단위·기호 | 5km → 오 킬로미터, % → 퍼센트 | 5km → five kilometers |
| 약어 | AI → 에이아이 | Dr. → Doctor |

- 상용 API는 자체 정규화가 어느 정도 되어 있지만 완벽하지 않습니다. 특히 **한국어 고유어/한자어 수사 구분**(세 개 vs 삼 층)은 자주 틀리므로 직접 테스트 케이스를 만들어 확인하세요.
- 정규화 결과를 사용자에게 보여 주고 수정할 수 있게 하면 품질 민원이 크게 줄어듭니다.

### ③ 문장 분할 (청킹)

- 대부분의 API는 요청당 글자 수 한도가 있습니다(서비스마다 다름, 공식 문서 확인).
- **문장 경계 기준으로 분할** → 각 청크 생성 → ffmpeg로 이어 붙이기. 단어 중간에서 자르면 억양이 끊깁니다.
- 청크 사이에 짧은 무음(예: 150~300ms)을 넣으면 자연스럽습니다.

### ④ 보이스 매핑

```json
{
  "ko-KR": { "provider": "azure",  "voiceId": "...", "gender": "female" },
  "ja-JP": { "provider": "google", "voiceId": "...", "gender": "male" },
  "en-US": { "provider": "elevenlabs", "voiceId": "..." }
}
```

- 이 설정을 코드가 아니라 **DB 또는 설정 파일**에 두어, 재배포 없이 엔진·보이스를 교체할 수 있게 합니다.

### ⑤ Provider 호출

- 모든 엔진을 같은 인터페이스(`synthesize(text, locale, voiceId, options) → audio buffer`)로 감쌉니다.
- 재시도(지수 백오프), 타임아웃, 실패 시 대체 엔진(fallback)을 둡니다.

### ⑥ 오디오 후처리

- `ffmpeg`로 포맷 변환(MP3/WAV/OGG), 샘플레이트 통일, 청크 병합, 음량 정규화(loudnorm).
- Node에서는 `fluent-ffmpeg` 또는 `child_process`로 ffmpeg 바이너리 실행.

### ⑦ 캐싱

- 키: `hash(정규화된 텍스트 + locale + voiceId + 속도 + 기타 옵션)`
- 같은 요청은 저장된 파일을 바로 반환 → **비용 절감 효과가 큼**.

---

## 7. 코드 골격 예시 (Node.js)

> 아래는 구조를 보여 주기 위한 골격입니다. **각 API의 엔드포인트·파라미터 이름은 버전에 따라 바뀔 수 있으니 공식 문서를 기준으로 작성**하세요.

### 7-1. 폴더 구조

```
tts-app/
├─ apps/
│  ├─ web/                 # React 프론트엔드
│  └─ api/                 # Node.js API 서버
│     ├─ src/
│     │  ├─ routes/tts.js
│     │  ├─ pipeline/
│     │  │  ├─ detectLanguage.js
│     │  │  ├─ normalize/   # ko.js, en.js, ja.js ...
│     │  │  ├─ chunk.js
│     │  │  └─ mergeAudio.js
│     │  ├─ providers/
│     │  │  ├─ BaseProvider.js
│     │  │  ├─ AzureProvider.js
│     │  │  ├─ GoogleProvider.js
│     │  │  ├─ ElevenLabsProvider.js
│     │  │  └─ LocalModelProvider.js  # Python 모델 서버 호출
│     │  ├─ services/cache.js
│     │  └─ config/voices.json
│     └─ .env
└─ services/
   └─ model-server/        # Python FastAPI + 오픈소스 TTS (2단계 이후)
```

### 7-2. Provider 인터페이스

```js
// providers/BaseProvider.js
export class BaseProvider {
  /**
   * @param {string} text      정규화된 텍스트 (한 청크)
   * @param {string} locale    예: 'ko-KR'
   * @param {string} voiceId
   * @param {{speed?: number, format?: 'mp3'|'wav'}} options
   * @returns {Promise<Buffer>} 오디오 데이터
   */
  async synthesize(text, locale, voiceId, options = {}) {
    throw new Error('not implemented');
  }

  /** 이 엔진이 지원하는 보이스 목록 */
  async listVoices(locale) {
    throw new Error('not implemented');
  }
}
```

### 7-3. 파이프라인 오케스트레이션

```js
// routes/tts.js (요지)
router.post('/tts', async (req, res) => {
  const { text, locale: userLocale, voiceId: userVoice, speed = 1.0, format = 'mp3' } = req.body;

  validateInput(text);                               // 길이·금칙어 검사

  const locale = userLocale ?? detectLanguage(text); // ① 감지 (사용자 선택 우선)
  const normalized = normalize(text, locale);        // ② 정규화
  const voice = resolveVoice(locale, userVoice);     // ④ 매핑 → {provider, voiceId}

  const cacheKey = hash({ normalized, locale, voice, speed, format });
  const cached = await cache.get(cacheKey);
  if (cached) return sendAudio(res, cached, format);

  const chunks = splitIntoSentences(normalized, locale, voice.maxChars); // ③
  const provider = getProvider(voice.provider);

  const buffers = [];
  for (const chunk of chunks) {
    buffers.push(await withRetry(() =>
      provider.synthesize(chunk, locale, voice.voiceId, { speed, format })
    ));
  }

  const audio = await mergeAudio(buffers, { format, gapMs: 200 });      // ⑥
  await cache.set(cacheKey, audio);
  await saveHistory(req.user, { text, locale, voice, cacheKey });

  sendAudio(res, audio, format);
});
```

### 7-4. 환경 변수 (.env)

```
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=
GOOGLE_APPLICATION_CREDENTIALS=
ELEVENLABS_API_KEY=
MODEL_SERVER_URL=http://localhost:8000
REDIS_URL=redis://localhost:6379
DATABASE_URL=
S3_BUCKET=
```

- **API 키는 절대 프론트엔드에 넣지 마세요.** 반드시 서버를 거쳐 호출합니다.

---

## 8. 데이터베이스 설계

```sql
-- 사용자
CREATE TABLE users (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  email         VARCHAR(255) UNIQUE NOT NULL,
  plan          VARCHAR(20) DEFAULT 'free',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 보이스 카탈로그 (재배포 없이 교체 가능하도록 DB에 보관)
CREATE TABLE voices (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  locale        VARCHAR(10) NOT NULL,     -- 'ko-KR'
  provider      VARCHAR(30) NOT NULL,     -- 'azure'
  provider_voice_id VARCHAR(100) NOT NULL,
  display_name  VARCHAR(100),
  gender        VARCHAR(10),
  is_default    BOOLEAN DEFAULT FALSE,
  is_active     BOOLEAN DEFAULT TRUE
);

-- 생성 이력
CREATE TABLE generations (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id       BIGINT,
  input_text    TEXT NOT NULL,
  locale        VARCHAR(10),
  voice_id      BIGINT,
  char_count    INT,
  cache_key     CHAR(64),
  file_url      VARCHAR(500),
  status        VARCHAR(20),              -- queued / done / failed
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (user_id, created_at),
  INDEX (cache_key)
);

-- 사용량 집계 (요금제·한도 관리)
CREATE TABLE usage_daily (
  user_id       BIGINT,
  usage_date    DATE,
  chars_used    INT DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

-- 발음 사전 (2차)
CREATE TABLE lexicon (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id       BIGINT NULL,              -- NULL이면 전체 공용
  locale        VARCHAR(10),
  term          VARCHAR(100),
  pronunciation VARCHAR(200)
);
```

---

## 9. 단계별 개발 로드맵

> 기간은 1인 개발 기준의 대략적인 가늠치(추정)이며, 실제로는 경험과 투입 시간에 따라 크게 달라집니다.

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **0. 엔진 비교 실험** | 지원할 언어 3~5개를 정하고, 후보 엔진 2~3개로 **같은 테스트 문장**을 생성해 비교 청취 | 언어별 사용 엔진·보이스 확정 |
| **1. 최소 동작** | Node 서버 + 단일 Provider + 간단한 HTML 폼, MP3 다운로드 | 문장 입력 → 원어민 음성 파일 다운로드 |
| **2. MVP** | React UI, 언어 자동 감지, 보이스 선택, 청킹·병합, 캐싱, 이력 | 5장 MVP 체크리스트 완료 |
| **3. 품질 개선** | 언어별 정규화 규칙, 발음 사전, 원어민 청취 피드백 반영 | 10장 품질 기준 통과 |
| **4. 서비스화** | 회원·인증, 사용량 제한, 요금제·결제, 큐 기반 비동기 처리 | 외부 사용자 베타 오픈 |
| **5. 확장** | 스트리밍, 공개 API, 오픈소스 모델 셀프호스팅으로 비용 절감, 모바일 앱 | 사용량 증가 대응 |

---

## 10. 품질 평가 방법

1. **테스트 문장 세트 만들기** (언어별 30~50문장)
   - 숫자·날짜·화폐, 고유명사, 의문문/감탄문, 긴 문장, 외래어 섞인 문장 포함
2. **원어민 청취 평가**
   - 가능하면 해당 언어 원어민에게 1~5점 척도로 자연스러움(MOS 방식) 평가를 받기
   - "억양이 그 나라 사람 같은가"를 별도 항목으로 평가
3. **자동 역검증 (ASR 받아쓰기)**
   - 생성된 음성을 Whisper 같은 음성인식 모델로 다시 받아써서 원문과 비교(WER/CER 측정)
   - 오류율이 높게 나온 문장 = 발음이 뭉개졌거나 오독한 문장 → 우선 점검 대상
   - 단, 받아쓰기가 정확해도 억양이 어색할 수는 있으므로 청취 평가를 대체하지는 못합니다
4. **회귀 테스트**
   - 엔진·보이스·정규화 규칙을 바꿀 때마다 같은 세트로 다시 평가

---

## 11. 법적·윤리적 주의사항

- **상용 API 이용약관 확인:** 생성된 음성을 상업적으로 쓰거나 **내 서비스에서 재판매(API 리셀링)** 하는 것이 허용되는지 업체마다 다릅니다. 착수 전에 반드시 확인하세요.
- **오픈소스 라이선스:** Apache 2.0 / MIT는 비교적 자유롭지만, 일부 모델은 비상업 전용이거나 상업 이용 시 별도 유료 라이선스가 필요합니다. 학습 데이터 출처 문제도 모델 카드에서 확인하세요.
- **보이스 복제:** 타인 목소리 무단 복제는 퍼블리시티권·초상권 침해, 사기·딥페이크 악용 위험이 큽니다. 기능을 넣는다면
  - 본인 녹음으로 **동의 문장을 직접 읽게 하는 인증 절차**
  - 유명인·정치인 음성 차단
  - 생성 기록 보관 및 신고 처리 절차
- **생성물 표시:** AI 생성 음성임을 알리는 고지·워터마크 도입을 검토하세요. 국내외 AI 관련 법규(예: 한국 AI 기본법, EU AI Act의 투명성 의무)는 시행 시점과 세부 내용이 계속 바뀌고 있으니 **서비스 출시 전 최신 조항을 확인**해야 합니다.
- **개인정보:** 사용자가 입력한 텍스트·업로드 파일 보관 기간과 삭제 정책을 개인정보처리방침에 명시하세요.

---

## 12. 비용 관리

- 상용 API는 대부분 **글자 수(또는 토큰/시간) 단위 과금**입니다. 정확한 단가는 각 공식 가격 페이지에서 확인하세요(이 문서에는 수치를 적지 않았습니다).
- 비용 절감 장치
  - **캐싱** (같은 문장·옵션 재요청은 무료로 처리)
  - 무료 사용자 일일 글자 수 한도
  - 미리 듣기는 앞부분만 생성하고, 전체 생성은 확정 시에만
  - 언어별로 가성비 좋은 엔진 배정 (하이브리드)
  - 사용량이 일정 수준을 넘으면 오픈소스 셀프호스팅 비용과 비교 (GPU 서버 비용 vs API 비용 손익분기점 계산)
- 내 서비스 요금제는 **"원가(엔진 비용) + 인프라 + 마진"** 기준으로 설계하고, 엔진 가격 변경에 대비해 여유를 두세요.

---

## 13. 배포

| 구성요소 | 후보 |
|---|---|
| 프론트엔드 | Vercel, Netlify, Cloudflare Pages |
| Node API 서버 | Railway, Render, Fly.io, AWS/GCP VM |
| 오픈소스 모델 서버 (GPU) | RunPod, Modal, Replicate, AWS/GCP GPU 인스턴스 |
| DB | 관리형 MySQL/PostgreSQL (PlanetScale, Supabase, RDS 등) |
| 파일 저장 | S3, Cloudflare R2 (R2는 송신 요금 측면에서 유리하다고 알려져 있음, 확인 필요) |
| 캐시·큐 | Redis (Upstash 등 관리형) |

- 음성 파일은 서버가 직접 내려주기보다 **오브젝트 스토리지 + 서명된 URL(유효시간 제한)** 로 제공하면 서버 부하가 줄어듭니다.
- 로그·모니터링: 엔진별 응답 시간, 실패율, 일별 글자 사용량 대시보드를 초기부터 만들어 두세요.

---

## 14. 최종 체크리스트

**착수 전**
- [ ] 지원 언어(로케일) 목록 확정
- [ ] 후보 엔진 약관에서 상업 이용·재판매 허용 여부 확인
- [ ] 엔진별 최신 가격·요청 한도 확인
- [ ] 언어별 비교 청취로 엔진·보이스 확정

**개발 중**
- [ ] Provider 인터페이스로 엔진 교체 가능 구조
- [ ] API 키 서버 측 보관
- [ ] 언어 감지 + 수동 변경 가능
- [ ] 언어별 정규화 테스트 케이스
- [ ] 문장 단위 청킹 + 무음 삽입 병합
- [ ] 캐싱
- [ ] 재시도·타임아웃·fallback

**출시 전**
- [ ] 원어민 청취 평가 + ASR 역검증 통과
- [ ] 사용량 제한·요금제
- [ ] 이용약관·개인정보처리방침
- [ ] AI 생성물 고지 정책
- [ ] (보이스 복제 시) 동의 인증 절차
- [ ] 모니터링 대시보드

---

### 참고 자료 (조사 출처)

- [The Complete Guide to Open Source Text-to-Speech in 2026 — TTS.ai](https://tts.ai/blog/open-source-text-to-speech-guide-2026/)
- [Best Open-Source AI Voice Generators in 2026 — Dograh](https://www.dograh.com/feeds/blog/open-source-ai-voice-generator)
- [Best Open Source Models for Multilingual Speech in 2026 — SiliconFlow](https://www.siliconflow.com/articles/best-open-source-models-for-multilingual-speech-recognition)
- [Best Text-to-Speech APIs in 2026: 8 Providers Compared — Novita AI](https://blogs.novita.ai/best-text-to-speech-api-2026/)
- [Best Text-to-Speech APIs in 2026 — BenchLM](https://benchlm.ai/blog/posts/best-text-to-speech-apis)
- [Top Google Cloud TTS alternatives in 2026 — ElevenLabs Blog](https://elevenlabs.io/blog/google-tts-alternatives-2026) *(ElevenLabs 자사 블로그이므로 비교 내용은 감안해서 읽기)*
