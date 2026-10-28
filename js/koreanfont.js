/* Korean engraving contours from the bundled OFL font data, loaded on demand. */
(function(root,factory){
  if(typeof module!=='undefined'&&module.exports)module.exports=factory(require('./geometry.js'),require('./korean-glyphs.js'));
  else {
    const url=new URL('korean-glyphs.js',document.currentScript.src);
    url.search=new URL(document.currentScript.src).search;
    root.KoreanFont=factory(root.Geo,null,()=>new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=url.href;
      script.onload=()=>{script.remove();resolve(root.KoreanGlyphs);};
      script.onerror=()=>{script.remove();reject(new Error('Could not load Korean engraving outlines. Please retry the export.'));};
      document.head.appendChild(script);
    }));
  }
})(typeof self!=='undefined'?self:this,function(Geo,initialGlyphs,loadGlyphs){
  'use strict';
  let glyphs=initialGlyphs,loading=null;
  const ADVANCE=1.05;
  function needsFont(str){return /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff]/u.test(str);}
  function load(){
    if(glyphs)return Promise.resolve();
    if(!loading)loading=loadGlyphs().then(data=>{
      if(!data)throw new Error('Korean engraving outline data is unavailable. Please retry the export.');
      glyphs=data;
    }).catch(error=>{loading=null;throw error;});
    return loading;
  }
  function supports(ch){return !!glyphs && Object.prototype.hasOwnProperty.call(glyphs,ch);}
  function strokes(ch,origin,height){
    if(!supports(ch))throw new Error('Korean engraving glyph is unavailable.');
    const tokens=glyphs[ch].match(/[MLQZ]|-?\d+/g),out=[];
    let i=0,path=null;
    const point=()=>({x:origin.x+Number(tokens[i++])*height/1000,y:origin.y-(Number(tokens[i++])+100)*height/1000});
    while(i<tokens.length){
      const op=tokens[i++];
      if(op==='M'){path=[point()];out.push(path);}
      else if(op==='L')path.push(point());
      else if(op==='Q'){
        const a=path[path.length-1],q=point(),b=point();
        path.push(...Geo.flattenCubic(a,Geo.lerp(a,q,2/3),Geo.lerp(b,q,2/3),b,.01).slice(1));
      } else if(op==='Z'){
        if(Geo.dist(path[0],path[path.length-1])>0)path.push({...path[0]});
      } else throw new Error('Invalid Korean engraving outline command.');
    }
    return out;
  }
  return {load,needsFont,supports,strokes,ADVANCE};
});
