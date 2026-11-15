import { describe, expect, it } from 'vitest';
import {
  decideToolApproval,
  toolEffects,
  type ToolApprovalContext,
  type ToolEffects,
} from '../src/workspaces/tool-effects.js';

describe('public tool effects', () => {
  it.each(['GET', 'get', 'GeT'])('uses HTTP execution normalization for %s', (method) => {
    expect(toolEffects('secret_http', { method })).toEqual({
      changes: 'none',
      reach: 'external',
      personalData: true,
      secrets: true,
    });
  });
  it('includes request delivery when restoring an Assignment with a message', () => {
    expect(toolEffects('unarchive_assignment', { session_id: 'assignment-1' })).toEqual({
      changes: 'reversible',
      reach: 'local',
      personalData: true,
    });
    expect(
      toolEffects('unarchive_assignment', {
        session_id: 'assignment-1',
        message: 'Continue the approved task.',
      }),
    ).toEqual({ changes: 'irreversible', reach: 'external', personalData: true });
  });
  it.each([
    ['group', 'external'],
    ['nearby', 'external'],
    ['thread', 'external'],
    ['retained', 'local'],
    ['retained-nearby', 'local'],
  ] as const)('declares %s context with %s reach', (scope, reach) => {
    expect(toolEffects('bridge_context', { scope })).toEqual({
      changes: 'none',
      reach,
      personalData: true,
    });
  });
  it.each([
    [
      'secret_http',
      { method: 'GET' },
      { changes: 'none', reach: 'external', personalData: true, secrets: true },
    ],
    [
      'secret_http',
      { method: 'POST' },
      { changes: 'irreversible', reach: 'external', personalData: true, secrets: true },
    ],
    [
      'browser_tabs',
      { action: 'close' },
      { changes: 'irreversible', reach: 'local', personalData: true },
    ],
  ] as const)('resolves mixed-purpose effects for %s %j', (name, input, expected) => {
    expect(toolEffects(name, input)).toEqual(expected);
  });
  it.each([
    ['channel_read', {}, { changes: 'none', reach: 'local', personalData: true }],
    [
      'channel_attachment_open',
      { access: 'read' },
      { changes: 'none', reach: 'local', personalData: true },
    ],
    [
      'channel_attachment_open',
      { access: 'write' },
      { changes: 'reversible', reach: 'local', personalData: true },
    ],
    ['memory_switch_branch', {}, { changes: 'reversible', reach: 'memory', personalData: true }],
    [
      'channel_attachment_save',
      {},
      { changes: 'reversible', reach: 'workspace', personalData: true },
    ],
    ['bot_send_message', {}, { changes: 'irreversible', reach: 'external', personalData: true }],
    [
      'secret_cli',
      {},
      { changes: 'irreversible', reach: 'external', personalData: true, secrets: true },
    ],
    [
      'cloud_work',
      { operation: 'inspect' },
      { changes: 'none', reach: 'local', personalData: true },
    ],
    [
      'channel_action',
      { action: 'inspect' },
      { changes: 'none', reach: 'local', personalData: true },
    ],
    [
      'channel_action',
      { action: 'drop' },
      { changes: 'reversible', reach: 'local', personalData: true },
    ],
    [
      'browser_tabs',
      { action: 'select' },
      { changes: 'reversible', reach: 'local', personalData: true },
    ],
    ['browser_tabs', { action: 'list' }, { changes: 'none', reach: 'local', personalData: true }],
  ] as const)('resolves author effects for %s with %j', (name, args, expected) => {
    expect(toolEffects(name, args)).toEqual(expected);
  });
  it.each(['bash', 'pwsh', 'third_party_tool', 'toString'])(
    'retains undeclared provenance for %s',
    (name) => {
      expect(toolEffects(name, { command: 'send everything' })).toBeUndefined();
      expect(
        decideToolApproval(undefined, {
          stage: 'admission',
          admission: 'native',
          legacyProtected: false,
        }),
      ).toMatchObject({ path: 'native', reason: 'undeclared-native' });
    },
  );
});

const request = {
  stage: 'request',
  fullAccess: false,
  eachUse: false,
  explicitApproval: false,
  legacyProtected: false,
  device: false,
  standingRule: 'none',
  reviewer: false,
  rememberable: false,
} satisfies ToolApprovalContext;
const local: ToolEffects = { changes: 'none', reach: 'local', personalData: false };
const external: ToolEffects = { changes: 'irreversible', reach: 'external', personalData: true };

describe('E1 pure approval decision', () => {
  it.each([
    [local, { fullAccess: true }, 'full-access', true, false, 'full-access-existing'],
    [external, { fullAccess: true }, 'full-access', true, false, 'full-access-existing'],
    [
      { ...external, secrets: true },
      { fullAccess: true },
      'full-access',
      true,
      false,
      'full-access-existing',
    ],
    [
      { ...local, authority: 'management' },
      { fullAccess: true, reviewer: true },
      'human',
      true,
      true,
      'protected-operation',
    ],
    [
      { ...local, authority: 'management' },
      { standingRule: 'explicit', reviewer: true },
      'standing-rule',
      true,
      true,
      'saved-authorization',
    ],
    [
      { ...local, authority: 'management' },
      { standingRule: 'ordinary', fullAccess: true, reviewer: true },
      'human',
      true,
      true,
      'protected-operation',
    ],
    [
      undefined,
      { legacyProtected: true, fullAccess: true, reviewer: true },
      'human',
      true,
      true,
      'protected-operation',
    ],
    [
      external,
      { standingRule: 'ordinary', reviewer: true },
      'standing-rule',
      true,
      false,
      'saved-authorization',
    ],
    [external, { reviewer: true }, 'reviewer', true, false, 'template-review'],
    [external, {}, 'human', true, false, 'human-required'],
    [
      external,
      { eachUse: true, fullAccess: true, standingRule: 'ordinary' },
      'human',
      false,
      false,
      'human-required',
    ],
    [external, { eachUse: true, rememberable: true }, 'human', true, false, 'human-required'],
    [
      local,
      { device: true, standingRule: 'explicit' },
      'standing-rule',
      true,
      true,
      'saved-authorization',
    ],
    [
      local,
      { explicitApproval: true, fullAccess: true, reviewer: true },
      'human',
      true,
      true,
      'protected-operation',
    ],
  ] as const)(
    'routes effects %j and context %j',
    (effects, context, path, rememberable, explicitRule, reason) => {
      expect(decideToolApproval(effects, { ...request, ...context })).toEqual({
        path,
        rememberable,
        explicitRule,
        reason,
      });
    },
  );
});

describe('CLI effect declarations at the public approval seam', () => {
  it('declares exact brokered management argv without trusting prose', () => {
    expect(
      toolEffects('deepseekbot grant-write-set', {
        patch: { argv: ['grant-write-set', 'bot', '--grant', 'grant', '--enabled', '--confirm'] },
      }),
    ).toEqual({
      changes: 'reversible',
      reach: 'local',
      personalData: true,
      authority: 'management',
    });
    expect(
      toolEffects('deepseekbot unknown', { patch: { argv: ['future-command'] } }),
    ).toBeUndefined();
    expect(
      toolEffects('bash', { command: 'deepseekbot grant-write-set bot --enabled' }),
    ).toBeUndefined();
  });
});

it('keeps irreversible reach when a CLI operation also writes output', () => {
  expect(
    toolEffects('deepseekbot marketplace-upload', {
      patch: { argv: ['marketplace-upload', 'bot', '--out=result.json'] },
    }),
  ).toMatchObject({ changes: 'irreversible', reach: 'external' });
  expect(
    toolEffects('deepseekbot grant-write-set', {
      command: 'grant-write-set',
      target: 'bot',
      patch: { enabled: true },
      expectedRevision: 2,
    }),
  ).toMatchObject({ authority: 'management' });
  expect(
    toolEffects('deepseekbot channels', { patch: { argv: ['grant-write-set', 'bot'] } }),
  ).toBeUndefined();
});

describe('CLI family semantic effects', () => {
  it('declares a channels send after strict option parsing as external delivery', () => {
    expect(
      toolEffects('deepseekbot channels', {
        patch: { argv: ['channels', '--compact', 'send', 'channel-1', '--body-stdin'] },
      }),
    ).toEqual({ changes: 'irreversible', reach: 'external', personalData: true });
  });
});

it.each([
  [
    'devices',
    ['--member', 'alex', '--revoke', 'grant'],
    { changes: 'irreversible', authority: 'management' },
  ],
  ['bots', ['delete', 'bot'], { changes: 'irreversible', reach: 'local' }],
  ['members', ['password', '--password-stdin'], { authority: 'management', secrets: true }],
  ['cloud', ['import', '--input-stdin'], { authority: 'management', secrets: true }],
  ['voice-provider-add', ['voice', '--key-stdin'], { secrets: true }],
  [
    'spaces',
    ['delete', 'space', '--confirm'],
    { changes: 'irreversible', authority: 'management' },
  ],
  ['roles', ['list'], { changes: 'none' }],
] as const)('keeps actual family semantics for %s %j', (command, rest, expected) => {
  expect(
    toolEffects('deepseekbot ' + command, { patch: { argv: [command, ...rest] } }),
  ).toMatchObject(expected);
});

it.each(['bot-tool', 'browser-tool', 'computer-tool', 'todo-tool', 'settings-set'])(
  'keeps %s opaque when only stdin identity is available',
  (command) => {
    expect(
      toolEffects('deepseekbot ' + command, {
        patch: {
          argv: [command, 'bot', 'arbitrary-tool', '--args-stdin'],
          stdinSha256: 'not-authority',
        },
      }),
    ).toBeUndefined();
  },
);
it('keeps remote output, secrets and management together', () => {
  expect(
    toolEffects('deepseekbot relationships', {
      patch: { argv: ['relationships', 'approve', 'id', 'key', '--out=a.json'] },
    }),
  ).toMatchObject({
    authority: 'management',
    secrets: true,
    reach: 'external',
    changes: 'reversible',
  });
});

it.each(['delete', 'edit'])(
  'does not turn the %s family action into a declared root command',
  (command) => {
    expect(toolEffects('deepseekbot ' + command, { patch: { argv: [command] } })).toBeUndefined();
  },
);

it('resolves private-route reads and secret-bearing remote route changes', () => {
  expect(
    toolEffects('deepseekbot private-route', { patch: { argv: ['private-route', 'list'] } }),
  ).toMatchObject({ changes: 'none', reach: 'local' });
  expect(
    toolEffects('deepseekbot private-route', {
      patch: {
        argv: [
          'private-route',
          'add',
          'route',
          '--hostname',
          'example.test',
          '--token-stdin',
          '--confirm',
        ],
      },
    }),
  ).toMatchObject({ reach: 'external', authority: 'management', secrets: true });
});

it.each(['tool-approval-decide', 'tool-approval-rule-revoke', 'user-question-answer'])(
  'includes external card settlement for %s',
  (command) => {
    expect(toolEffects('deepseekbot ' + command, { patch: { argv: [command] } })).toMatchObject({
      changes: 'irreversible',
      reach: 'external',
    });
  },
);
it.each([
  'approval-test',
  'approval-retry',
  'question-retry',
  'failure-alerts-test',
  'failure-alerts-retry',
])('includes actual provider card/notification delivery for %s', (command) => {
  expect(
    toolEffects('deepseekbot ' + command, { patch: { argv: [command, 'bot'] } }),
  ).toMatchObject({ changes: 'irreversible', reach: 'external' });
});
it('includes irreversible member purge without weakening broker refusal', () => {
  expect(
    toolEffects('deepseekbot members', {
      patch: { argv: ['members', 'purge', 'member', '--confirm', '--token-stdin'] },
    }),
  ).toMatchObject({ changes: 'irreversible', authority: 'management', secrets: true });
});
