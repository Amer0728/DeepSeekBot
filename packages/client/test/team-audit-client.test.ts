import { describe, expect, it, vi } from 'vitest';

import {
  loadAuditLog,
  openPrivateContent,
  parsePrivateObject,
} from '../src/client/team-audit-bridge.js';

describe('private content audit client', () => {
  it('keeps only known private object kinds', () => {
    expect(parsePrivateObject({ objectId: 'b1', kind: 'bot', name: 'Helper' })).toEqual({
      objectId: 'b1',
      kind: 'bot',
      name: 'Helper',
    });
    expect(parsePrivateObject({ objectId: 'x', kind: 'file' })).toBeUndefined();
  });

  it('opens a view with an optional trimmed reason and reads its messages', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      value: {
        viewId: 'v1',
        messages: [
          {
            id: 'm1',
            at: '2026-11-15T00:00:00.000Z',
            author: { kind: 'human', displayName: 'Bob' },
            body: 'hi',
          },
        ],
      },
    }));
    const view = await openPrivateContent(
      call,
      { objectId: 'c1', kind: 'channel', name: 'Ops' },
      '  incident  ',
    );
    expect(call).toHaveBeenCalledWith(
      'privateContentOpen',
      { kind: 'channel', objectId: 'c1', reason: 'incident' },
      undefined,
    );
    expect(view.messages).toEqual([
      { id: 'm1', at: '2026-11-15T00:00:00.000Z', author: 'Bob', body: 'hi' },
    ]);
  });

  it('reads audit records from a page', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      value: {
        items: [
          { auditId: 'a1', at: 'now', viewerName: 'Owner', kind: 'dm', objectName: 'Bob · Alice' },
          { auditId: 'bad' },
        ],
      },
    }));
    expect((await loadAuditLog(call)).map((row) => row.auditId)).toEqual(['a1']);
  });
});
