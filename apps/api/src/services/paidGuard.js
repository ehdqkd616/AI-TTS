// 상용 TTS 엔진(글자 수 과금) 자동 결제 방지 장치.
//
// 여러 겹으로 막는다:
//   1) 긴급 차단 스위치 — 관리자 페이지에서 켜면 상용 엔진을 즉시 전부 끈다 (DB 저장, 재시작해도 유지)
//   2) 일일 한도      — 엔진별 하루 사용량 상한
//   3) 월간 한도      — 엔진별 이번 달 누적 상한 (무료 사용량보다 낮게)
//   4) 호출 단위 계측  — 청크를 보낼 때마다(재시도 포함) 보내기 "전에" 먼저 차감한다.
//                     실패·타임아웃 요청도 업체가 과금했을 수 있으므로 넉넉하게(보수적으로) 센다.
//   5) 경고 메일      — 월 50%·80%·100%, 일 100%에 닿으면 관리자에게 한 번씩 알린다.
// 한도에 걸린 엔진은 건너뛰고 같은 언어의 무료 모델로 넘어간다(무료 모델이 없으면 429).
// 업체 콘솔의 예산 알림은 하루 이상 늦을 수 있어 보조 장치일 뿐, 실제 차단은 여기서 한다.

export const PAID_PROVIDERS = new Set(['google', 'azure', 'elevenlabs', 'openai']);
const DISABLED_KEY = 'paid_engines_disabled';

export class EngineLimitError extends Error {
  constructor(provider, reason) {
    super(`[${provider}] engine limit: ${reason}`);
    this.provider = provider;
    this.reason = reason;
    this.engineLimit = true;
    this.retryable = false;
  }
}

export class PaidEngineGuard {
  /**
   * @param {import('./store.js').Store} store
   * @param {{daily: number, monthly: number, mailer?: object, logger?: object}} opts
   */
  constructor(store, { daily, monthly, mailer, logger = console }) {
    Object.assign(this, { store, daily, monthly, mailer, logger });
  }

  isPaid(provider) {
    return PAID_PROVIDERS.has(provider);
  }

  isDisabled() {
    return this.store.getSetting(DISABLED_KEY) === '1';
  }

  setDisabled(disabled) {
    this.store.setSetting(DISABLED_KEY, disabled ? '1' : '0');
  }

  usage(provider) {
    const subject = `engine:${provider}`;
    return { today: this.store.getUsage(subject), month: this.store.getMonthlyUsage(subject) };
  }

  /** 이 엔진으로 chars만큼 더 보내면 안 되는 이유 (괜찮으면 null) */
  blockReason(provider, chars) {
    if (!this.isPaid(provider)) return null;
    if (this.isDisabled()) return 'disabled';
    const { today, month } = this.usage(provider);
    if (today + chars > this.daily) return 'daily';
    if (month + chars > this.monthly) return 'monthly';
    return null;
  }

  allows(provider, chars) {
    return this.blockReason(provider, chars) == null;
  }

  /** 상용 엔진에 요청을 보내기 직전에 호출 — 한도를 넘으면 던지고, 아니면 먼저 차감한다 */
  meter(provider, chars) {
    if (!this.isPaid(provider)) return;
    const reason = this.blockReason(provider, chars);
    if (reason) throw new EngineLimitError(provider, reason);
    this.store.addUsage(`engine:${provider}`, chars);
    this.#maybeAlert(provider);
  }

  #maybeAlert(provider) {
    const { today, month } = this.usage(provider);
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dayKey = `${monthKey}-${String(now.getDate()).padStart(2, '0')}`;
    const checks = [
      ...[0.5, 0.8, 1].map((r) => ({ scope: '이번 달', used: month, limit: this.monthly, ratio: r, key: `alert:${provider}:month:${monthKey}:${r}` })),
      { scope: '오늘', used: today, limit: this.daily, ratio: 1, key: `alert:${provider}:day:${dayKey}:1` },
    ];
    for (const c of checks) {
      // 한도 직전 요청이 한도를 정확히 못 채워도 알림이 가도록 마지막 3%는 도달로 본다
      const threshold = c.ratio === 1 ? c.limit * 0.97 : c.limit * c.ratio;
      if (c.used < threshold || this.store.getSetting(c.key)) continue;
      this.store.setSetting(c.key, String(Date.now()));
      const pct = Math.round((c.used / c.limit) * 100);
      const subject = `${provider} ${c.scope} 사용량 ${pct}% (${c.used.toLocaleString()} / ${c.limit.toLocaleString()}자)`;
      const lines = [
        `상용 TTS 엔진(${provider})의 ${c.scope} 사용량이 한도의 ${pct}%에 도달했습니다.`,
        `오늘: ${today.toLocaleString()} / ${this.daily.toLocaleString()}자`,
        `이번 달: ${month.toLocaleString()} / ${this.monthly.toLocaleString()}자`,
        '',
        c.ratio === 1
          ? '한도에 도달해 이 엔진은 자동으로 멈췄고, 무료 모델로 전환됩니다. 결제는 발생하지 않습니다.'
          : '한도에 도달하면 자동으로 멈추고 무료 모델로 전환됩니다.',
        '즉시 멈추려면 관리자 페이지 대시보드의 "상용 엔진 긴급 차단"을 누르세요.',
      ];
      this.logger.warn?.(`[paid-guard] ${subject}`);
      void this.mailer?.sendAdminAlert(subject, lines).catch(() => {});
    }
  }

  status() {
    return {
      disabled: this.isDisabled(),
      dailyLimit: this.daily,
      monthlyLimit: this.monthly,
      engines: Object.fromEntries([...PAID_PROVIDERS].map((p) => [p, this.usage(p)])),
    };
  }
}
