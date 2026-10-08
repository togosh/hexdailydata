import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageSource } from './lab.mjs';
try {console.log(JSON.stringify(packageSource(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),null,2));}
catch(e){console.error(JSON.stringify({status:'STOPPED',message:e.message}));process.exitCode=1;}
