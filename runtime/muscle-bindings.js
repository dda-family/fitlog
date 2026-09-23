// Pure validation/binding logic: no renderer, DB, workout calculations or dependencies.
export const NEUTRAL = '#46535f';
export function normalizedColors(input, muscleIds) {
  const colors=Object.create(null);
  for (const id of muscleIds) {
    const value=input?.[id];
    colors[id]=typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : NEUTRAL;
  }
  return colors;
}
export function bindMuscles(scene, map, expectedIds) {
  if(map.packageVersion!=='2.0.0'||!Array.isArray(map.mappings))throw new Error('Unsupported 3D map');
  const entries=new Map();const names=new Map();
  scene.traverse(node=>{if(node.isMesh){if(names.has(node.name))throw new Error('Duplicate mesh name');names.set(node.name,node);}});
  const actual=new Set();const assigned=new Set();
  for(const item of map.mappings){
    if(!expectedIds.includes(item.muscleId)||entries.has(item.muscleId)||!Array.isArray(item.nodeNames)||!item.nodeNames.length)throw new Error('Invalid muscle mapping');
    const list=item.nodeNames.map(name=>{
      const node=names.get(name);
      if(!node||assigned.has(name)||node.userData.muscleId!==item.muscleId||Array.isArray(node.material)||!node.material?.color)throw new Error('Missing or mismatched muscle mesh');
      assigned.add(name);return node;
    });
    entries.set(item.muscleId,list);actual.add(item.muscleId);
  }
  if(actual.size!==expectedIds.length||expectedIds.some(id=>!actual.has(id)))throw new Error('Incomplete muscle coverage');
  for(const node of names.values())if(node.userData.muscleId && !assigned.has(node.name))throw new Error('Unmapped muscle mesh');
  // Any material shared across different logical regions would make independent recoloring unsafe.
  const materials=new Map();
  for(const [id,nodes]of entries)for(const node of nodes){
    const owner=materials.get(node.material);if(owner&&owner!==id)throw new Error('Shared muscle material');materials.set(node.material,id);
  }
  for(const node of names.values())if(!node.userData.muscleId&&materials.has(node.material))throw new Error('Body shares muscle material');
  return entries;
}
export function applyMuscleColors(bindings, colors) {
  for(const [id,nodes]of bindings)for(const node of nodes)node.material.color.set(colors[id] || NEUTRAL);
}
