import { ProductDownloadsSchema } from '../contracts/product-daily.ts';
import { endpoint, useResource } from './api.ts';
import { Feedback } from './components.tsx';
import { Live } from './ProductHome.tsx';
export function Downloads() {
  const data = useResource(endpoint('/downloads'), ProductDownloadsSchema);
  return (
    <div className="daily-product">
      <div className="page-heading">
        <div>
          <p className="eyebrow">HEXDailyData · Data</p>
          <h1>Complete CSV exports</h1>
        </div>
      </div>
      <section className="panel">
        <h2>The same selected daily values</h2>
        <p>
          SYNTHETIC SAMPLE / fixed partial fixtures: these five free examples are not genuine
          or complete history.
        </p>
        <p>
          {['daily', 'stakes', 'holders', 'maturities', 'markets'].map((name) => (
            <span key={name}>
              <a href={'/samples/' + name + '.csv'}>{name} sample CSV</a>
              {' · '}
            </span>
          ))}
        </p>
        <p>
          Daily CSV uses the exact values, dates, units and product version shown by the API
          and Daily charts.
        </p>
        <Feedback {...data} />
        <p>{data.data?.reason ?? 'The complete export catalog is unavailable.'}</p>
        <p>
          Complete downloads require current purchased access. This local candidate has not
          activated real accounts, payments or public redistribution. No bulk file is served
          from a static directory.
        </p>
        <p>
          <a href="/daily">Browse Daily</a> · <a href="/api">Developer access</a>
        </p>
      </section>
    </div>
  );
}
export function Status() {
  return (
    <>
      <Live />
      <section className="panel">
        <h2>Qualification status</h2>
        <p>
          The indexer is parked. No current feed, scheduler, production payment system or
          deployment is qualified by this local candidate. Historical gaps remain visible in
          Daily.
        </p>
      </section>
    </>
  );
}
