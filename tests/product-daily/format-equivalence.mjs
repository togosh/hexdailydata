import {parsers} from 'prettier/plugins/typescript';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
const root=process.env.HDD_TASK_ROOT,back=join(root,'scratch/format-equivalence');
const names=JSON.parse(await readFile(join(back,'paths.json')));
function tree(text){const parsed=parsers.typescript.parse(text,{parser:'typescript'});
 const skip=new Set(['start','end','loc','range','raw','extra','comments','tokens','__contentEnd']);
 const walk=n=>Array.isArray(n)?n.map(walk):n&&typeof n==='object'?Object.fromEntries(Object.keys(n).filter(k=>!skip.has(k)).sort().map(k=>[k,walk(n[k])])):n;return walk(parsed);}
for(const name of names)assert.deepEqual(tree(await readFile(name,'utf8')),tree(await readFile(join(back,basename(name)+'.before'),'utf8')),name);
await writeFile(join(root,'evidence/FORMAT_EQUIVALENCE.json'),JSON.stringify({status:'PASS',files:names,method:'Locked Prettier TypeScript parser AST equality excluding trivia/location/raw quoting, no source execution',purpose:'Keep unchanged legacy formatting and minimize reviewed semantic diff'})+'\n',{flag:'wx'});console.log('PASS same syntax trees; only old formatting restored');
