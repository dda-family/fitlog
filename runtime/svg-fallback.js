import {NEUTRAL} from './muscle-bindings.js';
const views=['front','front_oblique','side','back_oblique','back'];
const labels=['정면','정면 사선','측면','후면 사선','후면'];
let serial=0;
export async function createSVGFallback(container,{baseURL,colors,signal,onView=()=>{}}){
  const instance=++serial;
  const outcomes=await Promise.allSettled(views.map(async view=>{
    const r=await fetch(new URL(`assets/anatomy/human_${view}.svg`,baseURL),{signal});
    if(!r.ok)throw new Error('SVG HTTP '+r.status);
    const doc=new DOMParser().parseFromString(await r.text(),'image/svg+xml');
    if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg')throw new Error('Invalid SVG');
    const svg=document.importNode(doc.documentElement,true);
    // Only trusted bundled SVG assets are allowed. Reject active/external content defensively.
    if(svg.querySelector('script,foreignObject,image')||[svg,...svg.querySelectorAll('*')].some(n=>[...n.attributes].some(a=>/^on|href$/i.test(a.name))))throw new Error('Unsafe SVG');
    svg.querySelectorAll('[id]').forEach(n=>n.id=`fitlog-fallback-${instance}-${n.id}`);
    svg.style.cssText='width:100%;height:100%;display:block;';return svg;
  }));
  if(signal.aborted)throw new DOMException('Aborted','AbortError');
  const svgs=outcomes.map(o=>o.status==='fulfilled'?o.value:null);
  if(!svgs.some(Boolean))throw new Error('No cached fallback SVG');
  let index=Math.max(0,svgs.findIndex(Boolean));let disposed=false;let currentColors=colors;
  const paint=()=>{for(const svg of svgs)svg?.querySelectorAll('[data-muscle]').forEach(n=>n.setAttribute('fill',currentColors[n.dataset.muscle]||NEUTRAL));};
  const show=i=>{if(disposed)return;let next=Math.max(0,Math.min(4,i));if(!svgs[next])next=svgs.findIndex(Boolean);index=next;container.replaceChildren(svgs[index]);onView(labels[index],index);};
  paint();show(index);
  return {setColors(c){currentColors=c;paint();},setAngle(rad){const turn=((rad%(2*Math.PI))+2*Math.PI)%(2*Math.PI);show(Math.round(Math.min(turn,2*Math.PI-turn)/(Math.PI/4)));},step(delta){show(index+delta);},destroy(){disposed=true;container.replaceChildren();},get index(){return index;}};
}
