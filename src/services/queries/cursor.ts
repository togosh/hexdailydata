import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { restart } from '../../api/errors.ts';
const schema = z.strictObject({
  version: z.literal(1),
  binding: z.string().max(256),
  identity: z.string().max(512),
  key: z.string().max(120),
  expires: z.number().int().safe(),
});
/** No snapshot or visitor state survives a page. Restart explicitly on a changed cutoff. */
export class PageCursors {
  private secret = randomBytes(32);
  encode(binding: string, identity: string, key: string, now: number, expires = now + 60000) {
    const body = Buffer.from(
      JSON.stringify(schema.parse({ version: 1, binding, identity, key, expires })),
    ).toString('base64url');
    return body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url');
  }
  decode(text: string | undefined, binding: string, now: number) {
    if (!text) return null;
    try {
      if (text.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) throw restart();
      const [body, sig] = text.split('.');
      const actual = Buffer.from(sig!, 'base64url'),
        expected = createHmac('sha256', this.secret).update(body!).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw restart();
      const value = schema.parse(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')));
      if (value.binding !== binding || value.expires <= now) throw restart();
      return value;
    } catch {
      throw restart();
    }
  }
}
