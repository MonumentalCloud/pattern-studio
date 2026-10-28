/* Browser loader/export caller regression checks; node test/export-labels.test.js. */
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const Geo=require('../js/geometry.js'),DXF=require('../js/dxf.js');
const KoreanFont=require('../js/koreanfont.js');
const node=(x,y)=>({x,y,hin:null,hout:null});
const fixture=()=>({name:'Korean export',pieces:[{name:'앞판 LB x1',visible:true,path:{closed:true,nodes:[node(0,0),node(20,0),node(20,12),node(0,12)]},cutouts:[],stitchSlits:[]}]});
async function main(){
  const scripts=[];
  const browser={Geo,URL,Promise,Error,document:{currentScript:{src:'https://example.test/js/koreanfont.js?v=84'},createElement:()=>({remove(){this.removed=true;}}),head:{appendChild:s=>scripts.push(s)}}};
  browser.self=browser;
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/koreanfont.js'),'utf8'),browser);
  assert.equal(scripts.length,0);
  const first=browser.KoreanFont.load(),shared=browser.KoreanFont.load();assert.strictEqual(first,shared);assert.equal(scripts.length,1);
  assert.equal(scripts[0].src,'https://example.test/js/korean-glyphs.js?v=84');
  scripts[0].onerror();await assert.rejects(first,/retry the export/);assert(scripts[0].removed);
  const retry=browser.KoreanFont.load();assert.equal(scripts.length,2);
  browser.KoreanGlyphs={'가':'M0 0L1 0L0 1Z'};scripts[1].onload();await retry;
  assert(browser.KoreanFont.supports('가'));await browser.KoreanFont.load();assert.equal(scripts.length,2);

  const source=fs.readFileSync(require.resolve('../js/app.js'),'utf8');
  for(const format of ['DXF','SVG']){
    const fields={'ex-labels':{checked:true},'ex-label-h':{value:'.8'},'status-hint':{}};
    const files=[],alerts=[];let resolveFont,loadCalls=0;
    const ctx={Geo,DXF,doc:fixture(),$:id=>fields[id],KoreanFont:{needsFont:KoreanFont.needsFont,load:()=>{loadCalls++;return new Promise(resolve=>resolveFont=resolve);}},safeName:()=>ctx.doc.name,download:(name,data)=>files.push({name,data}),alert:m=>alerts.push(m),esc:v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;')};
    vm.runInNewContext(source.slice(source.indexOf('  function exportOpts('),source.indexOf('  /* global DXFImport */')),ctx);
    const snapshot=JSON.stringify(ctx.doc),exporting=ctx['export'+format]();assert.equal(files.length,0);assert.equal(loadCalls,1);
    // Font loading must not change which document/version the click exports.
    ctx.doc.name='Changed while loading';ctx.doc.pieces[0].path.nodes[1].x=30;resolveFont();await exporting;
    assert.equal(files.length,1);assert.equal(files[0].name,'Korean export.'+format.toLowerCase());assert.equal(alerts.length,0);
    const initial=JSON.parse(snapshot);
    if(format==='DXF')assert.equal(files[0].data,DXF.exportDXF(initial,{labels:true,labelHeight:.8}));
    else {assert(!files[0].data.includes('<text '));assert(files[0].data.includes('stroke="#0044cc"'));assert(files[0].data.includes('width="220.00mm"'));}
    assert.match(fields['status-hint'].textContent,/engraving paths/);
    ctx.doc=fixture();files.length=0;ctx.KoreanFont.load=async()=>{throw new Error('Font could not load; retry export');};
    await ctx['export'+format]();assert.equal(files.length,0);assert.equal(alerts.length,1);assert.match(fields['status-hint'].textContent,/could not load/);
    ctx.KoreanFont.load=async()=>{};await ctx['export'+format]();assert.equal(files.length,1);
    files.length=0;fields['ex-labels'].checked=false;ctx.KoreanFont.load=()=>assert.fail('Labels-off must not load Korean font');
    await ctx['export'+format]();assert.equal(files.length,1);
    if(format==='DXF')assert.equal(files[0].data,DXF.exportDXF(ctx.doc,{labels:false,labelHeight:.8}));
    else assert(!files[0].data.includes('#0044cc'));
    fields['ex-labels'].checked=true;ctx.doc.pieces[0].name='FRONT PANEL';files.length=0;
    await ctx['export'+format]();assert.equal(files.length,1);
  }
  console.log('Korean font lazy load, failure/retry, DXF/SVG caller snapshots, ASCII and labels-off checks passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
