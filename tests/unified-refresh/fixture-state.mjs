// Clearly synthetic derived state in a new root; does not restore or alter the genuine seed.
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { createMarketStorage } from '../../dist/services/product-daily/storage.js';
import { productFiles } from '../../dist/services/product-daily/project.js';
import { marketEvidence } from '../../dist/services/product-daily/market.js';
import { ParticipantRegistry } from '../../dist/services/source-update/refresh.js';
export async function deriveFixture(source, root, base) {
  await mkdir(root);
  const h = source.capture();
  try {
    const p = h.product,
      metadata = structuredClone(p.metadata);
    metadata.observations = marketEvidence(metadata);
    delete metadata.marketStorage;
    const exceptions = (
      await readFile(join(source.productDaily.root, p.version, 'exceptions.ndjson'), 'utf8')
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    const store = await createMarketStorage(
      join(root, 'product'),
      productFiles({ rows: p.rows, metadata, exceptions }),
    );
    await cp(source.root, join(root, 'participants'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const pointer = JSON.parse(await readFile(join(root, 'participants/CURRENT.json'))),
      selected = store.capture();
    pointer.product = { version: selected.version, manifestSha256: selected.manifestSha256 };
    await writeFile(join(root, 'participants/CURRENT.json'), JSON.stringify(pointer) + '\n');
    return ParticipantRegistry.open(join(root, 'participants'), store.root, base);
  } finally {
    h.release();
  }
}
