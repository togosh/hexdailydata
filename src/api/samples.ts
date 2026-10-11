import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
const names = ['daily', 'stakes', 'holders', 'maturities', 'markets'] as const;
async function bounded(url: URL) {
  const handle = await open(url, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16384) throw Error('SAMPLE_BOUND');
    const b = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(b, 0, b.length, 0);
    if (bytesRead > 16384 || bytesRead !== stat.size) throw Error('SAMPLE_BOUND');
    return b.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
/** Five fixed, manifest-bound examples; never read product/export roots. */
export async function sampleRoutes(app: FastifyInstance) {
  const root = new URL(
    import.meta.url.endsWith('.js') ? './samples/' : '../../delivery/samples/',
    import.meta.url,
  );
  const manifest = JSON.parse((await bounded(new URL('MANIFEST.json', root))).toString());
  for (const name of names) {
    const bytes = await bounded(new URL(`${name}.csv`, root));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (
      manifest.files?.[name]?.bytes !== bytes.length ||
      manifest.files?.[name]?.sha256 !== hash
    )
      throw Error('SAMPLE_INTEGRITY');
    const etag = `"${hash}"`;
    app.get(`/samples/${name}.csv`, async (request, reply) => {
      if (Object.keys(request.query as object).length)
        return reply.code(400).send({ error: 'Fixed sample takes no query.' });
      reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="SYNTHETIC-SAMPLE-${name}.csv"`)
        .header('X-Data-Label', 'SYNTHETIC SAMPLE; fixed partial fixture')
        .header('Cache-Control', 'public, max-age=86400')
        .header('ETag', etag);
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.header('Content-Length', bytes.length).send(bytes);
    });
  }
}
