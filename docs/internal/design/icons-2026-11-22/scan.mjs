import fs from 'fs'; import path from 'path';
const root=process.argv[2]; const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
const syms=[...html.matchAll(/<symbol id="i-([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/symbol>/g)].map(m=>({name:m[1],body:m[2]}));
const files=[];const walk=d=>{for(const n of fs.readdirSync(d)){const f=path.join(d,n);const st=fs.statSync(f);if(st.isDirectory()){if(!['test','vendor','i18n'].includes(n))walk(f)}else if(/\.(js|html)$/.test(n))files.push(f)}};
walk(path.join(root,'web'));
const src=files.map(f=>({f:path.relative(root,f),lines:fs.readFileSync(f,'utf8').split('\n')}));
const out=syms.map(s=>{const n=s.name.replace(/[-]/g,'\\-');
 const strict=new RegExp(`(icon(HTML)?\\(\\s*['"]${n}['"])|(#i-${n}\\b)|(\\bicon\\s*:\\s*['"]${n}['"])`);
 const loose=new RegExp(`['"]${n}['"]`);
 const uses=[];
 for(const {f,lines} of src){lines.forEach((l,i)=>{if(f==='web/index.html'&&l.includes('<symbol id="i-'))return;
   const st=strict.test(l); const lo=!st&&loose.test(l)&&/icon/i.test(l);
   if(st||lo)uses.push({f,line:i+1,code:l.trim().slice(0,220),loose:lo})})}
 return {name:s.name,body:s.body,uses}});
fs.writeFileSync('/tmp/icons/data.json',JSON.stringify(out,null,1));
for(const o of out)console.log(o.name.padEnd(22),o.uses.length,[...new Set(o.uses.map(u=>u.f.replace('web/js/','')))].slice(0,6).join(' '));
