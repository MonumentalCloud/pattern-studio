/* Paper/card sheet layout. Geometry stays in cm until export. */
(function(root,factory){
  if(typeof module!=='undefined'&&module.exports)module.exports=factory(require('./geometry.js'),require('./dxf.js'),require('./strokefont.js'));
  else root.SheetPlanner=factory(root.Geo,root.DXF,root.StrokeFont);
})(typeof self!=='undefined'?self:this,function(Geo,DXF,StrokeFont){
  'use strict';
  const EPS=1e-8;
  const point=(x,y)=>({x,y});
  const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const near=(a,b)=>Geo.dist(a,b)<EPS;
  const ringArea=pts=>Math.abs(Geo.polyArea(pts));
  const blank=()=>({polylines:[],lines:[],circles:[]});
  function segments(pts,closed){return pts.slice(closed?0:1).map((_,i)=>[pts[i],pts[(i+1)%pts.length]]);}
  function onRing(r,p){return segments(r,true).some(([a,b])=>Math.abs(cross(a,b,p))<EPS && p.x>=Math.min(a.x,b.x)-EPS && p.x<=Math.max(a.x,b.x)+EPS && p.y>=Math.min(a.y,b.y)-EPS && p.y<=Math.max(a.y,b.y)+EPS);}
  const inside=(r,p)=>Geo.pointInPolygon(r,p)||onRing(r,p);
  function rectRing(b){return [point(b.minX,b.minY),point(b.maxX,b.minY),point(b.maxX,b.maxY),point(b.minX,b.maxY)];}
  function clipSegment(a,b,r){
    let lo=0,hi=1;const dx=b.x-a.x,dy=b.y-a.y;
    for(const [p,q] of [[-dx,a.x-r.minX],[dx,r.maxX-a.x],[-dy,a.y-r.minY],[dy,r.maxY-a.y]]){
      if(Math.abs(p)<EPS){if(q<-EPS)return null;continue;}
      const t=q/p;if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);
      if(lo>hi-EPS)return null;
    }
    return [point(a.x+lo*dx,a.y+lo*dy),point(a.x+hi*dx,a.y+hi*dy)];
  }
  function lineCuts(a,b,rings){
    const ts=[0,1],dx=b.x-a.x,dy=b.y-a.y;
    for(const ring of rings)for(const [c,d] of segments(ring,true)){
      const ex=d.x-c.x,ey=d.y-c.y,den=dx*ey-dy*ex;
      if(Math.abs(den)<EPS){
        if(Math.abs(cross(a,b,c))<EPS){
          for(const p of [c,d])ts.push(Math.abs(dx)>Math.abs(dy)?(p.x-a.x)/dx:(p.y-a.y)/dy);
        }
      }else{
        const t=((c.x-a.x)*ey-(c.y-a.y)*ex)/den,u=((c.x-a.x)*dy-(c.y-a.y)*dx)/den;
        if(u>=-EPS&&u<=1+EPS)ts.push(t);
      }
    }
    return ts.filter(t=>Number.isFinite(t)&&t>=0&&t<=1).sort((a,b)=>a-b).filter((t,i,all)=>!i||t-all[i-1]>EPS);
  }
  function materialSpans(a,b,outer,holes=[]){
    const ts=lineCuts(a,b,[outer,...holes]),out=[];
    const at=t=>point(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t);
    for(let i=1;i<ts.length;i++){
      const mid=at((ts[i-1]+ts[i])/2);
      if(inside(outer,mid)&&!holes.some(h=>inside(h,mid)))out.push([at(ts[i-1]),at(ts[i])]);
    }
    return out;
  }
  // Clip boundary segments and close them along material spans of the rectangle.
  // Keeping a graph rather than one Sutherland-Hodgman ring preserves islands.
  function clipRing(outer,rect){
    const edges=[],border=rectRing(rect);
    for(const [a,b] of segments(outer,true)){
      const cut=clipSegment(a,b,rect);if(!cut)continue;
      if(segments(border,true).some(([c,d])=>onRing([c,d],cut[0])&&onRing([c,d],cut[1])))continue;
      edges.push(cut);
    }
    for(const [a,b] of segments(border,true))edges.push(...materialSpans(a,b,outer));
    const nodes=[];
    function vertex(p){let i=nodes.findIndex(n=>near(n.p,p));if(i<0){i=nodes.length;nodes.push({p,edges:[]});}return i;}
    const links=[];
    for(const [a,b] of edges){
      if(near(a,b))continue;const x=vertex(a),y=vertex(b);
      if(links.some(e=>(e.x===x&&e.y===y)||(e.x===y&&e.y===x)))continue;
      const id=links.length;links.push({x,y,used:false});nodes[x].edges.push(id);nodes[y].edges.push(id);
    }
    const loops=[];
    for(let i=0;i<links.length;i++){
      if(links[i].used)continue;
      const start=links[i].x,pts=[];let cur=start,id=i;
      do{
        const e=links[id];if(e.used)throw new Error('Cannot resolve a touching split boundary. Move the split by changing the sheet size or margin.');
        e.used=true;pts.push(nodes[cur].p);cur=e.x===cur?e.y:e.x;
        if(cur===start)break;
        const next=nodes[cur].edges.filter(j=>!links[j].used);
        if(next.length!==1)throw new Error('Cannot resolve a touching split boundary. Change the sheet size or margin.');
        id=next[0];
      }while(cur!==start);
      if(pts.length>=3&&ringArea(pts)>EPS)loops.push(pts);
    }
    return loops;
  }
  function circleRing(c){
    // Same 0.1mm geometric tolerance as the existing curve exporter.
    const n=Math.max(8,Math.ceil(Math.PI/Math.acos(Math.max(-1,1-.01/c.r))));
    return Array.from({length:n},(_,i)=>point(c.c.x+c.r*Math.cos(i*2*Math.PI/n),c.c.y+c.r*Math.sin(i*2*Math.PI/n)));
  }
  function clipShapes(s,rect){
    const out=blank();
    for(const pl of s.polylines){
      if(pl.pts.every(p=>p.x>=rect.minX-EPS&&p.x<=rect.maxX+EPS&&p.y>=rect.minY-EPS&&p.y<=rect.maxY+EPS))out.polylines.push(pl);
      else for(const [a,b] of segments(pl.pts,pl.closed)){const seg=clipSegment(a,b,rect);if(seg)out.lines.push({layer:pl.layer,a:seg[0],b:seg[1]});}
    }
    for(const l of s.lines){const seg=clipSegment(l.a,l.b,rect);if(seg)out.lines.push({layer:l.layer,a:seg[0],b:seg[1]});}
    for(const c of s.circles){
      if(c.c.x-c.r>=rect.minX-EPS&&c.c.x+c.r<=rect.maxX+EPS&&c.c.y-c.r>=rect.minY-EPS&&c.c.y+c.r<=rect.maxY+EPS)out.circles.push(c);
      else for(const [a,b] of segments(circleRing(c),true)){const seg=clipSegment(a,b,rect);if(seg)out.lines.push({layer:c.layer,a:seg[0],b:seg[1]});}
    }
    return out;
  }
  function transformShapes(s,fn){
    return {polylines:s.polylines.map(p=>({...p,pts:p.pts.map(fn)})),lines:s.lines.map(l=>({...l,a:fn(l.a),b:fn(l.b)})),circles:s.circles.map(c=>({...c,c:fn(c.c)}))};
  }
  function merge(a,b){a.polylines.push(...b.polylines);a.lines.push(...b.lines);a.circles.push(...b.circles);}
  function allPoints(s){return [...s.polylines.flatMap(p=>p.pts),...s.lines.flatMap(l=>[l.a,l.b]),...s.circles.flatMap(c=>[point(c.c.x-c.r,c.c.y-c.r),point(c.c.x+c.r,c.c.y+c.r)])];}
  function addLabel(shapes,value,at,outer,holes,rect) {
    const strokes=StrokeFont.strokes(value,at,.25,'center');
    for(const pts of strokes){
      if(pts.some(p=>p.x<rect.minX-EPS||p.x>rect.maxX+EPS||p.y<rect.minY-EPS||p.y>rect.maxY+EPS))return false;
      for(const [a,b] of segments(pts,false)){
        const spans=materialSpans(a,b,outer,holes);
        if(spans.reduce((n,[c,d])=>n+Geo.dist(c,d),0)<Geo.dist(a,b)-EPS)return false;
      }
    }
    for(const pts of strokes)shapes.polylines.push({layer:'MARK',pts,closed:false});
    return true;
  }
  function sectionLabel(shape,id,loop,rect,outer,holes){
    const p=Geo.labelBox(loop);
    if(addLabel(shape,id,point(p.x,p.y+.125),outer,holes,rect))return true;
    const ys=[rect.minY+.25,rect.maxY-.25,...loop.map(p=>p.y),...holes.flatMap(r=>r.map(p=>p.y))].filter(y=>y>=rect.minY&&y<=rect.maxY).sort((a,b)=>a-b);
    const candidates=ys.slice(1).map((y,i)=>(y+ys[i])/2);
    for(const y of candidates)for(const [a,b] of materialSpans(point(rect.minX,y),point(rect.maxX,y),loop,holes)){
      if(addLabel(shape,id,point((a.x+b.x)/2,y+.125),outer,holes,rect))return true;
    }
    return false;
  }
  function joinMarks(s,rect,box,outer,holes,pieceNo,row,col){
    const joins=[];
    for(const [side,axis,value,a,b,dir] of [
      ['L','V',rect.minX,point(rect.minX,rect.minY),point(rect.minX,rect.maxY),point(1,0)],
      ['R','V',rect.maxX,point(rect.maxX,rect.minY),point(rect.maxX,rect.maxY),point(-1,0)],
      ['T','H',rect.minY,point(rect.minX,rect.minY),point(rect.maxX,rect.minY),point(0,1)],
      ['B','H',rect.maxY,point(rect.minX,rect.maxY),point(rect.maxX,rect.maxY),point(0,-1)]]){
      if((axis==='V'&&(Math.abs(value-box.minX)<EPS||Math.abs(value-box.maxX)<EPS))||(axis==='H'&&(Math.abs(value-box.minY)<EPS||Math.abs(value-box.maxY)<EPS)))continue;
      for(const [c,d] of materialSpans(a,b,outer,holes)){
        // Existing outline on this boundary already cuts the material once.
        const mid=point((c.x+d.x)/2,(c.y+d.y)/2);
        if(onRing(outer,mid))continue;
        s.lines.push({layer:'CUT',a:c,b:d});
        const id=`${pieceNo}${axis}${axis==='V'?(side==='L'?col:col+1):(side==='T'?row:row+1)}.${axis==='V'?row+1:col+1}`;
        joins.push({id,side,a:c,b:d});
        if(!addLabel(s,id,point(mid.x+dir.x*.75,mid.y+dir.y*.55+.125),outer,holes,rect))s.missingLabels.push(id);
        for(const t of [1/3,2/3]){
          const p=point(c.x+(d.x-c.x)*t,c.y+(d.y-c.y)*t),q=point(p.x+dir.x*.35,p.y+dir.y*.35);
          for(const [u,v] of materialSpans(p,q,outer,holes))s.lines.push({layer:'MARK',a:u,b:v});
        }
      }
    }
    return joins;
  }
  async function makeItems(sources,w,h,turned,yieldWork){
    const items=[];
    for(const src of sources){
      const box=Geo.bbox(src.outer),bw=box.maxX-box.minX,bh=box.maxY-box.minY;
      const tw=turned?h:w,th=turned?w:h;
      // Keep an unbroken piece whenever a quarter turn already fits it.
      const fits=(bw<=w+EPS&&bh<=h+EPS)||(bw<=h+EPS&&bh<=w+EPS);
      const cols=fits?1:Math.ceil(bw/tw-EPS),rows=fits?1:Math.ceil(bh/th-EPS);
      const dx=bw/cols,dy=bh/rows;
      for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
        await yieldWork();
        const rect={minX:box.minX+col*dx,minY:box.minY+row*dy,maxX:box.minX+(col+1)*dx,maxY:box.minY+(row+1)*dy};
        const loops=cols*rows===1?[src.outer]:clipRing(src.outer,rect);if(!loops.length)continue;
        let shape=clipShapes(src.shape,rect);shape.missingLabels=[];const id=`${src.no}.${row+1}.${col+1}`;
        const joins=cols*rows===1?[]:joinMarks(shape,rect,box,src.outer,src.holes,src.no,row,col);
        // Each disconnected island carries its section number, also shown on the assembly map.
        if(cols*rows>1)for(const loop of loops)if(!sectionLabel(shape,id,loop,rect,src.outer,src.holes))shape.missingLabels.push(id);
        const missingLabels=shape.missingLabels;
        shape=clipShapes(shape,rect);
        const bounds=Geo.bbox(allPoints(shape)),norm=p=>point(p.x-bounds.minX,p.y-bounds.minY);
        items.push({id,piece:src.no,name:src.name,split:cols*rows>1,sourceRect:rect,joins,missingLabels,shape:transformShapes(shape,norm),loops:loops.map(r=>r.map(norm)),w:bounds.maxX-bounds.minX,h:bounds.maxY-bounds.minY,area:loops.reduce((n,r)=>n+ringArea(r),0)});
      }
    }
    return items;
  }
  function rotate(item,angle){
    const fn=p=>angle===0?p:angle===90?point(item.h-p.y,p.x):angle===180?point(item.w-p.x,item.h-p.y):point(p.y,item.w-p.x);
    return {...item,angle,w:angle%180?item.h:item.w,h:angle%180?item.w:item.h,shape:transformShapes(item.shape,fn),loops:item.loops.map(r=>r.map(fn))};
  }
  function pointSegDist(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);}
  function overlaps(a,b,gap){
    if(a.x+a.w+gap<=b.x+EPS||b.x+b.w+gap<=a.x+EPS||a.y+a.h+gap<=b.y+EPS||b.y+b.h+gap<=a.y+EPS)return false;
    for(const ra of a.loops)for(const rb of b.loops){
      if(ra.some(p=>Geo.pointInPolygon(rb,p))||rb.some(p=>Geo.pointInPolygon(ra,p)))return true;
      for(const [p,q] of segments(ra,true))for(const [r,s] of segments(rb,true)){
        if(cross(p,q,r)*cross(p,q,s)<-EPS&&cross(r,s,p)*cross(r,s,q)<-EPS)return true;
        const dist=Math.min(pointSegDist(p,r,s),pointSegDist(q,r,s),pointSegDist(r,p,q),pointSegDist(s,p,q));
        if(dist<gap-EPS||dist<EPS)return true;
      }
    }
    return false;
  }
  function placed(item,x,y){const fn=p=>point(p.x+x,p.y+y);return {...item,x,y,loops:item.loops.map(r=>r.map(fn)),shape:transformShapes(item.shape,fn)};}
  async function pack(items,width,height,margin,gap,order,yieldWork){
    const sheets=[];
    const sorted=items.slice().sort((a,b)=>(order==='area'?b.area-a.area:Math.max(b.w,b.h)-Math.max(a.w,a.h))||a.id.localeCompare(b.id));
    for(const item of sorted){
      await yieldWork();let chosen=null;
      for(let si=0;si<=sheets.length;si++){
        const sheet=sheets[si]||[];
        for(const angle of [0,90,180,270]){
          const r=rotate(item,angle);if(r.w>width-2*margin+EPS||r.h>height-2*margin+EPS)continue;
          const xs=new Set([margin]),ys=new Set([margin]);
          for(const p of sheet){for(const x of [p.x,p.x+p.w+gap,p.x-r.w-gap])if(x>=margin-EPS)xs.add(x);for(const y of [p.y,p.y+p.h+gap,p.y-r.h-gap])if(y>=margin-EPS)ys.add(y);}
          for(const y of [...ys].sort((a,b)=>a-b)){await yieldWork();for(const x of [...xs].sort((a,b)=>a-b)){
            if(x+r.w>width-margin+EPS||y+r.h>height-margin+EPS)continue;
            if(chosen&&(y>chosen.y+EPS||(Math.abs(y-chosen.y)<EPS&&x>=chosen.x)))continue;
            const p=placed(r,x,y);if(sheet.some(b=>overlaps(p,b,gap)))continue;
            chosen={...p,sheet:si};
          }}
        }
        if(chosen)break;
      }
      if(!chosen)throw new Error(`Section ${item.id} does not fit. Increase sheet/bed size or reduce the edge margin.`);
      if(!sheets[chosen.sheet])sheets.push([]);sheets[chosen.sheet].push(chosen);
    }
    return sheets;
  }
  function settings(input){
    const out={};
    for(const key of ['bedWidth','bedHeight','paperWidth','paperHeight','margin','gap']){
      const n=Number(input[key]);if(input[key]==null||String(input[key]).trim()===''||!Number.isFinite(n)||(key==='margin'||key==='gap'?n<0:n<=0))throw new Error('Enter positive bed/paper dimensions and non-negative margin/gap, in mm.');out[key]=n/10;
    }
    out.width=Math.min(out.bedWidth,out.paperWidth);out.height=Math.min(out.bedHeight,out.paperHeight);
    if(out.width<=2*out.margin||out.height<=2*out.margin)throw new Error('The edge margin leaves no cutting area.');
    return out;
  }
  async function plan(doc,input,opts={},yieldWork=async()=>{}){
    const cfg=settings(input),sources=[],guides=[],warnings=[];
    for(const piece of doc.pieces){
      if(piece.visible===false||piece.path.nodes.length<2)continue;
      const s=DXF.pieceShapes(piece,opts);
      if((s.texts||[]).length)throw new Error(`“${piece.name}” needs font-dependent text. Use Latin/Korean names or turn off name engraving for the sheet plan.`);
      if(piece.guide){guides.push(s);continue;}
      if(opts.labels&&piece.name&&!s.polylines.some(p=>p.layer==='MARK'&&!p.closed))warnings.push('Name too small for the existing 2.5 mm engraving minimum: '+piece.name+'.');
      if(!piece.path.closed)throw new Error(`“${piece.name}” is an open outline. Close it or hide it before planning.`);
      const outer=s.polylines.find(p=>p.layer==='CUT'&&p.closed)?.pts;
      if(!outer||ringArea(outer)<EPS)throw new Error(`“${piece.name}” has no usable closed cutting outline.`);
      const holes=s.polylines.filter(p=>p.layer==='CUT'&&p.closed&&p.pts!==outer).map(p=>p.pts).concat(s.circles.filter(c=>c.layer==='CUT').map(circleRing));
      sources.push({no:sources.length+1,name:piece.name||'Unnamed piece',shape:s,outer,holes});
    }
    if(!sources.length)throw new Error('No visible closed pattern pieces to plan.');
    // Scribed guides belong on the material beneath them, not on separate sheets.
    for(const src of sources)for(const guide of guides){
      const flat=blank();
      const add=(a,b,layer)=>{for(const [c,d] of materialSpans(a,b,src.outer,src.holes))flat.lines.push({layer,a:c,b:d});};
      for(const pl of guide.polylines)for(const [a,b] of segments(pl.pts,pl.closed))add(a,b,pl.layer);
      for(const l of guide.lines)add(l.a,l.b,l.layer);
      for(const c of guide.circles)for(const [a,b] of segments(circleRing(c),true))add(a,b,c.layer);
      merge(src.shape,flat);
    }
    if(guides.length)warnings.push('Visible guide geometry is scribed onto every panel it overlaps in your draft.');
    let best=null;
    for(const turned of [false,true]){
      const items=await makeItems(sources,cfg.width-2*cfg.margin,cfg.height-2*cfg.margin,turned,yieldWork);
      for(const order of ['area','long']){
        const sheets=await pack(items,cfg.width,cfg.height,cfg.margin,cfg.gap,order,yieldWork);
        const used=sheets.reduce((n,s)=>n+s.reduce((h,p)=>Math.max(h,p.y+p.h),0),0);
        if(!best||sheets.length<best.sheets.length||(sheets.length===best.sheets.length&&used<best.used))best={sheets,used};
      }
    }
    const missing=[...new Set(best.sheets.flatMap(s=>s.flatMap(p=>p.missingLabels)))];
    if(missing.length)warnings.push('Some 2.5 mm identifiers could not fit safely; use the assembly reference for: '+missing.join(', ')+'.');
    return {...best,...cfg,sources:sources.map(s=>({no:s.no,name:s.name,outer:s.outer})),warnings};
  }
  function sheetShapes(layout,index){const out=blank();for(const item of layout.sheets[index])merge(out,item.shape);return out;}
  function svgShapes(s,width,height){
    const n=x=>(x*10).toFixed(4),xy=p=>`${n(p.x)},${n(p.y)}`,color=l=>l==='CUT'?'#d00000':'#0044cc';
    let body='';
    for(const pl of s.polylines)body+=`<${pl.closed?'polygon':'polyline'} points="${pl.pts.map(xy).join(' ')}" stroke="${color(pl.layer)}"/>\n`;
    for(const l of s.lines)body+=`<line x1="${n(l.a.x)}" y1="${n(l.a.y)}" x2="${n(l.b.x)}" y2="${n(l.b.y)}" stroke="${color(l.layer)}"/>\n`;
    for(const c of s.circles)body+=`<circle cx="${n(c.c.x)}" cy="${n(c.c.y)}" r="${n(c.r)}" stroke="${color(c.layer)}"/>\n`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}mm" height="${n(height)}mm" viewBox="0 0 ${n(width)} ${n(height)}"><g fill="none" stroke-width="0.2">${body}</g></svg>`;
  }
  return {plan,settings,sheetShapes,svgShapes,clipRing,clipSegment,overlaps};
});
