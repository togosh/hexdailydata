import { lazy, Suspense, useEffect, useState } from 'react';
import Home from './Home.tsx';
import './style.css';
const History = lazy(() => import('./History.tsx'));
const Calculator = lazy(() => import('./Calculator.tsx'));
const Search = lazy(() => import('./Search.tsx'));
const Downloads = lazy(() => import('./Information.tsx').then((m) => ({ default: m.Downloads })));
const Learn = lazy(() => import('./Information.tsx').then((m) => ({ default: m.Learn })));
const Status = lazy(() => import('./Information.tsx').then((m) => ({ default: m.Status })));
const links = [
  ['/', 'Home'],
  ['/charts', 'Charts'],
  ['/search', 'Search'],
  ['/calculator', 'Calculator'],
  ['/downloads', 'Downloads'],
];
export default function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const changed = () => {
      setPath(location.pathname);
      window.scrollTo(0, 0);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('main')?.focus());
    };
    const clicked = (event: MouseEvent) => {
      const link = (event.target as Element).closest('a');
      if (
        !link ||
        event.defaultPrevented ||
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        link.target ||
        link.hasAttribute('download')
      )
        return;
      const url = new URL(link.href);
      if (
        url.origin !== location.origin ||
        url.hash ||
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/health/')
      )
        return;
      event.preventDefault();
      if (url.pathname !== location.pathname || url.search !== location.search)
        history.pushState(null, '', url);
      changed();
    };
    window.addEventListener('popstate', changed);
    document.addEventListener('click', clicked);
    return () => {
      window.removeEventListener('popstate', changed);
      document.removeEventListener('click', clicked);
    };
  }, []);
  useEffect(() => {
    document.title = `${path === '/' ? 'Home' : path.split('/')[1]} · HEXDailyData`;
  }, [path]);
  const active = path.startsWith('/address/') || path.startsWith('/stake/') ? '/search' : path;
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <header className="site-header">
        <a href="/" className="brand" aria-label="HEXDailyData home">
          <span className="brand-mark" aria-hidden="true">
            ⬡
          </span>
          <span>
            HEXDailyData<small>PulseChain research &amp; staking data</small>
          </span>
        </a>
        <span className="chain-badge">PulseChain</span>
        <nav aria-label="Main navigation">
          {links.map(([href, label]) => (
            <a href={href} key={href} aria-current={active === href ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
      </header>
      <main id="content" tabIndex={-1}>
        <Suspense fallback={<p role="status">Loading page…</p>}>
          {path === '/' ? (
            <Home />
          ) : path === '/charts' ? (
            <History />
          ) : path === '/calculator' ? (
            <Calculator />
          ) : path === '/downloads' ? (
            <Downloads />
          ) : path === '/learn' ? (
            <Learn />
          ) : path === '/status' ? (
            <Status />
          ) : path === '/search' || /^\/(address|stake)\//.test(path) ? (
            <Search key={path} path={path} />
          ) : (
            <>
              <h1>Page not found</h1>
              <a href="/">Return Home</a>
            </>
          )}
        </Suspense>
      </main>
      <footer className="site-footer">
        <span>
          HEXDailyData <small>· PulseChain</small>
        </span>
        <nav aria-label="More information">
          <a href="/learn">Learn &amp; methodology</a>
          <a href="/status">Data status</a>
          <a href="/api/v2/status?chain=pulsechain">API metadata</a>
        </nav>
        <p>Read-only data. Each source has its own observation time and coverage.</p>
      </footer>
    </>
  );
}
