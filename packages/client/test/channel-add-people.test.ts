// @vitest-environment jsdom
import {
  act,
  createElement,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => ({
  ...(await import('./primitive-mocks.js')).comboboxPrimitives(),
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => createElement('input', props),
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) =>
    createElement('button', props),
  Tag: ({ children }: PropsWithChildren) => createElement('span', null, children),
  Modal: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) =>
    createElement('div', { role: 'dialog' }, children, footer),
}));

import { BridgeCallError, type BridgeCall } from '../src/client/bridge.js';
import {
  AddPeopleDialog,
  addPeopleErrorText,
  canAddPeople,
} from '../src/client/channel-add-people.js';
import { en, zhTranslate } from '../src/client/locale.js';
import type { TeamViewer } from '../src/client/team-bridge.js';
import {
  addChannelHuman,
  DEFAULT_POLICY,
  loadMemberCandidates,
  parseChannelAccess,
} from '../src/client/team-channels-bridge.js';

const viewer = (patch: Partial<TeamViewer> = {}): TeamViewer => ({
  humanId: 'h-alice',
  kind: 'member',
  displayName: 'Alice',
  mustChangePassword: false,
  owner: false,
  permissions: [],
  roleIds: [],
  ...patch,
});

const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

describe('Channel invitations client', () => {
  it('lists well-formed candidates and sends the trimmed query', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      value: [
        { humanId: 'h-bob', displayName: 'Bob', username: 'bob' },
        { humanId: 'h-ext', displayName: '', username: null },
        { displayName: 'no id' },
      ],
    }));
    expect(await loadMemberCandidates(call, 'c1', '  bo ')).toEqual([
      { humanId: 'h-bob', displayName: 'Bob', username: 'bob' },
      { humanId: 'h-ext', displayName: 'h-ext' },
    ]);
    expect(call).toHaveBeenCalledWith(
      'channelMemberCandidates',
      { channelId: 'c1', query: 'bo' },
      undefined,
    );
    await loadMemberCandidates(call, 'c1', '   ');
    expect(call).toHaveBeenLastCalledWith(
      'channelMemberCandidates',
      { channelId: 'c1' },
      undefined,
    );
  });

  it('adds a person through channelHumanAdd', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: null }));
    await addChannelHuman(call, 'c1', 'h-bob');
    expect(call).toHaveBeenCalledWith(
      'channelHumanAdd',
      { channelId: 'c1', humanId: 'h-bob' },
      undefined,
    );
  });

  it('offers Add people only to those who may add members to the Channel', () => {
    const member = parseChannelAccess({ role: 'member', policy: { addMembers: 'admins' } });
    const open = parseChannelAccess({ role: 'member', policy: { addMembers: 'everyone' } });
    const admin = parseChannelAccess({ role: 'admin', policy: { addMembers: 'admins' } });
    expect(canAddPeople(undefined, viewer({ owner: true }))).toBe(false);
    expect(canAddPeople(member, viewer())).toBe(false);
    expect(canAddPeople(open, viewer())).toBe(true);
    expect(canAddPeople(admin, viewer())).toBe(true);
    expect(canAddPeople(member, viewer({ owner: true }))).toBe(true);
    expect(canAddPeople(member, viewer({ permissions: ['channels.manageAll'] }))).toBe(true);
    expect(DEFAULT_POLICY.addMembers).toBe('everyone');
  });

  it('explains an addMembers refusal in plain words', () => {
    const refusal = new BridgeCallError('permission-required', 'permission-required', {
      permission: 'addMembers',
    });
    expect(addPeopleErrorText(zhTranslate, refusal)).toBe(zhTranslate('channelPeople.denied'));
    expect(addPeopleErrorText(zhTranslate, new Error('boom'))).toBe(
      zhTranslate('team.error.generic'),
    );
  });

  it('searches, adds the chosen person and shows a refusal without closing', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let refuse = true;
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'channelMemberCandidates')
        return {
          ok: true as const,
          value: [{ humanId: 'h-carol', displayName: 'Carol', username: 'carol' }],
        };
      if (refuse)
        return {
          ok: false as const,
          error: {
            code: 'permission-required',
            message: 'permission-required',
            details: { permission: 'addMembers' },
          },
        };
      return { ok: true as const, value: null };
    }) as unknown as BridgeCall;
    const onAdded = vi.fn();
    try {
      await act(async () =>
        root.render(
          createElement(AddPeopleDialog, {
            call,
            channelId: 'c-private',
            t: zhTranslate,
            onClose: vi.fn(),
            onAdded,
          }),
        ),
      );
      await flush();
      const option = document.querySelector<HTMLButtonElement>(
        '[data-channel-add-option="h-carol"]',
      );
      expect(option?.textContent).toContain('@carol');
      await act(async () => option?.click());
      const submit = document.querySelector<HTMLButtonElement>('[data-channel-add-people-submit]');
      expect(submit?.disabled).toBe(false);
      await act(async () => submit?.click());
      await flush();
      expect(document.body.textContent).toContain(zhTranslate('channelPeople.denied'));
      expect(onAdded).not.toHaveBeenCalled();
      refuse = false;
      await act(async () => submit?.click());
      await flush();
      expect(onAdded).toHaveBeenCalledWith('h-carol');
      expect(call).toHaveBeenCalledWith(
        'channelHumanAdd',
        { channelId: 'c-private', humanId: 'h-carol' },
        undefined,
      );
      expect(en['channelPeople.add']).toBe('Add people');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
