import fs from 'fs'; import path from 'path';
const root=process.argv[2];
const data=JSON.parse(fs.readFileSync('/tmp/icons/data.json','utf8'));
const names=new Set(data.map(d=>d.name));
const files=[];const walk=d=>{for(const n of fs.readdirSync(d)){const f=path.join(d,n);const st=fs.statSync(f);if(st.isDirectory()){if(!['test','vendor','i18n'].includes(n))walk(f)}else if(/\.(js|html)$/.test(n))files.push(f)}};
walk(path.join(root,'web'));
const src=files.map(f=>({f:path.relative(root,f),lines:fs.readFileSync(f,'utf8').split('\n')}));
// constants whose value is an icon name
const consts={};
for(const {f,lines} of src) lines.forEach((l,i)=>{for(const m of l.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*[:=]\s*['"]([a-z0-9-]+)['"]/g)){if(names.has(m[2])) (consts[m[1]]??=[]).push({icon:m[2],f,line:i+1,code:l.trim().slice(0,220)})}});
// keep constants that are used in an icon context somewhere
const iconCtx=/icon|Icon|ICON|ico\b|Btn|btn|glyph/;
for(const [C,defs] of Object.entries(consts)){
  const uses=[];
  for(const {f,lines} of src) lines.forEach((l,i)=>{if(new RegExp('\\b'+C+'\\b').test(l) && !(defs.some(d=>d.f===f&&d.line===i+1))) uses.push({f,line:i+1,code:l.trim().slice(0,220)})});
  const isIcon=/ICON|_IC\b|GLYPH/.test(C)||uses.some(u=>iconCtx.test(u.code));
  if(!isIcon) continue;
  for(const d of defs){const it=data.find(x=>x.name===d.icon);
    it.uses.push({f:d.f,line:d.line,code:d.code,via:C,kind:'def'});
    for(const u of uses) it.uses.push({...u,via:C})}
}
for(const it of data){const seen=new Set();it.uses=it.uses.filter(u=>{const k=u.f+':'+u.line;if(seen.has(k))return false;seen.add(k);return true})}
fs.writeFileSync('/tmp/icons/data2.json',JSON.stringify(data,null,1));
for(const o of data)console.log(o.name.padEnd(20),String(o.uses.length).padStart(3),[...new Set(o.uses.map(u=>u.f.replace('web/js/','')))].length,'files');
