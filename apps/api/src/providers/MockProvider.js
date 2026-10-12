import { BaseProvider } from './BaseProvider.js';
import { runFfmpeg } from '../lib/ffmpeg.js';

/**
 * 개발용 테스트 톤. 실제 음성이 아니라, 글자 수에 비례한 길이의 비프음을 만든다.
 * API 키 없이 파이프라인(청킹·병합·캐시·다운로드)을 검증하는 용도.
 */
export class MockProvider extends BaseProvider {
  name = 'mock';
  maxChars = 300;

  constructor(env = process.env, { othersEnabled = false } = {}) {
    super();
    const mode = (env.TTS_MOCK ?? 'auto').toLowerCase();
    this.enabled = mode === 'true' || (mode === 'auto' && !othersEnabled);
  }

  isEnabled() {
    return this.enabled;
  }

  async synthesize(text) {
    const seconds = Math.min(30, Math.max(0.3, [...text].length * 0.06)).toFixed(2);
    return runFfmpeg([
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=24000:duration=${seconds}`,
      '-af', 'volume=0.3', '-f', 'wav', 'pipe:1',
    ]);
  }
}
