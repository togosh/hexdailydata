type Snapshot = { number: number; hash: string; deployment: string; observedAtUtc: string };
export function SourceUpdateDisclosure({
  snapshot,
  generation,
}: {
  snapshot: Snapshot;
  generation?: string;
}) {
  return (
    <div className="source-disclosure">
      <p className="eyebrow">Saved participant view / {snapshot.observedAtUtc}</p>
      <details>
        <summary>Source and snapshot details</summary>
        <p>
          pulsechain/hex / base block 27,720,851 (5 October 2026) plus captured updates through
          block {snapshot.number.toLocaleString('en-US')}.
        </p>
        <p>
          Accepted base plus observed updates. This is a saved historical view, not a full inventory
          at the update target or live data. Unchanged records retain their individual observation
          times.
        </p>
        <p>
          Deletion propagation and reorg safety are unproved. Source end/GA links do not establish
          canonical lifecycle, active stakes or maturity days. Historical discrepancies remain
          separate. Values are not independently verified on-chain.
        </p>
        <p>
          Reload reads local saved data. Daily payouts and other feeds retain their own observation
          times.
        </p>
        <dl className="fact-rows">
          <div>
            <dt>Generation</dt>
            <dd>{generation}</dd>
          </div>
          <div>
            <dt>Target hash</dt>
            <dd>{snapshot.hash}</dd>
          </div>
          <div>
            <dt>Deployment</dt>
            <dd>{snapshot.deployment}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
