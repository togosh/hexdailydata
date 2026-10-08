import { z } from 'zod';
/** Independently accepted descriptor v1; no visitor-supplied identity authority. */
export const ACCEPTED = {
  "schemaVersion": 1,
  "base": {
    "number": 27720851,
    "hash": "0x8d7a9233e143884558511f15558a03d88567bc2255d63f670707ff45894b3fb8",
    "timestamp": 1791215285
  },
  "target": {
    "number": 27724947,
    "hash": "0x688b4ce6c991cd8fa6d3012e3a6a063755e056e6e856aac7664dfb34046651e3",
    "timestamp": 1791257475
  },
  "deployment": "QmSsv8uvNLbfJCQARk7xd9iNouNmaoqZCrqEwRaFCHJMCw",
  "baseBindings": {
    "tokenHolders": {
      "datasetVersion": "94906fb219cceb6476f9fb7373ffd8a752cc0e4b2f3d2bbc096ac84d6ce66014",
      "manifestSha256": "869cf3515c7f06af4afe49c841775006a6047ae1c470fa827a81ece1d74ec020"
    },
    "stakeStarts": {
      "datasetVersion": "1078dc36dde165f35ad9c7f96faf77f8be078173818bd85af010314d339904b5",
      "manifestSha256": "1285acf4439dbf6d342686ece27d48f10d4605dca0b91af009d7ee4db61c1707"
    }
  },
  "familyVersions": {
    "tokenHolders": "0a2a0b6c3e2aa37cc1574ed4140b072d39504a4e2c4934274c2bea1f295c8f7d",
    "stakeStarts": "909e57667419a7fe383d3cc10ebf3bad0208db0826db5adf4462687c1bce1489"
  },
  "generation": "8de9ee83bebd2be68c4d976eb355c646283af0c2b2544075b7d7372882ab039e",
  "bundle": {
    "file": "changes/BUNDLE.json",
    "bytes": 14898012,
    "rawFileSha256": "8336bfaa179c4de3f202bc4208f7c19d2af3b6f3afd5e11d32dea067ea939a0c",
    "semanticSortedJsonSha256": "9ed3278a43a7a8fc19b541896a5ab60b96f6281b41e14e8441a05f5ef4c08ecf"
  },
  "manifest": {
    "file": "changes/MANIFEST.json",
    "bytes": 1718,
    "sha256": "ddf632a725e087c6b96149d4494407c36ebd9352db5e58425ba869719aff0e4e"
  }
} as const;
export const GenerationSelectionSchema = z.union([z.literal('base'), z.literal(ACCEPTED.generation)]);
export type GenerationSelection = z.infer<typeof GenerationSelectionSchema>;
export const TARGET_SNAPSHOT = { source: 'pulsechain/hex', deployment: ACCEPTED.deployment,
  ...ACCEPTED.target, observedAtUtc: '2026-10-06T03:31:15Z' } as const;
export const BASE_SNAPSHOT = { source: 'pulsechain/hex', deployment: ACCEPTED.deployment,
  ...ACCEPTED.base, observedAtUtc: '2026-10-05T15:48:05Z' } as const;
