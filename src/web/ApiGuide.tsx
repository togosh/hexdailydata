import { useState } from 'react';
import Copy from './ApiCopy.tsx';
import { endpointGroups, exampleCode, operationLink, type ExampleLanguage } from './api-guide.ts';
import './api-guide.css';
const languages: ExampleLanguage[] = ['cURL', 'JavaScript', 'Python'];
export default function ApiGuide() {
  const [language, setLanguage] = useState<ExampleLanguage>('cURL');
  const [pane, setPane] = useState('request');
  const code = exampleCode(location.origin, language);
  return (
    <div className="api-guide">
      <header className="api-hero">
        <div>
          <p className="api-eyebrow">BUILD WITH HEXDailyData</p>
          <h1>API Access</h1>
          <p>Read-only HEX data for apps, scripts and dashboards.</p>
        </div>
        <nav aria-label="API resources">
          <a className="button primary" href="/api/reference">
            Explore API reference <span aria-hidden="true">→</span>
          </a>
          <div>
            <a href="/openapi.json" download="hexdailydata-openapi.json">
              Download OpenAPI
            </a>
            <a href="/downloads">CSV downloads</a>
          </div>
        </nav>
      </header>
      <div className="api-connection panel">
        <div>
          <span className="meta">Base URL</span>
          <code>{location.origin}</code>
          <Copy value={location.origin} label="Copy URL" />
        </div>
        <p>
          <strong>GET</strong>
          <span>JSON + CSV</span>
          <span>Public browsing + paid API-key access</span>
          <a href="#api-errors">Integration limits</a>
        </p>
      </div>
      <section className="api-quickstart panel" aria-labelledby="api-quickstart-title">
        <div className="api-section-heading">
          <h2 id="api-quickstart-title">Quick start</h2>
          <span className="meta">One request. Exact values.</span>
        </div>
        <div className="api-mobile-panes" role="group" aria-label="Quick start view">
          <button aria-pressed={pane === 'request'} onClick={() => setPane('request')}>
            Request
          </button>
          <button aria-pressed={pane === 'response'} onClick={() => setPane('response')}>
            Response
          </button>
        </div>
        <div className="api-code-grid" data-pane={pane}>
          <div className="api-request">
            <div className="api-code-toolbar">
              <div role="tablist" aria-label="Example language">
                {languages.map((name, index) => (
                  <button
                    key={name}
                    id={`api-tab-${index}`}
                    role="tab"
                    aria-selected={language === name}
                    tabIndex={language === name ? 0 : -1}
                    aria-controls="api-example"
                    onClick={() => setLanguage(name)}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      const next =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? 2
                            : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
                      setLanguage(languages[next]!);
                      document.getElementById(`api-tab-${next}`)?.focus();
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <Copy value={code} />
            </div>
            <div
              id="api-example"
              role="tabpanel"
              aria-labelledby={`api-tab-${languages.indexOf(language)}`}
            >
              <pre tabIndex={0} aria-label={`${language} example`}>
                <code>{code}</code>
              </pre>
            </div>
          </div>
          <div className="api-response">
            <div className="api-code-toolbar">
              <strong>Synthetic response</strong>
              <span className="meta">Home excerpt · not live data</span>
            </div>
            <pre tabIndex={0} aria-label="Synthetic Home excerpt">
              <code>
                {JSON.stringify(
                  { live: { price: { status: 'unavailable', value: null } } },
                  null,
                  2,
                )}
              </code>
            </pre>
          </div>
        </div>
        <details className="api-quick-help">
          <summary>Using these examples</summary>
          <p>
            Check component status and coverage before using values. This excerpt omits other
            fields. Examples use this page’s origin and do not run here. In Windows PowerShell 5 use{' '}
            <code>curl.exe</code>. JavaScript needs top-level await support; Python uses its
            standard library. HTTP errors fail rather than become success values. Cross-origin
            browser access is not configured by these docs.
          </p>
        </details>
      </section>
      <section className="api-directory" aria-labelledby="api-directory-title">
        <div className="api-section-heading">
          <h2 id="api-directory-title">All endpoints</h2>
          <span className="meta">18 resources · GET</span>
        </div>
        <div className="api-directory-groups">
          {endpointGroups.map((group) => (
            <section key={group.id} id={group.id}>
              <h3>{group.title}</h3>
              <div className="panel">
                {group.routes.map((route) => (
                  <a
                    className="api-endpoint"
                    key={route.id}
                    href={operationLink(route.id)}
                    data-operation={route.id}
                  >
                    <span className="api-method">GET</span>
                    <span>
                      <strong>{route.title}</strong>
                      <code>{route.path}</code>
                      <span className="api-purpose">{route.description}</span>
                    </span>
                    <span aria-hidden="true">→</span>
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
      <section className="api-essentials" aria-labelledby="api-essentials-title">
        <h2 id="api-essentials-title">Integration essentials</h2>
        <div>
          <details id="api-exact">
            <summary>Exact values &amp; time</summary>
            <p>
              Keep magnitudes as exact strings; null is not zero. Hearts are 10<sup>−8</sup> HEX.
              Day counters are numbers; timestamps are UTC. HDS tokens may use signs/exponents.
            </p>
            <a href={operationLink('home')}>Value and observation reference →</a>
          </details>
          <details id="api-freshness">
            <summary>Freshness &amp; coverage</summary>
            <p>
              Components can independently be fresh, stale or unavailable. A partial address page is
              not a wallet inventory. Health is not proof of dataset completeness.
            </p>
            <a href={operationLink('address')}>Availability reference →</a>
          </details>
          <details id="api-pagination">
            <summary>Pagination</summary>
            <p id="api-indexed-cursors">
              Indexed cursors, HDS day/revision continuation and pinned address pages are different
              contracts. Public global lists allow five pages of up to 50 rows. More traversal, stake activity and advanced maturity filters require a paid key. Restart when changing mode or when a cursor expires.
            </p>
            <a href={operationLink('stakes')}>Indexed lists</a> ·{' '}
            <a href={operationLink('daily')}>HDS history</a> ·{' '}
            <a href={operationLink('addressStakes')}>Address pages</a>
          </details>
          <details id="api-errors">
            <summary>Errors, caching &amp; access</summary>
            <p>
              Honor 429 Retry-After and use bounded retries. Process resource limits are not
              customer quotas. With Authorization, each successful data GET/HEAD/304 page uses one monthly request. Browser sessions alone stay public. Revalidation still constructs the response.
              Read-only; no request console.
            </p>
            <a href={operationLink('home')}>Errors &amp; caching</a> ·{' '}
            <a href={operationLink('download')}>CSV behavior</a> ·{' '}
            <a href="/api/v2/status?chain=pulsechain">Raw API metadata (JSON)</a>
          </details>
        </div>
      </section>
    </div>
  );
}
