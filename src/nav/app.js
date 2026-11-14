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
  return {name:o.n||'Route',pts:decPoly(o.p),cues:(o.c||[]).map(c=>({i:c[0],k:c[1],onto:c[2]||'',where:c[3]||'',b:+c[4]||0})),loop:!!o.l,shape:o.s||''}; }
async function hashFromRoute(R){ const o={v:1,n:R.name,p:encPoly(R.pts),c:R.cues.map(c=>{ const a=[c.i,c.k,c.onto||'',c.where||'',c.b||0]; while(a.length>2&&!a[a.length-1]) a.pop(); return a; }),l:R.loop?1:0};
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
const sayDist=m=>{ const f=m/FT; if(f<1000) return `${Math.round(f/50)*50||50} feet`; if(f<2640) return `${(Math.round(f/100)*100).toLocaleString('en-US')} feet`; const mi=m/MI; return mi<1.05&&mi>0.95?'1 mile':`${mi.toFixed(1)} miles`; };
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
  const cg=document.getElementById('compassG'); if(cg) cg.setAttribute('transform',`rotate(${(MAP.rot*180/Math.PI).toFixed(1)} 12 12)`);
  const c=octx, d=MAP.dpr; c.setTransform(d,0,0,d,0,0); c.clearRect(0,0,MAP.W,MAP.H);
  if(!R.ll.length) return;
  const P=R.ll.map(p=>screenOf(p[0],p[1])), prog=DISP.s??NAV.s??0, lw=clamp(2**(MAP.zf-16)*7,4,11);
  const path=(from,to)=>{ c.beginPath(); let started=false; for(let i=0;i<P.length;i++){ if(R.cum[i]<from-1e-6&&i<P.length-1&&R.cum[i+1]<from) continue; if(R.cum[i]>to&&started){ const q=screenOf(...llAt(to)); c.lineTo(q[0],q[1]); break; }
      if(!started){ const q=R.cum[i]<from?screenOf(...llAt(from)):P[i]; c.moveTo(q[0],q[1]); started=true; if(R.cum[i]<from) continue; } c.lineTo(P[i][0],P[i][1]); } };
  c.lineCap='round'; c.lineJoin='round';
  const running=NAV.on&&NAV.s!=null, t=ANIM.t, calm=ANIM.reduced;
  if(!running){ // before the run: one clean bright line
    path(0,R.total); c.save(); c.shadowColor='#00D2BE'; c.shadowBlur=14; c.strokeStyle='#00A19C'; c.lineWidth=lw+3; c.stroke(); c.restore();
    c.strokeStyle='#00D2BE'; c.lineWidth=lw; c.stroke();
  } else {
    // ahead: a quiet guide line, a touch brighter inside the gravity well
    path(prog,R.total); c.strokeStyle='rgba(0,161,156,.5)'; c.lineWidth=lw*0.45; c.stroke();
    if(FX.kind!=='off'&&!calm) aheadGlow(c,prog,lw);
    // behind: calm, thick, glowing; no motion
    if(prog>0){ path(0,prog);
      c.save(); c.shadowColor='#00D2BE'; c.shadowBlur=26; c.strokeStyle='rgba(0,161,156,.9)'; c.lineWidth=lw*1.9+4; c.stroke(); c.restore();
      c.strokeStyle='#14E6D0'; c.lineWidth=lw*1.5; c.stroke();
      c.strokeStyle='rgba(225,255,251,.85)'; c.lineWidth=lw*0.5; c.stroke(); }
  }
  // direction chevrons every ~150 m ahead
  c.fillStyle=running?'rgba(0,210,190,.9)':'#000'; for(let s=prog+(running?WELL+40:60);s<R.total;s+=150){ const a=screenOf(...llAt(s)), b=screenOf(...llAt(s+5)); if(a[0]<-20||a[1]<-20||a[0]>MAP.W+20||a[1]>MAP.H+20) continue;
    const an=Math.atan2(b[1]-a[1],b[0]-a[0]); c.save(); c.translate(a[0],a[1]); c.rotate(an); c.beginPath(); c.moveTo(lw*0.55,0); c.lineTo(-lw*0.4,-lw*0.45); c.lineTo(-lw*0.15,0); c.lineTo(-lw*0.4,lw*0.45); c.closePath(); c.fill(); c.restore(); }
  // next cue marker
  const nc=NAV.next; if(nc&&nc.k!=='START'){ const q=screenOf(...R.ll[nc.i]); c.beginPath(); c.arc(q[0],q[1],lw*0.9,0,7); c.fillStyle='#fff'; c.fill(); c.lineWidth=2.5; c.strokeStyle='#000'; c.stroke(); }
  // start / finish
  const s0=P[0]; c.beginPath(); c.arc(s0[0],s0[1],9,0,7); c.fillStyle='#fff'; c.fill(); c.fillStyle='#000'; c.font='700 10px system-ui'; c.textAlign='center'; c.textBaseline='middle'; c.fillText('S',s0[0],s0[1]+0.5);
  if(running&&!calm&&DISP.lat!=null){ if(FX.kind==='well') drawWell(c,prog,lw); else if(FX.kind==='surge') drawSurge(c,prog,lw); else if(FX.kind==='chev') drawChevrons(c,prog,lw); }
  // you
  if(NAV.fix&&DISP.lat!=null){ const q=screenOf(DISP.lat,DISP.lon), mpp=156543.03*Math.cos(DISP.lat*Math.PI/180)/2**MAP.zf, rr=(DISP.s!=null?0:NAV.fix.acc)/mpp;
    if(rr>12){ c.beginPath(); c.arc(q[0],q[1],rr,0,7); c.fillStyle='rgba(0,210,190,.10)'; c.fill(); c.strokeStyle='rgba(0,210,190,.35)'; c.lineWidth=1; c.stroke(); }
    c.save(); c.translate(q[0],q[1]);
    if(DISP.head!=null){ c.rotate(MAP.rot+(Math.PI/2-DISP.head)); c.beginPath(); c.moveTo(0,-16); c.lineTo(11,11); c.lineTo(0,5); c.lineTo(-11,11); c.closePath(); c.fillStyle='#fff'; c.shadowColor='#000'; c.shadowBlur=8; c.fill(); c.shadowBlur=0; c.strokeStyle='#000'; c.lineWidth=2; c.stroke(); }
    else { c.beginPath(); c.arc(0,0,9,0,7); c.fillStyle='#fff'; c.fill(); c.lineWidth=3; c.strokeStyle='#00A19C'; c.stroke(); }
    c.restore(); }
}
const ANIM={t:0,dt:0,raf:0,last:0,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches};
/* What's drawn: on the route, the arrow glides along it at your measured speed and eases onto each new fix
   (like car nav apps); off the route it eases toward the raw GPS position. */
const DISP={lat:null,lon:null,head:null,s:null};
function stepDisplay(dt){
  const f=NAV.fix; if(!f) return;
  if(NAV.on&&NAV.s!=null&&!NAV.offOn){
    const ahead=Math.min(NAV.v*(performance.now()-NAV.fixT)/1000, NAV.v*1.6+3);   // dead-reckon, but never run far past the last fix
    const target=Math.min(R.total,NAV.s+ahead);
    if(DISP.s==null||Math.abs(target-DISP.s)>120) DISP.s=target;               // first fix or a jump: snap
    else DISP.s+=(target-DISP.s)*Math.min(1,dt*3.5);
    const [la,lo]=llAt(DISP.s); DISP.lat=la; DISP.lon=lo;
    const want=headAlong(Math.max(0,DISP.s-4));
    DISP.head=DISP.head==null?want:DISP.head+angWrap(want-DISP.head)*Math.min(1,dt*6);
  } else {
    DISP.s=null; const k=Math.min(1,dt*4);
    DISP.lat=DISP.lat==null?f.lat:DISP.lat+(f.lat-DISP.lat)*k; DISP.lon=DISP.lon==null?f.lon:DISP.lon+(f.lon-DISP.lon)*k;
    if(NAV.head!=null) DISP.head=DISP.head==null?NAV.head:DISP.head+angWrap(NAV.head-DISP.head)*Math.min(1,dt*5);
  } }
const angWrap=a=>{ while(a>Math.PI) a-=2*Math.PI; while(a<-Math.PI) a+=2*Math.PI; return a; };
/* ---- gravity well: particles ahead of you fall in along the route, slowly at first, then very fast ---- */
const WELL=230;                                  // metres ahead where the pull starts (~2½ blocks)
const PART={list:[],energy:0,spawn:0};
// The line ahead: barely lifted two-plus blocks out, building smoothly to a strong glow at the runner.
function aheadGlow(c,prog,lw){
  const lite=true, z1=Math.min(R.total,prog+WELL), step=10;
  for(let a=z1;a>prog;a-=step){                         // far → near, so the brighter pieces sit on top
    const b=Math.max(prog,a-step-0.6), k=1-(((a+b)/2)-prog)/WELL, e=Math.pow(Math.max(0,k),2.2);   // gentle far, steep near
    const p=screenOf(...llAt(a)), q=screenOf(...llAt(b));
    c.beginPath(); c.moveTo(p[0],p[1]); c.lineTo(q[0],q[1]);
    c.save(); if(!lite||e>0.55){ c.shadowColor='#00D2BE'; c.shadowBlur=lite?6+8*e:2+18*e; }
    c.strokeStyle=`rgba(${Math.round(0+200*e)},${Math.round(190+65*e)},${Math.round(180+70*e)},${(0.06+0.84*e).toFixed(3)})`;
    c.lineWidth=lw*(0.5+0.75*e); c.stroke(); c.restore(); } }
const FX={kind:['well','surge','chev','off'].includes(store.get('rnFx','well'))?store.get('rnFx','well'):'well'};
/* ---- power surge: the line ahead crackles; sparks get smaller-scale wild the closer you are, arcs jump from you onto it ---- */
const SURGE={list:[],spawn:0,arcT:0,arcs:[]}, GRIND={list:[],spawn:0};
/* ---- chevrons: arrows flowing forward along the route, same gradient; the light, battery-friendly option ---- */
function drawChevrons(c,prog,lw){
  const gap=16, flow=(ANIM.t*14)%gap;                     // they drift forward at ~14 m/s, so the line reads as moving ahead
  c.save(); c.lineCap='round'; c.lineJoin='round';
  // d grows with time: the arrows travel away from you, the way you're going
  for(let d=4+flow;d<WELL;d+=gap){ const s0=prog+d; if(s0>R.total-3) break;
    const k=1-d/WELL, e=Math.pow(k,1.8), a=screenOf(...llAt(s0)), b=screenOf(...llAt(s0+3)), an=Math.atan2(b[1]-a[1],b[0]-a[0]);
    const sz=lw*(0.45+0.7*e), fadeIn=Math.min(1,(d-4)/6);       // the nearest one fades in rather than popping
    c.save(); c.translate(a[0],a[1]); c.rotate(an);
    if(e>0.5){ c.shadowColor='#00D2BE'; c.shadowBlur=4+8*e; }
    c.strokeStyle=`rgba(${Math.round(40+215*e)},${Math.round(215+40*e)},${Math.round(200+55*e)},${((0.18+0.8*e)*fadeIn).toFixed(3)})`;
    c.lineWidth=Math.max(1.5,lw*(0.22+0.2*e));
    c.beginPath(); c.moveTo(-sz*0.55,-sz*0.75); c.lineTo(sz*0.45,0); c.lineTo(-sz*0.55,sz*0.75); c.stroke(); c.restore(); }
  c.restore(); }
function drawSurge(c,prog,lw){
  const dt=ANIM.frame?Math.min(0.06,ANIM.dt||0.033):0, mpp=156543.03*Math.cos(MAP.lat*Math.PI/180)/2**MAP.zf, live=!NAV.offOn&&!NAV.done, Z=WELL;
  const you=screenOf(DISP.lat,DISP.lon), heat=d=>{ const k=1-Math.min(1,Math.max(0,d)/Z); return k*k; };   // 0 far out → 1 at you
  const tan=s2=>{ const a=screenOf(...llAt(s2)), b=screenOf(...llAt(s2+2)), l=Math.hypot(b[0]-a[0],b[1]-a[1])||1; return [a,(b[0]-a[0])/l,(b[1]-a[1])/l]; };
  c.save(); c.globalCompositeOperation='lighter'; c.lineCap='round';
  const z1=Math.min(R.total,prog+Z);
  // 2. sparks: born on the line, thrown off it; near you they're faster, shorter-lived and twitchier
  // motion is in screen pixels so sparks read the same at any zoom
  if(live&&dt){ SURGE.spawn+=dt*140; while(SURGE.spawn>=1&&SURGE.list.length<170){ SURGE.spawn--;
      const d=Z*Math.pow(Math.random(),1.15), e=heat(d), ang=Math.random()*Math.PI*2, sp=(8+110*e)*(0.45+Math.random()*0.9);
      SURGE.list.push({s:prog+d,ox:0,oy:0,vx:Math.cos(ang)*sp,vy:Math.sin(ang)*sp,life:0,max:(0.8-0.4*e)*(0.6+Math.random()*0.8),prev:null,hot:Math.random()}); } }
  const keep=[];
  for(const p of SURGE.list){
    const d=p.s-prog; if(d<-3||d>Z+30){ continue; }
    const e=heat(d); p.life+=dt; if(p.life>p.max) continue;
    if(dt){ // eccentric: random kicks that grow with heat, a little drag
      const kick=(20+700*e*e)*dt; p.vx+=gauss()*kick; p.vy+=gauss()*kick;            // erratic, more so near you
      if(e>0.6&&Math.random()<e*dt*9){ const sp=Math.hypot(p.vx,p.vy), an=Math.random()*Math.PI*2; p.vx=Math.cos(an)*sp; p.vy=Math.sin(an)*sp; }   // sudden zig
      const dr=Math.exp(-dt*2.2); p.vx*=dr; p.vy*=dr; p.ox+=p.vx*dt; p.oy+=p.vy*dt; }
    const [a]=tan(p.s), x=a[0]+p.ox, y=a[1]+p.oy, fade=1-p.life/p.max;
    const w=(0.9+0.9*e)*Math.max(1,lw/8);
    const warm=Math.max(0,(e-0.55)/0.45)*(p.hot<0.6?1:0.3);                   // last ~third: sparks start to glow amber
    const col=[Math.round(110+145*Math.min(1,e*1.6)), Math.round(255-30*warm), Math.round(235+20*Math.min(1,e*1.6)-135*warm)];
    c.strokeStyle=`rgba(${col[0]},${col[1]},${col[2]},${(fade*(0.5+0.5*e)).toFixed(3)})`;
    c.lineWidth=w; c.beginPath(); if(p.prev&&dt) c.moveTo(p.prev[0],p.prev[1]); else c.moveTo(x,y); c.lineTo(x+0.01,y); c.stroke();
    if(dt) p.prev=[x,y]; keep.push(p); }
  SURGE.list=keep;
  // 3. arcs: jagged bolts from you onto the line ahead, and crawling along it; re-struck every ~70 ms
  if(dt){ SURGE.arcT-=dt; if(SURGE.arcT<=0&&live){ SURGE.arcT=0.07+Math.random()*0.1; SURGE.arcs=[];
      const n=1+(Math.random()<0.45?1:0);
      for(let i=0;i<n;i++){ const d0=i===0?0:Math.pow(Math.random(),1.5)*45, len=6+Math.random()*(i===0?16:12), pts=[];
        for(let k=0;k<=8;k++){ const sk=prog+d0+len*k/8, j=(k===0||k===8)?0:gauss()*(1.2+3.2*heat(sk-prog)); pts.push([sk,j]); }
        SURGE.arcs.push({pts,from:i===0,a:0.25+Math.random()*0.3}); } } }
  for(const arc of SURGE.arcs){ c.beginPath();
    arc.pts.forEach(([sk,j],k)=>{ const [a,tx,ty]=tan(Math.min(R.total,sk)); let x=a[0]-ty*j, y=a[1]+tx*j; if(arc.from&&k===0){ x=you[0]; y=you[1]; } k?c.lineTo(x,y):c.moveTo(x,y); });
    c.save(); c.shadowColor='#00D2BE'; c.shadowBlur=5; c.strokeStyle=`rgba(200,255,250,${arc.a.toFixed(3)})`; c.lineWidth=0.9*Math.max(1,lw/9); c.stroke(); c.restore(); }
  // 4. grinder sparks: a dense spray where you meet the line. White-hot streaks fan back past you,
  //    slow down, curl slightly and cool through amber to dull orange before they die.
  if(live){ const [cp,tx,ty]=tan(Math.min(R.total,prog+4)), back=Math.atan2(-ty,-tx);
    if(dt){ GRIND.spawn+=dt*(100+30*Math.random()); while(GRIND.spawn>=1&&GRIND.list.length<150){ GRIND.spawn--;
        const ang=back+(Math.random()<0.5?-1:1)*(0.32+Math.abs(gauss())*0.16), sp=(100+160*Math.random())*Math.max(1,lw/8);   // two narrow jets just off the trail
        GRIND.list.push({x:cp[0]+gauss()*1,y:cp[1]+gauss()*1,vx:Math.cos(ang)*sp,vy:Math.sin(ang)*sp,life:0,max:0.12+Math.random()*0.24,curl:gauss()*1.2,px:null,py:null}); } }
    const g2=[];
    for(const p of GRIND.list){ p.life+=dt; if(p.life>p.max) continue; const k=p.life/p.max;
      if(dt){ p.px=p.x; p.py=p.y; const dr=Math.exp(-dt*3.2), ca=Math.cos(p.curl*dt), sa=Math.sin(p.curl*dt), vx=p.vx*ca-p.vy*sa, vy=p.vx*sa+p.vy*ca;
        p.vx=vx*dr; p.vy=vy*dr; p.x+=p.vx*dt; p.y+=p.vy*dt; }
      // colour by temperature: white → yellow → amber → dull orange
      const col=k<0.2?[255,252,235]:k<0.45?[255,226,120]:k<0.75?[255,170,40]:[230,90,20], a=(1-k)*(k<0.2?0.85:0.7);
      c.strokeStyle=`rgba(${col[0]},${col[1]},${col[2]},${a.toFixed(3)})`; c.lineWidth=(k<0.3?1.1:0.8)*Math.max(1,lw/9);
      c.beginPath(); if(p.px!=null){ const sx=p.x+(p.px-p.x)*2.2, sy=p.y+(p.py-p.y)*2.2; c.moveTo(sx,sy); } else c.moveTo(p.x,p.y); c.lineTo(p.x+0.01,p.y); c.stroke();
      g2.push(p); }
    GRIND.list=g2;
    const hot=c.createRadialGradient(cp[0],cp[1],0,cp[0],cp[1],6+Math.random()*3); hot.addColorStop(0,'rgba(255,250,230,.8)'); hot.addColorStop(0.5,'rgba(255,190,60,.3)'); hot.addColorStop(1,'rgba(255,150,30,0)');
    c.fillStyle=hot; c.beginPath(); c.arc(cp[0],cp[1],10,0,7); c.fill(); }
  else GRIND.list=[];
  // 5. a crackle of light at you
  const g=c.createRadialGradient(you[0],you[1],2,you[0],you[1],30+(dt?Math.random()*10:5));
  g.addColorStop(0,'rgba(230,255,252,.55)'); g.addColorStop(0.4,'rgba(0,210,190,.25)'); g.addColorStop(1,'rgba(0,210,190,0)');
  c.fillStyle=g; c.beginPath(); c.arc(you[0],you[1],40,0,7); c.fill();
  c.restore(); }
// speed (m/s) at distance d ahead: gentle far out, violent close in
const pull=d=>3+14000/Math.pow(d+10,1.75);
function drawWell(c,prog,lw){
  const dt=ANIM.frame?Math.min(0.06,ANIM.dt||0.033):0, mpp=156543.03*Math.cos(MAP.lat*Math.PI/180)/2**MAP.zf, live=!NAV.offOn&&!NAV.done;
  // spawn: denser further out so the well looks fed from the distance
  if(live){ PART.spawn+=dt*34; while(PART.spawn>=1&&PART.list.length<100){ PART.spawn--; const d0=40+Math.pow(Math.random(),0.6)*(WELL-40);
      PART.list.push({s:prog+d0,d0,off:(Math.random()<.5?-1:1)*(4+Math.random()*26),sz:0.6+Math.random()*1.2,hue:Math.random(),prev:null}); } }
  const you=screenOf(DISP.lat,DISP.lon);
  c.save(); c.globalCompositeOperation='lighter'; c.lineCap='round';
  const keep=[];
  for(const p of PART.list){
    const d=p.s-prog; if(d>WELL+40||p.s>R.total){ continue; }
    if(d<=2.5){ PART.energy=Math.min(1.6,PART.energy+0.035); continue; }   // swallowed
    p.s-=pull(Math.max(0,d))*dt;
    const dd=Math.max(0,p.s-prog), k=Math.min(1,dd/p.d0);                 // 1 when spawned → 0 at the runner
    const a=screenOf(...llAt(p.s)), b=screenOf(...llAt(p.s+2)), tx=b[0]-a[0], ty=b[1]-a[1], tl=Math.hypot(tx,ty)||1;
    let x=a[0]-ty/tl*p.off*Math.pow(k,0.7)/mpp, y=a[1]+tx/tl*p.off*Math.pow(k,0.7)/mpp;
    // the last few metres bend straight into the arrow
    if(dd<14){ const w=1-dd/14; x+= (you[0]-x)*w*w; y+=(you[1]-y)*w*w; }
    const heat=1-k, alpha=0.25+0.75*heat, width=(p.sz*(1+2.2*heat))*Math.max(1,lw/7);
    const col=p.hue<0.7?`rgba(${Math.round(80+175*heat)},255,${Math.round(230+25*heat)},${alpha.toFixed(3)})`:`rgba(255,255,255,${alpha.toFixed(3)})`;
    c.strokeStyle=col; c.lineWidth=width;
    c.beginPath(); if(p.prev&&dt){ c.moveTo(x+(p.prev[0]-x)*2.5,y+(p.prev[1]-y)*2.5); } else c.moveTo(x,y); c.lineTo(x+0.01,y); c.stroke();
    if(dt) p.prev=[x,y]; keep.push(p); }
  PART.list=keep;
  // event horizon: a glow that swells as particles are swallowed, then settles
  PART.energy*=Math.exp(-dt*1.8);
  const e=Math.min(1.2,PART.energy), r0=16+10*e, g=c.createRadialGradient(you[0],you[1],2,you[0],you[1],r0*2.6);
  g.addColorStop(0,`rgba(220,255,250,${(0.35+0.4*e).toFixed(3)})`); g.addColorStop(0.35,`rgba(0,210,190,${(0.22+0.3*e).toFixed(3)})`); g.addColorStop(1,'rgba(0,210,190,0)');
  c.fillStyle=g; c.beginPath(); c.arc(you[0],you[1],r0*2.6,0,7); c.fill();
  c.restore(); }
function animLoop(ts){ ANIM.raf=0; if(!NAV.on||document.hidden||!$('pocket').hidden) return;
  if(ts-ANIM.last>=(FX.kind==='chev'||FX.kind==='off'?50:40)){ ANIM.dt=ANIM.last?Math.min(0.25,(ts-ANIM.last)/1000):0.033; ANIM.last=ts; ANIM.t=ts/1000; ANIM.frame=true;
    stepDisplay(ANIM.dt); followNow(); turnCall(); if(MAP.follow) draw(); else drawOverlay(); ANIM.frame=false; }
  ANIM.raf=requestAnimationFrame(animLoop); }
function animStart(){ if(!ANIM.raf) ANIM.raf=requestAnimationFrame(animLoop); }
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) animStart(); });
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
function vvInset(){ const vv=window.visualViewport; const b=vv?Math.max(0,Math.round(innerHeight-(vv.height+vv.offsetTop))):0; document.documentElement.style.setProperty('--vvb',b+'px'); }
if(window.visualViewport){ visualViewport.addEventListener('resize',vvInset); visualViewport.addEventListener('scroll',vvInset); } addEventListener('resize',vvInset); vvInset();
$('map').addEventListener('keydown',e=>{ const k=e.key, step=80;
  if(k==='+'||k==='='){ MAP.zf=clamp(MAP.zf+0.5,3,19.5); draw(); }
  else if(k==='-'||k==='_'){ MAP.zf=clamp(MAP.zf-0.5,3,19.5); draw(); }
  else if(k.startsWith('Arrow')){ if(MAP.follow&&NAV.on) setFollow(false); panBy(k==='ArrowLeft'?step:k==='ArrowRight'?-step:0,k==='ArrowUp'?step:k==='ArrowDown'?-step:0); }
  else return; e.preventDefault(); });

/* ---------------- voice ---------------- */
const VOICE={on:store.get('rnVoice',true),miles:store.get('rnMiles',true),leadFt:clamp(store.get('rnLeadFt',50),0,100),pocketLvl:store.get('rnPocketLvl',1),thenNext:store.get('rnThenNext',false),haptic:store.get('rnHaptic',true),unlocked:false};
function say(t,urgent=false){ if(!VOICE.on||!('speechSynthesis' in window)) return; try{ if(urgent) speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(t); u.rate=1.02; u.lang='en-US'; speechSynthesis.speak(u); return u; }catch(e){} }
function buzz(p){ if(!VOICE.haptic) return; try{ navigator.vibrate&&navigator.vibrate(p); }catch(e){} }

/* ---------------- navigation ---------------- */
const NAV={nextSaid:new Set(),v:0,fixT:0,on:false,demo:false,s:null,fix:null,head:null,next:null,off:0,offOn:false,t0:0,watch:null,said:new Map(),mile:0,lastXY:null,done:false,offAnnounced:0};
// where on the route am I? Look near my last progress first (routes can cross or retrace themselves), else anywhere.
function project(x,y,from,to){ let best=null; for(let i=0;i<R.xy.length-1;i++){ if(R.cum[i+1]<from||R.cum[i]>to) continue;
    const [ax,ay]=R.xy[i],[bx,by]=R.xy[i+1], L2=(bx-ax)**2+(by-ay)**2||1e-9, t=clamp(((x-ax)*(bx-ax)+(y-ay)*(by-ay))/L2,0,1), px=ax+(bx-ax)*t, py=ay+(by-ay)*t, d=Math.hypot(x-px,y-py);
    if(!best||d<best.d-0.5) best={d,s:R.cum[i]+t*Math.sqrt(L2)}; }
  return best; }
function onFix(f){
  const prevS=NAV.s, prevT=NAV.fixT; NAV.fix=f; NAV.fixT=performance.now(); const [x,y]=toXY(f.lat,f.lon), tol=Math.max(30,Math.min(60,f.acc*1.3));
  // heading: GPS course when moving, else from my last few metres of movement
  if(f.heading!=null&&!isNaN(f.heading)&&(f.speed||0)>0.8) NAV.head=Math.PI/2-f.heading*Math.PI/180;
  else if(NAV.lastXY&&Math.hypot(x-NAV.lastXY[0],y-NAV.lastXY[1])>6){ NAV.head=Math.atan2(y-NAV.lastXY[1],x-NAV.lastXY[0]); }
  if(!NAV.lastXY||Math.hypot(x-NAV.lastXY[0],y-NAV.lastXY[1])>6) NAV.lastXY=[x,y];
  $('gpsWarn').hidden=f.acc<=40; if(f.acc>40) $('gpsWarn').textContent=`Weak GPS (±${Math.round(f.acc/FT)} ft)`;
  if(!NAV.on){ updateAway(); stepDisplay(1); draw(); return; }
  let m=null;
  if(NAV.s!=null) m=project(x,y,NAV.s-40,NAV.s+500+Math.max(0,NAV.v)*3);
  else { m=project(x,y,-1,300); }          // first fix: prefer the start (a loop's finish is in the same place)
  // Jump further along only before the run has begun, or after being off route for a while (a deliberate shortcut).
  // Otherwise brushing past another part of the route would skip you ahead.
  if((!m||m.d>tol)&&(NAV.s==null||NAV.off>=8)){ const g=project(x,y,NAV.s??-1,1e9); if(g&&g.d<=tol) m=g; }
  if(m&&m.d<=tol){
    if(NAV.s==null) NAV.s=m.s; else if(m.s>=NAV.s-30) NAV.s=Math.max(NAV.s,m.s);
    if(NAV.offOn){ NAV.offOn=false; say('Back on route.',true); }
    NAV.off=0;
  } else { NAV.off++; if(NAV.off>=2&&!NAV.offOn&&NAV.s!=null){ NAV.offOn=true; buzz([200,100,200]); say('Off route.',true); } }
  // running speed for smooth display: GPS speed when reported, else from progress between fixes
  if(f.speed!=null&&!isNaN(f.speed)&&f.speed>=0) NAV.v=NAV.v*0.5+f.speed*0.5;
  else if(prevS!=null&&NAV.s!=null&&prevT){ const dtf=(NAV.fixT-prevT)/1000; if(dtf>0.2) NAV.v=NAV.v*0.6+clamp((NAV.s-prevS)/dtf,0,12)*0.4; }
  update(); }
function nearestOnRoute(x,y){ return project(x,y,-1,1e9); }
function update(){
  if(NAV.s==null){ // not on the route yet: guide to the start
    const g=NAV.fix?nearestOnRoute(...toXY(NAV.fix.lat,NAV.fix.lon)):null;
    showBanner('OFF',g?fmtDist(g.d):['',''],NAV.fix?'Head to the route':'Waiting for GPS…',NAV.fix?'The start is marked S':'Allow location access to begin',true);
    $('then').hidden=true; drawFollow(); return; }
  const s=NAV.s;
  // finished?
  if(!NAV.done&&s>=R.total-25){ NAV.done=true; say(`You've finished. ${(R.total/MI).toFixed(1)} miles in ${spokenTime((Date.now()-NAV.t0)/1000*(NAV.demo?DEMO.mult:1))}.`,true); buzz([300,150,300,150,300]); }
  const i=R.cues.findIndex(c=>c.s>s+6); const nc=i<0?R.cues[R.cues.length-1]:R.cues[i]; NAV.next=nc;
  const dist=Math.max(0,nc.s-s);
  if(NAV.offOn){ const g=nearestOnRoute(...toXY(NAV.fix.lat,NAV.fix.lon)); showBanner('OFF',fmtDist(g?g.d:0),'Off route','Head back to the bright line',true); }
  else if(NAV.done) showBanner('END',['Done',''],R.loop?'Finished, back at the start':'Finished',`${(R.total/MI).toFixed(2)} mi · ${fmtTime((Date.now()-NAV.t0)/1000)}`);
  else showBanner(nc.k,fmtDist(dist),cueText(nc),nc.where&&nc.k!=='END'?`at ${nc.where}`:'');
  // the cue after next, when it comes quickly
  const after=i>=0?R.cues[i+1]:null;
  if(after&&!NAV.offOn&&!NAV.done&&after.s-nc.s<120){ $('then').hidden=false; $('thIc').innerHTML=arrowSvg(after.k); $('thTxt').textContent=cueShort(after); } else $('then').hidden=true;
  turnCall();
  // mile markers
  const mile=Math.floor(s/MI); if(VOICE.miles&&mile>NAV.mile&&!NAV.done){ NAV.mile=mile; const el=(Date.now()-NAV.t0)/1000*(NAV.demo?DEMO.mult:1); say(`Mile ${mile}. ${spokenTime(el/mile)} per mile. ${((R.total-s)/MI).toFixed(1)} to go.`); }
  stats(); drawFollow(); pocketUpdate(); }
// One call per turn, VOICE.leadFt before the intersection, timed on the smoothed (dead-reckoned) position so it
// isn't late between 1-second GPS fixes. With "turn after next" on, the following turn is spoken right after.
function turnCall(){
  if(!NAV.on||NAV.offOn||NAV.done||NAV.s==null||!VOICE.on&&!VOICE.haptic) return;
  const sp=NAV.s+Math.max(0,Math.min(NAV.v*(performance.now()-NAV.fixT)/1000,NAV.v*1.6+3)), lead=VOICE.leadFt*FT;
  for(let i=1;i<R.cues.length;i++){ const c=R.cues[i]; if(c.k==='END') break; if(c.s<sp-15||NAV.said.get(i)) continue; if(c.s-sp>lead) break;
    NAV.said.set(i,1); say(cap(spoken(c))+'.',true); buzz(c.k==='S'?90:[260,110,260,110,420]);
    break; }
  // "Next turn…": once you're ~40 ft past a turn (or the start) and onto the new street, which is when you
  // start wondering what's next. Skipped if the next turn is so close that its own call is about to play.
  if(VOICE.thenNext) for(let i=0;i<R.cues.length-1;i++){ const c=R.cues[i], after=R.cues[i+1];
    if(NAV.nextSaid.has(i)||sp<c.s+12) continue; if(sp>c.s+150){ NAV.nextSaid.add(i); continue; }
    NAV.nextSaid.add(i); if(after.s-sp>lead+15) say(nextTurnLine(c,after)); break; } }
// "Next turn, right, in 2 blocks." Blocks come from the builder (named cross streets on the stretch);
// on paths, unnamed stretches or when there's no count it gives the distance instead.
const DIRWORD={TR:'right',TL:'left',BR:'bear right',BL:'bear left',XR:'sharp right',XL:'sharp left',U:'U-turn',S:'straight on'};
function nextTurnLine(c,after){ const gap=after.s-c.s, when=c.b>0?`in ${c.b} block${c.b>1?'s':''}`:`in ${sayDist(gap)}`;
  if(after.k==='END') return `Then the finish, ${when}.`;
  return `Next turn, ${DIRWORD[after.k]||'continue'}${after.k==='S'&&after.onto?' onto '+speakName(after.onto):''}, ${when}.`; }
function spoken(c){ if(c.k==='END') return R.loop?'you are back at the start':'you have arrived'; const t=(TXT[c.k]||'Continue').toLowerCase().replace('make a ','');
  return c.onto?`${t} onto ${speakName(c.onto)}`:t; }
const speakName=n=>n.replace(/^NE /,'Northeast ').replace(/^NW /,'Northwest ').replace(/^SE /,'Southeast ').replace(/^SW /,'Southwest ').replace(/^N /,'North ').replace(/^S /,'South ').replace(/^E /,'East ').replace(/^W /,'West ')
  .replace(/ Ave$/,' Avenue').replace(/ St$/,' Street').replace(/ Blvd$/,' Boulevard').replace(/ Dr$/,' Drive').replace(/ Rd$/,' Road').replace(/ Pl$/,' Place').replace(/ Ct$/,' Court').replace(/ Pkwy$/,' Parkway').replace(/ Hwy$/,' Highway');
const cap=t=>t.charAt(0).toUpperCase()+t.slice(1);
const spokenTime=s=>{ s=Math.round(s); const m=Math.floor(s/60), x=s%60; return m?`${m} minute${m>1?'s':''}${x?` ${x} second${x>1?'s':''}`:''}`:`${x} seconds`; };
function showBanner(k,[d,u],txt,sub,off=false){ const b=$('banner'); b.hidden=false; b.classList.toggle('off',!!off); $('bIc').innerHTML=arrowSvg(k); $('bDist').innerHTML=d?`${d}<small>${u}</small>`:''; $('bTxt').textContent=txt; $('bSub').textContent=sub||'';
  document.documentElement.style.setProperty('--bh',(b.offsetHeight)+'px'); }
function stats(){ const s=NAV.s??0, el=(NAV.t0?(Date.now()-NAV.t0)/1000:0)*(NAV.demo?DEMO.mult:1); $('sDone').textContent=(s/MI).toFixed(2); $('sLeft').textContent=((R.total-s)/MI).toFixed(2); $('sTime').textContent=fmtTime(el);
  $('sPace').textContent=s>160?fmtTime(el/(s/MI)):'–'; }
function followNow(){ if(MAP.follow&&DISP.lat!=null){ MAP.lat=DISP.lat; MAP.lon=DISP.lon; if(MAP.headUp&&DISP.head!=null) MAP.rot=-(Math.PI/2-DISP.head); else MAP.rot=0; } }
function drawFollow(){ if(!ANIM.raf){ stepDisplay(1); followNow(); } draw(); }
function setFollow(on){ MAP.follow=on; $('fFollow').setAttribute('aria-pressed',String(on)); $('fFollow').setAttribute('aria-label',on?'Following you. Pan the map, then tap to re-center.':'Re-center on my position'); if(on){ if(MAP.zf<16.5) MAP.zf=17; drawFollow(); } }
setInterval(()=>{ if(NAV.on&&NAV.t0&&!NAV.done){ stats(); pocketUpdate(); } },1000);

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
  NAV.on=true; NAV.demo=demo; if(demo){ NAV.fix=null; NAV.head=null; NAV.lastXY=null; } NAV.s=null; NAV.v=0; DISP.s=DISP.lat=DISP.lon=DISP.head=null; $('simChip').hidden=!demo; NAV.said.clear(); NAV.nextSaid.clear(); NAV.mile=0; NAV.done=false; NAV.offOn=false; NAV.off=0; NAV.t0=Date.now();
  $('startSheet').hidden=true; $('bar').hidden=false; $('mapCtl').hidden=false;
  // a gesture is needed before speech works on iPhones
  if('speechSynthesis' in window){ try{ const u=new SpeechSynthesisUtterance(' '); u.volume=0; speechSynthesis.speak(u); }catch(e){} }
  keepAwake(); setFollow(true); MAP.zf=17; PART.list=[]; PART.energy=0; SURGE.list=[]; SURGE.arcs=[]; GRIND.list=[]; ANIM.last=0; animStart();
  const c0=R.cues[0]; say(`Head ${COMPASS(R.startHead)}${c0.onto?' on '+speakName(c0.onto):''}.`);
  if(demo) runDemo(); else { startGps(); if(NAV.fix) onFix(NAV.fix); else update(); }
  store.set('rnActive',{key:currentKey(),t0:NAV.t0});
}
function end(){ NAV.on=false; $('simChip').hidden=true; DISP.s=DISP.lat=DISP.lon=DISP.head=null; if(NAV.demo){ NAV.demo=false; clearInterval(DEMO.t); if(NAV.realFix){ NAV.fix=NAV.realFix; NAV.head=null; NAV.lastXY=null; } } NAV.s=null; NAV.next=null; try{ wake&&wake.release(); }catch(e){} wake=null;
  $('bar').hidden=$('mapCtl').hidden=$('banner').hidden=$('then').hidden=true; $('pocket').hidden=true; $('startSheet').hidden=false; store.set('rnActive',null); fitRoute(); }
// simulated run: walks the route at ~9 min/mile pace, sped up, with a little GPS wobble
// Simulated phone GPS: one fix a second (like a phone's GPS chip) at a steady ~9:00/mi pace times the preview speed,
// with slowly wandering error (a few metres), reported accuracy, course and speed.
const SIM_SPEEDS=[1,3,8,25];
const DEMO={t:null,s:0,mult:SIM_SPEEDS.includes(store.get('rnSimMult',3))?store.get('rnSimMult',3):3,last:0,ex:0,ey:0};
const gauss=()=>{ let u=0,v=0; while(!u) u=Math.random(); while(!v) v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
function demoTick(){ if(!NAV.on||!NAV.demo){ clearInterval(DEMO.t); return; }
  const now=performance.now(), pace=2.98*DEMO.mult; DEMO.s+=pace*(now-DEMO.last)/1000; DEMO.last=now;
  DEMO.ex=DEMO.ex*0.85+gauss()*0.9; DEMO.ey=DEMO.ey*0.85+gauss()*0.9;          // drift, not white noise
  const [x,y]=pointAt(Math.min(DEMO.s,R.total)), hd=headAlong(Math.min(DEMO.s,R.total-1));
  const course=((90-hd*180/Math.PI+gauss()*4)%360+360)%360;
  onFix({lat:PROJ.lat0+(y+DEMO.ex)/PROJ.ky,lon:PROJ.lon0+(x+DEMO.ey)/PROJ.kx,acc:4+Math.abs(gauss())*3,heading:DEMO.s<R.total?course:null,speed:DEMO.s<R.total?pace*(1+gauss()*0.04):0,t:Date.now()});
  if(DEMO.s>R.total+30) clearInterval(DEMO.t); }
function runDemo(){ DEMO.s=0; DEMO.ex=DEMO.ey=0; DEMO.last=performance.now(); clearInterval(DEMO.t); simLabel(); demoTick(); DEMO.t=setInterval(demoTick,1000); }
const simLabel=()=>{ $('simChip').textContent=`Preview · ${DEMO.mult}×`; $('simChip').setAttribute('aria-label',`Preview speed ${DEMO.mult} times running pace. Tap to change.`); };
$('simChip').onclick=()=>{ const o=SIM_SPEEDS; DEMO.mult=o[(o.indexOf(DEMO.mult)+1)%o.length]||3; store.set('rnSimMult',DEMO.mult); simLabel(); toast(DEMO.mult===1?'Preview at running pace (about 9 min/mi).':`Preview at ${DEMO.mult}× running pace.`); };

/* ---------------- pocket mode ---------------- */
const PK=[0.65,1,1.9,3.2];
function setPocketLvl(v){ VOICE.pocketLvl=clamp(+v,0,3); store.set('rnPocketLvl',VOICE.pocketLvl); $('pocket').style.setProperty('--pk',PK[VOICE.pocketLvl]); $('mPocketLvl').value=$('piLvl').value=String(VOICE.pocketLvl); }
function askPocket(){ if(store.get('rnPocketIntroSeen',false)&&!store.get('rnPocketAlways',false)){ pocket(true); return; }
  $('piAgain').checked=store.get('rnPocketAlways',false); $('pocketIntro').hidden=$('scrim').hidden=false; $('piGo').focus(); }
const closePocketIntro=()=>{ $('pocketIntro').hidden=true; if($('menuSheet').hidden&&$('cueSheet').hidden) $('scrim').hidden=true; };
$('piGo').onclick=()=>{ store.set('rnPocketIntroSeen',true); store.set('rnPocketAlways',$('piAgain').checked); closePocketIntro(); pocket(true); };
$('piCancel').onclick=()=>{ closePocketIntro(); $('pocketBtn').focus(); };
$('piLvl').onchange=e=>setPocketLvl(e.target.value); $('mPocketLvl').onchange=e=>setPocketLvl(e.target.value);
function pocket(on){ $('pocket').hidden=!on; if(!on){ $('pocketBtn').focus(); animStart(); } if(on){ goFull(); $('hold').focus(); keepAwake(); pocketUpdate(); } }
function pocketUpdate(){ if($('pocket').hidden) return; const nc=NAV.next; if(!nc) return; $('pIc').innerHTML=arrowSvg(NAV.offOn?'OFF':nc.k); const [d,u]=NAV.offOn?['Off','route']:fmtDist(Math.max(0,nc.s-(NAV.s??0)));
  $('pDist').textContent=`${d} ${u}`; $('pTxt').textContent=NAV.offOn?'Head back to the route':cueText(nc); $('pStat').textContent=`${$('sDone').textContent} / ${(R.total/MI).toFixed(2)} mi · ${$('sTime').textContent}`;
  const now=nowPace(); $('pPace').textContent=`Pace now ${now||'–'} · avg ${$('sPace').textContent} /mi`; }
// current pace: smoothed GPS speed (in a preview, scaled back to running pace)
function nowPace(){ const v=NAV.v/(NAV.demo?DEMO.mult:1); return v>0.6?fmtTime(MI/v):''; }
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
(()=>{ const hd=$('cueHead'), sh=$('cueSheet'); let y0=null;
  hd.addEventListener('pointerdown',e=>{ if(e.target.closest('button')) return; y0=e.clientY; hd.setPointerCapture(e.pointerId); });
  hd.addEventListener('pointermove',e=>{ if(y0==null) return; const dy=Math.max(0,e.clientY-y0); sh.style.transform=`translateY(${dy}px)`; });
  const up=e=>{ if(y0==null) return; const dy=e.clientY-y0; y0=null; sh.style.transform=''; if(dy>70) closeCues(); };
  hd.addEventListener('pointerup',up); hd.addEventListener('pointercancel',up); })();
$('cuesBtn').onclick=e=>openCues(e.currentTarget); $('cuesBtn2').onclick=e=>openCues(e.currentTarget); $('cueClose').onclick=closeCues;

/* ---------------- full screen ---------------- */
// Browsers only allow it from a tap, so it goes full screen on Start (and on the first tap anywhere while running).
// iPhones don't offer full screen to web pages; adding Run Nav to the home screen gives the same thing there.
const fsEl=document.documentElement, fsOK=!!(fsEl.requestFullscreen||fsEl.webkitRequestFullscreen)&&document.fullscreenEnabled!==false;
const isFull=()=>!!(document.fullscreenElement||document.webkitFullscreenElement);
function goFull(){ if(!fsOK||isFull()) return; try{ const p=(fsEl.requestFullscreen||fsEl.webkitRequestFullscreen).call(fsEl,{navigationUI:'hide'}); p&&p.catch&&p.catch(()=>{}); }catch(e){} }
function exitFull(){ try{ (document.exitFullscreen||document.webkitExitFullscreen).call(document); }catch(e){} }
const fsUI=()=>{ $('fFull').textContent=isFull()?'Leave full screen':'Full screen'; $('fFullMap').setAttribute('aria-pressed',String(isFull())); $('fFullMap').setAttribute('aria-label',isFull()?'Leave full screen':'Full screen'); document.documentElement.classList.toggle('fs',isFull()); vvInset(); };
$('fFull').hidden=$('fFullMap').hidden=!fsOK; $('fFullMap').onclick=()=>{ if(isFull()) exitFull(); else { fsAuto=true; goFull(); } }; $('fFull').onclick=()=>{ closeMenu(); if(isFull()) exitFull(); else { fsAuto=true; goFull(); } };
let fsAuto=true;   // once you leave full screen yourself, taps stop putting it back
const fsChange=()=>{ fsUI(); if(!isFull()) fsAuto=false; };
document.addEventListener('fullscreenchange',fsChange); document.addEventListener('webkitfullscreenchange',fsChange);
document.addEventListener('pointerdown',()=>{ if(NAV.on&&fsAuto) goFull(); },{capture:true});

/* ---------------- wiring ---------------- */
$('goBtn').onclick=()=>{ fsAuto=true; goFull(); begin(false); };
$('demoBtn').onclick=()=>{ fsAuto=true; goFull(); begin(true); };
$('otherBtn').onclick=openElsewhere; $('mOther').onclick=()=>{ closeMenu(); openElsewhere(); };
$('pocketBtn').onclick=askPocket;
$('fFollow').onclick=()=>setFollow(true);
$('fAll').onclick=()=>{ closeMenu(); setFollow(false); fitRoute(); };
const setHead=on=>{ MAP.headUp=on; $('fHead').setAttribute('aria-pressed',String(on)); $('fHead').setAttribute('aria-label',on?'Map turns with you. Tap to face north.':'Map faces north. Tap to turn the map with you.'); $('mHead').checked=on; store.set('rnHead',on); if(!on) MAP.rot=0;
  if(NAV.on) setFollow(true); else drawFollow(); };   // switching modes always re-centres on you
$('fHead').onclick=()=>setHead(!MAP.headUp); $('mHead').onchange=e=>setHead(e.target.checked);
const setVoice=on=>{ VOICE.on=on; store.set('rnVoice',on); $('mVoice').checked=on; if(!on) try{ speechSynthesis.cancel(); }catch(e){} };
$('mVoice').onchange=e=>setVoice(e.target.checked);
$('mMiles').onchange=e=>{ VOICE.miles=e.target.checked; store.set('rnMiles',VOICE.miles); }; $('mMiles').checked=VOICE.miles;
const leadLabel=()=>{ $('mLeadV').textContent=VOICE.leadFt?`${VOICE.leadFt} ft before`:'At the turn'; };
$('mLead').value=VOICE.leadFt; leadLabel();
$('mLead').addEventListener('input',e=>{ VOICE.leadFt=+e.target.value; store.set('rnLeadFt',VOICE.leadFt); leadLabel(); });
$('mFx').value=FX.kind; $('mFx').onchange=e=>{ FX.kind=e.target.value; store.set('rnFx',FX.kind); PART.list=[]; SURGE.list=[]; SURGE.arcs=[]; GRIND.list=[]; drawOverlay(); };
$('mThen').checked=VOICE.thenNext; $('mThen').onchange=e=>{ VOICE.thenNext=e.target.checked; store.set('rnThenNext',VOICE.thenNext); };
$('mHaptic').checked=VOICE.haptic; $('mHaptic').onchange=e=>{ VOICE.haptic=e.target.checked; store.set('rnHaptic',VOICE.haptic); if(VOICE.haptic) buzz([260,110,260]); };
if(!('vibrate' in navigator)){ $('mHaptic').disabled=true; $('mHapticNote').textContent='This phone doesn\'t let web pages vibrate (iPhones don\'t).'; }
const closeMenu=()=>{ $('menuSheet').hidden=$('scrim').hidden=true; $('menuBtn').focus(); };
$('menuBtn').onclick=()=>{ $('menuSheet').hidden=$('scrim').hidden=false; $('mVoice').focus(); }; $('mClose').onclick=closeMenu; $('scrim').onclick=()=>{ closeMenu(); closeCues(); closePocketIntro(); };
$('mEnd').onclick=()=>{ if(NAV.s>50&&!NAV.done&&!confirm('End this run? Your progress will be cleared.')) return; closeMenu(); end(); };
$('mRestart').onclick=()=>{ if(NAV.s>50&&!NAV.done&&!confirm('Restart from the beginning? Your progress will be cleared.')) return; closeMenu(); const d=NAV.demo; end(); begin(d); };
$('mShare').onclick=()=>{ closeMenu(); openShare(); };
setVoice(VOICE.on); setHead(store.get('rnHead',false)); setPocketLvl(VOICE.pocketLvl);
document.addEventListener('keydown',e=>{ if(e.key!=='Escape') return; if(!$('pocketIntro').hidden){ closePocketIntro(); return; } if(!$('cueSheet').hidden) closeCues(); else if(!$('menuSheet').hidden) closeMenu(); });

(async()=>{ resize();
  try{ const r=await routeFromHash(location.hash); if(r){ load(r); return; } }catch(e){ toast('That route link looks damaged. Ask for a fresh link or open the GPX file.',6000); }
  showLanding(); MAP.lat=45.52; MAP.lon=-122.65; MAP.zf=12; draw(); })();
addEventListener('hashchange',async()=>{ try{ const r=await routeFromHash(location.hash); if(r){ if(NAV.on) end(); load(r); } }catch(e){} });
if('serviceWorker' in navigator && location.protocol==='https:') navigator.serviceWorker.register('sw.js').catch(()=>{});
