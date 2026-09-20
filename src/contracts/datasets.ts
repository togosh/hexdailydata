import contract from './datasets.json' with { type: 'json' };
export const datasets = ['daily', 'stakes', 'holders', 'maturities', 'markets'] as const;
export type Dataset = (typeof datasets)[number];
export const definitions = Object.fromEntries(contract.datasets.map((d) => [d.name, d])) as Record<
  Dataset,
  (typeof contract.datasets)[number]
>;
