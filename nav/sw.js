// Keeps the app itself available offline. Map tiles are cached as you view them, up to a limit.
const APP='runnav-v1', TILES='runnav-tiles';
self.addEventListener('install',e=>{ e.waitUntil(caches.open(APP).then(c=>c.addAll(['./','index.html','manifest.webmanifest','icon.svg','icon-192.png']))); self.skipWaiting(); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==APP&&k!==TILES).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch',e=>{ const u=new URL(e.request.url);
  if(u.hostname==='tile.openstreetmap.org'){ e.respondWith(caches.open(TILES).then(async c=>{ const hit=await c.match(e.request); if(hit) return hit;
      try{ const r=await fetch(e.request); if(r.ok||r.type==='opaque'){ c.put(e.request,r.clone()); c.keys().then(ks=>{ if(ks.length>1500) for(const k of ks.slice(0,ks.length-1500)) c.delete(k); }); } return r; }catch(err){ return hit||Response.error(); } })); return; }
  if(u.origin===location.origin){ e.respondWith(fetch(e.request).then(r=>{ const cp=r.clone(); caches.open(APP).then(c=>c.put(e.request,cp)); return r; }).catch(()=>caches.match(e.request).then(r=>r||caches.match('./')))); } });
