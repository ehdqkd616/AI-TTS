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

/** 파일 본문을 그대로 업로드 (관리자 목소리 모델). onProgress(0~1)로 진행률 표시 */
function uploadFile(method, path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `/api${path}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      if (xhr.status === 401) window.dispatchEvent(new Event('auth:expired'));
      reject(new ApiError(xhr.status, data.error ?? (xhr.status === 413 ? { message: '파일이 너무 큽니다.' } : undefined)));
    };
    xhr.onerror = () => reject(new ApiError(0, { message: '업로드 중 연결이 끊겼습니다.' }));
    xhr.send(file);
  });
}

const get = (p) => call('GET', p);
const post = (p, body = {}) => call('POST', p, body);
const patch = (p, body = {}) => call('PATCH', p, body);
const del = (p) => call('DELETE', p, {});
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
  voiceModels: () => get('/voice-models'),

  // 관리자
  admin: {
    paidEngines: () => get('/admin/paid-engines'),
    setPaidEnginesDisabled: (disabled) => post('/admin/paid-engines/disabled', { disabled }),
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
    voiceModels: () => get('/admin/voice-models'),
    uploadVoiceModel: (file, { name, defaultPitch }, onProgress) =>
      uploadFile('POST', `/admin/voice-models${qs({ name, defaultPitch })}`, file, onProgress),
    uploadVoiceIndex: (id, file, onProgress) => uploadFile('PUT', `/admin/voice-models/${id}/index`, file, onProgress),
    removeVoiceIndex: (id) => del(`/admin/voice-models/${id}/index`),
    updateVoiceModel: (id, body) => patch(`/admin/voice-models/${id}`, body),
    deleteVoiceModel: (id) => del(`/admin/voice-models/${id}`),
  },
};
