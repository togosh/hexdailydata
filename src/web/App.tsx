import { useEffect, useState } from 'react';
import { StatusResponseSchema } from '../contracts/api.ts';
import './style.css';

export default function App() {
  const [status, setStatus] = useState('Connecting to the development API…');
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    void fetch('/api/v2/status', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('API unavailable');
        StatusResponseSchema.parse(await response.json());
        if (active) setStatus('Development API connected. HEX data is not available yet.');
      })
      .catch(() => {
        if (active) setStatus('Development API unavailable. HEX data is not available yet.');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  return (
    <main>
      <header>
        <h1>HEXDailyData</h1>
        <span>PulseChain</span>
      </header>
      <p role="status">{status}</p>
      <section aria-labelledby="metrics-title">
        <h2 id="metrics-title">Current HEX data</h2>
        <dl>
          {['HEX price', 'T-share rate', 'Today’s payout estimate', 'Latest completed payout'].map(
            (label) => (
              <div className="metric" key={label}>
                <dt>{label}</dt>
                <dd>Unavailable</dd>
              </div>
            ),
          )}
        </dl>
      </section>
      <p>Shared Ethereum-era HEX history will be identified separately from PulseChain activity.</p>
      <footer>Development shell · Live data qualification and final interface are pending.</footer>
    </main>
  );
}
