/** Tasks 01/07 wire this shell to the shared contracts. No fictitious market numbers. */
import './style.css';

export default function App() {
  return (
    <main>
      <header>
        <h1>HEXDailyData</h1>
        <span>PulseChain</span>
      </header>
      <p role="status">
        Version 2 development scaffold. Data synchronization is not implemented yet.
      </p>
      <section aria-label="Build status">
        <h2>Current HEX data</h2>
        <p>
          Live price, T-share rate, payout and address data will appear here
          after their build tasks pass.
        </p>
      </section>
    </main>
  );
}
