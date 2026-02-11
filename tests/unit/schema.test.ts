import { describe, expect, it } from 'vitest';

import { normalizeOutputs, parseJsonObject, validateMeta } from '../../src/lib/schema.js';

describe('schema', () => {
  it('accepts valid flat scalar outputs', () => {
    const outputs = normalizeOutputs({ ok: true, count: 2, note: 'x', none: null }, 'strict');
    expect(outputs).toEqual({ ok: true, count: 2, note: 'x', none: null });
  });

  it('rejects invalid output keys in strict mode', () => {
    expect(() => normalizeOutputs({ 'bad-key': true }, 'strict')).toThrow(/Invalid output key/);
  });

  it('rejects nested values in strict mode', () => {
    expect(() => normalizeOutputs({ nested: { ok: true } }, 'strict')).toThrow(/scalar/);
  });

  it('parses json objects only', () => {
    expect(parseJsonObject('{"a":1}', 'x')).toEqual({ a: 1 });
    expect(() => parseJsonObject('[]', 'x')).toThrow(/JSON object/);
  });

  it('validates required meta fields', () => {
    const meta = {
      schema_version: 2,
      repository: 'owner/repo',
      workflow_name: 'CI',
      workflow_run_id: '1',
      workflow_run_attempt: '1',
      event_name: 'pull_request',
      head_sha: 'abc',
      created_at: new Date().toISOString()
    };
    expect(() => validateMeta(meta)).not.toThrow();
  });

  it('rejects unsupported schema version', () => {
    expect(() =>
      validateMeta({
        schema_version: 999,
        repository: 'owner/repo',
        workflow_name: 'CI',
        workflow_run_id: '1',
        workflow_run_attempt: '1',
        event_name: 'pull_request',
        head_sha: 'abc',
        created_at: new Date().toISOString()
      })
    ).toThrow(/Unsupported schema_version/);
  });

  it('rejects missing required meta fields', () => {
    expect(() =>
      validateMeta({
        schema_version: 2,
        repository: 'owner/repo',
        workflow_name: 'CI',
        workflow_run_id: '1',
        workflow_run_attempt: '1',
        event_name: 'pull_request',
        head_sha: 'abc'
      })
    ).toThrow(/Missing required meta field: created_at/);
  });

  it('rejects empty required string meta fields', () => {
    expect(() =>
      validateMeta({
        schema_version: 2,
        repository: '',
        workflow_name: 'CI',
        workflow_run_id: '1',
        workflow_run_attempt: '1',
        event_name: 'pull_request',
        head_sha: 'abc',
        created_at: new Date().toISOString()
      })
    ).toThrow(/Invalid meta field: repository/);
  });

  it('rejects invalid optional meta field types', () => {
    expect(() =>
      validateMeta({
        schema_version: 2,
        repository: 'owner/repo',
        workflow_name: 'CI',
        workflow_run_id: '1',
        workflow_run_attempt: '1',
        event_name: 'pull_request',
        head_sha: 'abc',
        created_at: new Date().toISOString(),
        pr_number: '12'
      })
    ).toThrow(/meta.pr_number must be a number/);

    expect(() =>
      validateMeta({
        schema_version: 2,
        repository: 'owner/repo',
        workflow_name: 'CI',
        workflow_run_id: '1',
        workflow_run_attempt: '1',
        event_name: 'pull_request',
        head_sha: 'abc',
        created_at: new Date().toISOString(),
        event: []
      })
    ).toThrow(/meta.event must be an object/);
  });
});
