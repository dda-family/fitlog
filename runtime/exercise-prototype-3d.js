// 3D 기술 시제품(technical_prototype) 전용 뷰어: 공유 인체 + 운동별 클립 GLB + 별도 장비 GLB.
// 운영 중인 컬 3종은 exercise-preview-3d.js(운동별 완결 GLB)를 그대로 쓰며, 이 모듈과 상태를 공유하지 않는다.
// 계약 두 가지를 schemaVersion으로 분기한다(그 외 버전은 거부):
//   2.0.0-prototype.1 — Astra stage1/R2 (fixed/twoHand, mixer.update 재생). 기존 의미 그대로.
//   2.1.0-prototype.1 — Astra Equipment Contract (fixed/node/twoPoint 부착, 장비 인스턴스, normalizedPhase 동기화).
import * as T from "./vendor/three/three.module.min.js";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";

const SCHEMA_V20 = "2.0.0-prototype.1", SCHEMA_V21 = "2.1.0-prototype.1";

export function createPrototypePreview(container, options = {}) {
  const baseURL = new URL(options.baseURL || "../", import.meta.url);
  const manifestPaths = options.manifestURLs || [options.manifestURL || "data/prototype/stage1-manifest.json", "data/prototype/equipment-p1-manifest.json"];
  const schemaV21Path = options.schemaV21URL || "data/prototype/equipment-manifest.schema.json";
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
  // 운동 ID → { manifest, entry, schema } (manifest별 오류는 해당 운동 선택 시 그대로 보고)
  const exerciseIndex = new Map(), manifestErrors = [];
  // 2.1 전용 상태: 인체 위상 p 하나로 인체·장비를 평가한다(장비별 벽시계 누적 없음).
  let schema = null, phase = 0;
  const templates = new Map(), instances = [], cables21 = [];
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
  async function loadGLB(url, expectSha, label = "Rig") {
    const buf = await fetchBuffer(url);
    if (expectSha) {
      if (!globalThis.crypto?.subtle) throw new Error(label + " integrity check unavailable");
      const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (hex !== expectSha) throw new Error(label + " hash mismatch");
    }
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) throw new Error("Invalid GLB");
    if (dv.getUint32(8, true) !== buf.byteLength) throw new Error("GLB length mismatch");
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
    if (header.buffers?.some((x) => x.uri) || header.images?.some((x) => x.uri)) throw new Error("External resource forbidden");
    const gltf = await new GLTFLoader().parseAsync(buf, baseURL.href);
    if (disposed) { disposeTree(gltf.scene); throw new Error("disposed"); }
    gltf.fitlogExtras = header.extras || {};
    gltf.fitlogHeader = header;
    return gltf;
  }
  async function fetchJSON(path) {
    const r = await fetch(new URL(path, baseURL));
    if (!r.ok) throw new Error("Data HTTP " + r.status + " " + path);
    return r.json();
  }
  // 리그 계약 검사(rigId·계층·바인드 위치·근육 노드). 불일치하면 로딩을 거부하고 보정하지 않는다.
  function checkRig(scene, extras, contract) {
    const rig = manifest.rig;
    if (extras.rigId !== rig.id) throw new Error("Rig id mismatch (GLB " + extras.rigId + ")");
    if (contract.rigId !== rig.id || contract.sha256 !== rig.sha256) throw new Error("Rig contract mismatch");
    const names = contract.joints.map((j) => j.name);
    if (names.join() !== rig.jointNames.join()) throw new Error("Rig joint list mismatch");
    const count = new Map();
    scene.traverse((o) => { if (o.name) count.set(o.name, (count.get(o.name) || 0) + 1); });
    const p = new T.Vector3();
    for (const j of contract.joints) {
      if (count.get(j.name) !== 1) throw new Error("Rig joint missing/duplicate " + j.name);
      const node = scene.getObjectByName(j.name);
      const parentOk = j.parent === null ? !names.includes(node.parent?.name) : node.parent?.name === j.parent;
      if (!parentOk) throw new Error("Rig hierarchy mismatch " + j.name);
      if (node.position.distanceTo(p.fromArray(j.bindTranslation)) > 1e-4) throw new Error("Rig bind pose mismatch " + j.name);
    }
    let skeleton = null;
    scene.traverse((o) => { if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton; });
    if (!skeleton || skeleton.bones.map((b) => b.name).join() !== names.join()) throw new Error("Rig skeleton mismatch");
    const mats = new Map();
    for (const m of colorMap.mappings) for (const n of m.nodeNames) {
      const node = scene.getObjectByName(n);
      if (!node?.isSkinnedMesh || node.userData?.muscleId !== m.muscleId) throw new Error("Muscle mesh mismatch " + m.muscleId);
      if (mats.has(node.material) && mats.get(node.material) !== m.muscleId) throw new Error("Shared muscle material");
      mats.set(node.material, m.muscleId);
    }
  }
  // 클립 계약 검사: 같은 리그 전용인지, 정확한 이름인지, 전 관절 회전 + pelvis 위치 트랙이 있는지.
  function checkClip(gltf, e, id, contract) {
    const x = gltf.fitlogExtras;
    if (x.rigId !== manifest.rig.id || x.rigSha256 !== manifest.rig.sha256) throw new Error("Clip rig mismatch " + id);
    if (e.clip.name !== id) throw new Error("Clip name mismatch " + id);
    const clip = gltf.animations.find((c) => c.name === e.clip.name);
    if (!clip) throw new Error("Animation missing " + e.clip.name);
    const tracks = new Set(clip.tracks.map((t) => t.name));
    const need = contract.joints.map((j) => j.name + ".quaternion").concat("pelvis.position");
    const missing = need.filter((n) => !tracks.has(n));
    if (missing.length) throw new Error("Clip tracks missing " + missing.slice(0, 3).join(","));
    return clip;
  }

  // ───────────── 2.1.0-prototype.1 (Equipment Contract) ─────────────
  const fract = (x) => x - Math.floor(x);
  // data/prototype/equipment-manifest.schema.json 을 그대로 해석하는 JSON Schema 부분집합 검사(모르는 필드 거부).
  function schemaCheck(rootSchema, node, value, path) {
    if (node.$ref) return schemaCheck(rootSchema, rootSchema.$defs[node.$ref.replace("#/$defs/", "")], value, path);
    if (node.oneOf) {
      const ok = node.oneOf.filter((s) => { try { schemaCheck(rootSchema, s, value, path); return true; } catch (_) { return false; } });
      if (ok.length !== 1) throw new Error("Schema: no single match at " + path);
      return;
    }
    if ("const" in node && JSON.stringify(value) !== JSON.stringify(node.const)) throw new Error("Schema: const at " + path);
    const fail = (why) => { throw new Error("Schema: " + why + " at " + path); };
    if (node.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("object expected");
      for (const k of node.required || []) if (!(k in value)) fail("missing " + k);
      if (node.minProperties != null && Object.keys(value).length < node.minProperties) fail("too few properties");
      for (const [k, v] of Object.entries(value)) {
        if (node.propertyNames) schemaCheck(rootSchema, node.propertyNames, k, path + "{" + k + "}");
        if (node.properties && k in node.properties) schemaCheck(rootSchema, node.properties[k], v, path + "." + k);
        else if (node.additionalProperties === false) fail("unknown field " + k);
        else if (node.additionalProperties && typeof node.additionalProperties === "object") schemaCheck(rootSchema, node.additionalProperties, v, path + "." + k);
      }
    } else if (node.type === "array") {
      if (!Array.isArray(value)) fail("array expected");
      if (node.minItems != null && value.length < node.minItems) fail("too few items");
      if (node.maxItems != null && value.length > node.maxItems) fail("too many items");
      if (node.items) value.forEach((v, i) => schemaCheck(rootSchema, node.items, v, path + "[" + i + "]"));
    } else if (node.type === "string") {
      if (typeof value !== "string") fail("string expected");
      if (node.minLength != null && value.length < node.minLength) fail("too short");
      if (node.pattern && !new RegExp(node.pattern).test(value)) fail("pattern");
    } else if (node.type === "number" || node.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) fail("number expected");
      if (node.type === "integer" && !Number.isInteger(value)) fail("integer expected");
      if (node.minimum != null && value < node.minimum) fail("below minimum");
      if (node.maximum != null && value > node.maximum) fail("above maximum");
      if (node.exclusiveMinimum != null && value <= node.exclusiveMinimum) fail("not above exclusiveMinimum");
      if (node.exclusiveMaximum != null && value >= node.exclusiveMaximum) fail("not below exclusiveMaximum");
    }
  }
  // 스키마로 표현되지 않는 운동 단위 의미 검사(자산을 받기 전 단계).
  function checkEntryV21(m, id, e) {
    if (e.catalogId !== id) throw new Error("Catalog key mismatch " + id);
    if (e.rigId !== m.rig.id) throw new Error("Entry rig mismatch " + id);
    if (e.clip.name !== id) throw new Error("Clip name mismatch " + id);
    const ids = e.equipment.map((q) => q.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate equipment instance " + id);
    const cids = e.cables.map((c) => c.id);
    if (new Set(cids).size !== cids.length) throw new Error("Duplicate cable " + id);
    for (const q of e.equipment) {
      const a = q.attachment;
      if (a.type !== "twoPoint" && Math.abs(Math.hypot(...a.quaternion) - 1) > 1e-5) throw new Error("Attachment quaternion not unit " + q.id);
      if (q.animation && q.animation.clip !== id) throw new Error("Equipment clip name " + q.id);
    }
    for (const c of e.cables) for (const ep of [c.from, c.to]) if (ep.space === "equipment" && !ids.includes(ep.instance)) throw new Error("Cable instance missing " + c.id);
  }
  const muscleKey = (m) => JSON.stringify(["primary", "secondary", "minor"].map((k) => Object.entries(m?.[k] || {}).sort()));
  function bodyNode(name) {
    let hit = null, n = 0;
    shared.traverse((o) => { if (o.name === name) { hit = o; n++; } });
    if (n !== 1) throw new Error("Body node missing/duplicate " + name);
    return hit;
  }
  // 장비 템플릿: src+SHA 키로 뷰어 수명 동안 1회 로드. 인스턴스는 clone으로 트리·변환·mixer를 분리한다.
  function loadTemplate(q) {
    const key = q.src + "|" + q.sha256;
    let t = templates.get(key);
    if (!t) {
      t = { gltf: null };
      t.promise = (async () => {
        const g = await loadGLB(assetURL(q.src), q.sha256, "Equipment");
        const x = g.fitlogExtras, base = q.src.split("/").pop().replace(/\.glb$/, "");
        try {
          if (x.assetType !== "equipment" || x.equipmentId !== base || x.equipmentVersion !== "1.0.0" || x.contractVersion !== SCHEMA_V21 || x.coordinateSystem !== "Y_UP_Z_FORWARD_METERS") throw new Error("Equipment extras mismatch " + base);
          const h = g.fitlogHeader, names = (h.nodes || []).map((n) => n.name);
          if (names.some((n) => !n) || new Set(names).size !== names.length) throw new Error("Equipment node names not unique " + base);
          const sc = h.scenes?.[h.scene || 0];
          if (sc?.nodes?.length !== 1 || h.nodes[sc.nodes[0]].name !== "equipment_root") throw new Error("Equipment root missing " + base);
        } catch (err) { disposeTree(g.scene); throw err; }
        t.gltf = g;
        return g;
      })().catch((err) => { templates.delete(key); throw err; });
      templates.set(key, t);
    }
    return t.promise;
  }
  function makeInstance(g, q) {
    const obj = g.scene.clone(true);   // geometry/material/buffer 공유, Object3D 트리·변환은 인스턴스 전용
    obj.name = "instance:" + q.id;
    const find = (name) => { const hits = []; obj.traverse((n) => { if (n.name === name) hits.push(n); }); if (hits.length !== 1) throw new Error("Equipment node missing/duplicate " + name + " (" + q.id + ")"); return hits[0]; };
    obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1); obj.updateMatrixWorld(true);
    const inst = { spec: q, obj, find, mixer: null, action: null };
    const a = q.attachment; let anchors = [];
    if (a.type === "fixed") {
      obj.position.fromArray(a.position); obj.quaternion.fromArray(a.quaternion);
    } else if (a.type === "node") {
      inst.target = bodyNode(a.target.node);
      anchors = [find(a.anchor)];
      inst.anchorInv = anchors[0].matrixWorld.clone().invert();   // 인스턴스 외부 변환을 뺀 누적 bind(anchorRestInEquipment)
    } else if (a.type === "twoPoint") {
      inst.targets = a.targets.map((t) => bodyNode(t.node));
      anchors = a.anchors.map(find);
      inst.anchorsLocal = anchors.map((n) => n.getWorldPosition(new T.Vector3()));
      const lx = inst.anchorsLocal[1].clone().sub(inst.anchorsLocal[0]);
      if (lx.length() < 1e-6) throw new Error("Two-point anchors coincide " + q.id);
      if (new T.Vector3().fromArray(a.localUp).cross(lx.normalize()).length() < 1e-6) throw new Error("Two-point localUp degenerate " + q.id);
    } else throw new Error("Unsupported attachment " + a.type);
    if (q.animation) {
      const clip = g.animations.find((c) => c.name === q.animation.clip);
      if (!clip) throw new Error("Equipment clip missing " + q.id);
      if (Math.abs(clip.duration - q.animation.duration) > 1e-5) throw new Error("Equipment duration mismatch " + q.id);
      const blocked = new Set();
      for (const an of anchors) for (let n = an; n && n !== obj; n = n.parent) blocked.add(n);
      for (const tr of clip.tracks) { const n = find(tr.name.split(".")[0]); if (blocked.has(n)) throw new Error("Animated attachment anchor " + q.id); }
      inst.mixer = new T.AnimationMixer(obj);   // 바인딩 root를 이 인스턴스로 한정
      inst.action = inst.mixer.clipAction(clip).setLoop(T.LoopOnce, 1);
      inst.action.clampWhenFinished = true; inst.action.play();
    }
    return inst;
  }
  function endpointSource(ep) {
    if (ep.space === "scene") return null;
    if (ep.space === "body") return bodyNode(ep.node);
    const inst = instances.find((i) => i.spec.id === ep.instance);
    if (!inst) throw new Error("Cable instance missing " + ep.instance);
    return ep.node ? inst.find(ep.node) : inst.obj;
  }
  const mA = new T.Matrix4(), mB = new T.Matrix4(), qA = new T.Quaternion(), qB = new T.Quaternion(), ONE = new T.Vector3(1, 1, 1);
  function attachV21(inst) {
    const a = inst.spec.attachment;
    if (a.type === "node") {
      // equipmentWorld = compose(P, targetWorldQuaternion * attachmentQuaternion, 1) * inverse(anchorRestInEquipment)
      vA.fromArray(a.target.point).applyMatrix4(inst.target.matrixWorld);
      inst.target.getWorldQuaternion(qA).multiply(qB.fromArray(a.quaternion));
      mA.compose(vA, qA, ONE).multiply(inst.anchorInv);
      mA.decompose(inst.obj.position, inst.obj.quaternion, inst.obj.scale);
    } else if (a.type === "twoPoint") {
      const A = new T.Vector3().fromArray(a.targets[0].point).applyMatrix4(inst.targets[0].matrixWorld);
      const B = new T.Vector3().fromArray(a.targets[1].point).applyMatrix4(inst.targets[1].matrixWorld);
      const [lA, lB] = inst.anchorsLocal, x = B.clone().sub(A), dist = x.length();
      if (dist < 1e-6) throw new Error("Two-point targets coincide " + inst.spec.id);
      if (Math.abs(dist - lA.distanceTo(lB)) > a.distanceTolerance) throw new Error("Two-point distance mismatch " + inst.spec.id);
      x.normalize();
      const up = new T.Vector3().fromArray(a.up), z = up.clone().addScaledVector(x, -up.dot(x));
      if (z.length() < 1e-6) throw new Error("Two-point up degenerate " + inst.spec.id);
      z.normalize();
      const lx = lB.clone().sub(lA).normalize(), lu = new T.Vector3().fromArray(a.localUp), lz = lu.clone().addScaledVector(lx, -lu.dot(lx)).normalize();
      mA.makeBasis(x, z.clone().cross(x), z);
      mB.makeBasis(lx, lz.clone().cross(lx), lz).invert();   // 직교 행렬의 역 = 전치
      inst.obj.quaternion.setFromRotationMatrix(mA.multiply(mB));
      inst.obj.position.copy(A).sub(lA.clone().applyQuaternion(inst.obj.quaternion));
      inst.obj.scale.set(1, 1, 1);
    }
  }
  function endpointWorld(ep, src, out) { out.fromArray(ep.point); return src ? out.applyMatrix4(src.matrixWorld) : out; }
  // 계약 평가 순서: 인체 pose → 장비 내부 pose → world 갱신 → 부착 → world 재갱신 → 케이블 → (호출자가) 렌더
  function evaluateV21Core(p) {
    // LoopOnce 액션은 끝(t=duration)에 한 번 닿으면 three가 paused로 바꿔 이후 setTime이 0에 머문다 → 매번 해제.
    action.paused = false; action.enabled = true;
    mixer.setTime(p * entry.clip.duration);
    for (const inst of instances) if (inst.mixer) {
      const an = inst.spec.animation;
      let q = fract(p * an.cycles + an.phaseOffset);
      if (p === 1 && an.phaseOffset === 0) q = 1;   // scrub 끝점은 마지막 key 평가
      inst.action.paused = false; inst.action.enabled = true;
      inst.mixer.setTime(q * an.duration);
    }
    body.updateMatrixWorld(true);
    for (const inst of instances) inst.obj.updateMatrixWorld(true);
    for (const inst of instances) attachV21(inst);
    for (const inst of instances) inst.obj.updateMatrixWorld(true);
    for (const c of cables21) {
      endpointWorld(c.spec.from, c.from, vA); endpointWorld(c.spec.to, c.to, vB);
      vD.copy(vB).sub(vA);
      const len = vD.length();
      c.mesh.visible = len >= 1e-6;
      if (c.mesh.visible) {
        c.mesh.position.copy(vA).add(vB).multiplyScalar(0.5);
        c.mesh.scale.set(1, len, 1);
        c.mesh.quaternion.setFromUnitVectors(UP, vD.normalize());
      }
      c.mesh.updateMatrixWorld(true);
    }
  }
  function evaluateV21(p) {
    try { evaluateV21Core(p); return true; }
    catch (err) { stop(); clearActive(); notify("error", "시제품을 불러오지 못했습니다 (" + (err?.message || err) + ")"); return false; }
  }
  async function selectV21(id, e, token, opts) {
    const t0 = performance.now();
    try {
      // 강조는 앱 카탈로그 매핑 기준. manifest 사본이 카탈로그와 다르면 버전 혼용으로 보고 거부.
      if (opts.muscles && muscleKey(opts.muscles) !== muscleKey(e.muscles)) throw new Error("Manifest muscles differ from catalog " + id);
      await loadRig();
      if (token !== gen || disposed) return state;
      const ckey = "v21|" + id + "|" + e.clip.sha256;
      if (!clipCache.has(ckey)) {
        const g = await loadGLB(assetURL(e.clip.src), e.clip.sha256, "Clip");
        disposeTree(g.scene);
        const x = g.fitlogExtras;
        if (x.assetType !== "humanClip" || x.catalogId !== id) throw new Error("Clip extras mismatch " + id);
        if (g.animations.length !== 1) throw new Error("Clip must have exactly one animation " + id);
        const clip = checkClip(g, e, id, rigContract);
        if (clip.tracks.length !== rigContract.joints.length + 1) throw new Error("Clip has non-body tracks " + id);   // 인체 clip에 장비 트랙 금지
        if (clip.tracks.some((t) => !shared.getObjectByName(t.name.split(".")[0]))) throw new Error("Clip tracks not in rig");
        if (Math.abs(clip.duration - e.clip.duration) > 1e-5) throw new Error("Clip duration mismatch " + id);
        clipCache.set(ckey, clip);
      }
      const loaded = [];
      for (const q of e.equipment) { const g = await loadTemplate(q); if (token !== gen || disposed) return state; loaded.push([g, q]); }
      if (token !== gen || disposed) return state;

      entry = e; body = shared; scene.add(body);
      applyColors(opts.muscles || e.muscles);
      for (const s of ["L", "R"]) { const h = body.getObjectByName("grip_hand_" + s); if (h) h.visible = true; }   // 2.1은 grip 손만 허용
      for (const [g, q] of loaded) { const inst = makeInstance(g, q); instances.push(inst); scene.add(inst.obj); }
      for (const c of e.cables) {
        const mesh = new T.Mesh(new T.CylinderGeometry(c.radius, c.radius, 1, 10), new T.MeshStandardMaterial({ color: 0xdde6ee }));
        mesh.name = "cable:" + c.id;
        cables21.push({ spec: c, mesh, from: endpointSource(c.from), to: endpointSource(c.to) });
        scene.add(mesh);
      }
      mixer = new T.AnimationMixer(body);
      action = mixer.clipAction(clipCache.get(ckey)).setLoop(T.LoopOnce, 1);
      action.clampWhenFinished = true; action.play();
      phase = 0;
      evaluateV21Core(0);   // 부착·케이블 검사를 ready 전에 한 번 수행
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
    if (schema === SCHEMA_V21) {
      // 프레임 간격 상한(0.05s)은 위상 하나에만 적용 → 인체·장비에 동일하게 반영. 복귀 시 last=0이라 점프 없음.
      if (playing) { if (last) phase = fract(phase + Math.min((now - last) / 1000, 0.05) / entry.clip.duration); last = now; }
      if (!evaluateV21(phase)) return;
      renderer.render(scene, camera); renders++;
      if (playing) schedule();
      return;
    }
    if (playing) { if (last) mixer.update(Math.min((now - last) / 1000, 0.05)); last = now; }
    connect();
    renderer.render(scene, camera); renders++;
    if (playing) schedule();
  }
  function renderOnce() {
    if (state !== "ready") return;
    if (schema === SCHEMA_V21) { if (evaluateV21(phase)) { renderer.render(scene, camera); renders++; } return; }
    connect(); renderer.render(scene, camera); renders++;
  }
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
    // 2.1 인스턴스: 트리·mixer만 해제. geometry/material은 템플릿(뷰어 수명 캐시) 소유라 dispose하지 않는다.
    for (const inst of instances) { if (inst.mixer) { inst.mixer.stopAllAction(); inst.mixer.uncacheRoot(inst.obj); } scene.remove(inst.obj); }
    instances.length = 0;
    for (const { mesh } of cables21) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    cables21.length = 0;
    if (body) for (const s of ["L", "R"]) { const h = body.getObjectByName("grip_hand_" + s); if (h) h.visible = true; }
    body = null; entry = null; schema = null; phase = 0;
  }
  function applyColors(muscles) {
    const pri = muscles.primary || {}, sec = muscles.secondary || {};
    body.traverse((n) => {
      const id = n.userData?.muscleId; if (!id || !n.material?.color) return;
      // minor는 데이터만 유지하고 중립색(운동 부위 안내이지 활성도 표시가 아님)
      n.material.color.set(id in pri ? colorMap.colors.primary : id in sec ? colorMap.colors.secondary : colorMap.colors.neutral);
    });
  }

  // 공유 인체는 rigId+SHA-256 키로 뷰어당 한 번만 로드(2.0·2.1 manifest가 같은 인체면 같은 객체를 재사용).
  // 동시 select도 같은 Promise를 기다림. 실패 시 다음 select에서 재시도.
  const rigs = new Map();
  let rigContract = null;
  function loadRig() {
    const spec = manifest.rig, key = spec.id + "|" + spec.sha256;
    let r = rigs.get(key);
    if (!r) {
      r = { promise: null, scene: null, contract: null };
      r.promise = (async () => {
        const contract = await fetchJSON("data/prototype/rig-contract-" + spec.id + ".json");
        const g = await loadGLB(assetURL(spec.src), spec.sha256);
        try { checkRig(g.scene, g.fitlogExtras, contract); } catch (err) { disposeTree(g.scene); throw err; }
        g.scene.traverse((n) => { if (n.isSkinnedMesh) n.frustumCulled = false; });
        r.scene = g.scene; r.contract = contract;
      })().catch((err) => { rigs.delete(key); throw err; });
      rigs.set(key, r);
    }
    return r.promise.then(() => { shared = r.scene; rigContract = r.contract; });
  }

  async function select(id, opts = {}) {
    const token = ++gen;
    clearActive();
    catalogId = id;
    notify("loading", "3D 시제품을 불러오는 중");
    await ready;
    if (token !== gen || disposed) return state;
    if (!colorMap) { notify("error", readyError || "시제품 뷰어를 준비하지 못했습니다"); return state; }
    const hit = exerciseIndex.get(id);
    if (!hit) {
      const bad = manifestErrors.find((m) => m.ids?.includes(id));
      if (bad) { notify("error", "시제품을 불러오지 못했습니다 (" + bad.error + ")"); return state; }
      notify("unavailable", "이 운동의 시제품 자산이 없습니다"); return state;
    }
    if (hit.error) { notify("error", "시제품을 불러오지 못했습니다 (" + hit.error + ")"); return state; }
    manifest = hit.manifest; schema = hit.schema;
    const e = hit.entry;
    if (schema === SCHEMA_V21) return selectV21(id, e, token, opts);
    const t0 = performance.now();
    try {
      if (e.rigId !== manifest.rig.id) throw new Error("Rig mismatch");
      await loadRig();
      if (token !== gen || disposed) return state;
      if (!clipCache.has(id)) {
        const g = await loadGLB(assetURL(e.clip.src));
        disposeTree(g.scene);
        const clip = checkClip(g, e, id, rigContract);
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
  function seek(sec) {
    if (!mixer || !entry) return;
    const d = entry.clip.duration;
    if (schema === SCHEMA_V21) { phase = fract(sec / d); renderOnce(); return; }
    mixer.setTime(((sec % d) + d) % d); renderOnce();
  }
  // 정규화 위상(0~1) 스크럽. 2.1은 인체·장비가 같은 p로 평가된다. p=1은 끝점(마지막 key) 확인용.
  function seekPhase(p) {
    if (!mixer || !entry) return;
    p = Math.min(1, Math.max(0, +p || 0));
    if (schema === SCHEMA_V21) { phase = p; renderOnce(); return; }
    mixer.setTime(p * entry.clip.duration); renderOnce();
  }
  function getPhase() {
    if (!entry || !action) return 0;
    return schema === SCHEMA_V21 ? phase : fract(action.time / entry.clip.duration);
  }

  function destroy() {
    if (disposed) return;
    disposed = true; gen++;
    aborts.forEach((a) => a.abort());
    clearActive();
    off.splice(0).forEach((f) => f());
    for (const r of rigs.values()) disposeTree(r.scene);
    rigs.clear(); shared = null;
    for (const t of templates.values()) if (t.gltf) disposeTree(t.gltf.scene);   // 공유 geometry는 뷰어 종료 시에만 해제
    templates.clear();
    eqCache.forEach(disposeTree); eqCache.clear(); clipCache.clear();
    if (floor) { floor.geometry.dispose(); floor.material.dispose(); }
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); }
    root.remove();
    notify("disposed");
  }

  // 시험 검증용: 한 주기 여러 시점에서 인체·장비·케이블의 화면 좌표(NDC) 범위. 1을 넘으면 잘림.
  function frameFit(samples = 8) {
    if (state !== "ready") return null;
    const v21 = schema === SCHEMA_V21, keep = v21 ? phase : action.time, box = new T.Box3(), tmp = new T.Box3(), p = new T.Vector3();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    camera.updateMatrixWorld(true);
    for (let i = 0; i < samples; i++) {
      if (v21) evaluateV21Core(i / samples); else { mixer.setTime((entry.clip.duration * i) / samples); connect(); }
      box.makeEmpty();
      body.traverse((n) => { if (n.isMesh && n.visible) { tmp.makeEmpty(); tmp.expandByObject(n, true); box.union(tmp); } });
      for (const { obj } of active) box.expandByObject(obj, true);
      for (const { mesh } of cables) box.expandByObject(mesh, true);
      for (const { obj } of instances) box.expandByObject(obj, true);
      for (const { mesh } of cables21) if (mesh.visible) box.expandByObject(mesh, true);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        p.set(x, y, z).project(camera);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    if (v21) phase = keep; else mixer.setTime(keep);
    renderOnce();
    return { minX, maxX, minY, maxY };
  }
  function diagnostics() {
    const colors = {};
    body?.traverse((n) => { if (n.userData?.muscleId && n.material?.color) colors[n.userData.muscleId] = n.material.color.getHexString(); });
    return {
      schemaVersion: entry ? schema : null, phase: getPhase(), rigCacheCount: rigs.size, templateCount: templates.size,
      instances: instances.map((i) => ({ id: i.spec.id, src: i.spec.src, attachment: i.spec.attachment.type, animated: !!i.mixer, uuid: i.obj.uuid, animTime: i.action ? i.action.time : null, position: i.obj.position.toArray().map((v) => +v.toFixed(4)) })),
      cables21: cables21.map((c) => ({ id: c.spec.id, visible: c.mesh.visible })),
      state, reason, exerciseId: catalogId, status: entry?.status || null, rigId: shared && manifest ? manifest.rig.id : null, clipDuration: entry?.clip.duration || null, playing, visible, inView, framePending: !!frame, renders,
      time: action?.time || 0, lastLoadMs, bodyUUID: body?.uuid || null, sharedUUID: shared?.uuid || null,
      equipment: active.map((x) => x.item.id), cables: cables.map((c) => ({ id: c.spec.id, from: c.from.getWorldPosition(new T.Vector3()).toArray().map((v) => +v.toFixed(3)) })),
      openHands: openHands.length, clipCache: clipCache.size, equipmentCache: eqCache.size, requests: requests.slice(),
      colors, geometries: renderer?.info.memory.geometries || 0, triangles: renderer?.info.render.triangles || 0, listeners: off.length,
    };
  }

  const ready = (async () => {
    try {
      const c = await fetchJSON(muscleMapURL.href);
      if (c.schemaVersion !== "1.0.0" || c.mappings?.length !== 20) throw new Error("Invalid muscle mapping");
      // manifest별로 schemaVersion 분기. 알 수 없는 버전·스키마 위반은 그 manifest의 운동만 거부(추측 해석 없음).
      let schemaV21 = null;
      for (const path of manifestPaths) {
        let m = null;
        try { m = await fetchJSON(path); } catch (err) { manifestErrors.push({ path, error: err.message }); continue; }
        const ids = Object.keys(m?.exercises || {});
        try {
          if (m.schemaVersion === SCHEMA_V21) {
            schemaV21 ||= await fetchJSON(schemaV21Path);
            schemaCheck(schemaV21, schemaV21, m, "manifest");
          } else if (m.schemaVersion !== SCHEMA_V20) throw new Error("Unsupported manifest schema " + m.schemaVersion);
        } catch (err) { manifestErrors.push({ path, ids, error: err.message }); continue; }
        for (const [id, e] of Object.entries(m.exercises)) {
          if (exerciseIndex.has(id)) { exerciseIndex.set(id, { error: "Exercise defined in more than one manifest: " + id }); continue; }
          let error = null;
          if (m.schemaVersion === SCHEMA_V21) try { checkEntryV21(m, id, e); } catch (err) { error = err.message; }
          exerciseIndex.set(id, { manifest: m, entry: e, schema: m.schemaVersion, error });
        }
      }
      if (disposed) return;
      colorMap = c;
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

  // 검증용 읽기 전용 참조(장면 객체를 바꾸지 않음): 부착·접점·케이블 수치 확인에 사용.
  const debug = () => ({ scene, camera, body, instances: instances.slice(), cables21: cables21.slice() });
  return { ready, select, play, pause, seek, seekPhase, getPhase, setVisible, setAngle: view, destroy, getDiagnostics: diagnostics, frameFit, debug, isPlaying: () => playing };
}
