// pm2 운영 설정: npm run build && pm2 start ecosystem.config.cjs && pm2 save
// 비밀값과 포트는 apps/api/.env (git 제외, 권한 600). 앱은 127.0.0.1:3300에만 바인딩되고 외부는 Caddy가 받는다.
// 무료 TTS 모델 서버는 127.0.0.1:8020 (외부 노출 없음, Node 서버만 호출). 설치: services/model-server/setup.sh
module.exports = {
  apps: [
    {
      name: 'ai-tts',
      cwd: `${__dirname}/apps/api`,
      script: 'src/server.js',
      interpreter: 'node',
      node_args: '--env-file=.env --disable-warning=ExperimentalWarning',
      max_memory_restart: '512M',
    },
    {
      name: 'ai-tts-models',
      cwd: `${__dirname}/services/model-server`,
      script: '.venv/bin/uvicorn',
      args: 'app:app --host 127.0.0.1 --port 8020 --no-access-log',
      interpreter: 'none',
      env: {
        // 모델은 setup.sh에서 미리 받아 둠 → 재부팅 시 네트워크 없이도 기동
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        TORCH_THREADS: '4',
        MELO_LANGS: 'KR',
        // 10분 동안 요청이 없으면 종료해 메모리(최대 약 3.5GB)를 돌려준다 → pm2가 빈 상태로 재시작
        IDLE_EXIT_MINUTES: '10',
      },
      max_memory_restart: '4500M',
      restart_delay: 2000,
    },
  ],
};
