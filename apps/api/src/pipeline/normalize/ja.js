// 日本語: 数字の読みはエンジンの精度が高いため、単位・記号のみ整える。
const UNITS = {
  km: 'キロメートル', kg: 'キログラム', cm: 'センチメートル', mm: 'ミリメートル',
  m: 'メートル', g: 'グラム', '%': 'パーセント', '℃': '度', '°C': '度',
};

export function normalizeJa(text) {
  const keys = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
  return text.replace(new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${keys})(?![A-Za-z])`, 'g'), (_, n, u) => `${n}${UNITS[u]}`);
}
