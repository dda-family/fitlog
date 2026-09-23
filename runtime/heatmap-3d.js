import {bindMuscles,applyMuscleColors,normalizedColors} from './muscle-bindings.js';
import {createSVGFallback} from './svg-fallback.js';
/** Static ES module, no build step. create -> ready -> setColors/setVisible -> destroy. */
export function createHeatmap3D(container,options={}){
  if(!(container instanceof HTMLElement))throw new TypeError('A container element is required');
  const baseURL=new URL(options.baseURL||'../',import.meta.url);
  const abort=new AbortController();const signal=abort.signal;
  let generation=0;const bootGeneration=0;
  let state='loading',disposed=false,visible=true,inViewport=true,angle=0,raf=0,renderCount=0;
  let renderer=null,scene=null,camera=null,model=null,bindings=null,fallback=null,THREE=null;
  let muscleIds=[],colors={},rawColors=options.colors||{},failureReason=null,resizeObserver=null,intersectionObserver=null;
  let width=0,height=0,halfHeight=1,radius=.5,pointer=null,pointers=new Set(),initialMetrics=null,contextCanvas=null;
  colors=normalizedColors(rawColors,Object.keys(rawColors));
  const cleanups=[];const started=performance.now();
  const stage=document.createElement('div');stage.className='fitlog-anatomy-stage';stage.tabIndex=0;stage.setAttribute('role','img');stage.setAttribute('aria-label','근육별 상대 운동량 인체. 좌우 드래그 또는 화살표 키로 회전');
  stage.style.cssText='width:100%;height:100%;min-height:260px;position:relative;touch-action:pan-y pinch-zoom;outline-offset:4px;';
  container.replaceChildren(stage);
  const notify=()=>{try{options.onStatus?.({state,reason:failureReason});}catch(error){console.error(error);}};
  const listen=(target,type,fn,opts)=>{target.addEventListener(type,fn,opts);cleanups.push(()=>target.removeEventListener(type,fn,opts));};
  const cancelFrame=()=>{if(raf)cancelAnimationFrame(raf);raf=0;};
  const canRender=()=>!disposed&&state==='3d'&&visible&&inViewport&&!document.hidden;
  function render(){raf=0;if(!canRender())return;try{renderer.render(scene,camera);renderCount++;}catch(error){void useFallback('render-error',error);}}
  function invalidate(){if(canRender()&&!raf)raf=requestAnimationFrame(render);}
  function disposeScene(root){if(!root)return;const gs=new Set(),ms=new Set(),ts=new Set();root.traverse(n=>{if(n.geometry)gs.add(n.geometry);for(const m of Array.isArray(n.material)?n.material:[n.material])if(m){ms.add(m);for(const v of Object.values(m))if(v?.isTexture)ts.add(v);}});for(const x of gs)x.dispose();for(const x of ts)x.dispose();for(const x of ms)x.dispose();}
  function releaseGPU(){cancelFrame();if(contextCanvas){contextCanvas.removeEventListener('webglcontextlost',onContextLost);contextCanvas=null;}disposeScene(model);model=null;bindings=null;scene=null;camera=null;if(renderer){renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();renderer=null;}}
  function onContextLost(event){event.preventDefault();void useFallback('context-lost');}
  async function useFallback(reason,error){
    if(disposed||state==='svg'||state==='fallback-loading'||state==='unavailable')return;
    generation++;state='fallback-loading';failureReason=reason;releaseGPU();notify();
    try{
      const f=await createSVGFallback(stage,{baseURL,colors,signal,onView:label=>{try{options.onView?.(label);}catch{}}});
      if(disposed){f.destroy();return;}
      fallback=f;fallback.setColors(colors);fallback.setAngle(angle);state='svg';notify();
    }catch(e){if(disposed)return;stage.textContent='인체 자산을 불러올 수 없습니다. 운동 기록은 그대로 유지됩니다.';state='unavailable';notify();}
    if(options.debug&&error)console.warn('Fitlog 3D fallback:',reason,error);
  }
  function resize(){
    if(!renderer||!camera||disposed)return;
    const rect=stage.getBoundingClientRect();width=Math.max(1,rect.width);height=Math.max(1,rect.height);
    renderer.setPixelRatio(Math.min(1.5,window.devicePixelRatio||1));renderer.setSize(width,height,false);
    const aspect=width/height;const h=Math.max(halfHeight*1.12,radius/aspect*1.15);
    camera.left=-h*aspect;camera.right=h*aspect;camera.top=h;camera.bottom=-h;camera.updateProjectionMatrix();invalidate();
  }
  function setAngle(rad){if(disposed||!Number.isFinite(rad))return;angle=rad%(Math.PI*2);if(model)model.rotation.y=angle;fallback?.setAngle(angle);invalidate();}
  function resetPointer(){if(pointer&&stage.hasPointerCapture?.(pointer.id))stage.releasePointerCapture(pointer.id);pointer=null;}
  listen(stage,'pointerdown',event=>{pointers.add(event.pointerId);if(pointers.size!==1||!event.isPrimary||(event.pointerType==='mouse'&&event.button!==0)){resetPointer();return;}pointer={id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,startAngle:angle,lock:null};},{passive:true});
  listen(stage,'pointermove',event=>{
    if(!pointer||pointer.id!==event.pointerId||pointers.size!==1)return;
    const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
    if(!pointer.lock){if(Math.max(Math.abs(dx),Math.abs(dy))<6)return;pointer.lock=Math.abs(dx)>Math.abs(dy)*1.2?'horizontal':'vertical';if(pointer.lock==='horizontal')stage.setPointerCapture?.(event.pointerId);}
    if(pointer.lock!=='horizontal')return;
    if(event.cancelable)event.preventDefault();
    if(state==='3d')setAngle(pointer.startAngle+dx/Math.max(stage.clientWidth,1)*Math.PI*2);
    pointer.lastX=event.clientX;
  },{passive:false});
  function endPointer(event){if(pointer?.id===event.pointerId){if(state==='svg'&&pointer.lock==='horizontal'){const dx=event.clientX-pointer.x;if(Math.abs(dx)>35)fallback?.step(dx<0?1:-1);}resetPointer();}pointers.delete(event.pointerId);}
  listen(window,'pointerup',endPointer,{passive:true});
  listen(window,'pointercancel',event=>{if(pointer?.id===event.pointerId)resetPointer();pointers.delete(event.pointerId);},{passive:true});
  listen(stage,'lostpointercapture',event=>{if(event.target===stage)pointer=null;},{passive:true});
  listen(stage,'keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();if(state==='svg')fallback?.step(event.key==='ArrowRight'?1:-1);else setAngle(angle+(event.key==='ArrowRight'?1:-1)*Math.PI/12);}});
  listen(document,'visibilitychange',()=>{if(document.hidden){cancelFrame();resetPointer();pointers.clear();}else invalidate();});
  resizeObserver=new ResizeObserver(resize);resizeObserver.observe(stage);
  if('IntersectionObserver'in window){intersectionObserver=new IntersectionObserver(entries=>{inViewport=entries[0].isIntersecting;if(inViewport)invalidate();else cancelFrame();});intersectionObserver.observe(stage);}
  const api={
    ready:null,
    setColors(input){if(disposed)return;rawColors=input||{};colors=normalizedColors(rawColors,muscleIds.length?muscleIds:Object.keys(rawColors));if(bindings)applyMuscleColors(bindings,colors);fallback?.setColors(colors);invalidate();},
    setAngle,
    showFront(){setAngle(0);},showBack(){setAngle(Math.PI);},
    setVisible(value){visible=!!value;if(!visible){cancelFrame();resetPointer();pointers.clear();}else{resize();invalidate();}},
    async useFallback(reason='manual'){await useFallback(reason);},
    destroy(){if(disposed)return;disposed=true;state='destroyed';abort.abort();resetPointer();pointers.clear();resizeObserver?.disconnect();intersectionObserver?.disconnect();for(const fn of cleanups)fn();cleanups.length=0;fallback?.destroy();fallback=null;releaseGPU();container.replaceChildren();notify();},
    getDiagnostics(){return {state,reason:failureReason,angle,renderCount,pendingFrame:!!raf,meshCount:initialMetrics?.meshCount||0,geometryCount:renderer?.info.memory.geometries||0,textureCount:renderer?.info.memory.textures||0,drawCalls:renderer?.info.render.calls||0,triangles:renderer?.info.render.triangles||0,loadMilliseconds:initialMetrics?.loadMilliseconds??null,listenerCount:cleanups.length,dimensions:{width,height},colors:{...colors},materials:bindings?Object.fromEntries([...bindings].map(([id,nodes])=>[id,nodes.map(n=>'#'+n.material.color.getHexString())])):{}};}
  };
  api.ready=(async()=>{
    try{
      const rr=await fetch(new URL('data/muscle-regions.json',baseURL),{signal});if(!rr.ok)throw new Error('Region data unavailable');
      const regions=await rr.json();muscleIds=regions.regions.map(m=>m.id);api.setColors(rawColors);
      if(options.forceFallback){await useFallback('requested-fallback');return api;}
      const [three,loaderModule]=await Promise.all([import('./vendor/three/three.module.min.js'),import('./vendor/three/addons/loaders/GLTFLoader.js')]);
      if(disposed||bootGeneration!==generation)return api;THREE=three;
      renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});
      renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;renderer.setClearColor(0x000000,0);
      contextCanvas=renderer.domElement;contextCanvas.style.cssText='display:block;width:100%;height:100%;';contextCanvas.addEventListener('webglcontextlost',onContextLost);stage.appendChild(contextCanvas);
      const [mr,gr]=await Promise.all([fetch(new URL('data/anatomy-3d-map.json',baseURL),{signal}),fetch(new URL(options.modelURL||'assets/anatomy/human_3d.glb',baseURL),{signal})]);
      if(!mr.ok||!gr.ok)throw new Error('Model or mapping HTTP failure');
      const map=await mr.json();const buffer=await gr.arrayBuffer();if(disposed||bootGeneration!==generation)return api;
      // This authoring format has no textures, extensions, decoders or external buffers.
      const header=new DataView(buffer);if(buffer.byteLength<20||header.getUint32(0,true)!==0x46546c67||header.getUint32(4,true)!==2)throw new Error('Not a GLB 2.0 file');
      const doc=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,header.getUint32(12,true))));
      if(doc.asset?.version!=='2.0'||doc.extras?.packageVersion!=='2.0.0'||doc.images?.length||doc.textures?.length||doc.extensionsRequired?.length||doc.buffers?.some(b=>b.uri))throw new Error('Unsupported external model resources');
      const gltf=await new loaderModule.GLTFLoader().parseAsync(buffer,baseURL.href);
      if(disposed||bootGeneration!==generation){disposeScene(gltf.scene);return api;}
      model=gltf.scene;bindings=bindMuscles(model,map,muscleIds);
      model.traverse(n=>{if(n.isMesh){if(!n.userData.muscleId)n.material.color.set('#303d48');n.material.roughness=1;n.material.metalness=0;n.material.toneMapped=false;}});
      scene=new THREE.Scene();const group=new THREE.Group();scene.add(group);
      const box=new THREE.Box3().setFromObject(model);const size=box.getSize(new THREE.Vector3());const center=box.getCenter(new THREE.Vector3());
      // Keep pivot on vertical body axis; symmetric x is zero. z extents include toes, not a camera shift.
      halfHeight=size.y/2;radius=Math.max(Math.abs(box.min.x),Math.abs(box.max.x),Math.abs(box.min.z),Math.abs(box.max.z));
      group.position.y=-center.y;group.add(model);model.rotation.y=angle;
      camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,20);camera.position.set(0,0,4);camera.lookAt(0,0,0);
      scene.add(new THREE.AmbientLight(0xffffff,1.8));
      const key=new THREE.DirectionalLight(0xffffff,1.7);key.position.set(-2,3,4);scene.add(key);
      const fill=new THREE.DirectionalLight(0xc6d9e7,.35);fill.position.set(2,1,-3);scene.add(fill);
      applyMuscleColors(bindings,colors);state='3d';let meshCount=0;model.traverse(n=>{if(n.isMesh)meshCount++;});
      initialMetrics={meshCount,loadMilliseconds:performance.now()-started};resize();notify();invalidate();
    }catch(error){if(!disposed)await useFallback('initialization-error',error);}
    return api;
  })();
  return api;
}
