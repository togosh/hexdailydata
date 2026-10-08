import { Component, type ReactNode, lazy, Suspense, useEffect, useState } from 'react';
import Home from './Home.tsx';
import { revealAnchor } from './anchors.ts';
import { SearchForm } from './components.tsx';
import { Dialog, HexMark, Icon, type IconName } from './visuals.tsx';
import './style.css';
const History = lazy(() => import('./History.tsx'));
const Charts = lazy(() => import('./Charts.tsx'));
const MaturityDetail = lazy(() => import('./MaturityDetail.tsx'));
const Calculator = lazy(() => import('./Calculator.tsx'));
const ApiReference = lazy(() => import('./ApiReference.tsx'));
class ReferenceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <section role="alert">
        <h1>Reference could not load</h1>
        <p>Try refreshing, or use the overview and schema.</p>
        <a href="/api">API overview</a> ·{' '}
        <a href="/openapi.json" download="hexdailydata-openapi.json">
          Download OpenAPI
        </a>
      </section>
    ) : (
      this.props.children
    );
  }
}
const ApiGuide = lazy(() => import('./ApiGuide.tsx'));
const Search = lazy(() => import('./Search.tsx'));
const Downloads = lazy(() => import('./Information.tsx').then((m) => ({ default: m.Downloads })));
const Learn = lazy(() => import('./Learn.tsx'));
const Status = lazy(() => import('./Information.tsx').then((m) => ({ default: m.Status })));
const links = [
  ['/', 'Home', 'home'],
  ['/charts', 'Charts', 'chart'],
  ['/calculator', 'Calculator', 'calendar'],
  ['/downloads', 'Data', 'database'],
  ['/search', 'Search', 'search'],
] satisfies [string, string, IconName][];
// Inside Suspense: effects wait for the destination route's DOM, even on a cold hash URL.
function RoutePosition({ hash, navigation }: { hash: string; navigation: number }) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const main = document.querySelector<HTMLElement>('main');
      if (!main) return;
      if (hash && revealAnchor(hash, main)) return;
      if (navigation > 0) {
        main.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, navigation]);
  return null;
}
export default function App() {
  const [path, setPath] = useState(location.pathname);
  const [navigation, setNavigation] = useState(0);
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
    let lastHref = location.href;
    const changed = (event?: Event) => {
      // Traversing a fragment history entry can emit both events for one navigation.
      if (event?.type === 'hashchange' && lastHref === location.href) return;
      lastHref = location.href;
      setMenu(false);
      setPath(location.pathname);
      setNavigation((value) => value + 1);
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
        url.pathname === '/account' ||
        url.pathname.startsWith('/account/') ||
        (url.pathname.startsWith('/api/') && url.pathname !== '/api/reference') ||
        (location.pathname === '/api/reference' && url.pathname === '/api/reference') ||
        url.pathname === '/openapi.json' ||
        url.pathname.startsWith('/health/')
      )
        return;
      event.preventDefault();
      if (url.href !== location.href) history.pushState(null, '', url);
      changed();
    };
    window.addEventListener('popstate', changed);
    window.addEventListener('hashchange', changed);
    document.addEventListener('click', clicked);
    return () => {
      window.removeEventListener('popstate', changed);
      window.removeEventListener('hashchange', changed);
      document.removeEventListener('click', clicked);
    };
  }, []);
  useEffect(() => {
    document.title = `${path === '/' ? 'Home' : path === '/api' ? 'API Access' : path === '/api/reference' ? 'API reference' : path.split('/')[1]} · HEXDailyData`;
  }, [path]);
  const active =
    path.startsWith('/address/') || path.startsWith('/stake/')
      ? '/search'
      : path.startsWith('/charts')
        ? '/charts'
        : path === '/api/reference'
          ? '/api'
          : path;
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
              ['/learn', 'Learn', 'chart'],
              ['/status', 'Data status', 'chart'],
              ['/api', 'Developer API', 'chart'],
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
            <Charts />
          ) : path === '/charts/maturities' ? (
            <MaturityDetail />
          ) : path === '/charts/detail' ? (
            <History />
          ) : path === '/calculator' ? (
            <Calculator />
          ) : path === '/api/reference' ? (
            <ReferenceBoundary>
              <ApiReference />
            </ReferenceBoundary>
          ) : path === '/api' ? (
            <ApiGuide />
          ) : path === '/downloads' ? (
            <Downloads />
          ) : path === '/learn' ? (
            <Learn />
          ) : path === '/status' ? (
            <Status />
          ) : path === '/search' || /^\/(address|stake)\//.test(path) ? (
            <Search key={path + location.search} path={path} />
          ) : (
            <>
              <h1>Page not found</h1>
              <a href="/">Return Home</a>
            </>
          )}
          {path !== '/api/reference' && (
            <RoutePosition hash={location.hash} navigation={navigation} />
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
          <a href="/learn#methodology">Learn &amp; methodology</a>
          <a href="/status">Data status</a>
          <a href="/api">Developer API</a>
        </nav>
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
