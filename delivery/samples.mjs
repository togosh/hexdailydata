import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// Fixed finite assets, independent of the current bundle and account database.
export async function sampleRoutes(app) {
  const manifest=JSON.parse(await readFile(new URL('./samples/MANIFEST.json',import.meta.url),'utf8'));
  for (const name of ['daily','stakes','holders','maturities','markets']) {
    const bytes=await readFile(new URL(`./samples/${name}.csv`,import.meta.url));
    if (bytes.length>16384 || bytes.length!==manifest.files[name].bytes ||
        createHash('sha256').update(bytes).digest('hex')!==manifest.files[name].sha256)
      throw Error('Fixed sample integrity failed.');
    app.get(`/samples/${name}.csv`, async (request,reply)=>{
      if (Object.keys(request.query).length) return reply.code(400).send({error:'Fixed sample takes no query.'});
      return reply.type('text/csv; charset=utf-8')
        .header('Content-Disposition',`attachment; filename="SYNTHETIC-SAMPLE-${name}.csv"`)
        .header('X-Data-Label','SYNTHETIC SAMPLE; fixed partial fixture')
        .header('Cache-Control','public, max-age=86400')
        .header('Content-Length',bytes.length).send(bytes);
    });
  }
}
