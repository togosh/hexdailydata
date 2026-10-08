import { ACCEPTED } from '../contracts/saved-generation.ts';

export function SourceUpdateDisclosure() {
  return <div className="source-disclosure">
    <p className="eyebrow">Saved source update · 6 Oct 2026</p>
    <details><summary>Source and snapshot details</summary>
      <p>pulsechain/hex · base block 27,720,851 (5 Oct 2026, 15:48:05 UTC) plus captured updates through block 27,724,947 (6 Oct 2026, 03:31:15 UTC).</p>
      <p>Coverage: accepted_base_plus_observed_updates. This is a fixed historical view, not a complete B1 inventory or live data. Unchanged rows retain their base observation; individual record evidence identifies directly observed updates.</p>
      <p>Deletion propagation and reorg safety are unproved. Source links do not establish canonical lifecycle, active stakes or maturity days. Updated packed-field discrepancies are unassessed; historical base findings remain separate. Values are not independently verified on-chain.</p>
      <p>Refresh rereads local saved files. The separate 2,498-day ledger retains its 5 October pin.</p>
      <dl className="fact-rows"><div><dt>Generation</dt><dd>{ACCEPTED.generation}</dd></div>
        <div><dt>Holder version</dt><dd>{ACCEPTED.familyVersions.tokenHolders}</dd></div>
        <div><dt>Stake version</dt><dd>{ACCEPTED.familyVersions.stakeStarts}</dd></div>
        <div><dt>Target hash</dt><dd>{ACCEPTED.target.hash}</dd></div>
        <div><dt>Deployment</dt><dd>{ACCEPTED.deployment}</dd></div></dl>
    </details>
  </div>;
}
