import { useId, useState, type ReactNode, type FormEvent } from 'react';
import { numberText } from './format.ts';
import { Icon, type IconName } from './visuals.tsx';
import { normalizeSearch, readSearches, rememberSearch, recentSearchKey } from './searches.ts';

export function Value({
  value,
  unit = '',
  places,
  prefix = '',
}: {
  value: string | null | undefined;
  unit?: string;
  places?: number;
  prefix?: string;
}) {
  return (
    <span
      className="value"
      title={value == null ? 'Unavailable' : prefix + value + (unit ? ' ' + unit : '')}
    >
      {value == null ? (
        'Unavailable'
      ) : (
        <>
          {prefix}
          {numberText(value, places)}
          {unit && <small> {unit}</small>}
        </>
      )}
    </span>
  );
}
export function Metric({
  title,
  value,
  unit,
  prefix,
  note,
  id,
  display,
  icon = 'chart',
}: {
  title: string;
  value: string | null | undefined;
  unit?: string;
  prefix?: string;
  note?: ReactNode;
  id?: string;
  display?: string;
  icon?: IconName;
}) {
  return (
    <div className="metric" data-metric={id}>
      <dt>
        <Icon name={icon} />
        {title}
      </dt>
      <dd>
        {value != null && display !== undefined ? (
          <span className="value" title={(prefix ?? '') + value + (unit ? ' ' + unit : '')}>
            {prefix}
            {display}
            {unit && <small> {unit}</small>}
          </span>
        ) : (
          <Value
            value={value}
            {...(unit ? { unit } : {})}
            {...(prefix ? { prefix } : {})}
            places={4}
          />
        )}
      </dd>
      {note != null && <div className="meta">{note}</div>}
    </div>
  );
}
export function Feedback({
  loading,
  error,
  refresh,
  hasData = false,
}: {
  loading: boolean;
  error?: string | undefined;
  refresh: () => void;
  hasData?: boolean;
}) {
  return (
    <div className="feedback">
      <span role="status">
        {error
          ? `${error}${hasData ? ' Last received data remains dated below.' : ''}`
          : loading
            ? 'Loading…'
            : ''}
      </span>
      <button type="button" onClick={refresh} disabled={loading}>
        Refresh
      </button>
    </div>
  );
}
export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [status, setStatus] = useState('');
  return (
    <span className="copy">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => setStatus('Copied'),
            () => setStatus('Select the full value to copy.'),
          );
        }}
      >
        {label}
      </button>
      <span role="status">{status}</span>
    </span>
  );
}
export function Table({
  title,
  headings,
  children,
}: {
  title: string;
  headings: string[];
  children: ReactNode;
}) {
  return (
    <div className="table-region" role="region" aria-label={title} tabIndex={0}>
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            {headings.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function SearchForm({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const [value, setValue] = useState(''),
    [error, setError] = useState('');
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return readSearches(localStorage);
    } catch {
      return [];
    }
  });
  const navigate = (term: string) => {
    try {
      setRecent(rememberSearch(localStorage, term));
    } catch {
      /* Search works without storage. */
    }
    window.history.pushState(
      null,
      '',
      term.startsWith('0x') ? '/address/' + term : '/stake/' + term,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
    setError('');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const term = normalizeSearch(value);
    if (term === null) {
      setError('Enter a 42-character address or a decimal stake ID below 1099511627776.');
      return;
    }
    navigate(term);
  };
  return (
    <form className={'search ' + (compact ? 'compact' : '')} onSubmit={submit}>
      <label htmlFor={id} className={compact ? 'sr-only' : ''}>
        {compact ? 'Header address or stake ID' : 'Address or stake ID'}
      </label>
      <div className="inline">
        <input
          id={id}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError('');
          }}
          placeholder="Address or stake ID"
          spellCheck={false}
          maxLength={80}
          aria-invalid={!!error}
          aria-describedby={error ? id + '-error' : undefined}
        />
        <button className="primary" aria-label={compact ? 'Search from header' : 'Search'}>
          {compact ? <Icon name="search" /> : 'Search'}
        </button>
      </div>
      {error && (
        <p id={id + '-error'} role="alert">
          {error}
        </p>
      )}
      {!compact && recent.length > 0 && (
        <details className="recent-searches">
          <summary>
            Recent searches <span>On this device</span>
          </summary>
          <div>
            {recent.map((term) => (
              <button type="button" key={term} title={term} onClick={() => navigate(term)}>
                {term.startsWith('0x') ? term.slice(0, 8) + '…' + term.slice(-6) : '#' + term}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.removeItem(recentSearchKey);
                } catch {
                  /* Clear the displayed history too. */
                }
                setRecent([]);
                document.getElementById(id)?.focus();
              }}
            >
              Clear recent searches
            </button>
          </div>
        </details>
      )}
    </form>
  );
}
