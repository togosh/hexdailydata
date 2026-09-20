import { lazy, Suspense, useEffect, useState } from 'react';
import Home from './Home.tsx';
import { SearchForm } from './components.tsx';
import { Dialog, HexMark, Icon, type IconName } from './visuals.tsx';
import './style.css';
const History = lazy(() => import('./History.tsx'));
const Calculator = lazy(() => import('./Calculator.tsx'));
const Search = lazy(() => import('./Search.tsx'));
const Downloads = lazy(() => import('./Information.tsx').then((m) => ({ default: m.Downloads })));
const Learn = lazy(() => import('./Information.tsx').then((m) => ({ default: m.Learn })));
const Status = lazy(() => import('./Information.tsx').then((m) => ({ default: m.Status })));
const links = [
  ['/', 'Home', 'home'],
  ['/charts', 'Charts', 'chart'],
  ['/calculator', 'Calculator', 'calendar'],
  ['/downloads', 'Data', 'database'],
  ['/search', 'Search', 'search'],
] satisfies [string, string, IconName][];
export default function App() {
  const [path, setPath] = useState(location.pathname);
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('hdd-v2-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#050d18' : '#f5f8fc');
    try {
      localStorage.setItem('hdd-v2-theme', theme);
    } catch {
      // A blocked preference store must not disable the theme control.
    }
  }, [theme]);
  useEffect(() => {
    const changed = () => {
      setMenu(false);
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
          <HexMark />
          <span>
            HEXDailyData<small>PulseChain HEX research &amp; staking data</small>
          </span>
        </a>
        <nav className="desktop-nav" aria-label="Main navigation">
          {links.map(([href, label]) => (
            <a href={href} key={href} aria-current={active === href ? 'page' : undefined}>
              {label}
            </a>
          ))}
          <a href="/learn" aria-current={active === '/learn' ? 'page' : undefined}>
            Learn
          </a>
        </nav>
        <div className="header-search">
          <SearchForm compact />
        </div>
        <div className="header-actions">
          <button
            className="theme-toggle"
            aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Use ${theme === 'dark' ? 'light' : 'dark'} mode`}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <button
            className="menu-toggle"
            aria-label="Open navigation menu"
            aria-haspopup="dialog"
            aria-expanded={menu}
            onClick={() => setMenu(true)}
          >
            <Icon name="menu" />
          </button>
        </div>
      </header>
      {menu && (
        <Dialog title="Navigation" onClose={() => setMenu(false)}>
          <nav className="menu-links" aria-label="All destinations">
            {[
              ...links,
              ['/learn', 'Learn & methodology', 'chart'],
              ['/status', 'Data status', 'chart'],
            ].map(([href, label]) => (
              <a key={href} href={href} aria-current={active === href ? 'page' : undefined}>
                {label}
              </a>
            ))}
          </nav>
        </Dialog>
      )}
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
        <a href="/" className="brand">
          <HexMark />
          <span>
            HEXDailyData<small>PulseChain HEX research &amp; staking data</small>
          </span>
        </a>
        <nav aria-label="More information">
          <a href="/learn">Learn &amp; methodology</a>
          <a href="/status">Data status</a>
          <a href="/api/v2/status?chain=pulsechain">API metadata</a>
        </nav>
        <p>Read-only data. Each source has its own observation time and coverage.</p>
      </footer>
      <nav className="bottom-nav" aria-label="Mobile destinations">
        {links.map(([href, label, icon]) => (
          <a href={href} key={href} aria-current={active === href ? 'page' : undefined}>
            <Icon name={icon} />
            {label}
          </a>
        ))}
      </nav>
    </>
  );
}
