/* Sheet planner dialog; the editor document is never written here. */
/* global SheetPlanner, DXF, KoreanFont */
(function(){
  'use strict';
  const $=id=>document.getElementById(id),dlg=$('sheet-planner');
  let snapshot,opts,filename,download,layout=null,index=0,busy=false,generation=0;
  const fields=['bedWidth','bedHeight','paperWidth','paperHeight','margin','gap'];
  const input=key=>$('plan-'+key);
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  function updateFramingHint(){
    $('plan-framing-note').hidden=$('plan-machine').value!=='20w';
    const margin=Number(input('margin').value);
    const position=Number.isFinite(margin)&&margin>=0?`Set the top of each batch to Y = ${(21.8+margin).toFixed(1)} mm to retain your edge margin.`:'Enter a valid edge margin before exporting.';
    $('plan-framing-note').textContent=`S1 20W white area: excludes the top 21.8 mm grey framing strip. xTool may centre imports. ${position} Keep size; do not scale to fit.`;
  }
  function invalidate(){updateFramingHint();layout=null;$('plan-results').hidden=true;$('plan-message').textContent='Settings changed. Arrange sheets to update the preview.';}
  function syncPaper(){if($('plan-paper').value==='bed'){input('paperWidth').value=input('bedWidth').value;input('paperHeight').value=input('bedHeight').value;}}
  for(const key of fields)input(key).addEventListener('input',()=>{if(key.startsWith('bed')){$('plan-machine').value='custom';syncPaper();}if(key.startsWith('paper'))$('plan-paper').value='custom';invalidate();});
  $('plan-machine').addEventListener('change',()=>{
    const preset=$('plan-machine').value;
    if(preset!=='custom'){input('bedWidth').value=498;input('bedHeight').value=preset==='20w'?308.2:preset==='20w-full'?330:319;syncPaper();}invalidate();
  });
  $('plan-paper').addEventListener('change',()=>{
    const preset=$('plan-paper').value;
    if(preset==='bed')syncPaper();
    else if(preset!=='custom'){const [w,h]=preset==='a4'?[297,210]:[420,297];input('paperWidth').value=w;input('paperHeight').value=h;}invalidate();
  });
  function showSheet(){
    $('plan-sheet').textContent=`Sheet ${index+1} of ${layout.sheets.length}`;
    $('plan-prev').disabled=index===0;$('plan-next').disabled=index===layout.sheets.length-1;
    const s=SheetPlanner.sheetShapes(layout,index);
    let svg=SheetPlanner.svgShapes(s,layout.width,layout.height);
    const titles=layout.sheets[index].map(p=>`<text x="${(p.x+p.w/2)*10}" y="${(p.y+p.h/2)*10}" text-anchor="middle" font-size="4" fill="#555">${esc(p.id)}</text>`).join('');
    svg=svg.replace('</svg>',titles+'</svg>');$('plan-preview').innerHTML=svg;
    $('plan-manifest').replaceChildren();
    for(const p of layout.sheets[index]){const li=document.createElement('li');li.textContent=`${p.id} — ${p.name}${p.split?' · join section':''} · turned ${p.angle}°`;$('plan-manifest').appendChild(li);}
  }
  function assemblySvg(){
    const pad=2.5,gap=4,sourceBoxes=layout.sources.map(s=>({s,bb:Geo.bbox(s.outer)}));
    let width=0,y=pad,body='';
    for(const {s,bb} of sourceBoxes){
      const w=bb.maxX-bb.minX,h=bb.maxY-bb.minY,dx=pad-bb.minX,dy=y-bb.minY;
      width=Math.max(width,w+2*pad);
      body+=`<g transform="translate(${dx} ${dy})"><polygon points="${s.outer.map(p=>`${p.x},${p.y}`).join(' ')}" fill="#edf2f7" stroke="#555" stroke-width=".05"/>`;
      for(const p of layout.sheets.flat().filter(p=>p.piece===s.no)){
        const r=p.sourceRect,x=(r.minX+r.maxX)/2,cy=(r.minY+r.maxY)/2;
        body+=`<rect x="${r.minX}" y="${r.minY}" width="${r.maxX-r.minX}" height="${r.maxY-r.minY}" fill="none" stroke="#999" stroke-dasharray=".2 .2" stroke-width=".03"/><text x="${x}" y="${cy}" font-size=".6" text-anchor="middle">${esc(p.id)} / S${p.sheet+1}</text>`;
        for(const j of p.joins){const x=(j.a.x+j.b.x)/2,cy=(j.a.y+j.b.y)/2;body+=`<text x="${x}" y="${cy}" font-size=".32" text-anchor="middle" fill="#0044cc">${esc(j.id)}</text>`;}
      }
      body+=`</g><text x="${pad}" y="${y-.7}" font-size=".65">${s.no} — ${esc(s.name)}</text>`;y+=h+gap;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width*10}mm" height="${y*10}mm" viewBox="0 0 ${width} ${y}"><rect width="100%" height="100%" fill="white"/>${body}</svg>`;
  }
  $('plan-run').addEventListener('click',async()=>{
    if(busy)return;busy=true;const run=++generation,active=()=>run===generation;layout=null;$('plan-results').hidden=true;
    $('plan-run').disabled=true;$('plan-settings').disabled=true;$('plan-message').textContent='Arranging sheets… You can cancel at any time.';
    let last=performance.now();
    const yieldWork=async()=>{if(!active())throw new Error('Planning cancelled.');if(performance.now()-last>16){await new Promise(r=>setTimeout(r,0));last=performance.now();if(!active())throw new Error('Planning cancelled.');}};
    try{
      if(opts.labels&&snapshot.pieces.some(p=>p.visible!==false&&!p.guide&&KoreanFont.needsFont(p.name)))await KoreanFont.load();
      if(!active())throw new Error('Planning cancelled.');
      const settings=Object.fromEntries(fields.map(key=>[key,input(key).value]));
      const result=await SheetPlanner.plan(snapshot,settings,opts,yieldWork);
      if(!active())return;layout=result;index=0;
      const sections=layout.sheets.flat(),splitPieces=new Set(sections.filter(p=>p.split).map(p=>p.piece)).size;
      $('plan-message').textContent=`${layout.sheets.length} sheet(s) · ${layout.sources.length} templates, each once · ${splitPieces} split template(s) · cutting area ${layout.width*10} × ${layout.height*10} mm. ${layout.warnings.join(' ')}`;
      $('plan-results').hidden=false;showSheet();$('plan-assembly').innerHTML=assemblySvg();$('plan-options').open=false;dlg.scrollTop=0;
    }catch(e){if(active())$('plan-message').textContent=e.message;}
    finally{if(active()){busy=false;$('plan-run').disabled=false;$('plan-settings').disabled=false;}}
  });
  $('plan-prev').addEventListener('click',()=>{index--;showSheet();});
  $('plan-next').addEventListener('click',()=>{index++;showSheet();});
  $('plan-svg').addEventListener('click',()=>{if(layout)download(`${filename}-sheet-${index+1}.svg`,SheetPlanner.svgShapes(SheetPlanner.sheetShapes(layout,index),layout.width,layout.height),'image/svg+xml');});
  $('plan-dxf').addEventListener('click',()=>{if(layout)download(`${filename}-sheet-${index+1}.dxf`,DXF.exportShapes([SheetPlanner.sheetShapes(layout,index)],{minX:0,minY:0,maxX:layout.width,maxY:layout.height}),'application/dxf');});
  function exportAll(format){
    if(!layout)return;
    try{
      const all=SheetPlanner.allSheets(layout,$('plan-export-gap').value);
      const data=format==='svg'?SheetPlanner.svgShapes(all.shape,all.width,all.height):DXF.exportShapes([all.shape],{minX:0,minY:0,maxX:all.width,maxY:all.height});
      download(`${filename}-all-sheets.${format}`,data,format==='svg'?'image/svg+xml':'application/dxf');
    }catch(e){$('plan-message').textContent=e.message;}
  }
  $('plan-all-dxf').addEventListener('click',()=>exportAll('dxf'));
  $('plan-all-svg').addEventListener('click',()=>exportAll('svg'));
  $('plan-map').addEventListener('click',()=>{if(layout)download(`${filename}-assembly-reference.svg`,assemblySvg(),'image/svg+xml');});
  $('plan-close').addEventListener('click',()=>dlg.close());
  dlg.addEventListener('close',()=>{generation++;busy=false;$('plan-run').disabled=false;$('plan-settings').disabled=false;});
  window.SheetPlannerUI={open(doc,exportOptions,name,save){
    if(busy)return;updateFramingHint();snapshot=JSON.parse(JSON.stringify(doc));opts={...exportOptions};filename=name;download=save;layout=null;
    $('plan-options').open=true;$('plan-results').hidden=true;$('plan-message').textContent='Each visible closed panel is used once. Hidden panels are excluded. Name engraving follows your Export setting.';dlg.showModal();
  }};
})();
