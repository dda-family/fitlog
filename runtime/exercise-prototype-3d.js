// 3D 기술 시제품(technical_prototype) 전용 뷰어: 공유 인체 + 운동별 클립 GLB + 별도 장비 GLB.
// 운영 중인 컬 3종은 exercise-preview-3d.js(운동별 완결 GLB)를 그대로 쓰며, 이 모듈과 상태를 공유하지 않는다.
// 참고 구현: Astra stage1 runtime/prototype-viewer.js (계약 2.0.0-prototype.1). 히트맵과 무관.
import * as T from "./vendor/three/three.module.min.js";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";

const MANIFEST_SCHEMA = "2.0.0-prototype.1";

export function createPrototypePreview(container, options = {}) {
  const baseURL = new URL(options.baseURL || "../", import.meta.url);
  const manifestURL = new URL(options.manifestURL || "data/prototype/stage1-manifest.json", baseURL);
  const muscleMapURL = new URL(options.muscleMapURL || "data/animation-muscle-map.json", baseURL);
  const assetBase = new URL(options.assetBase || "assets/prototype/stage1/", baseURL);

  const root = document.createElement("div");
  root.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;touch-action:pan-y;";
  container.append(root);

  let renderer = null, scene = null, camera = null, floor = null, manifest = null, colorMap = null;
  let shared = null, body = null, mixer = null, action = null, entry = null, catalogId = null;
  let state = "loading", reason = null, disposed = false, gen = 0;
  let playing = true, visible = true, inView = true, frame = 0, last = 0, renders = 0, yaw = 0;
  let lastLoadMs = 0, readyError = null;
  const clipCache = new Map(), eqCache = new Map(), active = [], cables = [], openHands = [], requests = [], aborts = new Set(), off = [];
  const vA = new T.Vector3(), vB = new T.Vector3(), vD = new T.Vector3(), UP = new T.Vector3(0, 1, 0);

  const notify = (s, msg) => { state = s; reason = msg || null; try { options.onStatus?.({ state: s, reason, exerciseId: catalogId }); } catch (_) {} };
  const on = (t, type, fn, opt) => { t.addEventListener(type, fn, opt); off.push(() => t.removeEventListener(type, fn, opt)); };

  // manifest 경로("assets/…")를 앱 안의 시제품 자산 폴더로 옮겨 해석. 외부 URL·경로 탈출은 거부.
  function assetURL(src) {
    if (typeof src !== "string" || /^[a-z]+:|^\/|\\|(^|\/)\.\.(\/|$)/i.test(src)) throw new Error("Invalid asset path " + src);
    return new URL(src.replace(/^assets\//, ""), assetBase);
  }
  function disposeTree(obj) {
    if (!obj) return;
    const g = new Set(), m = new Set(), s = new Set();
    obj.traverse((o) => { if (o.geometry) g.add(o.geometry); if (o.material) [].concat(o.material).forEach((x) => m.add(x)); if (o.skeleton) s.add(o.skeleton); });
    g.forEach((x) => x.dispose()); m.forEach((x) => x.dispose()); s.forEach((x) => x.dispose());
  }
  async function fetchBuffer(url) {
    const ctrl = new AbortController(); aborts.add(ctrl);
    const t0 = performance.now();
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url.pathname.split("/").pop());
      const buf = await r.arrayBuffer();
      requests.push({ src: url.pathname.split("/").slice(-2).join("/"), bytes: buf.byteLength, ms: Math.round(performance.now() - t0) });
      return buf;
    } finally { aborts.delete(ctrl); }
  }
  async function loadGLB(url, expectSha) {
    const buf = await fetchBuffer(url);
    if (expectSha && globalThis.crypto?.subtle) {
      const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hex !== expectSha) throw new Error("Rig hash mismatch");
    }
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) throw new Error("Invalid GLB");
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
    if (header.buffers?.some((x) => x.uri) || header.images?.some((x) => x.uri)) throw new Error("External resource forbidden");
    const gltf = await new GLTFLoader().parseAsync(buf, baseURL.href);
    if (disposed) { disposeTree(gltf.scene); throw new Error("disposed"); }
    return gltf;
  }

  function active_() { return !disposed && state === "ready" && visible && inView && !document.hidden; }
  function stop() { if (frame) cancelAnimationFrame(frame); frame = 0; last = 0; }
  function schedule() { if (!frame && active_()) frame = requestAnimationFrame(tick); }
  function connect() {
    if (!body) return;
    body.updateMatrixWorld(true);
    for (const { item, obj } of active) {
      if (item.mode !== "twoHand") continue;
      const a = body.getObjectByName(item.sockets[0]), b = body.getObjectByName(item.sockets[1]);
      a.getWorldPosition(vA); b.getWorldPosition(vB);
      obj.position.copy(vA).add(vB).multiplyScalar(0.5);
      a.getWorldQuaternion(obj.quaternion);
    }
    for (const { obj } of active) obj.updateMatrixWorld(true);
    // 케이블 양 끝은 manifest의 장비 로컬 접점 기준(컬용 고정 도르래 좌표를 쓰지 않음)
    for (const { spec, mesh, from, to } of cables) {
      vA.fromArray(spec.from.local || [0, 0, 0]).applyMatrix4(from.matrixWorld);
      vB.fromArray(spec.to.local || [0, 0, 0]).applyMatrix4(to.matrixWorld);
      vD.copy(vB).sub(vA);
      mesh.position.copy(vA).add(vB).multiplyScalar(0.5);
      mesh.scale.set(1, Math.max(vD.length(), 1e-4), 1);
      mesh.quaternion.setFromUnitVectors(UP, vD.normalize());
      mesh.updateMatrixWorld(true);
    }
  }
  function tick(now) {
    frame = 0;
    if (!active_()) return;
    if (playing) { if (last) mixer.update(Math.min((now - last) / 1000, 0.05)); last = now; }
    connect();
    renderer.render(scene, camera); renders++;
    if (playing) schedule();
  }
  function renderOnce() { if (state === "ready") { connect(); renderer.render(scene, camera); renders++; } }
  // 운동별 manifest camera: height(세로 폭)와 minWidth(최소 가로 폭) → 좁은 화면에선 높이를 늘려 가로를 확보
  function resize() {
    if (!renderer) return;
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    if (entry) {
      const aspect = r.width / r.height, h = Math.max(entry.camera.height, entry.camera.minWidth / aspect);
      camera.left = -h * aspect / 2; camera.right = h * aspect / 2; camera.top = h / 2; camera.bottom = -h / 2;
      camera.updateProjectionMatrix();
    }
    if (playing) schedule(); else renderOnce();
  }
  function view(angle) {
    if (!entry) return;
    yaw = Number.isFinite(angle) ? angle : yaw;
    const c = entry.camera, target = vA.fromArray(c.target), R = 4;
    camera.position.set(target.x + Math.sin(yaw) * Math.cos(c.elevation) * R, target.y + Math.sin(c.elevation) * R, target.z + Math.cos(yaw) * Math.cos(c.elevation) * R);
    camera.lookAt(target);
    if (playing) schedule(); else renderOnce();
  }

  function clearActive() {
    stop();
    if (mixer) { mixer.stopAllAction(); if (action) mixer.uncacheClip(action.getClip()); if (body) mixer.uncacheRoot(body); }
    mixer = null; action = null;
    if (body) scene.remove(body);
    for (const { obj } of active) scene.remove(obj);
    active.length = 0;
    for (const { mesh } of cables) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    cables.length = 0;
    for (const o of openHands) o.removeFromParent();
    openHands.length = 0;
    if (body) for (const s of ["L", "R"]) { const h = body.getObjectByName("grip_hand_" + s); if (h) h.visible = true; }
    body = null; entry = null;
  }
  function applyColors(muscles) {
    const pri = muscles.primary || {}, sec = muscles.secondary || {};
    body.traverse((n) => {
      const id = n.userData?.muscleId; if (!id || !n.material?.color) return;
      // minor는 데이터만 유지하고 중립색(운동 부위 안내이지 활성도 표시가 아님)
      n.material.color.set(id in pri ? colorMap.colors.primary : id in sec ? colorMap.colors.secondary : colorMap.colors.neutral);
    });
  }

  // 공유 인체는 뷰어당 한 번만 로드(동시 select도 같은 Promise를 기다림). 실패 시 다음 select에서 재시도.
  let rigPromise = null;
  function loadRig() {
    rigPromise ||= (async () => {
      const g = await loadGLB(assetURL(manifest.rig.src), manifest.rig.sha256);
      const missing = manifest.rig.jointNames.filter((j) => !g.scene.getObjectByName(j));
      if (missing.length) { disposeTree(g.scene); throw new Error("Rig joints missing: " + missing.join(",")); }
      g.scene.traverse((n) => { if (n.isSkinnedMesh) n.frustumCulled = false; });
      shared = g.scene;
    })().catch((err) => { rigPromise = null; throw err; });
    return rigPromise;
  }

  async function select(id, opts = {}) {
    const token = ++gen;
    clearActive();
    catalogId = id;
    notify("loading", "3D 시제품을 불러오는 중");
    await ready;
    if (token !== gen || disposed) return state;
    if (!manifest) { notify("error", readyError || "시제품 뷰어를 준비하지 못했습니다"); return state; }
    const e = manifest.exercises?.[id];
    if (!e) { notify("unavailable", "이 운동의 시제품 자산이 없습니다"); return state; }
    const t0 = performance.now();
    try {
      if (e.rigId !== manifest.rig.id) throw new Error("Rig mismatch");
      await loadRig();
      if (token !== gen || disposed) return state;
      if (!clipCache.has(id)) {
        const g = await loadGLB(assetURL(e.clip.src));
        disposeTree(g.scene);
        const clip = g.animations.find((c) => c.name === e.clip.name);
        if (!clip) throw new Error("Animation missing " + e.clip.name);
        const unbound = clip.tracks.filter((t) => !shared.getObjectByName(t.name.split(".")[0]));
        if (unbound.length) throw new Error("Clip tracks not in rig");
        clipCache.set(id, clip);
      }
      if (token !== gen) return state;
      const equip = [];
      for (const item of e.equipment || []) {
        if (!eqCache.has(item.src)) { const g = await loadGLB(assetURL(item.src)); if (token !== gen) { disposeTree(g.scene); return state; } eqCache.set(item.src, g.scene); }
        if (item.mode === "twoHand" && !(item.sockets?.length === 2 && item.sockets.every((s) => shared.getObjectByName(s)))) throw new Error("Missing sockets for " + item.id);
        if (item.mode !== "twoHand" && item.mode !== "fixed") throw new Error("Unsupported equipment mode " + item.mode);
        equip.push({ item, obj: eqCache.get(item.src) });
      }
      if (e.handPose === "open" && !eqCache.has("__hands")) {
        const g = await loadGLB(assetURL("assets/equipment/open_hands.glb"));
        if (token !== gen) { disposeTree(g.scene); return state; }
        eqCache.set("__hands", g.scene);
      }
      if (token !== gen || disposed) return state;

      entry = e; body = shared; scene.add(body);
      applyColors(opts.muscles || e.muscles || {});
      for (const s of ["L", "R"]) {
        const gripHand = body.getObjectByName("grip_hand_" + s);
        if (gripHand) gripHand.visible = e.handPose !== "open";
        if (e.handPose === "open") {
          const hand = eqCache.get("__hands").getObjectByName("open_hand_" + s)?.clone();
          if (hand) { body.getObjectByName("wrist_" + s).add(hand); openHands.push(hand); }
        }
      }
      for (const o of equip) { o.obj.position.set(0, 0, 0); o.obj.quaternion.identity(); o.obj.scale.set(1, 1, 1); scene.add(o.obj); active.push(o); }
      for (const spec of e.cables || []) {
        const fromEq = active.find((x) => x.item.id === spec.from.equipment), toEq = active.find((x) => x.item.id === spec.to.equipment);
        if (!fromEq || !toEq) throw new Error("Cable equipment missing " + spec.id);
        const from = spec.from.node ? fromEq.obj.getObjectByName(spec.from.node) : fromEq.obj;
        if (!from) throw new Error("Cable node missing " + spec.from.node);
        const mesh = new T.Mesh(new T.CylinderGeometry(spec.radius, spec.radius, 1, 10), new T.MeshStandardMaterial({ color: 0xdde6ee }));
        mesh.name = "cable:" + spec.id;
        scene.add(mesh); cables.push({ spec, mesh, from, to: toEq.obj });
      }
      mixer = new T.AnimationMixer(body);
      action = mixer.clipAction(clipCache.get(id)).setLoop(T.LoopRepeat, Infinity).play();
      mixer.setTime(0);
      lastLoadMs = Math.round(performance.now() - t0);
      notify("ready", "기술 시제품 · 품질 검증 전");
      view(e.camera.azimuth);
      resize();
      renderOnce();
      schedule();
    } catch (err) {
      if (token !== gen || disposed) return state;
      clearActive();
      notify("error", "시제품을 불러오지 못했습니다 (" + (err?.message || err) + ")");
    }
    return state;
  }

  function pause() { playing = false; stop(); renderOnce(); }
  function play() { if (disposed) return; playing = true; last = 0; schedule(); }
  function setVisible(v) { visible = !!v; if (visible) schedule(); else stop(); }
  function seek(sec) { if (!mixer || !entry) return; const d = entry.clip.duration; mixer.setTime(((sec % d) + d) % d); renderOnce(); }

  function destroy() {
    if (disposed) return;
    disposed = true; gen++;
    aborts.forEach((a) => a.abort());
    clearActive();
    off.splice(0).forEach((f) => f());
    disposeTree(shared); shared = null;
    eqCache.forEach(disposeTree); eqCache.clear(); clipCache.clear();
    if (floor) { floor.geometry.dispose(); floor.material.dispose(); }
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); }
    root.remove();
    notify("disposed");
  }

  // 시험 검증용: 한 주기 여러 시점에서 인체·장비·케이블의 화면 좌표(NDC) 범위. 1을 넘으면 잘림.
  function frameFit(samples = 8) {
    if (state !== "ready") return null;
    const keep = action.time, box = new T.Box3(), tmp = new T.Box3(), p = new T.Vector3();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    camera.updateMatrixWorld(true);
    for (let i = 0; i < samples; i++) {
      mixer.setTime((entry.clip.duration * i) / samples); connect();
      box.makeEmpty();
      body.traverse((n) => { if (n.isMesh && n.visible) { tmp.makeEmpty(); tmp.expandByObject(n, true); box.union(tmp); } });
      for (const { obj } of active) box.expandByObject(obj, true);
      for (const { mesh } of cables) box.expandByObject(mesh, true);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        p.set(x, y, z).project(camera);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    mixer.setTime(keep); renderOnce();
    return { minX, maxX, minY, maxY };
  }
  function diagnostics() {
    const colors = {};
    body?.traverse((n) => { if (n.userData?.muscleId && n.material?.color) colors[n.userData.muscleId] = n.material.color.getHexString(); });
    return {
      state, reason, exerciseId: catalogId, status: entry?.status || null, playing, visible, inView, framePending: !!frame, renders,
      time: action?.time || 0, lastLoadMs, bodyUUID: body?.uuid || null, sharedUUID: shared?.uuid || null,
      equipment: active.map((x) => x.item.id), cables: cables.map((c) => ({ id: c.spec.id, from: c.from.getWorldPosition(new T.Vector3()).toArray().map((v) => +v.toFixed(3)) })),
      openHands: openHands.length, clipCache: clipCache.size, equipmentCache: eqCache.size, requests: requests.slice(),
      colors, geometries: renderer?.info.memory.geometries || 0, triangles: renderer?.info.render.triangles || 0, listeners: off.length,
    };
  }

  const ready = (async () => {
    try {
      const [m, c] = await Promise.all([manifestURL, muscleMapURL].map(async (u) => { const r = await fetch(u); if (!r.ok) throw new Error("Data HTTP " + r.status); return r.json(); }));
      if (disposed) return;
      if (m.schemaVersion !== MANIFEST_SCHEMA) throw new Error("Unsupported manifest " + m.schemaVersion);
      if (c.schemaVersion !== "1.0.0" || c.mappings?.length !== 20) throw new Error("Invalid muscle mapping");
      manifest = m; colorMap = c;
      renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
      renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.NoToneMapping;
      renderer.domElement.style.cssText = "display:block;width:100%;height:100%;";
      root.prepend(renderer.domElement);
      on(renderer.domElement, "webglcontextlost", (ev) => { ev.preventDefault(); stop(); notify("error", "WebGL 컨텍스트가 해제되었습니다"); });
      scene = new T.Scene(); scene.background = new T.Color("#101c29");
      camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.01, 30);
      scene.add(new T.HemisphereLight(0xe4f3ff, 0x738797, 2.2));
      const key = new T.DirectionalLight(0xffffff, 2.3); key.position.set(3, 5, 4); scene.add(key);
      const fill = new T.DirectionalLight(0xa7dcec, 0.8); fill.position.set(-3, 2, -2); scene.add(fill);
      floor = new T.Mesh(new T.PlaneGeometry(5, 5), new T.MeshBasicMaterial({ color: 0x172636 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = -0.018; scene.add(floor);
      const ro = new ResizeObserver(resize); ro.observe(root); off.push(() => ro.disconnect());
      const io = new IntersectionObserver((es) => { inView = es[0].isIntersecting; if (inView) schedule(); else stop(); }); io.observe(root); off.push(() => io.disconnect());
      on(document, "visibilitychange", () => { if (document.hidden) stop(); else schedule(); });
      // 가로 드래그만 회전, 세로는 페이지 스크롤. 두 손가락이면 회전 취소.
      const pointers = new Set(); let g = null;
      on(root, "pointerdown", (ev) => { pointers.add(ev.pointerId); g = pointers.size === 1 ? { id: ev.pointerId, x: ev.clientX, y: ev.clientY, yaw, lock: null } : null; });
      on(root, "pointermove", (ev) => {
        if (!g || g.id !== ev.pointerId) return;
        const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
        if (!g.lock && Math.hypot(dx, dy) > 8) { g.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y"; if (g.lock === "x") try { root.setPointerCapture(ev.pointerId); } catch (_) {} }
        if (g.lock === "x") view(g.yaw + dx * 0.01);
      });
      const end = (ev) => { pointers.delete(ev.pointerId); if (g?.id === ev.pointerId) g = null; };
      on(root, "pointerup", end); on(root, "pointercancel", end);
    } catch (err) {
      readyError = "시제품 뷰어를 준비하지 못했습니다 (" + (err?.message || err) + ")";
      if (!disposed) notify("error", readyError);
    }
  })();

  return { ready, select, play, pause, seek, setVisible, setAngle: view, destroy, getDiagnostics: diagnostics, frameFit, isPlaying: () => playing };
}
