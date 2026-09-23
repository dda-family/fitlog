// Separate from the record heatmap. No DB, scores, storage, or framework dependency.
export function createExercisePreview(container, options = {}) {
  if (!container?.appendChild) throw new TypeError('A container is required');
  const baseURL = new URL(options.baseURL || '../', import.meta.url);
  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:100%;height:100%;min-height:260px;touch-action:pan-y pinch-zoom;overflow:hidden;';
  root.tabIndex=0; root.setAttribute('aria-label','3D 운동 미리보기. 좌우 방향키로 시점 변경');
  container.appendChild(root);
  const status=document.createElement('span');status.style.cssText='position:absolute;left:12px;bottom:10px;font-size:12px;font-family:inherit;color:#abbccc;pointer-events:none';root.appendChild(status);
  let T, renderer, scene, camera, model, mixer, action, bindings, entry, map, frame=0, renders=0, state='loading', reason=null, disposed=false, visible=true, intersecting=true, playing=options.autoplay!==false, last=0, yaw=.35, pending=false;
  let resizeObserver,intersectionObserver,gripL,gripR,equipL,equipR,cable,endpoint,pulley,up,dir,mid,quat;
  const abort=new AbortController(), events=[];
  const on=(el,type,fn,opts)=>{el.addEventListener(type,fn,opts);events.push(()=>el.removeEventListener(type,fn,opts));};
  function notify(s,msg){state=s;status.textContent=msg;try{options.onStatus?.({state:s,reason,exerciseId:options.exerciseId});}catch{}}
  function disposeModel(obj){if(!obj)return;const geo=new Set(),mat=new Set(),sk=new Set();obj.traverse(o=>{if(o.geometry)geo.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])mat.add(m);if(o.skeleton)sk.add(o.skeleton);});geo.forEach(g=>g.dispose());mat.forEach(m=>m.dispose());sk.forEach(s=>s.dispose());}
  function stop(){if(frame)cancelAnimationFrame(frame);frame=0;last=0;}
  function active(){return !disposed&&state==='ready'&&visible&&intersecting&&!document.hidden;}
  function schedule(){if(active()&&!frame)frame=requestAnimationFrame(tick);}
  function release(){stop();mixer?.stopAllAction();if(model)mixer?.uncacheRoot(model);disposeModel(scene);renderer?.dispose();renderer?.forceContextLoss();renderer?.domElement.remove();model=null;scene=null;renderer=null;mixer=null;bindings=null;}
  function fail(error){if(disposed)return;reason=String(error?.message||error);state='error';abort.abort();release();notify('error','미리보기를 불러오지 못했습니다. 운동 설명과 추가 기능은 계속 사용할 수 있습니다.');}
  function syncEquipment(){
    if(!gripL)return;
    model.updateMatrixWorld(true);
    gripL.getWorldPosition(mid);gripL.getWorldQuaternion(quat);
    // Model is at the world origin; camera moves to orbit, so sockets share equipment coordinates.
    if(equipR){equipL.position.copy(mid);equipL.quaternion.copy(quat);gripR.getWorldPosition(mid);gripR.getWorldQuaternion(quat);equipR.position.copy(mid);equipR.quaternion.copy(quat);}
    else{gripR.getWorldPosition(endpoint);equipL.position.copy(mid).add(endpoint).multiplyScalar(.5);equipL.quaternion.copy(quat);}
    if(cable){equipL.updateMatrixWorld(true);endpoint.set(0,0,.027).applyMatrix4(equipL.matrixWorld);dir.copy(endpoint).sub(pulley);const length=dir.length();cable.position.copy(endpoint).add(pulley).multiplyScalar(.5);cable.quaternion.setFromUnitVectors(up,dir.normalize());cable.scale.set(1,length,1);}
    model.updateMatrixWorld(true);
  }
  function tick(now){frame=0;if(!active())return;try{if(playing){if(last)mixer.update(Math.min((now-last)/1000,.05));last=now;}else last=0;syncEquipment();renderer.render(scene,camera);renders++;pending=false;if(playing)schedule();}catch(e){fail(e);}}
  function resize(){if(!renderer)return;const r=root.getBoundingClientRect();if(r.width<1||r.height<1)return;const aspect=r.width/r.height;const extent=entry.exerciseId==='cable_curl'?1.17:1.02;camera.left=-extent*aspect;camera.right=extent*aspect;camera.top=extent;camera.bottom=-extent;camera.updateProjectionMatrix();renderer.setSize(r.width,r.height,false);schedule();}
  function view(angle){yaw=Number.isFinite(angle)?angle:yaw;if(camera){const center=entry.exerciseId==='cable_curl'?.47:.05;camera.position.set(Math.sin(yaw)*4,1.55,center+Math.cos(yaw)*4);camera.lookAt(0,.91,center);schedule();}}
  function setColors(colors={}){if(!bindings)return;for(const[id,meshes]of bindings){let color=colors[id];if(!/^#[\da-f]{6}$/i.test(color||''))color=map.colors.neutral;for(const m of meshes)m.material.color.set(color);}schedule();}
  function highlight(){if(!entry||!map)return;const colors={};for(const id of Object.keys(entry.primary))colors[id]=map.colors.primary;for(const id of Object.keys(entry.secondary))if(!colors[id])colors[id]=map.colors.secondary;setColors(colors);}
  function pause(){playing=false;stop();schedule();}
  function play(){if(disposed)return;playing=true;last=0;schedule();}
  function setVisible(value){visible=!!value;if(!visible)stop();else schedule();}
  function seek(seconds){if(!mixer||!Number.isFinite(seconds))return;mixer.setTime(((seconds%entry.duration)+entry.duration)%entry.duration);syncEquipment();last=0;schedule();}
  function destroy(){if(disposed)return;disposed=true;state='disposed';abort.abort();resizeObserver?.disconnect();intersectionObserver?.disconnect();events.splice(0).forEach(f=>f());release();root.remove();}
  const ready=(async()=>{
    try{
      notify('loading','3D 운동을 준비하고 있습니다');
      const json=async path=>{const r=await fetch(new URL(path,baseURL),{signal:abort.signal});if(!r.ok)throw new Error('Data HTTP '+r.status);return r.json();};
      const [manifest,mapping]=await Promise.all([json('data/exercise-preview-map.json'),json('data/animation-muscle-map.json')]);
      if(disposed)return;
      map=mapping;entry=manifest.exercises[options.exerciseId];
      if(!entry){notify('unavailable','이 운동은 3D 미리보기가 없습니다');return;}
      if(map.schemaVersion!=='1.0.0'||map.mappings.length!==20)throw new Error('Invalid muscle mapping');
      const [three,loader]=await Promise.all([import('./vendor/three/three.module.min.js'),import('./vendor/three/addons/loaders/GLTFLoader.js')]);T=three;if(disposed)return;
      const res=await fetch(new URL(options.modelURL||entry.src,baseURL),{signal:abort.signal});if(!res.ok)throw new Error('Model HTTP '+res.status);const buffer=await res.arrayBuffer();
      const dv=new DataView(buffer);if(dv.getUint32(0,true)!==0x46546c67||dv.getUint32(4,true)!==2)throw new Error('Invalid GLB');
      const header=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,dv.getUint32(12,true))));if(header.buffers?.some(x=>x.uri)||header.images?.some(x=>x.uri))throw new Error('External resource forbidden');
      const gltf=await new loader.GLTFLoader().parseAsync(buffer,baseURL.href);if(disposed){disposeModel(gltf.scene);return;}
      model=gltf.scene;scene=new T.Scene();scene.background=new T.Color('#101c29');scene.add(model);
      bindings=new Map();const materials=new Map();
      for(const m of map.mappings){if(bindings.has(m.muscleId))throw new Error('Duplicate muscle');const nodes=m.nodeNames.map(n=>model.getObjectByName(n));if(!nodes.length||nodes.some(n=>!n?.isSkinnedMesh||n.userData.muscleId!==m.muscleId))throw new Error('Missing skinned muscle '+m.muscleId);for(const n of nodes){if(materials.has(n.material)&&materials.get(n.material)!==m.muscleId)throw new Error('Shared material');materials.set(n.material,m.muscleId);}bindings.set(m.muscleId,nodes);}
      model.traverse(n=>{if(n.isSkinnedMesh)n.frustumCulled=false;});
      const clip=gltf.animations.find(c=>c.name===entry.clip);if(!clip)throw new Error('Animation missing');
      mixer=new T.AnimationMixer(model);action=mixer.clipAction(clip);action.setLoop(T.LoopRepeat,Infinity).play();mixer.setTime(0);
      gripL=model.getObjectByName('grip_L');gripR=model.getObjectByName('grip_R');equipL=model.getObjectByName(entry.equipmentNodes[0]);equipR=entry.equipmentNodes[1]?model.getObjectByName(entry.equipmentNodes[1]):null;cable=model.getObjectByName('cable_dynamic');
      if(!gripL||!gripR||!equipL)throw new Error('Missing grip/equipment');
      endpoint=new T.Vector3();mid=new T.Vector3();dir=new T.Vector3();quat=new T.Quaternion();up=new T.Vector3(0,1,0);pulley=new T.Vector3(0,.16,.97);
      renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.NoToneMapping;
      const canvas=renderer.domElement;canvas.style.cssText='display:block;width:100%;height:100%;';root.prepend(canvas);
      on(canvas,'webglcontextlost',e=>{e.preventDefault();if(state==='ready')fail(new Error('WebGL context lost'));});
      camera=new T.OrthographicCamera(-1,1,1,-1,.01,20);scene.add(new T.HemisphereLight(0xdceeff,0x718496,2.2));const key=new T.DirectionalLight(0xffffff,2.3);key.position.set(3,4,5);scene.add(key);const fill=new T.DirectionalLight(0x99d7ed,1);fill.position.set(-3,2,-2);scene.add(fill);
      const floor=new T.Mesh(new T.CircleGeometry(.78,64),new T.MeshBasicMaterial({color:'#1c2c3b'}));floor.rotation.x=-Math.PI/2;floor.position.y=-.012;scene.add(floor);
      highlight();view(entry.exerciseId==='cable_curl'?1.00:.35);resize();
      resizeObserver=new ResizeObserver(resize);resizeObserver.observe(root);
      intersectionObserver=new IntersectionObserver(es=>{intersecting=es[0].isIntersecting;if(intersecting)schedule();else stop();});intersectionObserver.observe(root);
      on(document,'visibilitychange',()=>{if(document.hidden)stop();else schedule();});
      let gesture=null;const pointers=new Set();
      on(root,'pointerdown',e=>{pointers.add(e.pointerId);if(pointers.size!==1){gesture=null;return;}gesture={id:e.pointerId,x:e.clientX,y:e.clientY,yaw,lock:null};});
      on(root,'pointermove',e=>{if(!gesture||gesture.id!==e.pointerId||pointers.size!==1)return;const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;if(!gesture.lock&&Math.max(Math.abs(dx),Math.abs(dy))>7){gesture.lock=Math.abs(dx)>Math.abs(dy)?'x':'y';if(gesture.lock==='x')root.setPointerCapture(e.pointerId);}if(gesture.lock==='x')view(gesture.yaw+dx*.009);});
      const end=e=>{pointers.delete(e.pointerId);if(gesture?.id===e.pointerId)gesture=null;};on(root,'pointerup',end);on(root,'pointercancel',end);on(root,'pointerleave',e=>{if(!root.hasPointerCapture(e.pointerId))end(e);});on(root,'lostpointercapture',e=>{if(e.target===root)end(e);});
      on(root,'keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();view(yaw+(e.key==='ArrowRight'?.15:-.15));}});
      notify('ready','일반적인 운동 동작 · 주요 운동 부위');schedule();
    }catch(e){fail(e);}
    return controller;
  })();
  function diagnostics(){
    const colors={};bindings?.forEach((ns,id)=>colors[id]=ns[0].material.color.getHexString());
    const grips={};if(model){model.updateMatrixWorld(true);for(const n of ['grip_L','grip_R',...(entry?.equipmentNodes||[]),'cable_dynamic']){const o=model.getObjectByName(n);if(o)grips[n]={position:o.getWorldPosition(new T.Vector3()).toArray(),quaternion:o.getWorldQuaternion(new T.Quaternion()).toArray(),scale:o.scale.toArray()};}}
    return {state,reason,exerciseId:options.exerciseId,playing,visible,intersecting,framePending:!!frame,renderCount:renders,time:action?.time||0,yaw,listenerCount:events.length,colors,grips,geometryCount:renderer?.info.memory.geometries||0,textures:renderer?.info.memory.textures||0,drawCalls:renderer?.info.render.calls||0,triangles:renderer?.info.render.triangles||0};
  }
  const controller={ready,play,pause,seek,setVisible,setColors,highlight,setAngle:view,destroy,getDiagnostics:diagnostics};return controller;
}
