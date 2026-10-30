const assert=require('assert');
const Geo=require('../js/geometry.js'),DXF=require('../js/dxf.js'),P=require('../js/sheetplanner.js');
const pt=(x,y)=>({x,y});
const piece=(name,pts)=>({name,path:{nodes:pts.map(([x,y])=>pt(x,y)),closed:true}});
const rect=(name,x,y,w,h)=>piece(name,[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]);
const cfg={bedWidth:498,bedHeight:330,paperWidth:498,paperHeight:330,margin:5,gap:3};
const area=loops=>loops.reduce((n,r)=>n+Math.abs(Geo.polyArea(r)),0);
const items=p=>p.sheets.flat();
async function main(){
  const doc={pieces:[rect('Front x2',0,0,20,25),rect('Back x4',35,0,20,25)]},before=JSON.stringify(doc);
  let p=await P.plan(doc,cfg);assert.equal(items(p).length,2);assert.equal(p.sheets.length,1);assert.equal(JSON.stringify(doc),before);
  assert(items(p).every(i=>!i.split));assert.equal(new Set(items(p).map(i=>i.piece)).size,2);
  const square={pieces:[rect('White area fit',0,0,30,30)]},squareBefore=JSON.stringify(square);
  const full=await P.plan(square,cfg),white=await P.plan(square,{...cfg,bedHeight:308.2,paperHeight:308.2});
  assert.equal(items(full).length,1);assert(items(white).length>1);
  assert(items(white).every(i=>i.w<=48.8+1e-8&&i.h<=29.82+1e-8));
  assert(Math.abs(items(white).reduce((n,i)=>n+i.area,0)-900)<1e-7);assert.equal(JSON.stringify(square),squareBefore);
  const many={pieces:[rect('One',0,0,48,31),rect('Two',60,0,48,31),rect('Three',120,0,48,31)]};
  many.pieces[1].holes=[{x:70,y:8,r:.3}];
  const multi=await P.plan(many,cfg),saved=JSON.stringify(multi);
  assert.equal(multi.sheets.length,3);
  const combined=P.allSheets(multi,20);
  assert(Math.abs(combined.width-(49.8*3+4))<1e-8);assert.equal(combined.height,33);
  for(const kind of ['polylines','lines','circles'])assert.equal(combined.shape[kind].length,multi.sheets.reduce((n,_,i)=>n+P.sheetShapes(multi,i)[kind].length,0));
  const second=P.sheetShapes(multi,1).polylines[0].pts[0],secondOut=combined.shape.polylines[P.sheetShapes(multi,0).polylines.length].pts[0];
  assert(Math.abs(secondOut.x-second.x-51.8)<1e-8);assert.equal(secondOut.y,second.y);
  assert.equal(combined.shape.circles[0].r,.3);
  assert.equal(JSON.stringify(multi),saved);
  assert.equal(P.allSheets(multi,0).width,49.8*3);
  assert.throws(()=>P.allSheets(multi,-1),/non-negative/);assert.throws(()=>P.allSheets(multi,''),/non-negative/);
  const allSvg=P.svgShapes(combined.shape,combined.width,combined.height);assert(allSvg.includes('width="1534.0000mm"'));assert(!allSvg.includes('<rect'));
  const allDxf=DXF.exportShapes([combined.shape],{minX:0,minY:0,maxX:combined.width,maxY:combined.height});assert(allDxf.includes('1534.0000'));
  const wide={pieces:[rect('Long handle',4,7,120,7)]};
  p=await P.plan(wide,cfg);assert.equal(items(p).length,3);assert.equal(p.sheets.length,1);assert(Math.abs(items(p).reduce((n,i)=>n+i.area,0)-840)<1e-6);
  const joins=items(p).flatMap(i=>i.joins);assert(joins.length>0);
  const counts={};for(const j of joins)counts[j.id]=(counts[j.id]||0)+1;assert(Object.values(counts).every(n=>n===2));
  for(const sheet of p.sheets)for(const item of sheet){
    assert(item.x>=.5-1e-8&&item.y>=.5-1e-8);assert(item.x+item.w<=49.3+1e-8&&item.y+item.h<=32.5+1e-8);
    assert(item.shape.lines.some(l=>l.layer==='MARK'));
  }
  const svg=P.svgShapes(P.sheetShapes(p,0),p.width,p.height);assert(svg.includes('width="498.0000mm"'));assert(svg.includes('height="330.0000mm"'));assert(!svg.includes('<text'));
  const dxf=DXF.exportShapes([P.sheetShapes(p,0)],{minX:0,minY:0,maxX:p.width,maxY:p.height});assert(dxf.includes('498.0000'));assert(dxf.includes('330.0000'));
  // Concave C clipped through both arms gives separate islands, not a bridge.
  const c=[[0,0],[10,0],[10,2],[2,2],[2,8],[10,8],[10,10],[0,10]].map(([x,y])=>pt(x,y));
  const loops=P.clipRing(c,{minX:5,minY:0,maxX:10,maxY:10});assert.equal(loops.length,2);assert(Math.abs(area(loops)-20)<1e-7);
  assert.equal(P.clipRing(c,{minX:3,minY:3,maxX:7,maxY:7}).length,0);
  const boundary=P.clipRing(c,{minX:0,minY:0,maxX:10,maxY:10});assert(Math.abs(area(boundary)-52)<1e-6);
  // Fit by quarter turn rather than splitting.
  p=await P.plan({pieces:[rect('Turn',0,0,31,48)]},cfg);assert.equal(items(p).length,1);assert.equal(items(p)[0].angle%180,90);
  const panel=rect('Panel',0,0,90,20);panel.cutouts=[{nodes:[pt(43,4),pt(47,4),pt(47,12),pt(43,12)]}];
  panel.holes=[{x:45,y:15,r:.8}];panel.stitchSlits=[{free:true,x:45,y:2,ang:45,abs:true,len:1,width:.1}];
  const guide=piece('Scribed guide',[[10,5],[80,5],[80,6],[10,6]]);guide.guide=true;
  p=await P.plan({pieces:[panel,guide]},cfg);
  assert.equal(items(p).length,2);assert.equal(p.sources.length,1);assert(p.warnings.some(s=>s.includes('every panel')));
  // One ID identifies the entire tile-edge group, even across separate strips.
  const cutoutJoins=items(p).flatMap(i=>i.joins);
  assert(cutoutJoins.length>2);assert.equal(new Set(cutoutJoins.map(j=>j.id)).size,1);
  const left=cutoutJoins.filter(j=>j.side==='R'),right=cutoutJoins.filter(j=>j.side==='L');
  assert.equal(left.length,right.length);
  assert.deepEqual(left.map(j=>[j.a,j.b]),right.map(j=>[j.a,j.b]));
  // Join cuts must leave the cutout/circle/slot voids open.
  for(const i of items(p))for(const j of i.joins){const mid=pt((j.a.x+j.b.x)/2,(j.a.y+j.b.y)/2);assert(!Geo.pointInPolygon(panel.cutouts[0].nodes,mid));assert(Geo.dist(mid,panel.holes[0])>=.8-1e-7);}
  // Guides are projected onto both overlapping panels, without moving the draft.
  const a=rect('A',0,0,10,10),b=rect('B',0,0,10,10),g=piece('Guide',[[2,3],[8,3]]);g.guide=true;g.path.closed=false;
  p=await P.plan({pieces:[a,b,g]},cfg);assert.equal(items(p).length,2);assert(items(p).every(i=>i.shape.lines.some(l=>l.layer==='MARK'&&Math.abs(Geo.dist(l.a,l.b)-6)<1e-6)));
  p=await P.plan({pieces:[{...a,visible:false},b]},cfg);assert.equal(items(p).length,1);
  p=await P.plan({pieces:[rect('Paper',0,0,25,15)]},{...cfg,paperWidth:210,paperHeight:297});assert.equal(p.width,21);assert.equal(p.height,29.7);assert.equal(items(p).length,1);
  await assert.rejects(P.plan({pieces:[]},cfg),/No visible/);
  await assert.rejects(P.plan({pieces:[a]},{...cfg,margin:200}),/margin/);
  await assert.rejects(P.plan({pieces:[a]},{...cfg,gap:-1}),/non-negative/);
  await assert.rejects(P.plan({pieces:[{...a,path:{...a.path,closed:false}}]},cfg),/open outline/);
  await assert.rejects(P.plan({pieces:[a]},cfg,{},async()=>{throw new Error('Cancelled');}),/Cancelled/);
  await assert.rejects(P.plan({pieces:[{...a,name:'😀'}]},cfg,{labels:true}),/font-dependent/);
  // Analytic area coverage across a grid, including concave split cells.
  let total=0;for(let y=0;y<10;y+=2.5)for(let x=0;x<10;x+=2.5)total+=area(P.clipRing(c,{minX:x,minY:y,maxX:x+2.5,maxY:y+2.5}));assert(Math.abs(total-52)<1e-6);
  for(let k=1;k<=80;k++){
    const ring=Array.from({length:16},(_,i)=>{const a=i*Math.PI/8,r=2+Math.abs(Math.sin(i*17+k*13))*3;return pt(6+r*Math.cos(a),6+r*Math.sin(a));});
    let covered=0;
    for(let y=0;y<12;y+=3)for(let x=0;x<12;x+=3)covered+=area(P.clipRing(ring,{minX:x,minY:y,maxX:x+3,maxY:y+3}));
    assert(Math.abs(covered-Math.abs(Geo.polyArea(ring)))<1e-6,'Split coverage must conserve concave polygon area');
  }
  console.log('Sheet planner: exact-once, split coverage/islands, joins, fixed bounds/scale, quarter turns, cutouts/slots/circles, guide projection, paper dimensions, validation and cancellation passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
