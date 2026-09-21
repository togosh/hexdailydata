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

test('five stable concepts share one short-answer source; Learn-only prose stays lazy', () => {
  assert.deepEqual(
    concepts.map((c) => c.id),
    ['hex', 'staking', 'tshares', 'payout', 'pulsechain'],
  );
  assert.equal(new Set(concepts.map((c) => c.anchor)).size, 5);
  assert.equal(concepts[1].anchor, 'staking-basics');
  const home = readFileSync('src/web/HomeFaq.tsx', 'utf8');
  const learn = readFileSync('src/web/Learn.tsx', 'utf8');
  assert.match(home, /concepts\.map/);
  assert.match(home, /\{concept\.answer\}/);
  for (const concept of concepts) assert.ok(learn.includes(`<Summary id="${concept.id}"`));
  assert.doesNotMatch(home, /Information|Learn\.tsx|learnResources|fetch\(/);
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
  assert.match(source, /10 T-Shares correspond to 60 HEX/);
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
