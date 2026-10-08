import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { concepts } from '../../src/web/education.ts';
import {
  primaryResources,
  deeperResources,
  resourceCheckDate,
} from '../../src/web/learnResources.ts';
import { HEARTS_PER_HEX, SHARES_PER_TSHARE } from '../../src/domain/units.ts';
import { quoteStake, payoutScenario } from '../../src/domain/calculator.ts';
import { HEX_LAUNCH_SECONDS } from '../../src/domain/day.ts';
import { HomeResponseSchema } from '../../src/contracts/api.ts';

test('five Learn questions preserve risk meanings; Home only links to the lazy route', () => {
  assert.deepEqual(
    concepts.map((c) => c.id),
    ['hex', 'staking', 'tshares', 'payout', 'tools'],
  );
  assert.equal(new Set(concepts.map((c) => c.anchor)).size, 5);
  assert.equal(concepts[1].anchor, 'staking-basics');
  const home = readFileSync('src/web/Home.tsx', 'utf8');
  assert.match(home, /className="home-learn-link" href="\/learn"/);
  assert.match(home, /New to HEX\? Learn the basics →/);
  assert.doesNotMatch(home, /HomeFaq|home-faq|concepts|education\.ts|Learn\.tsx|learnResources/);
  assert.match(concepts[1].answer, /cannot spend the committed amount while staked/);
  assert.match(
    concepts[1].answer,
    /Ending early or too late can reduce the payout and starting amount/,
  );
  assert.match(
    concepts[1].answer,
    /owner must use Stake End.*maturity does not pay it automatically/,
  );
  assert.match(concepts[2].answer, /one trillion stake shares/);
  assert.match(concepts[2].answer, /not a separate token to buy or trade/);
  assert.match(concepts[2].answer, /not an interest rate/);
  assert.match(
    concepts[3].answer,
    /not a guaranteed future rate or a daily deposit into your wallet/,
  );
  assert.match(concepts[4].answer, /does not sell tokens or execute stakes/);
  const learn = readFileSync('src/web/Learn.tsx', 'utf8');
  assert.doesNotMatch(learn, /<details[^>]*\bopen[\s=>]/);
  assert.match(learn, /HEXDailyData is read-only/);
  assert.match(learn, /Maturity is not an automatic wallet payment/);
  for (const id of [
    'start',
    'hex',
    'pulsechain',
    'staking-basics',
    'staking',
    'tshares',
    'payout',
    'example-title',
    'data',
    'project-resources',
    'learn-depth-title',
    'longer-stakes',
    'maturity-questions',
    'good-accounting',
    'stake-states',
    'using-tools',
    'math',
    'methodology',
    'protocol-context',
    'share-mechanics',
    'site-pages',
    'resources',
  ]) {
    assert.equal(
      learn.split(`id="${id}"`).length - 1 - (concepts.some((c) => c.id === id) ? 1 : 0),
      1,
      `one DOM fragment ${id} (Summary props excluded)`,
    );
  }
  assert.match(
    readFileSync('src/web/App.tsx', 'utf8'),
    /lazy\(\(\) => import\('\.\/Learn\.tsx'\)\)/,
  );
});

test('curated resources retain exact HTTPS destinations, classifications and check date', () => {
  assert.equal(resourceCheckDate, '2026-09-21');
  const resources = [
    ...primaryResources,
    ...deeperResources.flatMap((r) => [r, ...(r.companion ? [r.companion] : [])]),
  ];
  assert.deepEqual(
    resources.map((r) => r.href),
    [
      'https://hex.com/',
      'https://pulsechain.com/',
      'https://go.hex.com/',
      'https://app.pulsex.com/',
      'https://hex.com/dev',
      'https://hex.com/_assets/docs/HEX_whitepaper.pdf',
      'https://hexicans.info/documentation/deep-dive/',
      'https://docs.google.com/document/d/112IkMxL94d5AlXukQonRLlyNlF0_5zmX6k1Z0Stsmo0/edit',
      'https://www.coinfabrik.com/blog/hex-financial-audit/',
    ],
  );
  for (const resource of resources) {
    const url = new URL(resource.href);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.search, '');
    assert.equal(url.username + url.password, '');
  }
  assert.match(deeperResources[1].label, /historical community guide/);
  assert.match(deeperResources[2].label, /2019/);
});

test('published units and illustrative daily allocation match independent packet literals', () => {
  assert.equal(HEARTS_PER_HEX, 100000000n);
  assert.equal(SHARES_PER_TSHARE, 1000000000000n);
  const result = payoutScenario(
    { principalHearts: 100000000n, stakeShares: 10000000000000n, days: 1 },
    { numerator: 6n, denominator: 1n },
    null,
  );
  assert.equal(result.rewardHex.numerator / result.rewardHex.denominator, 60n);
  const source = readFileSync('src/web/Learn.tsx', 'utf8');
  assert.match(source, /10 T-Shares × 6 HEX per T-Share ≈ 60 HEX/);
  // Packet's independent combined-floor witness; never generate expected values from quoteStake.
  const quote = quoteStake(100000000001n, 2, 123456n, HEX_LAUNCH_SECONDS + 100n * 86400n);
  assert.equal(quote.bonusHearts, 55011721n);
  assert.equal(quote.stakeShares, 81045078183n);
  assert.equal(quote.lockedDay, 101);
});

test('browser presentation fixture is explicitly synthetic and satisfies the actual Home wire contract', () => {
  const fixture = JSON.parse(readFileSync('tests/browser/education-fixture.json', 'utf8'));
  assert.match(fixture.description, /SYNTHETIC/);
  HomeResponseSchema.parse(fixture.home);
});
