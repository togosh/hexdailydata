import assert from 'node:assert/strict';

export const auditPostgresImage =
  'postgres:17.11-bookworm@sha256:e8587c2065ad04a2798579d86275e12c85b73b164ed2cacaa46693d636340d08';

/** Validate the effective, standalone audit graph; never inherit normal worker,
 * initialization, export, backup or prior session mounts. No Docker mutation here. */
export function checkAuditBindings(plan, graph, volume, stateVolumes, containers) {
  const phase = plan.phases[0];
  assert.equal(phase.kind, 'pinned-audit');
  assert.deepEqual(Object.keys(graph.services).sort(), ['db', 'operator']);
  const db = graph.services.db,
    op = graph.services.operator;
  assert.equal(graph.name, plan.project);
  assert.equal(op.image, plan.release);
  assert.equal(db.image, auditPostgresImage);
  assert.deepEqual(db.entrypoint, ['postgres']); // Missing PG data cannot invoke initdb.
  assert.equal(db.ports, undefined);
  assert.equal(op.ports, undefined);
  assert.equal(op.depends_on, undefined);
  assert.equal(db.depends_on, undefined);
  assert.equal(op.environment.HDD_V2_DB_INSTANCE, plan.instance);
  assert.equal(op.environment.HDD_V2_PROJECT, plan.project);
  assert.equal(op.environment.HDD_V2_DB_HOST, 'db');
  assert.equal(op.environment.HDD_V2_DB_NAME, 'hexdailydata_v2');
  assert.equal(op.environment.HDD_V2_STORAGE_PATH, plan.storagePath);
  assert.equal(op.environment.HDD_V2_PROVIDER_STATE, plan.quotaPath);
  assert.equal(op.environment.HDD_V2_CANARY_RELEASE, plan.release);
  assert.equal(op.environment.HDD_V2_ALLOW_LIVE_RPC, 'false');
  assert.equal(op.environment.HDD_V2_CANARY_OPT_IN ?? '', '');
  assert.deepEqual(op.entrypoint, ['node', 'dist/operator/main.js']);
  assert.equal(db.read_only, true);
  assert.equal(op.read_only, true);
  assert.equal(Number(db.cpus), 1.25);
  assert.equal(Number(op.cpus), 0.5);
  assert.equal(Number(db.mem_limit), 2684354560);
  assert.equal(Number(op.mem_limit), 1073741824);
  assert.deepEqual(Object.keys(db.networks), ['private']);
  assert.equal(graph.networks.private.internal, true);
  assert.deepEqual(Object.keys(op.networks).sort(), ['egress', 'private']);
  assert.equal(db.volumes.length, 1);
  const data = db.volumes[0];
  assert.equal(data.type, 'volume');
  assert.equal(data.target, '/var/lib/postgresql/data');
  assert.equal(graph.volumes[data.source].external, true);
  assert.equal(graph.volumes[data.source].name, phase.admission.volume);
  assert.equal(volume.Name, phase.admission.volume);
  assert.equal(volume.Labels['hdd.v2.instance'], plan.instance);
  assert.equal(op.volumes.length, 3);
  assert.deepEqual(
    op.volumes.map((m) => m.target).sort(),
    ['/input', plan.quotaPath, plan.storagePath].sort(),
  );
  const input = op.volumes.find((m) => m.target === '/input');
  assert.equal(input.type, 'bind');
  assert.equal(input.read_only, true);
  for (const target of [plan.storagePath, plan.quotaPath]) {
    const mount = op.volumes.find((m) => m.target === target);
    assert.equal(mount.type, 'volume');
    const definition = graph.volumes[mount.source];
    assert.equal(definition.external, true);
    assert.notEqual(definition.name, phase.admission.volume);
    const actual = stateVolumes.find((v) => v.Name === definition.name);
    assert.equal(actual?.Labels?.['hdd.v2.audit-session'], plan.session);
  }
  assert.notEqual(
    op.volumes.find((m) => m.target === plan.storagePath).source,
    op.volumes.find((m) => m.target === plan.quotaPath).source,
  );
  assert.deepEqual(op.secrets.map((s) => s.source).sort(), ['api', 'worker']);
  assert.equal(db.secrets, undefined);
  for (const c of containers) {
    if (!c.Mounts.some((m) => m.Type === 'volume' && m.Name === phase.admission.volume)) continue;
    assert.equal(
      c.Config.Labels['com.docker.compose.project'],
      plan.project,
      'Retained database active elsewhere',
    );
    assert.equal(c.Config.Labels['com.docker.compose.service'], 'db');
    assert.equal(c.Config.Image, auditPostgresImage);
  }
  return {
    mode: 'pinned-audit',
    project: plan.project,
    instance: plan.instance,
    volume: volume.Name,
    image: op.image,
    onlyServices: ['db', 'operator'],
    canonicalSql: 'read-only',
    newStateVolumes: stateVolumes.map((v) => v.Name),
  };
}
