import test from 'node:test';
import assert from 'node:assert/strict';
import { ordinaryArrivalCohort } from '../integration/oracle.mjs';

test('predeclared capacity cohort survives a one-millisecond early timer and a late completion', () => {
  // Recorded ordinal80 arrived479999ms into the run, then completed in minute8.
  // It must stay in its declared cohort8; the literal wall arrival bucket remains7.
  const row = {
    path: '/api/v2/addresses/0x00000000000000000000000000000000000f7170',
    arrival: 479999,
    completion: 483420,
  };
  assert.equal(Math.floor(row.arrival / 60000), 7);
  assert.equal(ordinaryArrivalCohort(row.path), 8);
  assert.equal(Math.floor(row.completion / 60000), 8);
  assert.equal(
    ordinaryArrivalCohort('/api/v2/addresses/0x00000000000000000000000000000000000f7129'),
    0,
  );
  assert.throws(() =>
    ordinaryArrivalCohort('/api/v2/addresses/0x00000000000000000000000000000000000f7184'),
  );
  assert.throws(() => ordinaryArrivalCohort('/api/v2/addresses/not-an-address'));
});
