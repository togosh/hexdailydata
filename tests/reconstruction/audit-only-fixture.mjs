import assert from 'node:assert/strict';
import pg from 'pg';
import { CanonicalWriter } from '../../dist/services/projections/writer.js';
import { SyncEngine } from '../../dist/worker/sync/engine.js';
import { newPlan, fixture } from './fixture.mjs';

export async function auditPlan(root, prior, overrides = {}) {
  return newPlan(root, prior, {
    auditOnly: true,
    target: '355',
    milestones: ['355'],
    methods: ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'],
    ...overrides,
  });
}

/** Installed only after fixture seeding. Actual pg clients/statements still execute. */
export function readOnlyWitness() {
  const connect = pg.Client.prototype.connect,
    query = pg.Client.prototype.query;
  const acquire = CanonicalWriter.acquire,
    once = SyncEngine.prototype.once;
  const clients = [],
    statements = [];
  pg.Client.prototype.connect = function (...args) {
    assert.equal(this.connectionParameters.options, '-c default_transaction_read_only=on');
    assert(['hdd_v2_worker', 'hdd_v2_api'].includes(this.connectionParameters.user));
    clients.push(this.connectionParameters.user);
    return connect.apply(this, args);
  };
  pg.Client.prototype.query = function (text, ...args) {
    const sql = typeof text === 'string' ? text : text.text;
    statements.push(sql);
    assert(
      /^(WITH|SELECT|DECLARE audit_rows NO SCROLL CURSOR FOR SELECT|FETCH FORWARD 256 FROM audit_rows|CLOSE audit_rows|SET (?:LOCAL |TRANSACTION |default_transaction_read_only=on|statement_timeout|idle_in_transaction_session_timeout)|BEGIN|ROLLBACK)/i.test(
        sql.trim(),
      ),
      sql,
    );
    assert(!/\b(?:setval|nextval)\s*\(/i.test(sql), sql);
    return query.call(this, text, ...args);
  };
  CanonicalWriter.acquire = () => {
    throw Error('Audit constructed canonical writer');
  };
  SyncEngine.prototype.once = () => {
    throw Error('Audit attempted replay');
  };
  return {
    clients,
    statements,
    close() {
      pg.Client.prototype.connect = connect;
      pg.Client.prototype.query = query;
      CanonicalWriter.acquire = acquire;
      SyncEngine.prototype.once = once;
    },
  };
}

export function auditFixture(p, clock, mode = 'normal') {
  const f = fixture(p, clock, mode),
    calls = [];
  const transport = f.transport;
  f.transport = (endpoint) => {
    const raw = transport(endpoint);
    return async (body, signal, deadline) => {
      const batch = JSON.parse(body);
      calls.push({ source: p.profile.ethereum[p.endpoints.indexOf(endpoint)].id, calls: batch });
      for (const c of batch) {
        assert.notEqual(c.method, 'eth_getLogs');
        if (c.method === 'eth_call')
          assert.deepEqual(c.params[1], {
            blockHash: p.admission.checkpoint.hash,
            requireCanonical: true,
          });
      }
      return raw(body, signal, deadline);
    };
  };
  f.calls = calls;
  return f;
}
