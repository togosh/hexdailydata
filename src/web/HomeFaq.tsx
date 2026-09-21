import { concepts } from './education.ts';

export default function HomeFaq() {
  return (
    <section className="home-faq" aria-labelledby="home-faq-title">
      <div>
        <h2 id="home-faq-title">New to HEX?</h2>
        <p className="home-faq-subtitle">Understand the numbers.</p>
        <p>Start with five short answers about HEX, staking and the data on this page.</p>
        <a href="/learn">Learn HEX →</a>
      </div>
      <div>
        {concepts.map((concept, index) => (
          <details id={`home-faq-${concept.id}`} key={concept.id} open={index === 0}>
            <summary>{concept.question}</summary>
            <p>{concept.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
