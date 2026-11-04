const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** HSTS·Server 헤더 제거는 Caddy가, 앱 고유 정책(CSP 등)은 여기서 */
export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // 마이크: 관리자 목소리 학습 화면에서 낭독 녹음 (같은 출처만)
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}

/**
 * CSRF 방어: 상태를 바꾸는 API는 JSON 본문만 받고(폼으로는 교차 출처 전송 불가),
 * Origin이 붙어 오면 같은 호스트여야 한다. 세션 쿠키도 SameSite=Strict.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // 서버 내부 서비스 요청(토큰 검증 완료): 브라우저가 보낼 수 없는 헤더라 CSRF 대상이 아니다
  if (req.service) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.host) {
      return res.status(403).json({ error: { code: 'BAD_ORIGIN', message: '허용되지 않은 요청 출처입니다.' } });
    }
  }
  // 예외: 관리자 목소리 모델·학습 녹음 업로드는 파일 본문(application/octet-stream). 이 형식은 교차 출처 폼으로
  // 보낼 수 없고, fetch로 보내려면 CORS 사전 요청이 필요해서(허용 안 함) JSON과 같은 수준으로 막힌다.
  if ((req.path.startsWith('/admin/voice-models') || req.path.startsWith('/admin/voice-trainings')) && req.is('application/octet-stream')) return next();
  if (!req.is('application/json')) {
    return res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'JSON 요청만 허용됩니다.' } });
  }
  next();
}
