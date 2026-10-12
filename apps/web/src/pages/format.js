const fmt = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' });

/** ms 타임스탬프 또는 SQLite UTC 문자열('2026-10-11 01:23:45') */
export function fmtDate(v) {
  if (v == null) return '-';
  const d = typeof v === 'number' ? new Date(v) : new Date(`${v.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? '-' : fmt.format(d);
}

export const STATUS_LABEL = { pending: '승인 대기', approved: '승인', rejected: '거절', suspended: '정지' };
