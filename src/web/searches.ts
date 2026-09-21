import { AddressSchema, StakeIdSchema } from '../contracts/reads.ts';

export const recentSearchKey = 'hdd-recent-searches';
export function normalizeSearch(input: string): string | null {
  const term = input.trim();
  const address = AddressSchema.safeParse(term);
  if (address.success) return address.data;
  const stake = StakeIdSchema.safeParse(term.startsWith('#') ? term.slice(1) : term);
  return stake.success ? stake.data : null;
}
export function readSearches(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const values: unknown = JSON.parse(storage.getItem(recentSearchKey) ?? '[]');
    if (!Array.isArray(values)) return [];
    return [
      ...new Set(
        values.slice(0, 20).flatMap((v) => {
          const term = typeof v === 'string' ? normalizeSearch(v) : null;
          return term ? [term] : [];
        }),
      ),
    ].slice(0, 5);
  } catch {
    return [];
  }
}
export function rememberSearch(storage: Pick<Storage, 'getItem' | 'setItem'>, input: string) {
  const term = normalizeSearch(input);
  if (!term) return readSearches(storage);
  const values = [term, ...readSearches(storage).filter((v) => v !== term)].slice(0, 5);
  try {
    storage.setItem(recentSearchKey, JSON.stringify(values));
  } catch {
    /* Storage may be disabled. */
  }
  return values;
}
