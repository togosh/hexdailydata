import { useEffect, useRef, useState } from 'react';
import { endpointGroups, operationLink, requestCode, type ExampleLanguage } from './api-guide.ts';
import {
  resources,
  selection,
  matchingResources,
  parameterFacts,
  responseLabel,
  errorAction,
  type ReferenceDocument,
  type Operation,
} from './api-reference.ts';
import Copy from './ApiCopy.tsx';
import './api-reference.css';

function Download({ value, name }: { value: string; name: string }) {
  const [url, setURL] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
    setURL(next);
    return () => URL.revokeObjectURL(next);
  }, [value]);
  return (
    <a href={url} download={name}>
      Download JSON
    </a>
  );
}
function JSONPane({ value, name, label }: { value: unknown; name: string; label: string }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <>
      <div className="ref-code-actions">
        <Copy value={text} label={`Copy ${label}`} />
        <Download value={text} name={name} />
      </div>
      <pre tabIndex={0} aria-label={label}>
        <code>{text}</code>
      </pre>
    </>
  );
}
function Selected({ id, document }: { id: string; document: ReferenceDocument }) {
  const route = resources.find((r) => r.id === id)!;
  const op: Operation = document.paths[route.path]!.get;
  const [language, setLanguage] = useState<ExampleLanguage>('cURL');
  const [requestIndex, setRequestIndex] = useState(0);
  const [status, setStatus] = useState('200');
  const [mode, setMode] = useState<'Example' | 'Schema'>('Example');
  const [parameterJSON, setParameterJSON] = useState(false);
  const sample = op['x-requests'][requestIndex]!;
  const response = op.responses[status]!;
  const media = Object.entries(response.content ?? {})[0];
  const values = media?.[1].examples ?? {};
  const variant =
    sample.variant && values[sample.variant] ? sample.variant : Object.keys(values)[0];
  const request = requestCode(location.origin, language, sample.path, id === 'download');
  const languages: ExampleLanguage[] = ['cURL', 'JavaScript', 'Python'];
  return (
    <article className="ref-operation" data-operation={id} aria-labelledby="ref-title">
      <header>
        <h2 id="ref-title" tabIndex={-1}>
          {op.summary}
        </h2>
        <div className="ref-path">
          <span className="ref-method">GET</span>
          <code>{route.path}</code>
          <Copy
            value={new URL(sample.path, location.origin).href}
            label={sample.template ? 'Copy template URL' : 'Copy URL'}
          />
        </div>
        <p>{route.description}</p>
        <p className="ref-context">
          {op.description.split('\n\n').slice(1)
            .filter((paragraph) => !Object.values(document['x-essentials']).includes(paragraph))
            .join(' ')}
        </p>
        <p className="ref-access">
          {id === 'stakeEvents' ? 'Active API key required. ' : id === 'download'
            ? 'Current purchased access required through a session or API key. ' : ''}
          <a href="#api-essentials">Access, quota and caching rules</a>
        </p>
      </header>
      <section className="ref-parameters" aria-labelledby="ref-parameters-title">
        <h3 id="ref-parameters-title">Request parameters</h3>
        {op.parameters.length ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type / required</th>
                <th>Default / bounds</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              {op.parameters.map((p) => (
                <tr key={p.in + p.name} data-parameter={p.name}>
                  <td data-label="Name">
                    <strong>{p.name}</strong>
                    <small>{p.in}</small>
                  </td>
                  <td data-label="Type / required">
                    <span>
                      {Array.isArray(p.schema.type)
                        ? p.schema.type.join(' | ')
                        : (p.schema.type ?? 'See exact JSON')}
                    </span>
                    <strong className={p.required ? 'ref-required' : ''}>
                      {p.required ? 'Required' : 'Optional'}
                    </strong>
                  </td>
                  <td data-label="Default / bounds">
                    {parameterFacts(p.schema).map((f) => (
                      <span key={f}>{f}</span>
                    ))}
                  </td>
                  <td data-label="Meaning">{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No request parameters.</p>
        )}
        {op['x-rules'].map((rule) => (
          <p className="ref-rule" key={rule}>
            {rule}
          </p>
        ))}
        {op.parameters.length > 0 && (
          <>
            <button
              className="ref-json-toggle"
              aria-expanded={parameterJSON}
              onClick={() => setParameterJSON((v) => !v)}
            >
              Exact parameter JSON
            </button>
            {parameterJSON && (
              <JSONPane
                value={op.parameters}
                name={`${id}-parameters.json`}
                label="parameter JSON"
              />
            )}
          </>
        )}
      </section>
      <div className="ref-example-heading">
        <h3>Examples</h3>
        <span className="ref-badge">Synthetic · not live data</span>
      </div>
      {sample.template && (
        <p className="ref-template" role="note">
          Template — replace the sample bundle ID with an available ID from the catalog before using
          it.
        </p>
      )}
      {sample.note && <p className="ref-context">{sample.note}</p>}
      <div className="ref-examples">
        <section className="ref-request panel" aria-label="Request example">
          <div className="ref-toolbar">
            <strong>Request</strong>
            {op['x-requests'].length > 1 && (
              <label>
                Dataset
                <select
                  aria-label="Dataset"
                  value={requestIndex}
                  onChange={(e) => {
                    setRequestIndex(Number(e.target.value));
                    setStatus('200');
                  }}
                >
                  {op['x-requests'].map((s, i) => (
                    <option key={s.label} value={i}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="ref-language" role="tablist" aria-label="Request language">
            {languages.map((lang, i) => (
              <button
                role="tab"
                aria-selected={language === lang}
                tabIndex={language === lang ? 0 : -1}
                id={`ref-language-${i}`}
                aria-controls="ref-request-code"
                key={lang}
                onClick={() => setLanguage(lang)}
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                  e.preventDefault();
                  const next =
                    e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? 2
                        : (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
                  setLanguage(languages[next]!);
                  window.document.getElementById(`ref-language-${next}`)?.focus();
                }}
              >
                {lang}
              </button>
            ))}
          </div>
          <div className="ref-code-actions">
            <Copy value={request} label={sample.template ? 'Copy template' : 'Copy request'} />
          </div>
          <div
            id="ref-request-code"
            role="tabpanel"
            aria-labelledby={`ref-language-${languages.indexOf(language)}`}
          >
            <pre tabIndex={0} aria-label="Complete request example">
              <code>{request}</code>
            </pre>
          </div>
        </section>
        <section className="ref-response panel" aria-label="Response details">
          <div className="ref-toolbar">
            <strong>Response</strong>
            <label>
              Status
              <select
                aria-label="Response status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {Object.entries(op.responses).map(([s]) => (
                  <option value={s} key={s}>
                    {s} ·{' '}
                    {s === '304'
                      ? 'No body'
                      : s === '200'
                        ? id === 'download'
                          ? 'CSV'
                          : 'Success'
                        : 'Error'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ref-view" role="group" aria-label="Response view">
            {(['Example', 'Schema'] as const).map((view) => (
              <button key={view} aria-pressed={mode === view} onClick={() => setMode(view)}>
                {view}
              </button>
            ))}
          </div>
          {media ? (
            mode === 'Schema' ? (
              <JSONPane
                value={media[1].schema}
                name={`${id}-${status}-schema.json`}
                label="response schema"
              />
            ) : variant ? (
              <>
                <p className="ref-variant">{responseLabel(variant)} · complete JSON</p>
                <JSONPane
                  value={values[variant]!.value}
                  name={`${id}-${status}-${variant}.json`}
                  label="response example"
                />
              </>
            ) : (
              <p className="ref-empty">
                CSV file, not JSON. Select an available catalog bundle; no fabricated file contents
                are shown. Schema is available above.
              </p>
            )
          ) : (
            <p className="ref-empty">No response body for this status.</p>
          )}
        </section>
      </div>
      <section className="ref-response-headers">
        <h3>Response headers · {status}</h3>
        {response.headers ? (
          <dl>
            {Object.entries(response.headers).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value.description}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>No additional headers are declared for this response.</p>
        )}
      </section>
      <section className="ref-errors">
        <h3>Errors</h3>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Reason</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(op.responses)
              .filter(([s]) => Number(s) >= 400)
              .map(([s, r]) => (
                <tr key={s}>
                  <td data-label="Status">{s}</td>
                  <td data-label="Reason">{r.description}</td>
                  <td data-label="Action">{errorAction(s)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="ref-context">
          Select a status above for its complete example or schema. Shared error shape and retry
          rules: <a href="#api-essentials">API essentials</a>.
        </p>
      </section>
    </article>
  );
}

export default function ApiReference() {
  const [hash, setHash] = useState(location.hash);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [document, setDocument] = useState<ReferenceDocument>();
  const [error, setError] = useState(false);
  const last = useRef('home');
  const selected = selection(hash);
  const id = ['#api-essentials', '#content'].includes(hash) ? last.current : selected.id;
  useEffect(() => {
    const changed = () => {
      setHash(location.hash);
      setMenu(false);
    };
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('popstate', changed);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/openapi.json', { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const doc: ReferenceDocument = await r.json();
        if (
          !resources.every(
            (route) =>
              doc.paths[route.path]?.get.operationId === route.id &&
              doc.paths[route.path]!.get['x-requests']?.length,
          )
        )
          throw new Error();
        setDocument(doc);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(true);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!document) return;
    if (hash.endsWith('Head') && !selected.unknown)
      history.replaceState(null, '', operationLink(id));
    const target = window.document.getElementById(
      hash === '#api-essentials' ? 'api-essentials' : 'ref-title',
    );
    last.current = id;
    if (hash) target?.focus({ preventScroll: true });
    if (hash)
      (hash === '#api-essentials'
        ? target
        : window.document.querySelector('.api-reference')
      )?.scrollIntoView({ block: 'start' });
  }, [document, hash, id, selected.unknown]);
  const matches = matchingResources(query);
  return (
    <div className="api-reference">
      <header className="ref-top">
        <h1>API reference</h1>
        <nav aria-label="Reference navigation">
          <a href="/api">API overview</a>
          <a href="#api-essentials">API essentials</a>
          <a href="/openapi.json" download="hexdailydata-openapi.json">
            Download OpenAPI
          </a>
        </nav>
      </header>
      <button
        className="ref-mobile-menu"
        aria-expanded={menu}
        aria-controls="ref-endpoints"
        onClick={() => setMenu((v) => !v)}
      >
        Endpoints · {resources.length} resources
      </button>
      <div className="ref-layout">
        <aside
          id="ref-endpoints"
          className={menu ? 'ref-navigation is-open' : 'ref-navigation'}
          aria-label="API endpoints"
        >
          <label htmlFor="ref-search">Find an endpoint</label>
          <input
            id="ref-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or path"
          />
          <span className="ref-count" role="status">
            {matches.length} resources
          </span>
          {endpointGroups.map((group) => (
            <section key={group.id}>
              <h2>{group.title}</h2>
              {group.routes
                .filter((route) => matches.some((m) => m.id === route.id))
                .map((route) => (
                  <a
                    data-endpoint={route.id}
                    key={route.id}
                    href={operationLink(route.id)}
                    aria-current={id === route.id ? 'page' : undefined}
                    onClick={() => {
                      setMenu(false);
                      if (id === route.id) window.document.getElementById('ref-title')?.focus();
                    }}
                  >
                    <span>{route.title}</span>
                    <code>{route.path}</code>
                  </a>
                ))}
            </section>
          ))}
          {matches.length === 0 && (
            <p>
              No matching endpoint. <button onClick={() => setQuery('')}>Clear search</button>
            </p>
          )}
        </aside>
        <div className="ref-content">
          {selected.unknown && (
            <p role="alert">
              Unknown endpoint link. Showing Home;{' '}
              <a href={operationLink('home')}>reset the link</a>.
            </p>
          )}
          {error ? (
            <p role="alert">
              Reference data could not load. Refresh, or use the overview and schema download.
            </p>
          ) : document ? (
            <Selected key={id} id={id} document={document} />
          ) : (
            <p role="status">Loading reference…</p>
          )}
          {document && (
            <section id="api-essentials" className="ref-essentials" tabIndex={-1}>
              <h2>API essentials</h2>
              <div>
                {Object.entries(document['x-essentials']).map(([key, value]) => (
                  <section key={key}>
                    <h3>
                      {(
                        {
                          exact: 'Exact values & units',
                          freshness: 'Freshness & coverage',
                          indexed: 'Indexed cursors',
                          hds: 'Source-reported history',
                          address: 'Pinned address pages',
                          errors: 'Errors & request limits',
                          downloads: 'Immutable downloads',
                          caching: 'Caching & revalidation',
                        } as Record<string, string>
                      )[key] ?? key}
                    </h3>
                    <p>{value}</p>
                  </section>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
