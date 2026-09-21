import { concepts } from './education.ts';
import { primaryResources, deeperResources } from './learnResources.ts';
import './learn.css';

function Summary({ id }: { id: (typeof concepts)[number]['id'] }) {
  return <p>{concepts.find((concept) => concept.id === id)!.answer}</p>;
}
function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href}>
      {label} <span className="resource-host">{new URL(href).hostname} ↗</span>
      <span className="sr-only"> (external)</span>
    </a>
  );
}
export default function Learn() {
  return (
    <article className="learn-page">
      <header className="learn-heading">
        <h1>Learn HEX</h1>
        <p>Understand staking, T-Shares, payouts and the numbers on HEXDailyData.</p>
        <nav className="learn-jumps" aria-label="Learn sections">
          <a href="#start">Start here</a>
          <a href="#staking">Understand staking</a>
          <a href="#data">Understand the data</a>
        </nav>
      </header>

      <section id="start">
        <h2>Start here</h2>
        <div className="learn-intro">
          <section id="hex">
            <h3>HEX in a minute</h3>
            <Summary id="hex" />
            <p>
              Starting a stake burns the committed HEX from the liquid balance and records its
              principal and shares in the contract. Ending it mints the calculated return, after any
              applicable penalty. “Locked HEX” on this site describes that recorded stake principal,
              not tokens deposited into a savings account.
            </p>
          </section>
          <section id="pulsechain">
            <h3>HEX, PulseChain and this website</h3>
            <Summary id="pulsechain" />
            <p>
              HEX staking is different from staking PLS to operate a network validator. HEXDailyData
              is an independent, read-only research site: it explains records and estimates, but
              does not hold funds or start, end or manage stakes.
            </p>
          </section>
        </div>
      </section>

      <section id="staking-basics">
        <h2>How a stake works</h2>
        <Summary id="staking" />
        <ol className="stake-lifecycle">
          <li>
            <strong>Choose</strong>
            <p>
              Select an amount and a term. A longer commitment can increase shares, but also leaves
              that principal unavailable for longer.
            </p>
          </li>
          <li>
            <strong>Start</strong>
            <p>
              The contract records the stake. An ordinary new stake waits until the next protocol
              day before becoming active.
            </p>
          </li>
          <li>
            <strong>Accrue</strong>
            <p>
              Eligible shares receive allocations from each day's payout pool during the committed
              term. The amount can vary from day to day.
            </p>
          </li>
          <li>
            <strong>Mature</strong>
            <p>
              The term finishes. It does not automatically settle or continue earning extra payout
              for days beyond the term.
            </p>
          </li>
          <li>
            <strong>Settle</strong>
            <p>
              Stake End calculates and mints the return. Applicable penalties and transaction fees
              affect the outcome.
            </p>
          </li>
        </ol>
        <p className="learn-aside">
          <strong>Optional after maturity: Good Accounting.</strong> This records a mature stake's
          payout and penalty without sending the proceeds to its owner. Anyone may call it for a
          mature stake; the owner still needs Stake End to receive the return. It does not erase a
          penalty already incurred.
        </p>
      </section>

      <section id="staking">
        <h2>Understand staking</h2>
        <section id="tshares">
          <h3>T-Shares are your allocation units</h3>
          <Summary id="tshares" />
          <p>
            An existing stake's assigned shares do not automatically increase when the global share
            rate rises. More T-Shares mean a larger fraction of the same eligible payout pool, not a
            guaranteed dollar return.
          </p>
        </section>
        <section>
          <h3>Share rate is not APY</h3>
          <p>
            The displayed T-Share rate is the effective HEX required per T-Share before amount and
            duration bonuses. It is different from HEX's market price and from a return percentage.
            A higher rate produces fewer new shares from otherwise identical inputs.
          </p>
        </section>
        <section id="payout">
          <h3>Payout is an allocation, not a daily deposit</h3>
          <Summary id="payout" />
          <p>
            For ordinary post-launch days, the contract's payout calculation includes protocol
            issuance and the portion of stake penalties redistributed to the payout pool. Not all
            penalties go to stakers. Future payouts depend on protocol state and activity; they are
            not fixed interest from a borrower.
          </p>
          <p className="learn-example">
            <strong>Simple example — not a forecast:</strong> at exactly 6 HEX per T-Share for one
            eligible day, 10 T-Shares correspond to 60 HEX before stake-level integer rounding and
            any settlement penalties. Nothing in that example promises tomorrow's payout or a USD
            value.
          </p>
        </section>
        <section>
          <h3>Duration bonuses are shares, not free liquid HEX</h3>
          <p>
            Longer terms and larger amounts can increase the effective amount used to issue stake
            shares, within the contract's caps. That does not immediately mint bonus HEX or
            guarantee an annual yield. The current calculator models a new ordinary stake; it does
            not recreate every historical claim-era stake.
          </p>
          <p>
            <strong>Before committing:</strong> early or late settlement can reduce principal as
            well as payout. Maturity is not automatic, and token price changes and fees can outweigh
            HEX-denominated rewards. The calendar and exact contract rules matter.
          </p>
        </section>
        <details className="learn-disclosure">
          <summary>Stake states</summary>
          <dl className="learn-glossary">
            <dt>Queued</dt>
            <dd>
              Started, but its lock day has not arrived. It is not yet receiving a daily payout
              allocation.
            </dd>
            <dt>Active</dt>
            <dd>Within its committed payout term and not ended or good-accounted.</dd>
            <dt>Mature, open</dt>
            <dd>
              Its term finished but it has not been settled or good-accounted. It does not gain
              extra payout days just because it remains listed.
            </dd>
            <dt>Good Accounted (GA)</dt>
            <dd>
              Mature accounting has been performed; the return has not been paid to the owner. This
              site's locked principal includes it; accounted T-Shares do not.
            </dd>
            <dt>Ended</dt>
            <dd>Stake End has settled the stake. Its payout and penalty are historical records.</dd>
            <dt>Cancelled</dt>
            <dd>
              An ordinary stake was ended before its lock day, without a staking payout or early-end
              penalty. A transaction fee can still apply.
            </dd>
          </dl>
          <p>
            In Address, the <strong>Open</strong> tab groups queued, active and mature-open stakes;
            <strong> Good Accounted</strong> is separate. <strong>Ended</strong> includes cancelled
            rows, which retain their own label. “Current” means unended, not “currently earning.”
          </p>
        </details>
        <a className="learn-source-link" href="#resources">
          Sources &amp; details
        </a>
      </section>

      <section id="data">
        <h2>Understand the data</h2>
        <h3>Start with the label, not just the number</h3>
        <p>
          <strong>Live</strong> describes a recent provisional observation at a particular block.
          <strong> Indexed</strong> means accepted records through the shown cutoff.
          <strong> HDS reported</strong> identifies a retained HEXDailyStats observation, not a new
          measurement by this site. Their timestamps and meanings can differ.
        </p>
        <p>
          A blank or unavailable value is not zero. “No upcoming maturities” is a known empty
          schedule; an unavailable index means the schedule is unknown. A partial live stake page is
          not a complete address total.
        </p>
        <h3>The most useful distinctions</h3>
        <p>
          <strong>Price versus reference price.</strong> A historical HDS reference price is an
          observation from that archive, not guaranteed market-close data or a price you can trade
          at.
        </p>
        <p>
          <strong>Completed payout versus estimate.</strong> A day can have ended while its protocol
          payout record is still pending. Today's estimate remains provisional, even after a
          refresh.
        </p>
        <p>
          <strong>Stakes versus stakers.</strong> One address can have many stakes; one person can
          control many addresses. Current holders, current stakers and historical-ever counts are
          not interchangeable or necessarily distinct people.
        </p>
        <p>
          <strong>Supply versus locked principal.</strong> Liquid/circulating HEX and recorded stake
          principal are separate. Do not add an old indexed staking amount to a newer live balance
          and call it one exact current total.
        </p>
        <h3>Use the right page</h3>
        <ul className="learn-destinations">
          <li>
            <a href="/">Home</a> — Current observations and headline statistics, each with its own
            status.
          </li>
          <li>
            <a href="/charts">Charts</a> — Historical patterns, sources, date coverage and exact
            records.
          </li>
          <li>
            <a href="/calculator">Calculator</a> — New-stake shares and explicitly hypothetical
            payout/price scenarios.
          </li>
          <li>
            <a href="/search">Search</a> — An address or stake's records, timing, live coverage and
            dated ranks.
          </li>
          <li>
            <a href="/downloads">Data</a> — The five standard CSV datasets and their units and
            coverage.
          </li>
        </ul>
      </section>

      <section>
        <h2>Using HEX on PulseChain</h2>
        <p>
          HEXDailyData does not buy, sell or stake tokens. Using external tools generally requires a
          compatible self-custody wallet, the correct network and enough PLS for transaction fees. A
          token swap and a HEX stake are separate contract interactions.
        </p>
        <p>
          Before signing elsewhere, check the destination domain, network, token address, quoted
          amounts, slippage and any spending allowance or stake duration. Never give a website,
          message or support agent your recovery phrase or private key.
        </p>
        <p>
          <strong>External tools can move funds.</strong> Project-published links are starting
          points for your own investigation, not a safety audit or investment recommendation.
          Smart-contract, wallet, market and liquidity risks remain. This page offers education, not
          a promise of returns or a recommendation of how much or how long to stake.
        </p>
        <h3 id="project-resources">Project resources &amp; external tools</h3>
        <ul className="learn-resources" aria-labelledby="project-resources">
          {primaryResources.map((resource) => (
            <li key={resource.href}>
              <ExternalLink {...resource} />
              <p>{resource.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="learn-depth" aria-labelledby="learn-depth-title">
        <h2 id="learn-depth-title">Deeper detail</h2>
        <details id="math" className="learn-disclosure">
          <summary>Show me the math</summary>
          <h3>Units</h3>
          <p>
            1 HEX = 100,000,000 hearts.
            <br />1 T-Share = 1,000,000,000,000 stake shares.
            <br />
            Shares are not HEX or dollars.
          </p>
          <h3>Ordinary daily allocation</h3>
          <p className="learn-formula">
            allocation in hearts = floor(stake shares × daily payout hearts / daily total shares)
          </p>
          <p>
            The familiar T-Shares × HEX-per-T-Share version is a readable approximation if the
            displayed ratio has been rounded. The contract works in integer units; eligible days,
            final settlement and historical launch rules still matter.
          </p>
          <h3>New ordinary stake: effective amount and shares</h3>
          <p>
            Let H be principal in hearts, d the chosen days, and R the raw share rate.
            <br />
            Let e = min(d − 1, 3640), c = min(H, 15,000,000,000,000,000), and B =
            150,000,000,000,000,000.
          </p>
          <div className="learn-formula">
            <p>bonus hearts = floor(H × (e × B + c × 1820) / (1820 × B))</p>
            <p>stake shares = floor((H + bonus hearts) × 100000 / R)</p>
            <p>T-Shares = stake shares / 1,000,000,000,000</p>
          </div>
          <p>
            The bonuses share one floor; do not round them separately. Duration is 1–5,555 days; the
            duration-bonus cap is reached at 3,641 days. Amount/storage limits and nonzero-share
            checks also apply. This describes ordinary issuance, not every historical launch rule.
          </p>
          <h3>Percentage staked</h3>
          <p className="learn-formula">
            100 × locked principal / (circulating HEX + locked principal)
          </p>
          <p>Locked principal includes GA here. A zero denominator is unavailable, not 0%.</p>
          <h3>USD T-Share reference cost</h3>
          <p className="learn-formula">HEX per T-Share × USD per HEX</p>
          <p>
            For the historical chart, both inputs come from the same admitted HDS record. This is a
            derived reference cost before stake bonuses, not a transaction quote or guaranteed
            amount required to obtain exactly one T-Share. Missing input means missing result.
          </p>
          <a href="#resources">Sources &amp; details</a>
        </details>

        <details id="methodology" className="learn-disclosure">
          <summary>How HEXDailyData measures data</summary>
          <h3>Sources, freshness and missing values</h3>
          <p>
            Native history is built from accepted protocol records; live values are separately aged
            block observations; HDS history preserves reported values, source dates and coverage.
            These are not three names for the same accuracy or freshness guarantee.
          </p>
          <p>
            Current metric observations are fresh through 120 seconds, then last-known/stale through
            30 minutes and unavailable beyond that; a current-day estimate also expires at its day
            boundary. Live stake pages have a separate pinned cursor lifetime. Re-fetching an old
            source block does not make it fresh.
          </p>
          <p>
            HDS reported history is an attributed HEXDailyStats archive, independently selectable in
            Charts. It does not supply Home's current price, raw share rate or calculator presets.
          </p>
          <h3>Counts and stake amounts</h3>
          <p>
            Locked principal includes queued, active, mature-open and GA stakes. Accounted principal
            excludes GA; accounted shares additionally exclude queued shares. Mature-open shares can
            remain in protocol accounting even though that stake has no extra eligible payout days.
            Upcoming maturities include queued/active stakes, not GA or already-mature open stakes.
            Ranks have their own cutoff and are not live balance rankings.
          </p>
          <p>
            HDS total HEX is circulating plus locked, not ERC20 totalSupply. Current holders differ
            from historical-ever holders. Do not combine those series without their definitions. A
            live page is a bounded observation, not proof that every stake was fetched. Provider
            unavailability or index lag never establishes absence.
          </p>
          <h3>Duration and days</h3>
          <p>
            Native weighted length weights each included stake's original term by its principal;
            queued, active and mature-open stakes are included, GA and ended stakes excluded. It is
            not average time remaining. Contract days roll at 00:00 UTC, starting December 3, 2019.
            Display days add one. Ordinary stakes lock next day, with the launch lock floor
            preserved, and mature after their whole staked duration.
          </p>
          <p>
            The existing Home conversion uses 365.25 days per display year. Native chart conversion
            and HDS-reported duration use a 365-day convention. The calculator's APY term convention
            also uses 365-day years. Values labeled years can therefore differ slightly; the source
            and exact day values identify the basis.
          </p>
          <h3>Calculator and Home APY scenarios</h3>
          <p>
            The calculator uses the latest eligible share rate for a start-now illustration. Its
            optional payout scenario holds a selected 1-, 30- or 365-day arithmetic mean of daily
            payout ratios constant; missing/pending days or invalid denominators prevent a valid
            preset. It does not predict future penalties, prices or rewards, and does not compound
            daily payouts.
          </p>
          <p>
            Home Stake APY scenarios use 10,000 HEX, the current raw share rate, 365/1,825/3,650-day
            terms and the 30-consecutive-completed-day mean, ending at the latest indexed completed
            payout. The calculator's exact amount/duration bonuses and share issuance floors apply.
            The annualized end-of-term expression is:
          </p>
          <p className="learn-formula">((ending HEX / starting HEX)^(1 / years) − 1) × 100</p>
          <p>
            It is an assumption-based comparison, not a current protocol yield or promised return.
            Its formula keeps penalties already present in the historical payout observations, not
            unknown future stake-level penalties. An expired share rate or unavailable history makes
            the estimates unavailable.
          </p>
          <p>
            A completed payout belongs to its actual materialized day. Today's payout is an estimate
            and cannot become final merely through polling. Missing ledger rounds remain pending.
          </p>
          <h3>Precision and archive coverage</h3>
          <p>
            Exact raw integers and published decimal values are retained. Compact Home display may
            truncate a magnitude; its full received value is in the title. Chart tables retain full
            published precision. Chart coordinates are approximate pixels, never inputs to protocol
            calculations.
          </p>
          <p>
            HDS record dates are not proven market-close times. Missing/ambiguous prices stay
            missing; missing prices and dates break chart lines. Duplicate-date records remain
            separate by sourceDay and are not silently merged. Price charts use admitted post-fork
            PulseChain observations only, without Ethereum HEX prices. Inherited protocol records
            keep their earlier origin and dates. Native readiness, HDS coverage, market availability
            and standard CSV publication are separate.
          </p>
          <p>
            <a href="/status">Data status</a> ·{' '}
            <a href="/api/v2/status?chain=pulsechain">API metadata</a>
          </p>
        </details>

        <details id="resources" className="learn-disclosure">
          <summary>Technical &amp; historical reading</summary>
          <p>
            Some older guides describe Ethereum-era launch features and simulations. Those sections
            are historical, not current instructions or forecasts. Read their scope and compare
            exact rules with the contract documentation. This site's explanations distinguish
            project references, community writing and dated audits.
          </p>
          <ul className="learn-reading">
            {deeperResources.map((resource) => (
              <li key={resource.href}>
                <ExternalLink {...resource} />
                <p>{resource.description}</p>
                {resource.companion && <ExternalLink {...resource.companion} />}
              </li>
            ))}
          </ul>
        </details>
      </section>
    </article>
  );
}
