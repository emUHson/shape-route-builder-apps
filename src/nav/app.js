'use strict';
/* Run Nav — turn-by-turn for a shared running route. No build step, no dependencies besides the QR encoder.
   A route arrives in the link (#r=…, compressed JSON) or as a GPX file. */
const $=id=>document.getElementById(id);
const FT=0.3048, MI=1609.344;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const store={get(k,d){ try{ const v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } }, set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }};
function toast(t,ms=3200){ const el=$('toast'); el.textContent=t; el.hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>el.hidden=true,ms); }

/* ---------------- route encoding ---------------- */
// Polyline (Google algorithm, 1e-5 degrees) for points; the rest is plain JSON. Whole payload deflated + base64url.
function encPoly(pts){ let out='',pa=0,po=0; const enc=v=>{ v=v<0?~(v<<1):v<<1; let s=''; while(v>=0x20){ s+=String.fromCharCode((0x20|(v&0x1f))+63); v>>=5; } return s+String.fromCharCode(v+63); };
  for(const [la,lo] of pts){ const a=Math.round(la*1e5), o=Math.round(lo*1e5); out+=enc(a-pa)+enc(o-po); pa=a; po=o; } return out; }
function decPoly(s){ const pts=[]; let i=0,la=0,lo=0; const dec=()=>{ let r=0,sh=0,b; do{ b=s.charCodeAt(i++)-63; r|=(b&0x1f)<<sh; sh+=5; }while(b>=0x20); return r&1?~(r>>1):r>>1; };
  while(i<s.length){ la+=dec(); lo+=dec(); pts.push([la/1e5,lo/1e5]); } return pts; }
const b64u={ enc(bytes){ let s=''; for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); },
  dec(str){ str=str.replace(/-/g,'+').replace(/_/g,'/'); while(str.length%4) str+='='; const s=atob(str), b=new Uint8Array(s.length); for(let i=0;i<s.length;i++) b[i]=s.charCodeAt(i); return b; } };
async function inflate(bytes){ const ds=new DecompressionStream('deflate-raw'); const r=new Response(new Blob([bytes]).stream().pipeThrough(ds)); return new Uint8Array(await r.arrayBuffer()); }
async function deflate(bytes){ const cs=new CompressionStream('deflate-raw'); const r=new Response(new Blob([bytes]).stream().pipeThrough(cs)); return new Uint8Array(await r.arrayBuffer()); }
async function routeFromHash(h){ const m=/[#&]r=([A-Za-z0-9_-]+)/.exec(h); if(!m) return null;
  const json=new TextDecoder().decode(await inflate(b64u.dec(m[1]))); const o=JSON.parse(json);
  return {name:o.n||'Route',pts:decPoly(o.p),cues:(o.c||[]).map(c=>({i:c[0],k:c[1],onto:c[2]||'',where:c[3]||''})),loop:!!o.l,shape:o.s||''}; }
async function hashFromRoute(R){ const o={v:1,n:R.name,p:encPoly(R.pts),c:R.cues.map(c=>[c.i,c.k,c.onto,c.where].map(v=>v===''?undefined:v)),l:R.loop?1:0};
  if(R.shape) o.s=R.shape; return 'r='+b64u.enc(await deflate(new TextEncoder().encode(JSON.stringify(o)))); }

/* ---------------- GPX ---------------- */
function parseGpx(text,fname){
  const doc=new DOMParser().parseFromString(text,'application/xml'); if(doc.querySelector('parsererror')) throw new Error('That file is not valid GPX.');
  let nodes=[...doc.getElementsByTagName('trkpt')]; if(!nodes.length) nodes=[...doc.getElementsByTagName('rtept')];
  const pts=nodes.map(n=>[+n.getAttribute('lat'),+n.getAttribute('lon')]).filter(p=>isFinite(p[0])&&isFinite(p[1]));
  if(pts.length<2) throw new Error('No track found in that GPX file.');
  const nm=(doc.querySelector('trk > name')||doc.querySelector('metadata > name')||doc.querySelector('rte > name'));
  const wpts=[...doc.getElementsByTagName('wpt')].map(w=>({lat:+w.getAttribute('lat'),lon:+w.getAttribute('lon'),name:(w.querySelector('name')||{}).textContent||'',type:(w.querySelector('type')||{}).textContent||'',desc:(w.querySelector('desc')||{}).textContent||''}));
  return {name:(nm&&nm.textContent.trim())||(fname||'Route').replace(/\.gpx$/i,''),pts,wpts,cues:null};
}

/* ---------------- geometry (local metres around the route) ---------------- */
let PROJ={lat0:45.5,lon0:-122.6,kx:1,ky:1};
function setProj(pts){ let la=0,lo=0; for(const p of pts){ la+=p[0]; lo+=p[1]; } la/=pts.length; lo/=pts.length;
  PROJ={lat0:la,lon0:lo,ky:111320,kx:111320*Math.cos(la*Math.PI/180)}; }
const toXY=(la,lo)=>[(lo-PROJ.lon0)*PROJ.kx,(la-PROJ.lat0)*PROJ.ky];
const angDiff=(a,b)=>{ let d=(b-a)*180/Math.PI; while(d>180) d-=360; while(d<=-180) d+=360; return d; };
function turnOf(d){ const a=Math.abs(d), side=d>0?'L':'R', w=d>0?'left':'right';
  if(a<20) return {k:'S',txt:'Continue'}; if(a<50) return {k:'B'+side,txt:'Bear '+w}; if(a<135) return {k:'T'+side,txt:'Turn '+w}; if(a<165) return {k:'X'+side,txt:'Sharp '+w}; return {k:'U',txt:'U-turn'}; }
const TXT={S:'Continue',BL:'Bear left',BR:'Bear right',TL:'Turn left',TR:'Turn right',XL:'Sharp left',XR:'Sharp right',U:'Make a U-turn',START:'Start',END:'Finish'};
const COMPASS=h=>['east','northeast','north','northwest','west','southwest','south','southeast'][((Math.round(h/(Math.PI/4))%8)+8)%8];
function dpKeep(P,tol){ const keep=new Uint8Array(P.length); keep[0]=keep[P.length-1]=1; const st=[[0,P.length-1]];
  while(st.length){ const [a,b]=st.pop(); let md=0,mi=-1; const [ax,ay]=P[a],[bx,by]=P[b], L=Math.hypot(bx-ax,by-ay)||1e-9;
    for(let i=a+1;i<b;i++){ const d=Math.abs((bx-ax)*(ay-P[i][1])-(ax-P[i][0])*(by-ay))/L; if(d>md){ md=d; mi=i; } }
    if(md>tol){ keep[mi]=1; st.push([a,mi],[mi,b]); } }
  return keep; }

/* the loaded route, prepared for navigation */
const R={name:'',ll:[],xy:[],cum:[],total:0,cues:[],loop:false,raw:null};
function prepare(src){
  R.name=src.name; R.ll=src.pts; setProj(R.ll); R.xy=R.ll.map(p=>toXY(p[0],p[1])); R.cum=[0];
  const e0=R.xy[0], e1=R.xy[R.xy.length-1]; R.loop=src.loop!=null&&src.loop!==false?!!src.loop:Math.hypot(e0[0]-e1[0],e0[1]-e1[1])<60;
  for(let i=1;i<R.xy.length;i++) R.cum.push(R.cum[i-1]+Math.hypot(R.xy[i][0]-R.xy[i-1][0],R.xy[i][1]-R.xy[i-1][1]));
  R.total=R.cum[R.cum.length-1];
  if(src.cues&&src.cues.length){ R.cues=src.cues.map(c=>({...c,s:R.cum[clamp(c.i,0,R.cum.length-1)]})); }
  else if(src.wpts&&src.wpts.some(w=>/^(START|END|S|BL|BR|TL|TR|XL|XR|U)$/.test(w.type))){
    // cue waypoints from Shape Route Builder: match each one, in order, to the route
    let from=0; R.cues=[];
    for(const w of src.wpts){ if(!w.type) continue; const [x,y]=toXY(w.lat,w.lon); let bi=from,bd=1e18;
      for(let i=from;i<R.xy.length;i++){ const d=Math.hypot(R.xy[i][0]-x,R.xy[i][1]-y); if(d<bd){ bd=d; bi=i; } if(d<3) break; }
      if(w.type==='END') bi=R.xy.length-1;
      const onto=(w.name.match(/(?:onto|on|stay on) (.+?)(?:,|$)/)||[])[1]||'';
      R.cues.push({i:bi,k:w.type,onto,where:w.desc,s:R.cum[bi],label:w.name}); from=bi; } }
  else R.cues=deriveCues();
  if(!R.cues.length||R.cues[0].k!=='START') R.cues.unshift({i:0,k:'START',onto:'',where:'',s:0});
  if(R.cues[R.cues.length-1].k!=='END') R.cues.push({i:R.xy.length-1,k:'END',onto:'',where:'',s:R.total});
  R.startHead=headAlong(0);
}
// turns worked out from the track's shape (for GPX files without named cues)
function deriveCues(){ const keep=dpKeep(R.xy,6), idx=[]; for(let i=0;i<R.xy.length;i++) if(keep[i]) idx.push(i);
  const cues=[]; for(let j=1;j<idx.length-1;j++){ const a=R.xy[idx[j-1]], b=R.xy[idx[j]], c=R.xy[idx[j+1]];
    const d=angDiff(Math.atan2(b[1]-a[1],b[0]-a[0]),Math.atan2(c[1]-b[1],c[0]-b[0])); if(Math.abs(d)<30) continue;
    const s=R.cum[idx[j]]; if(cues.length&&s-cues[cues.length-1].s<15) continue; cues.push({i:idx[j],k:turnOf(d).k,onto:'',where:'',s}); }
  return cues; }
function pointAt(s){ s=clamp(s,0,R.total); let lo=0,hi=R.cum.length-1; while(hi-lo>1){ const m=(lo+hi)>>1; if(R.cum[m]<=s) lo=m; else hi=m; }
  const t=(s-R.cum[lo])/((R.cum[hi]-R.cum[lo])||1); return [R.xy[lo][0]+(R.xy[hi][0]-R.xy[lo][0])*t, R.xy[lo][1]+(R.xy[hi][1]-R.xy[lo][1])*t]; }
function headAlong(s){ const a=pointAt(s), b=pointAt(s+25); return Math.atan2(b[1]-a[1],b[0]-a[0]); }
function cueText(c){ if(c.label&&c.k!=='START'&&c.k!=='END') return c.label;
  if(c.k==='START') return c.onto?`Head ${COMPASS(R.startHead)} on ${c.onto}`:`Head ${COMPASS(R.startHead)}`;
  if(c.k==='END') return R.loop?'Finish back at the start':'Finish';
  return (TXT[c.k]||'Continue')+(c.onto?` onto ${c.onto}`:''); }
function cueShort(c){ return c.k==='END'?'Finish':(TXT[c.k]||'Continue')+(c.onto?` onto ${c.onto.replace(/^(N|S|NE|NW|SE|SW|E|W) /,'')}`:''); }

/* ---------------- arrows ---------------- */
function arrowSvg(k){ const S='fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';
  const head=(tx,ty,fx,fy)=>{ const a=Math.atan2(fy-ty,fx-tx), s=5.5; return `<path d="M${tx} ${ty}L${(tx+s*Math.cos(a+.55)).toFixed(1)} ${(ty+s*Math.sin(a+.55)).toFixed(1)}M${tx} ${ty}L${(tx+s*Math.cos(a-.55)).toFixed(1)} ${(ty+s*Math.sin(a-.55)).toFixed(1)}" ${S}/>`; };
  const line=(pts)=>`<path d="${pts.map((p,i)=>(i?'L':'M')+p[0]+' '+p[1]).join('')}" ${S}/>`+head(...pts[pts.length-1],...pts[pts.length-2]);
  const g=(k==='TR'||k==='BR'||k==='XR')?1:-1; let body='';
  if(k==='S') body=line([[12,21],[12,3]]);
  else if(k==='TL'||k==='TR') body=line([[12,21],[12,11],[12+g*9,11]]);
  else if(k==='BL'||k==='BR') body=line([[12,21],[12,13],[12+g*7,5]]);
  else if(k==='XL'||k==='XR') body=line([[12,21],[12,6],[12+g*7,15]]);
  else if(k==='U') body=`<path d="M8 21V10a5 5 0 0110 0v6" ${S}/>`+head(18,17,18,11);
  else if(k==='START') body=`<circle cx="12" cy="12" r="6" fill="currentColor"/>`;
  else if(k==='END') body=`<path d="M6 21V3" ${S}/><path d="M6 4h12l-3 4 3 4H6" fill="currentColor"/>`;
  else if(k==='OFF') body=`<circle cx="12" cy="12" r="9" ${S}/><path d="M12 7v6M12 16.5v.5" ${S}/>`;
  return `<svg viewBox="0 0 24 24" width="100%" height="100%">${body}</svg>`; }
const fmtDist=m=>{ const f=m/FT; if(f<1000) return [String(Math.max(0,Math.round(f/10)*10)),'ft']; return [(m/MI).toFixed(m<16*MI?2:1),'mi']; };
const sayDist=m=>{ const f=m/FT; if(f<1000) return `${Math.round(f/50)*50||50} feet`; const mi=m/MI; return mi<1.05&&mi>0.95?'1 mile':`${mi.toFixed(1)} miles`; };
const fmtTime=s=>{ s=Math.max(0,Math.round(s)); const h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60; return h?`${h}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`:`${m}:${String(x).padStart(2,'0')}`; };

/* ---------------- map: OSM raster tiles + canvas overlay ---------------- */
const MAP={lat:45.52,lon:-122.65,zf:16,rot:0,W:0,H:0,dpr:1,follow:true,headUp:false};
const lon2x=(lo,z)=>(lo+180)/360*256*2**z, lat2y=(la,z)=>{ const r=la*Math.PI/180; return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*256*2**z; };
const x2lon=(x,z)=>x/(256*2**z)*360-180, y2lat=(y,z)=>{ const n=Math.PI-2*Math.PI*y/(256*2**z); return 180/Math.PI*Math.atan(Math.sinh(n)); };
const tileEls=new Map(); const tilesEl=$('tiles'), ov=$('ov'), octx=ov.getContext('2d');
function resize(){ MAP.W=innerWidth; MAP.H=innerHeight; MAP.dpr=Math.min(3,devicePixelRatio||1); ov.width=MAP.W*MAP.dpr; ov.height=MAP.H*MAP.dpr; ov.style.width=MAP.W+'px'; ov.style.height=MAP.H+'px'; draw(); }
// the point the map centres on sits lower on screen while navigating, so you see more of what's ahead
const focusY=()=>NAV.on&&MAP.follow?MAP.H*0.62:MAP.H/2;
function screenOf(la,lo){ const z=Math.round(MAP.zf), sc=2**(MAP.zf-z), cx=lon2x(MAP.lon,z), cy=lat2y(MAP.lat,z);
  const dx=(lon2x(lo,z)-cx)*sc, dy=(lat2y(la,z)-cy)*sc, c=Math.cos(MAP.rot), s=Math.sin(MAP.rot);
  return [MAP.W/2+dx*c-dy*s, focusY()+dx*s+dy*c]; }
function draw(){ drawTiles(); drawOverlay(); }
function drawTiles(){
  const z=clamp(Math.round(MAP.zf),3,19), sc=2**(MAP.zf-z), cx=lon2x(MAP.lon,z), cy=lat2y(MAP.lat,z), fy=focusY();
  tilesEl.style.transform=`translate(${MAP.W/2}px,${fy}px) rotate(${MAP.rot}rad) scale(${sc})`;
  const rad=Math.hypot(MAP.W,MAP.H)/sc*0.75+256, n=2**z, t0x=Math.floor((cx-rad)/256), t1x=Math.floor((cx+rad)/256), t0y=Math.max(0,Math.floor((cy-rad)/256)), t1y=Math.min(n-1,Math.floor((cy+rad)/256));
  const want=new Set();
  for(let ty=t0y;ty<=t1y;ty++) for(let tx=t0x;tx<=t1x;tx++){ const wx=((tx%n)+n)%n, key=z+'/'+wx+'/'+ty; want.add(key);
    let im=tileEls.get(key); if(!im){ im=new Image(); im.decoding='async'; im.alt=''; im.onerror=()=>{ im.style.visibility='hidden'; }; im.src=`https://tile.openstreetmap.org/${z}/${wx}/${ty}.png`; im.dataset.z=z; im.dataset.tx=tx; im.dataset.ty=ty; tilesEl.appendChild(im); tileEls.set(key,im); }
    im.style.left=(tx*256-cx)+'px'; im.style.top=(ty*256-cy)+'px'; }
  for(const [k,im] of tileEls) if(!want.has(k)){ im.remove(); tileEls.delete(k); } }
function drawOverlay(){
  const c=octx, d=MAP.dpr; c.setTransform(d,0,0,d,0,0); c.clearRect(0,0,MAP.W,MAP.H);
  if(!R.ll.length) return;
  const P=R.ll.map(p=>screenOf(p[0],p[1])), prog=NAV.s??0, lw=clamp(2**(MAP.zf-16)*7,4,11);
  const path=(from,to)=>{ c.beginPath(); let started=false; for(let i=0;i<P.length;i++){ if(R.cum[i]<from-1e-6&&i<P.length-1&&R.cum[i+1]<from) continue; if(R.cum[i]>to&&started){ const q=screenOf(...llAt(to)); c.lineTo(q[0],q[1]); break; }
      if(!started){ const q=R.cum[i]<from?screenOf(...llAt(from)):P[i]; c.moveTo(q[0],q[1]); started=true; if(R.cum[i]<from) continue; } c.lineTo(P[i][0],P[i][1]); } };
  c.lineCap='round'; c.lineJoin='round';
  // run part dimmed, rest bright with a glow
  if(NAV.s!=null&&prog>0){ path(0,prog); c.strokeStyle='rgba(192,194,197,.35)'; c.lineWidth=lw*0.7; c.stroke(); }
  path(prog,R.total); c.save(); c.shadowColor='#00D2BE'; c.shadowBlur=14; c.strokeStyle='#00A19C'; c.lineWidth=lw+3; c.stroke(); c.restore();
  c.strokeStyle='#00D2BE'; c.lineWidth=lw; c.stroke();
  // direction chevrons every ~150 m ahead
  c.fillStyle='#000'; for(let s=prog+60;s<R.total;s+=150){ const a=screenOf(...llAt(s)), b=screenOf(...llAt(s+5)); if(a[0]<-20||a[1]<-20||a[0]>MAP.W+20||a[1]>MAP.H+20) continue;
    const an=Math.atan2(b[1]-a[1],b[0]-a[0]); c.save(); c.translate(a[0],a[1]); c.rotate(an); c.beginPath(); c.moveTo(lw*0.55,0); c.lineTo(-lw*0.4,-lw*0.45); c.lineTo(-lw*0.15,0); c.lineTo(-lw*0.4,lw*0.45); c.closePath(); c.fill(); c.restore(); }
  // next cue marker
  const nc=NAV.next; if(nc&&nc.k!=='START'){ const q=screenOf(...R.ll[nc.i]); c.beginPath(); c.arc(q[0],q[1],lw*0.9,0,7); c.fillStyle='#fff'; c.fill(); c.lineWidth=2.5; c.strokeStyle='#000'; c.stroke(); }
  // start / finish
  const s0=P[0]; c.beginPath(); c.arc(s0[0],s0[1],9,0,7); c.fillStyle='#fff'; c.fill(); c.fillStyle='#000'; c.font='700 10px system-ui'; c.textAlign='center'; c.textBaseline='middle'; c.fillText('S',s0[0],s0[1]+0.5);
  // you
  if(NAV.fix){ const q=screenOf(NAV.fix.lat,NAV.fix.lon), mpp=156543.03*Math.cos(NAV.fix.lat*Math.PI/180)/2**MAP.zf, rr=NAV.fix.acc/mpp;
    if(rr>12){ c.beginPath(); c.arc(q[0],q[1],rr,0,7); c.fillStyle='rgba(0,210,190,.10)'; c.fill(); c.strokeStyle='rgba(0,210,190,.35)'; c.lineWidth=1; c.stroke(); }
    c.save(); c.translate(q[0],q[1]);
    if(NAV.head!=null){ c.rotate(MAP.rot+(Math.PI/2-NAV.head)); c.beginPath(); c.moveTo(0,-16); c.lineTo(11,11); c.lineTo(0,5); c.lineTo(-11,11); c.closePath(); c.fillStyle='#fff'; c.shadowColor='#000'; c.shadowBlur=8; c.fill(); c.shadowBlur=0; c.strokeStyle='#000'; c.lineWidth=2; c.stroke(); }
    else { c.beginPath(); c.arc(0,0,9,0,7); c.fillStyle='#fff'; c.fill(); c.lineWidth=3; c.strokeStyle='#00A19C'; c.stroke(); }
    c.restore(); }
}
function llAt(s){ const [x,y]=pointAt(s); return [PROJ.lat0+y/PROJ.ky, PROJ.lon0+x/PROJ.kx]; }
function fitRoute(pad=60){ if(!R.ll.length) return; let a=1e9,b=-1e9,c=1e9,d=-1e9; for(const [la,lo] of R.ll){ a=Math.min(a,la); b=Math.max(b,la); c=Math.min(c,lo); d=Math.max(d,lo); }
  const top=NAV.on?170:pad, bottom=NAV.on?110:(innerHeight*0.55);
  const wpx=lon2x(d,0)-lon2x(c,0), hpx=lat2y(a,0)-lat2y(b,0), z=Math.log2(Math.min((MAP.W-2*pad)/wpx,(MAP.H-top-bottom)/hpx));
  MAP.zf=clamp(z,3,18.5); MAP.rot=0; const zz=Math.round(MAP.zf), cx=(lon2x(c,zz)+lon2x(d,zz))/2, cy=(lat2y(a,zz)+lat2y(b,zz))/2, sc=2**(MAP.zf-zz);
  // centre the box between the top and bottom bars
  const want=(top+(MAP.H-bottom))/2, fy=focusY(); MAP.lon=x2lon(cx,zz); MAP.lat=y2lat(cy-(want-fy)/sc,zz); draw(); }
// gestures: drag to pan, pinch / wheel to zoom
(()=>{ const pts=new Map(); let last=null, pinch=null;
  const el=$('map');
  el.addEventListener('pointerdown',e=>{ el.setPointerCapture(e.pointerId); pts.set(e.pointerId,[e.clientX,e.clientY]); if(pts.size===2){ const [a,b]=[...pts.values()]; pinch={d:Math.hypot(a[0]-b[0],a[1]-b[1]),z:MAP.zf}; } last=[e.clientX,e.clientY]; });
  el.addEventListener('pointermove',e=>{ if(!pts.has(e.pointerId)) return; pts.set(e.pointerId,[e.clientX,e.clientY]);
    if(pts.size===2&&pinch){ const [a,b]=[...pts.values()]; MAP.zf=clamp(pinch.z+Math.log2(Math.hypot(a[0]-b[0],a[1]-b[1])/pinch.d),3,19.5); draw(); return; }
    if(pts.size===1&&last){ const dx=e.clientX-last[0], dy=e.clientY-last[1]; if(Math.abs(dx)+Math.abs(dy)<1) return; last=[e.clientX,e.clientY];
      if(MAP.follow&&NAV.on&&Math.abs(dx)+Math.abs(dy)>2) setFollow(false);
      panBy(dx,dy); } });
  const up=e=>{ pts.delete(e.pointerId); if(pts.size<2) pinch=null; last=pts.size?[...pts.values()][0]:null; };
  el.addEventListener('pointerup',up); el.addEventListener('pointercancel',up);
  el.addEventListener('wheel',e=>{ e.preventDefault(); MAP.zf=clamp(MAP.zf-e.deltaY*0.002,3,19.5); draw(); },{passive:false}); })();
function panBy(dx,dy){ const z=Math.round(MAP.zf), sc=2**(MAP.zf-z), c=Math.cos(-MAP.rot), s=Math.sin(-MAP.rot), ux=(dx*c-dy*s)/sc, uy=(dx*s+dy*c)/sc;
  MAP.lon=x2lon(lon2x(MAP.lon,z)-ux,z); MAP.lat=y2lat(lat2y(MAP.lat,z)-uy,z); draw(); }
addEventListener('resize',resize);
$('map').addEventListener('keydown',e=>{ const k=e.key, step=80;
  if(k==='+'||k==='='){ MAP.zf=clamp(MAP.zf+0.5,3,19.5); draw(); }
  else if(k==='-'||k==='_'){ MAP.zf=clamp(MAP.zf-0.5,3,19.5); draw(); }
  else if(k.startsWith('Arrow')){ if(MAP.follow&&NAV.on) setFollow(false); panBy(k==='ArrowLeft'?step:k==='ArrowRight'?-step:0,k==='ArrowUp'?step:k==='ArrowDown'?-step:0); }
  else return; e.preventDefault(); });

/* ---------------- voice ---------------- */
const VOICE={on:store.get('rnVoice',true),miles:store.get('rnMiles',true),unlocked:false};
function say(t,urgent=false){ if(!VOICE.on||!('speechSynthesis' in window)) return; try{ if(urgent) speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(t); u.rate=1.02; u.lang='en-US'; speechSynthesis.speak(u); }catch(e){} }
function buzz(p){ try{ navigator.vibrate&&navigator.vibrate(p); }catch(e){} }

/* ---------------- navigation ---------------- */
const NAV={on:false,demo:false,s:null,fix:null,head:null,next:null,off:0,offOn:false,t0:0,watch:null,said:new Map(),mile:0,lastXY:null,done:false,offAnnounced:0};
// where on the route am I? Look near my last progress first (routes can cross or retrace themselves), else anywhere.
function project(x,y,from,to){ let best=null; for(let i=0;i<R.xy.length-1;i++){ if(R.cum[i+1]<from||R.cum[i]>to) continue;
    const [ax,ay]=R.xy[i],[bx,by]=R.xy[i+1], L2=(bx-ax)**2+(by-ay)**2||1e-9, t=clamp(((x-ax)*(bx-ax)+(y-ay)*(by-ay))/L2,0,1), px=ax+(bx-ax)*t, py=ay+(by-ay)*t, d=Math.hypot(x-px,y-py);
    if(!best||d<best.d-0.5) best={d,s:R.cum[i]+t*Math.sqrt(L2)}; }
  return best; }
function onFix(f){
  NAV.fix=f; const [x,y]=toXY(f.lat,f.lon), tol=Math.max(30,Math.min(60,f.acc*1.3));
  // heading: GPS course when moving, else from my last few metres of movement
  if(f.heading!=null&&!isNaN(f.heading)&&(f.speed||0)>0.8) NAV.head=Math.PI/2-f.heading*Math.PI/180;
  else if(NAV.lastXY&&Math.hypot(x-NAV.lastXY[0],y-NAV.lastXY[1])>6){ NAV.head=Math.atan2(y-NAV.lastXY[1],x-NAV.lastXY[0]); }
  if(!NAV.lastXY||Math.hypot(x-NAV.lastXY[0],y-NAV.lastXY[1])>6) NAV.lastXY=[x,y];
  $('gpsWarn').hidden=f.acc<=40; if(f.acc>40) $('gpsWarn').textContent=`Weak GPS (±${Math.round(f.acc/FT)} ft)`;
  if(!NAV.on){ updateAway(); draw(); return; }
  let m=null;
  if(NAV.s!=null) m=project(x,y,NAV.s-40,NAV.s+500);
  else { m=project(x,y,-1,300); }          // first fix: prefer the start (a loop's finish is in the same place)
  // Jump further along only before the run has begun, or after being off route for a while (a deliberate shortcut).
  // Otherwise brushing past another part of the route would skip you ahead.
  if((!m||m.d>tol)&&(NAV.s==null||NAV.off>=8)){ const g=project(x,y,NAV.s??-1,1e9); if(g&&g.d<=tol) m=g; }
  if(m&&m.d<=tol){
    if(NAV.s==null) NAV.s=m.s; else if(m.s>=NAV.s-30) NAV.s=Math.max(NAV.s,m.s);
    if(NAV.offOn){ NAV.offOn=false; say('Back on route.',true); }
    NAV.off=0;
  } else { NAV.off++; if(NAV.off>=2&&!NAV.offOn&&NAV.s!=null){ NAV.offOn=true; buzz([200,100,200]); say('Off route.',true); } }
  update(); }
function nearestOnRoute(x,y){ return project(x,y,-1,1e9); }
function update(){
  if(NAV.s==null){ // not on the route yet: guide to the start
    const g=NAV.fix?nearestOnRoute(...toXY(NAV.fix.lat,NAV.fix.lon)):null;
    showBanner('OFF',g?fmtDist(g.d):['',''],NAV.fix?'Head to the route':'Waiting for GPS…',NAV.fix?'The start is marked S':'Allow location access to begin',true);
    $('then').hidden=true; drawFollow(); return; }
  const s=NAV.s;
  // finished?
  if(!NAV.done&&s>=R.total-25){ NAV.done=true; say(`You've finished. ${(R.total/MI).toFixed(1)} miles in ${spokenTime((Date.now()-NAV.t0)/1000)}.`,true); buzz([300,150,300,150,300]); }
  const i=R.cues.findIndex(c=>c.s>s+6); const nc=i<0?R.cues[R.cues.length-1]:R.cues[i]; NAV.next=nc;
  const dist=Math.max(0,nc.s-s);
  if(NAV.offOn){ const g=nearestOnRoute(...toXY(NAV.fix.lat,NAV.fix.lon)); showBanner('OFF',fmtDist(g?g.d:0),'Off route','Head back to the bright line',true); }
  else if(NAV.done) showBanner('END',['Done',''],R.loop?'Finished, back at the start':'Finished',`${(R.total/MI).toFixed(2)} mi · ${fmtTime((Date.now()-NAV.t0)/1000)}`);
  else showBanner(nc.k,fmtDist(dist),cueText(nc),nc.where&&nc.k!=='END'?`at ${nc.where}`:'');
  // the cue after next, when it comes quickly
  const after=i>=0?R.cues[i+1]:null;
  if(after&&!NAV.offOn&&!NAV.done&&after.s-nc.s<120){ $('then').hidden=false; $('thIc').innerHTML=arrowSvg(after.k); $('thTxt').textContent=cueShort(after); } else $('then').hidden=true;
  // voice: early warning and at the turn
  if(!NAV.offOn&&!NAV.done&&nc.k!=='START'){ const key=R.cues.indexOf(nc), st=NAV.said.get(key)||0;
    if(st<1&&dist<=130&&dist>45){ NAV.said.set(key,1); say(`In ${sayDist(dist)}, ${spoken(nc)}.`); }
    else if(st<2&&dist<=22){ NAV.said.set(key,2); say(cap(spoken(nc))+(after&&after.s-nc.s<80?`, then ${spoken(after)}`:'')+'.'); buzz(nc.k==='S'?60:[80,60,80]); } }
  // mile markers
  const mile=Math.floor(s/MI); if(VOICE.miles&&mile>NAV.mile&&!NAV.done){ NAV.mile=mile; const el=(Date.now()-NAV.t0)/1000; say(`Mile ${mile}. ${spokenTime(el/mile)} per mile. ${((R.total-s)/MI).toFixed(1)} to go.`); }
  stats(); drawFollow(); pocketUpdate(); }
function spoken(c){ if(c.k==='END') return R.loop?'you are back at the start':'you have arrived'; const t=(TXT[c.k]||'Continue').toLowerCase().replace('make a ','');
  return c.onto?`${t} onto ${speakName(c.onto)}`:t; }
const speakName=n=>n.replace(/^NE /,'Northeast ').replace(/^NW /,'Northwest ').replace(/^SE /,'Southeast ').replace(/^SW /,'Southwest ').replace(/^N /,'North ').replace(/^S /,'South ').replace(/^E /,'East ').replace(/^W /,'West ')
  .replace(/ Ave$/,' Avenue').replace(/ St$/,' Street').replace(/ Blvd$/,' Boulevard').replace(/ Dr$/,' Drive').replace(/ Rd$/,' Road').replace(/ Pl$/,' Place').replace(/ Ct$/,' Court').replace(/ Pkwy$/,' Parkway').replace(/ Hwy$/,' Highway');
const cap=t=>t.charAt(0).toUpperCase()+t.slice(1);
const spokenTime=s=>{ s=Math.round(s); const m=Math.floor(s/60), x=s%60; return m?`${m} minute${m>1?'s':''}${x?` ${x} second${x>1?'s':''}`:''}`:`${x} seconds`; };
function showBanner(k,[d,u],txt,sub,off=false){ const b=$('banner'); b.hidden=false; b.classList.toggle('off',!!off); $('bIc').innerHTML=arrowSvg(k); $('bDist').innerHTML=d?`${d}<small>${u}</small>`:''; $('bTxt').textContent=txt; $('bSub').textContent=sub||'';
  document.documentElement.style.setProperty('--bh',(b.offsetHeight)+'px'); }
function stats(){ const s=NAV.s??0, el=NAV.t0?(Date.now()-NAV.t0)/1000:0; $('sDone').textContent=(s/MI).toFixed(2); $('sLeft').textContent=((R.total-s)/MI).toFixed(2); $('sTime').textContent=fmtTime(el);
  $('sPace').textContent=s>160?fmtTime(el/(s/MI)):'–'; }
function drawFollow(){ if(MAP.follow&&NAV.fix){ MAP.lat=NAV.fix.lat; MAP.lon=NAV.fix.lon; if(MAP.headUp&&NAV.head!=null) MAP.rot=-(Math.PI/2-NAV.head); else MAP.rot=0; } draw(); }
function setFollow(on){ MAP.follow=on; $('fFollow').setAttribute('aria-pressed',String(on)); if(on){ if(MAP.zf<16.5) MAP.zf=17; drawFollow(); } }
setInterval(()=>{ if(NAV.on&&NAV.t0&&!NAV.done) stats(); },1000);

/* ---------------- GPS + screen wake ---------------- */
let wake=null;
async function keepAwake(){ try{ if('wakeLock' in navigator&&document.visibilityState==='visible'){ wake=await navigator.wakeLock.request('screen'); } }catch(e){} }
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&NAV.on) keepAwake(); });
function startGps(){ if(NAV.watch!=null||NAV.demo) return; if(!('geolocation' in navigator)){ toast('This browser has no GPS access.'); return; }
  NAV.watch=navigator.geolocation.watchPosition(p=>{ const f={lat:p.coords.latitude,lon:p.coords.longitude,acc:p.coords.accuracy||30,heading:p.coords.heading,speed:p.coords.speed,t:p.timestamp}; if(NAV.demo){ NAV.realFix=f; return; } onFix(f); },
    e=>{ $('gpsWarn').hidden=false; $('gpsWarn').textContent=e.code===1?'Location is blocked. Allow it for this site in your browser settings.':'Looking for GPS…'; },
    {enableHighAccuracy:true,maximumAge:1000,timeout:30000}); }
function updateAway(){ if(!NAV.fix||!R.ll.length) return; const [x,y]=toXY(NAV.fix.lat,NAV.fix.lon), d=Math.hypot(x-R.xy[0][0],y-R.xy[0][1]); const [v,u]=fmtDist(d); $('rAway').textContent=v+' '+u; }

/* ---------------- start / stop ---------------- */
function begin(demo=false){
  NAV.on=true; NAV.demo=demo; if(demo){ NAV.fix=null; NAV.head=null; NAV.lastXY=null; } NAV.s=null; NAV.said.clear(); NAV.mile=0; NAV.done=false; NAV.offOn=false; NAV.off=0; NAV.t0=Date.now();
  $('startSheet').hidden=true; $('bar').hidden=false; $('fabs').hidden=false;
  // a gesture is needed before speech works on iPhones
  if('speechSynthesis' in window){ try{ const u=new SpeechSynthesisUtterance(' '); u.volume=0; speechSynthesis.speak(u); }catch(e){} }
  keepAwake(); setFollow(true); MAP.zf=17;
  const c0=R.cues[0]; say(`Head ${COMPASS(R.startHead)}${c0.onto?' on '+speakName(c0.onto):''}.`);
  if(demo) runDemo(); else { startGps(); if(NAV.fix) onFix(NAV.fix); else update(); }
  store.set('rnActive',{key:currentKey(),t0:NAV.t0});
}
function end(){ NAV.on=false; if(NAV.demo){ NAV.demo=false; clearInterval(DEMO.t); if(NAV.realFix){ NAV.fix=NAV.realFix; NAV.head=null; NAV.lastXY=null; } } NAV.s=null; NAV.next=null; try{ wake&&wake.release(); }catch(e){} wake=null;
  $('bar').hidden=$('fabs').hidden=$('banner').hidden=$('then').hidden=true; $('pocket').hidden=true; $('startSheet').hidden=false; store.set('rnActive',null); fitRoute(); }
// simulated run: walks the route at ~9 min/mile pace, sped up, with a little GPS wobble
const DEMO={t:null,s:0};
function runDemo(){ DEMO.s=0; clearInterval(DEMO.t); const speed=2.98*12; // metres per tick (12x real pace)
  DEMO.t=setInterval(()=>{ if(!NAV.on){ clearInterval(DEMO.t); return; } DEMO.s+=speed*0.5; const [x,y]=pointAt(DEMO.s), j=()=>(Math.random()-0.5)*6;
    onFix({lat:PROJ.lat0+(y+j())/PROJ.ky,lon:PROJ.lon0+(x+j())/PROJ.kx,acc:8,heading:null,speed:3});
    if(DEMO.s>R.total+30){ clearInterval(DEMO.t); } },500); }

/* ---------------- pocket mode ---------------- */
function pocket(on){ $('pocket').hidden=!on; if(!on) $('pocketBtn').focus(); if(on){ $('hold').focus(); keepAwake(); pocketUpdate(); toast('Pocket mode: voice cues on, screen locked. Hold the circle to unlock.'); } }
function pocketUpdate(){ if($('pocket').hidden) return; const nc=NAV.next; if(!nc) return; $('pIc').innerHTML=arrowSvg(NAV.offOn?'OFF':nc.k); const [d,u]=NAV.offOn?['Off','route']:fmtDist(Math.max(0,nc.s-(NAV.s??0)));
  $('pDist').textContent=`${d} ${u}`; $('pTxt').textContent=NAV.offOn?'Head back to the route':cueText(nc); $('pStat').textContent=`${$('sDone').textContent} / ${(R.total/MI).toFixed(2)} mi · ${$('sTime').textContent}`; }
(()=>{ const h=$('hold'); let t=null; const stop=()=>{ h.classList.remove('on'); clearTimeout(t); };
  h.addEventListener('pointerdown',e=>{ e.preventDefault(); h.classList.add('on'); t=setTimeout(()=>{ stop(); pocket(false); },1200); });
  h.addEventListener('pointerup',stop); h.addEventListener('pointerleave',stop); h.addEventListener('pointercancel',stop);
  h.addEventListener('keydown',e=>{ if((e.key==='Enter'||e.key===' ')&&!e.repeat){ e.preventDefault(); h.classList.add('on'); t=setTimeout(()=>{ stop(); pocket(false); },1200); } }); h.addEventListener('keyup',stop); h.addEventListener('click',e=>e.preventDefault());
  $('pocket').addEventListener('contextmenu',e=>e.preventDefault()); })();

/* ---------------- sharing ---------------- */
function gpxText(){ const esc=s=>String(s).replace(/[<&>"]/g,c=>({'<':'&lt;','&':'&amp;','>':'&gt;','"':'&quot;'}[c]));
  const w=R.cues.map(c=>{ const [la,lo]=R.ll[c.i]; return `<wpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"><name>${esc(cueText(c))}</name>${c.where?`<desc>${esc(c.where)}</desc>`:''}<type>${c.k}</type></wpt>`; }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Run Nav" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(R.name)}</name></metadata>\n${w}\n<trk><name>${esc(R.name)}</name><trkseg>\n${R.ll.map(([la,lo])=>`<trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>`).join('\n')}\n</trkseg></trk>\n</gpx>\n`; }
async function openElsewhere(){ const name=(R.name||'route').replace(/[\\/:*?"<>|]+/g,' ').trim()+'.gpx', file=new File([gpxText()],name,{type:'application/gpx+xml'});
  try{ if(navigator.canShare&&navigator.canShare({files:[file]})){ await navigator.share({files:[file],title:R.name}); return; } }catch(e){ if(e&&e.name==='AbortError') return; }
  const a=document.createElement('a'); a.href=URL.createObjectURL(file); a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  toast('GPX saved. Open it with OsmAnd, Organic Maps or your watch app.',5000); }
async function shareLink(){ const h=await hashFromRoute(R.src), url=location.origin+location.pathname+'#'+h; return url; }
async function openShare(){ const url=await shareLink(); const qr=qrcode(0,'L'); qr.addData(url); qr.make(); $('qrBox').innerHTML=qr.createImgTag(6,8);
  $('shCopy').onclick=async()=>{ try{ await navigator.clipboard.writeText(url); toast('Link copied.'); }catch(e){ prompt('Copy this link',url); } };
  $('shSend').onclick=async()=>{ try{ await navigator.share({title:R.name,text:`${R.name}: ${(R.total/MI).toFixed(1)} mi run`,url}); }catch(e){} };
  $('shSend').hidden=!navigator.share; $('shareDlg').showModal(); }
$('shClose').onclick=()=>$('shareDlg').close();

/* ---------------- loading ---------------- */
function currentKey(){ return R.src?(R.name+'|'+R.total.toFixed(0)):''; }
function remember(){ const list=store.get('rnRecent',[]).filter(r=>r.name+'|'+r.len!==R.name+'|'+R.total.toFixed(0));
  list.unshift({name:R.name,len:R.total.toFixed(0),src:{name:R.src.name,pts:encPoly(R.src.pts),cues:R.src.cues,wpts:R.src.wpts,loop:R.src.loop},at:Date.now()}); store.set('rnRecent',list.slice(0,8)); }
function load(src,{save=true}={}){
  R.src=src; prepare(src); if(save) remember();
  $('landSheet').hidden=true; $('startSheet').hidden=false;
  $('cuesBtn2').textContent=`See all ${R.cues.filter(c=>c.k!=='START'&&c.k!=='END').length} turns`; $('rName').textContent=R.name; $('rDist').textContent=(R.total/MI).toFixed(2)+' mi'; $('rTurns').textContent=String(R.cues.filter(c=>c.k!=='START'&&c.k!=='END'&&c.k!=='S').length);
  const c0=R.cues[0]; $('rStart').textContent=`Starts ${c0.where?'at '+c0.where:'at the S on the map'}${R.loop?' and loops back there':''}. ${cueText(c0)}.`;
  const [la,lo]=R.ll[0]; $('dirBtn').href=`https://www.google.com/maps/dir/?api=1&destination=${la.toFixed(6)},${lo.toFixed(6)}&travelmode=walking`;
  document.title=R.name+' · Run Nav'; MAP.follow=false; fitRoute(); drawPreview(); startGps(); }
function drawPreview(){ const cv=$('preview'), r=cv.getBoundingClientRect(), d=devicePixelRatio||1; cv.width=r.width*d; cv.height=r.height*d; const c=cv.getContext('2d'); c.scale(d,d);
  let a=1e9,b=-1e9,e=1e9,f=-1e9; for(const [x,y] of R.xy){ a=Math.min(a,x); b=Math.max(b,x); e=Math.min(e,y); f=Math.max(f,y); }
  const k=Math.min((r.width-20)/(b-a||1),(r.height-20)/(f-e||1)), ox=(r.width-(b-a)*k)/2, oy=(r.height-(f-e)*k)/2;
  c.lineJoin=c.lineCap='round'; c.shadowColor='#00D2BE'; c.shadowBlur=8; c.strokeStyle='#00D2BE'; c.lineWidth=2.5; c.beginPath();
  R.xy.forEach(([x,y],i)=>{ const X=ox+(x-a)*k, Y=r.height-oy-(y-e)*k; i?c.lineTo(X,Y):c.moveTo(X,Y); }); c.stroke(); c.shadowBlur=0;
  const [sx,sy]=R.xy[0]; c.fillStyle='#fff'; c.beginPath(); c.arc(ox+(sx-a)*k,r.height-oy-(sy-e)*k,5,0,7); c.fill(); }
function showLanding(){ $('startSheet').hidden=true; $('landSheet').hidden=false; const list=store.get('rnRecent',[]); $('recentWrap').hidden=!list.length; const box=$('recent'); box.innerHTML='';
  for(const r of list){ const b=document.createElement('button'); b.innerHTML='<span></span><small></small>'; b.firstChild.textContent=r.name; b.lastChild.textContent=(r.len/MI).toFixed(1)+' mi';
    b.onclick=()=>load({...r.src,pts:decPoly(r.src.pts)},{save:true}); box.appendChild(b); } }
$('gpxBtn').onclick=()=>$('gpxFile').click();
$('gpxFile').addEventListener('change',async e=>{ const f=e.target.files[0]; e.target.value=''; if(!f) return; try{ load(parseGpx(await f.text(),f.name)); history.replaceState(null,'',location.pathname); }catch(err){ toast(err.message||'Could not read that file.'); } });


/* ---------------- full cue sheet ---------------- */
let cueOpener=null;
function openCues(from){
  cueOpener=from||document.activeElement; const list=$('cueList'); list.innerHTML='';
  const s=NAV.on&&NAV.s!=null?NAV.s:-1, nextIdx=NAV.on&&NAV.next?R.cues.indexOf(NAV.next):-1;
  const turns=R.cues.filter(c=>c.k!=='START'&&c.k!=='END').length;
  $('cueInfo').textContent=`${(R.total/MI).toFixed(2)} mi · ${turns} turn${turns===1?'':'s'}${s>=0?` · ${((R.total-s)/MI).toFixed(2)} mi to go`:''}. Tap a turn to see it on the map.`;
  R.cues.forEach((c,i)=>{ const li=document.createElement('li'); if(s>=0&&c.s<s-6&&i!==nextIdx) li.className='past'; if(i===nextIdx) li.className='next';
    const nxt=R.cues[i+1], leg=nxt?nxt.s-c.s:0;
    li.innerHTML=`<button type="button"><span class="at"></span><span class="ic" aria-hidden="true">${arrowSvg(c.k)}</span><span class="tx"><b></b><small></small></span><span class="ln"></span></button>`;
    li.querySelector('.at').textContent=(c.s/MI).toFixed(2); li.querySelector('b').textContent=cueText(c);
    li.querySelector('small').textContent=c.where?(c.k==='END'?c.where:'at '+c.where):'';
    li.querySelector('.ln').textContent=leg>0?fmtDist(leg).join(' '):'';
    li.querySelector('button').setAttribute('aria-label',`Mile ${(c.s/MI).toFixed(2)}: ${cueText(c)}${c.where?', at '+c.where:''}`);
    li.querySelector('button').onclick=()=>{ closeCues(); setFollow(false); const [la,lo]=R.ll[c.i]; MAP.lat=la; MAP.lon=lo; MAP.zf=Math.max(MAP.zf,17.5); MAP.rot=0; draw();
      toast(`${cueText(c)}${c.where?' · '+c.where:''}. Tap the target button to follow you again.`,4500); };
    list.appendChild(li); });
  $('cueSheet').hidden=$('scrim').hidden=false;
  const cur=list.querySelector('li.next')||list.firstChild; cur&&cur.scrollIntoView({block:'center'}); (cur&&cur.querySelector('button')||$('cueClose')).focus({preventScroll:true}); }
function closeCues(){ if($('cueSheet').hidden) return; $('cueSheet').hidden=true; if($('menuSheet').hidden) $('scrim').hidden=true; if(cueOpener&&cueOpener.focus) cueOpener.focus(); }
$('cuesBtn').onclick=e=>openCues(e.currentTarget); $('cuesBtn2').onclick=e=>openCues(e.currentTarget); $('cueClose').onclick=closeCues;

/* ---------------- wiring ---------------- */
$('goBtn').onclick=()=>begin(false);
$('demoBtn').onclick=()=>begin(true);
$('otherBtn').onclick=openElsewhere; $('mOther').onclick=()=>{ closeMenu(); openElsewhere(); };
$('pocketBtn').onclick=()=>pocket(true);
$('fFollow').onclick=()=>setFollow(!MAP.follow);
$('fAll').onclick=()=>{ setFollow(false); fitRoute(); };
const setHead=on=>{ MAP.headUp=on; $('fHead').setAttribute('aria-pressed',String(on)); $('mHead').checked=on; store.set('rnHead',on); if(!on) MAP.rot=0; drawFollow(); };
$('fHead').onclick=()=>setHead(!MAP.headUp); $('mHead').onchange=e=>setHead(e.target.checked);
const setVoice=on=>{ VOICE.on=on; store.set('rnVoice',on); $('fVoice').setAttribute('aria-pressed',String(on)); $('mVoice').checked=on; if(!on) try{ speechSynthesis.cancel(); }catch(e){} };
$('fVoice').onclick=()=>{ setVoice(!VOICE.on); toast(VOICE.on?'Voice cues on.':'Voice cues off.'); }; $('mVoice').onchange=e=>setVoice(e.target.checked);
$('mMiles').onchange=e=>{ VOICE.miles=e.target.checked; store.set('rnMiles',VOICE.miles); }; $('mMiles').checked=VOICE.miles;
const closeMenu=()=>{ $('menuSheet').hidden=$('scrim').hidden=true; $('menuBtn').focus(); };
$('menuBtn').onclick=()=>{ $('menuSheet').hidden=$('scrim').hidden=false; $('mVoice').focus(); }; $('mClose').onclick=closeMenu; $('scrim').onclick=()=>{ closeMenu(); closeCues(); };
$('mEnd').onclick=()=>{ if(NAV.s>50&&!NAV.done&&!confirm('End this run? Your progress will be cleared.')) return; closeMenu(); end(); };
$('mRestart').onclick=()=>{ if(NAV.s>50&&!NAV.done&&!confirm('Restart from the beginning? Your progress will be cleared.')) return; closeMenu(); const d=NAV.demo; end(); begin(d); };
$('mShare').onclick=()=>{ closeMenu(); openShare(); };
setVoice(VOICE.on); setHead(store.get('rnHead',false));
document.addEventListener('keydown',e=>{ if(e.key!=='Escape') return; if(!$('cueSheet').hidden) closeCues(); else if(!$('menuSheet').hidden) closeMenu(); });

(async()=>{ resize();
  try{ const r=await routeFromHash(location.hash); if(r){ load(r); return; } }catch(e){ toast('That route link looks damaged. Ask for a fresh link or open the GPX file.',6000); }
  showLanding(); MAP.lat=45.52; MAP.lon=-122.65; MAP.zf=12; draw(); })();
addEventListener('hashchange',async()=>{ try{ const r=await routeFromHash(location.hash); if(r){ if(NAV.on) end(); load(r); } }catch(e){} });
if('serviceWorker' in navigator && location.protocol==='https:') navigator.serviceWorker.register('sw.js').catch(()=>{});
