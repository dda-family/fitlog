/* sound.js — 효과음 (기준 문서: docs/SOUND_DESIGN.md)
 * 재생 경로는 HTML <audio> 하나로 통일한다(Web Audio 미사용 — iOS에서 두 경로를 섞으면 소리가 가끔 사라짐).
 * 짧은 신호음은 시작 시 코드로 WAV를 만들어 쓰고(외부 파일 없음), "얏호~"는 기존 #rest-end-audio(rest-end.mp3) 그대로.
 * 소리마다 뜻은 하나:
 *   prep 준비 삑(3·2·1) · go 시작 땡~ · tick 끝나기 5·4·3·2·1초 전 똑 · step 다음 동작으로 띵 · set 세트 완료 딩-동 · rest 휴식 끝 얏호~
 * 모든 재생·언락은 canPlaySound() 하나를 지난다(v44 — 오늘 화면의 알림음 켜짐/꺼짐).
 */
(function () {
  const RATE = 22050;
  // notes: [{ f 주파수, at 시작(초), dur 길이(초), decay 감쇠, partial 배음 비율 }], peak: 최대 진폭(0~1)
  function wavURL(notes, peak) {
    const total = Math.max(...notes.map((n) => n.at + n.dur)) + 0.02;
    const N = Math.ceil(total * RATE), buf = new Float32Array(N);
    notes.forEach((n) => {
      const s0 = Math.floor(n.at * RATE), len = Math.floor(n.dur * RATE), fade = Math.floor(0.012 * RATE);
      for (let i = 0; i < len && s0 + i < N; i++) {
        const t = i / RATE;
        const env = Math.min(1, t / 0.004) * Math.exp(-t * n.decay) * Math.min(1, (len - i) / fade);
        buf[s0 + i] += env * (Math.sin(2 * Math.PI * n.f * t) + (n.partial || 0) * Math.sin(4 * Math.PI * n.f * t));
      }
    });
    let max = 0; for (let i = 0; i < N; i++) max = Math.max(max, Math.abs(buf[i]));
    const k = max ? peak / max : 0;
    const dv = new DataView(new ArrayBuffer(44 + N * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + N * 2, true); str(8, "WAVE"); str(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, RATE, true);
    dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, "data"); dv.setUint32(40, N * 2, true);
    for (let i = 0; i < N; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, buf[i] * k)) * 32767, true);
    return URL.createObjectURL(new Blob([dv], { type: "audio/wav" }));
  }
  const CUES = {
    prep: { label: "준비 삑 (3·2·1)", make: () => wavURL([{ f: 880, at: 0, dur: 0.14, decay: 6 }], 0.6) },
    go:   { label: "시작 땡~", make: () => wavURL([{ f: 1318.5, at: 0, dur: 0.85, decay: 3.2, partial: 0.3 }], 0.8) },
    tick: { label: "끝나기 5초 전 똑", make: () => wavURL([{ f: 1760, at: 0, dur: 0.05, decay: 45 }], 0.5) },
    step: { label: "다음 동작으로 띵", make: () => wavURL([{ f: 1046.5, at: 0, dur: 0.55, decay: 4.5, partial: 0.25 }], 0.7) },
    set:  { label: "세트 완료 딩-동", make: () => wavURL([{ f: 1318.5, at: 0, dur: 0.36, decay: 4.5, partial: 0.25 }, { f: 1046.5, at: 0.3, dur: 0.7, decay: 3.5, partial: 0.25 }], 0.75) },
    rest: { label: "휴식 끝 얏호~", make: null },   // 기존 rest-end.mp3
  };

  const Sound = {
    CUES,
    els: {},
    log: [],                 // 최근 재생 기록(점검·테스트용, 최대 50개)
    _unlocked: new Set(),
    _pending: new Map(),     // 언락 진행 중인 요소 → Promise (그동안 들어온 재생 요청은 언락 뒤에 실행)

    init() {
      Object.keys(CUES).forEach((k) => {
        if (k === "rest") { this.els.rest = document.getElementById("rest-end-audio") || new Audio("assets/sounds/rest-end.mp3"); return; }
        try { const a = new Audio(); a.preload = "auto"; a.src = CUES[k].make(); this.els[k] = a; } catch (_) {}
      });
      // iOS는 제스처 호출 스택 안의 play()만 허용 → 터치·클릭마다(아직 안 된 요소만) 같은 스택에서 언락
      ["touchend", "click", "keydown"].forEach((t) => document.addEventListener(t, () => this.unlock(), true));
    },
    // ── 하나의 관문(v44): 운동 알림음 OFF면 언락(음소거 재생)·재생 모두 audio.play()를 아예 부르지 않는다.
    //    외부 음악(Apple Music·Spotify 등)보다 Fitlog 소리를 앞세우지 않기 위함. 타이머·수행 흐름은 그대로.
    enabled() { const s = window.FitlogApp && window.FitlogApp.settings; return !(s && s.soundEnabled === false); },
    canPlaySound() { return this.enabled(); },
    // 사용자가 직접 켜고 끈 상태만 저장(앱이 임의로 바꾸지 않음). 끌 때는 울리는 중인 소리도 바로 멈춤.
    setEnabled(on) {
      const A = window.FitlogApp;
      if (A && A.settings) { A.settings.soundEnabled = !!on; if (A.persistSettings) A.persistSettings(); }
      if (!on) Object.values(this.els).forEach((a) => { try { if (!a.paused) a.pause(); } catch (_) {} });
      else this.unlock();   // 켜는 탭(제스처) 안에서 언락 → 다음 이벤트부터 바로 소리
    },

    // 동기 호출 전용(제스처 안). 재생 중인 요소·이미 언락된 요소는 건드리지 않는다.
    unlock() {
      if (!this.canPlaySound()) return;
      Object.entries(this.els).forEach(([k, a]) => {
        if (this._unlocked.has(k) || this._pending.has(k) || !a.paused) return;
        a.muted = true;
        let p; try { p = a.play(); } catch (_) { a.muted = false; return; }
        const done = Promise.resolve(p)
          .then(() => { a.pause(); try { a.currentTime = 0; } catch (_) {} this._unlocked.add(k); })
          .catch(() => {})
          .finally(() => { a.muted = false; this._pending.delete(k); });
        this._pending.set(k, done);
      });
    },
    play(k) {
      const a = this.els[k]; if (!a || !this.canPlaySound()) return;
      this.log.push({ k, at: Date.now() }); if (this.log.length > 50) this.log.shift();
      const go = () => {
        a.muted = false;
        try { a.currentTime = 0; } catch (_) {}
        const p = a.play();
        if (p && p.then) p.then(() => this._unlocked.add(k)).catch(() => {});
      };
      const pend = this._pending.get(k);
      if (pend) pend.then(go); else go();
    },
  };
  window.FitlogSound = Sound;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => Sound.init()); else Sound.init();
})();
