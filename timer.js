/* timer.js — 휴식 타이머 + 화면 유지 + 알림음 (CLAUDE §5, DATA_SPEC §10~§11)
 * 핵심: endsAt 기준 계산 / setInterval은 표시 갱신용 / 앱 복귀 시 재계산
 *       running 동안 무음 video로 화면 유지 / 0초에 자체 차임
 * Phase 1에서 구현.
 */

const RestTimer = {
  state: null, // { type:"set_rest"|"exercise_rest", durationSeconds, startedAt, endsAt, running }
  _tick: null,
  _audioUnlocked: false,

  els() {
    return {
      bar: document.getElementById("timer-bar"),
      barTime: document.getElementById("timer-bar-time"),
      audio: document.getElementById("rest-end-audio"),
      video: document.getElementById("keep-awake"),
    };
  },

  // 최초 사용자 제스처에서 호출 (알림 테스트 / 운동 시작). 오디오+video 언락 + 화면 유지 시작.
  async unlock() {
    const { audio, video } = this.els();
    try { audio.muted = true; await audio.play(); audio.pause(); audio.currentTime = 0; audio.muted = false; } catch (e) {}
    try { await video.play(); video.pause(); } catch (e) {}
    this._audioUnlocked = true;
    this.keepAwakeOn();   // 첫 탭부터 세션 내내 화면 유지 (C)
  },

  // 알림 테스트 버튼용
  async testSound() { await this.unlock(); this.playChime(); },
  playChime() { const { audio } = this.els(); audio.currentTime = 0; audio.play().catch(() => {}); },

  // 화면 유지 (C): Screen Wake Lock(주력, iOS 16.4+) + 무음 video(폴백) + 워치독(주기 재획득)
  // 타이머 도는 동안만이 아니라 운동 세션 내내 유지. 앱이 백그라운드/종료되면 자연 해제.
  _wake: { on: false, lock: null, watch: null, visBound: false },

  async keepAwakeOn() {
    this._wake.on = true;
    // 1) 표준 Screen Wake Lock
    try {
      if ("wakeLock" in navigator && !this._wake.lock) {
        this._wake.lock = await navigator.wakeLock.request("screen");
        if (this._wake.lock && this._wake.lock.addEventListener) this._wake.lock.addEventListener("release", () => { this._wake.lock = null; });
      }
    } catch (e) { this._wake.lock = null; }
    // 2) 폴백: 무음 루프 video 재생
    try { const { video } = this.els(); if (video && video.paused) await video.play(); } catch (e) {}
    // 3) 워치독: 8초마다 풀렸는지 확인해 다시 걸기
    if (!this._wake.watch) {
      this._wake.watch = setInterval(() => {
        if (!this._wake.on) return;
        const { video } = this.els();
        if (video && video.paused) video.play().catch(() => {});
        if ("wakeLock" in navigator && !this._wake.lock && document.visibilityState === "visible") {
          navigator.wakeLock.request("screen").then((l) => { this._wake.lock = l; if (l.addEventListener) l.addEventListener("release", () => { this._wake.lock = null; }); }).catch(() => {});
        }
      }, 8000);
    }
    // 4) 앱 복귀 시 재획득 + 타이머 표시 보정 (한 번만 등록)
    if (!this._wake.visBound) {
      this._wake.visBound = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") { if (this._wake.on) this.keepAwakeOn(); if (this.state && this.state.running) this._render(); }
      });
    }
  },
  keepAwakeOff() {
    this._wake.on = false;
    if (this._wake.watch) { clearInterval(this._wake.watch); this._wake.watch = null; }
    try { if (this._wake.lock) { this._wake.lock.release(); this._wake.lock = null; } } catch (e) {}
    try { const { video } = this.els(); if (video) video.pause(); } catch (e) {}
  },

  // 시작: type별 기본 시간은 설정값(90/180) 사용
  start(type, durationSeconds) {
    this.cancel();
    const now = Date.now();
    this.state = { type, durationSeconds, startedAt: now, endsAt: now + durationSeconds * 1000, running: true };
    this.keepAwakeOn();          // 세션 유지(이미 켜져 있으면 유지)
    this._render();
    this._tick = setInterval(() => this._render(), 250);
  },

  remaining() { return this.state ? Math.max(0, this.state.endsAt - Date.now()) : 0; },

  _render() {
    if (!this.state) return;
    const ms = this.remaining();
    const { bar, barTime } = this.els();
    bar.hidden = false; bar.classList.remove("ended");
    barTime.textContent = this._mmss(ms);
    if (typeof this.onTick === "function") this.onTick(ms, this.state);
    if (ms <= 0) this._finish();
  },

  _finish() {
    this.playChime();            // 0초에 단 한 번만. 반복/재알림 없음 (DECISIONS D7)
    this.state.running = false;
    clearInterval(this._tick); this._tick = null;
    // 화면 유지는 끄지 않는다 — 세트 사이/종료 후에도 세션 내내 켜둠 (C)
    const { bar } = this.els(); if (bar) bar.classList.add("ended");
    if (typeof this.onEnd === "function") this.onEnd(this.state);
  },

  // 제어 버튼 없음. 다음 세트 완료/운동 완료가 start()를 다시 부르면 맨 위 cancel()로 자연 대체.
  cancel() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this.state) this.state.running = false;
    // 화면 유지는 유지(끄지 않음)
    const { bar } = this.els(); if (bar) bar.hidden = true;
    this.state = null;
  },

  _mmss(ms) {
    const s = Math.ceil(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  },
};

window.FitlogTimer = RestTimer;
