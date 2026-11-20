// 로그인하지 않은 방문자에게 보여 주는 서비스 소개 홈 화면.
// 내용은 아래 LANDING 객체만 고치면 된다. 스타일은 landing.css(.lp- 접두사)에만 있다.
import './landing.css';

export const LANDING = {
  "icon": "🗣️",
  "name": "AI TTS",
  "tagline": "문장을 원어민 억양으로 읽어 주는 음성 합성 서비스",
  "intro": "글을 입력하면 그 언어의 자연스러운 목소리로 읽어 주고, 결과를 MP3나 WAV 파일로 내려받을 수 있어요.",
  "access": "회원가입 후 관리자 승인을 받으면 사용할 수 있어요.",
  "features": [
    {
      "icon": "🌏",
      "title": "여러 언어 지원",
      "desc": "한국어, 영어, 일본어, 중국어, 스페인어, 프랑스어 등 원어민 억양으로 읽어 줘요."
    },
    {
      "icon": "🎚️",
      "title": "보이스·속도 선택",
      "desc": "언어마다 여러 보이스 중에서 고르고 읽는 속도를 조절할 수 있어요."
    },
    {
      "icon": "🎙️",
      "title": "목소리 변환",
      "desc": "학습된 목소리 모델로 TTS 결과를 특정 사람의 목소리처럼 바꿔 받아요."
    },
    {
      "icon": "💾",
      "title": "MP3 / WAV 다운로드",
      "desc": "긴 글도 나눠서 읽은 뒤 하나의 파일로 합쳐서 내려받아요."
    }
  ],
  "steps": [
    "회원가입하고 관리자 승인을 기다려요.",
    "읽을 문장을 입력하고 언어와 보이스를 골라요.",
    "생성된 음성을 들어 보고 MP3나 WAV로 내려받아요."
  ]
};

export default function Landing({ LinkComponent, loginHref = '/login', signupHref = '/signup' }) {
  const L = LinkComponent ?? ((p) => <a href={p.to} className={p.className}>{p.children}</a>);
  const d = LANDING;
  return (
    <div className="lp">
      <section className="lp-hero">
        <div className="lp-icon" aria-hidden="true">{d.icon}</div>
        <h1 className="lp-title">{d.name}</h1>
        <p className="lp-tagline">{d.tagline}</p>
        {d.intro && <p className="lp-intro">{d.intro}</p>}
        <div className="lp-cta">
          <L to={loginHref} className="lp-btn lp-btn-primary">로그인</L>
          {signupHref && <L to={signupHref} className="lp-btn">{d.signupLabel ?? '회원가입'}</L>}
        </div>
        {d.access && <p className="lp-access">{d.access}</p>}
      </section>

      <section className="lp-section">
        <h2 className="lp-h2">이런 걸 할 수 있어요</h2>
        <ul className="lp-features">
          {d.features.map((f) => (
            <li key={f.title} className="lp-feature">
              <span className="lp-feature-icon" aria-hidden="true">{f.icon}</span>
              <div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {d.steps?.length > 0 && (
        <section className="lp-section">
          <h2 className="lp-h2">사용 방법</h2>
          <ol className="lp-steps">
            {d.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </section>
      )}

      <footer className="lp-footer">
        <a href="https://multi-tools.hotgarlic.dedyn.io">다른 프로젝트 둘러보기 →</a>
      </footer>
    </div>
  );
}
