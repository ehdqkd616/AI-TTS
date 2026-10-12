export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message ?? `요청 실패 (${status})`);
    this.status = status;
    this.code = error?.code;
    this.reason = error?.reason;
  }
}

async function call(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 세션이 만료되면 앱 전체에 알림 → 로그인 화면으로
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('auth:expired'));
    throw new ApiError(res.status, data.error);
  }
  return data;
}

const get = (p) => call('GET', p);
const post = (p, body = {}) => call('POST', p, body);
const patch = (p, body = {}) => call('PATCH', p, body);
const qs = (o) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
  return s ? `?${s}` : '';
};

export const api = {
  // 인증
  me: () => get('/auth/me'),
  login: (username, password) => post('/auth/login', { username, password }),
  signup: (body) => post('/auth/signup', body),
  logout: () => post('/auth/logout'),
  changePassword: (currentPassword, newPassword) => patch('/auth/password', { currentPassword, newPassword }),

  // TTS
  config: () => get('/config'),
  voices: () => get('/voices'),
  history: () => get('/history?limit=30'),
  detect: (text) => post('/detect', { text }),
  normalize: (text, locale) => post('/normalize', { text, locale }),
  tts: (body) => post('/tts', body),

  // 관리자
  admin: {
    stats: () => get('/admin/stats'),
    users: (filter) => get(`/admin/users${qs(filter)}`),
    user: (id) => get(`/admin/users/${id}`),
    approve: (id) => post(`/admin/users/${id}/approve`),
    reject: (id, reason) => post(`/admin/users/${id}/reject`, { reason }),
    suspend: (id) => post(`/admin/users/${id}/suspend`),
    unsuspend: (id) => post(`/admin/users/${id}/unsuspend`),
    bulkApprove: (userIds) => post('/admin/users/bulk-approve', { userIds }),
    setQuota: (id, dailyCharLimit) => patch(`/admin/users/${id}/quota`, { dailyCharLimit }),
    tempPassword: (id) => post(`/admin/users/${id}/temp-password`),
    generations: (filter) => get(`/admin/generations${qs(filter)}`),
    audit: (filter) => get(`/admin/audit${qs(filter)}`),
  },
};
