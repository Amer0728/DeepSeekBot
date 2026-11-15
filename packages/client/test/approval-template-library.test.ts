// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApprovalTemplateLibrarySettings } from '../src/client/approval-template-library.js';
import type { BridgeCall } from '../src/client/bridge.js';
import { zhTranslate as t } from '../src/client/locale.js';
import { createStore } from '../src/client/store.js';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => ({
  ...(await import('./primitive-mocks.js')).dialogPrimitives(),
  ...(await import('./primitive-mocks.js')).comboboxPrimitives(),
  Tag: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  Menu: ({
    items,
    onSelect,
  }: {
    items: { id: string; label: ReactNode }[];
    onSelect(id: string): void;
  }) =>
    createElement(
      'div',
      { role: 'menu' },
      items.map((item) =>
        createElement(
          'button',
          {
            key: item.id,
            role: 'menuitem',
            onClick: () => onSelect(item.id),
          },
          item.label,
        ),
      ),
    ),
}));
vi.mock('../src/client/avatar.js', () => ({ PersonaBotAvatar: () => null }));
vi.mock('../src/client/channel-sidebar-icon.js', () => ({ ChannelSidebarIcon: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const templates = ['cautious', 'get-work-done'].map((name) => ({
  name,
  title: name,
  description: '',
  builtIn: true,
  usedBy: [],
}));
function trigger(): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(
    'button[aria-label="' + t('autoApproval.globalDefault') + '"]',
  );
  if (!found) throw new Error('Missing global selection');
  return found;
}
async function render(call: BridgeCall, store = createStore()): Promise<void> {
  await act(async () =>
    root.render(createElement(ApprovalTemplateLibrarySettings, { call, store, t })),
  );
}

it.each(['write', 'readback'])(
  'shows an unknown global selection after %s failure and retries reads without replaying the write',
  async (failure) => {
    let current = 'cautious';
    let reads = 0;
    let writes = 0;
    const call: BridgeCall = async (endpoint) => {
      if (endpoint === 'approvalTemplates') {
        reads++;
        if (failure === 'readback' && reads === 2) throw new Error('read failed');
        return { ok: true, value: { templates, globalDefault: current } };
      }
      if (endpoint === 'approvalTemplateGlobalSet') {
        writes++;
        if (failure === 'write') throw new Error('write response unavailable');
        current = 'get-work-done';
        return { ok: true, value: {} };
      }
      throw new Error('Unexpected endpoint ' + endpoint);
    };
    await render(call);
    await act(async () => trigger().click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent === t('autoApproval.template.getWorkDone'),
    );
    if (!option) throw new Error('Missing template option');
    await act(async () => option.click());
    expect(writes).toBe(1);
    expect(trigger().textContent).toContain('读取失败');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === t('autoApproval.reload'),
    );
    if (!retry) throw new Error('Missing read-only retry');
    await act(async () => retry.click());
    expect(writes).toBe(1);
    expect(trigger().textContent).toContain(
      t(
        failure === 'write'
          ? 'autoApproval.template.cautious'
          : 'autoApproval.template.getWorkDone',
      ),
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
  },
);

it('keeps a missing global template recognizable without silently clearing its name', async () => {
  const call: BridgeCall = async () => ({
    ok: true,
    value: { templates, globalDefault: 'night-shift' },
  });
  await render(call);
  expect(trigger().textContent).toContain('night-shift');
  expect(trigger().textContent).toContain('不可用');
});

async function clickText(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === label,
  );
  if (!button) throw new Error('Missing button: ' + label);
  await act(async () => button.click());
}

it('requires an explicit source before showing the blank three-part editor and does not apply on opening', async () => {
  const calls: string[] = [];
  const call: BridgeCall = async (endpoint) => {
    calls.push(endpoint);
    return { ok: true, value: { templates, globalDefault: null } };
  };
  await render(call);
  await clickText(t('autoApproval.library.create'));
  expect(document.querySelector('textarea')).toBeNull();
  await clickText(t('autoApproval.library.chooseSource'));
  await clickText(t('autoApproval.library.blank'));
  expect(document.body.textContent).toContain(t('autoApproval.library.freeText'));
  expect(document.body.textContent).toContain(t('autoApproval.library.saveOnly'));
  expect(document.querySelector('textarea')?.value).toBe('');
  await clickText(
    t('autoApproval.library.addRow', { section: t('autoApproval.library.alwaysAsk') }),
  );
  expect(document.body.textContent).toContain(t('autoApproval.library.alwaysAsk') + ' 1');
  expect(calls).toEqual(['approvalTemplates']);
});

it('starts an independent copy with save-only even after choosing apply for the shared original', async () => {
  const store = createStore();
  store.setRoster(
    [
      {
        slug: 'qa',
        displayName: 'QA',
        roles: [],
        aggregateState: 'idle',
        workspaces: [],
        createdAt: '2026-11-16',
      },
    ],
    [],
  );
  store.select({ kind: 'bot', slug: 'qa' });
  const calls: string[] = [];
  const call: BridgeCall = async (endpoint) => {
    calls.push(endpoint);
    return {
      ok: true,
      value: {
        templates: [
          {
            name: 'legacy',
            title: 'Legacy',
            description: '',
            builtIn: false,
            usedBy: ['qa'],
            text: '# Legacy\r\nKeep this.',
          },
        ],
        globalDefault: null,
      },
    };
  };
  await render(call, store);
  const button = host.querySelector<HTMLButtonElement>('[data-approval-template="legacy"] button');
  if (!button) throw new Error('Missing shared original');
  await act(async () => button.click());
  const choice = () =>
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="' + t('autoApproval.library.saveChoice') + '"]',
    );
  await act(async () => choice()?.click());
  await clickText(t('autoApproval.library.saveApply', { name: 'QA' }));
  expect(choice()?.textContent).toContain('QA');
  await clickText(t('autoApproval.library.copy'));
  expect(choice()?.textContent).toContain(t('autoApproval.library.saveOnly'));
  expect(document.querySelector('textarea')?.value).toBe(
    '# Legacy\r\nKeep this.'.replaceAll('\r\n', '\n'),
  );
  expect(calls).toEqual(['approvalTemplates']);
});

it('identifies the selected source when independent templates have the same heading', async () => {
  const call: BridgeCall = async () => ({
    ok: true,
    value: {
      globalDefault: null,
      templates: ['alpha', 'beta'].map((name) => ({
        name,
        title: 'Shared heading',
        description: '',
        builtIn: false,
        usedBy: [],
        text: '# ' + name,
      })),
    },
  });
  await render(call);
  await clickText(t('autoApproval.library.create'));
  await clickText(t('autoApproval.library.chooseSource'));
  await clickText('Shared heading · beta');
  expect(document.querySelector('textarea')?.value).toBe('# beta');
});

it('keeps the visible View action in accessible template names', async () => {
  await render(async () => ({ ok: true, value: { templates, globalDefault: null } }));
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-approval-template] button')];
  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    expect(button.textContent).toBe(t('autoApproval.library.view'));
    expect(button.getAttribute('aria-label')).toContain(button.textContent);
  }
});
