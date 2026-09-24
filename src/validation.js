export function validateTargets(targets) {
  if(!Array.isArray(targets) || targets.length !== 92) throw new Error('Expected 92 targets');
  const keys=new Set();
  for(const t of targets) {
    if(typeof t.store !== 'string' || typeof t.seller !== 'string' || !t.store.trim() || !t.seller.trim()) throw new Error('Missing store or seller');
    const key=[t.store,t.seller].map(s=>s.normalize('NFKC').replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/[\u200c\u200d\u200e\u200f]/g,' ').replace(/\s+/g,' ').trim()).join('|');
    if(keys.has(key)) throw new Error('Duplicate seller');
    keys.add(key);
    if(!['baseline','t20','t30','t40','r20','r30','r40'].every(k=>typeof t[k]==='number' && Number.isFinite(t[k]) && t[k]>0)) throw new Error('Invalid amount');
    if(!(t.baseline<t.t20 && t.t20<t.t30 && t.t30<t.t40)) throw new Error('Invalid target ladder');
    if(t.r20!==1 || t.r30!==3 || t.r40!==5) throw new Error('Invalid reward ladder');
  }
  return targets;
}
