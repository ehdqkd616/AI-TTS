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
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
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
  if (!req.is('application/json')) {
    return res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'JSON 요청만 허용됩니다.' } });
  }
  next();
}
