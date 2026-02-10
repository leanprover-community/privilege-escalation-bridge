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
      schema_version: 1,
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
});
