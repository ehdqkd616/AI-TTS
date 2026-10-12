import { createApp } from './app.js';

const { app, providers } = await createApp();
const port = Number(process.env.PORT) || 3001;
// 기본은 루프백 전용: 외부 접근은 Caddy(HTTPS)를 통해서만
const host = process.env.HOST || '127.0.0.1';

app.listen(port, host, () => {
  const enabled = [...providers.values()].filter((p) => p.isEnabled()).map((p) => p.name);
  console.log(`TTS API listening on http://${host}:${port}`);
  console.log(`Enabled providers: ${enabled.join(', ') || '(none)'}`);
  if (enabled.length === 1 && enabled[0] === 'mock') {
    console.log('⚠  API 키가 설정되지 않아 개발용 테스트 톤만 사용합니다. apps/api/.env를 설정하세요.');
  }
});
