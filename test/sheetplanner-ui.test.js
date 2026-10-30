/* Exercise the real dialog caller across cancel/reopen while font loading. */
const assert=require('assert'),fs=require('fs'),vm=require('vm');
async function main(){
  const elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{id,value:'',hidden:false,disabled:false,events:{},addEventListener(t,f){this.events[t]=f;},replaceChildren(){},appendChild(){},showModal(){this.open=true;},close(){this.open=false;this.events.close?.();}});return elements.get(id);};
  for(const [k,v] of Object.entries({bedWidth:498,bedHeight:330,paperWidth:498,paperHeight:330,margin:5,gap:3}))el('plan-'+k).value=String(v);
  let resolveFont;const font=new Promise(r=>resolveFont=r),calls=[];
  const downloads=[];
  const result={sheets:[[]],sources:[],warnings:[],width:49.8,height:33};
  const ctx={document:{getElementById:el,createElement:()=>el('li')},window:{},performance:{now:()=>0},setTimeout,Geo:{},KoreanFont:{needsFont:()=>true,load:()=>font},SheetPlanner:{plan:async(doc)=>{calls.push(doc.name);return result;},sheetShapes:()=>({}),allSheets:require('../js/sheetplanner.js').allSheets,svgShapes:()=>'<svg></svg>'},DXF:require('../js/dxf.js')};
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/sheetplanner-ui.js'),'utf8'),ctx);
  const UI=ctx.window.SheetPlannerUI;
  // Approved 20W default excludes the 21.8mm framing strip; full travel stays opt-in.
  el('plan-paper').value='bed';el('plan-machine').value='20w';el('plan-machine').events.change();
  assert.equal(Number(el('plan-bedHeight').value),308.2);assert.match(el('plan-framing-note').textContent,/Y = 26.8 mm/);assert.equal(Number(el('plan-paperHeight').value),308.2);
  el('plan-machine').value='20w-full';el('plan-machine').events.change();assert.equal(Number(el('plan-bedHeight').value),330);assert.equal(el('plan-framing-note').hidden,true);
  el('plan-machine').value='40w';el('plan-machine').events.change();assert.equal(Number(el('plan-bedHeight').value),319);
  el('plan-paper').value='a4';el('plan-paperWidth').value='297';el('plan-paperHeight').value='210';
  el('plan-machine').value='20w';el('plan-machine').events.change();assert.equal(Number(el('plan-paperHeight').value),210);
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert(/id="plan-bedHeight"[^>]*value="308.2"/.test(html));assert(/id="plan-paperHeight"[^>]*value="308.2"/.test(html));

  UI.open({name:'Old',pieces:[{name:'앞판'}]},{labels:true},'old',()=>{});
  const first=el('plan-run').events.click();assert(el('plan-run').disabled);
  el('sheet-planner').close();assert(!el('plan-run').disabled);
  UI.open({name:'New',pieces:[{name:'NEW'}]},{labels:false},'new',(...args)=>downloads.push(args));assert(el('sheet-planner').open);
  await el('plan-run').events.click();assert.deepEqual(calls,['New']);const message=el('plan-message').textContent;
  resolveFont();await first;assert.deepEqual(calls,['New']);assert.equal(el('plan-message').textContent,message);assert(!el('plan-run').disabled);
  el('plan-export-gap').value='20';
  el('plan-all-dxf').events.click();el('plan-all-svg').events.click();
  assert.equal(downloads.length,2);assert.equal(downloads[0][0],'new-all-sheets.dxf');assert.equal(downloads[1][0],'new-all-sheets.svg');
  assert(downloads[0][1].includes('498.0000'));assert.equal(downloads[1][1],'<svg></svg>');
  el('plan-export-gap').value='-1';el('plan-all-dxf').events.click();assert.equal(downloads.length,2);assert.match(el('plan-message').textContent,/non-negative/);
  // A later settings change hides all stale previews/exports.
  el('plan-gap').events.input();assert.equal(el('plan-results').hidden,true);el('plan-all-svg').events.click();assert.equal(downloads.length,2);
  console.log('Sheet planner UI: pending-font cancel/reopen, stale completion isolation, settings invalidation passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
