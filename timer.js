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

  // 최초 사용자 제스처에서 호출 (알림 테스트 / 운동 시작). 오디오+video 언락.
  async unlock() {
    const { audio, video } = this.els();
    try { audio.muted = true; await audio.play(); audio.pause(); audio.currentTime = 0; audio.muted = false; } catch (e) {}
    try { await video.play(); video.pause(); } catch (e) {}
    this._audioUnlocked = true;
  },

  // 알림 테스트 버튼용
  async testSound() { await this.unlock(); this.playChime(); },
  playChime() { const { audio } = this.els(); audio.currentTime = 0; audio.play().catch(() => {}); },

  // 화면 유지 on/off — CLAUDE §5.2
  _wakeOn() { const { video } = this.els(); video.play().catch(() => {}); },
  _wakeOff() { const { video } = this.els(); video.pause(); },

  // 시작: type별 기본 시간은 설정값(90/180) 사용
  start(type, durationSeconds) {
    this.cancel();
    const now = Date.now();
    this.state = { type, durationSeconds, startedAt: now, endsAt: now + durationSeconds * 1000, running: true };
    this._wakeOn();
    this._render();
    this._tick = setInterval(() => this._render(), 250);
    // TODO: document.visibilitychange 리스너로 복귀 시 _render() 재계산
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
    this._wakeOff();
    const { bar } = this.els(); if (bar) bar.classList.add("ended");
    if (typeof this.onEnd === "function") this.onEnd(this.state);
    // "✓ 휴식 종료" 표시는 app.js onEnd에서 처리. 자동 다음 액션 없음.
  },

  // 제어 버튼 없음(일시정지·정지 없음). 다음 세트 완료/운동 완료가 start()를 다시 부르면
  // 맨 위 cancel()로 실행 중 타이머가 새 타이머로 자연 대체된다. (DECISIONS D7)
  cancel() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this.state) this.state.running = false;
    this._wakeOff();
    const { bar } = this.els(); if (bar) bar.hidden = true;
    this.state = null;
  },

  _mmss(ms) {
    const s = Math.ceil(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  },
};

window.FitlogTimer = RestTimer;
