import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTempRoot } from './helpers.js';
import { createTestRegistry } from './registry-fixture.js';
import {
  attachOperationalModule,
  mountOperationalDatabase,
  type OperationalDatabaseOwner,
} from '../src/database/owner.js';
import { BOT_HARNESS_SCHEMA_PLAN } from '../src/database/schema-plan.js';
import { ensureMemoryRepository } from '../src/memory/repository.js';
import { memoryOwnership } from '../src/bots/deletion.js';
import { accountMemoryPath, relocateSpaceMemories } from '../src/workspaces/space-memory.js';
import { createSqliteChannelStore } from '../src/channels/sqlite-store.js';
import { TeamService } from '../src/team/service.js';
import { relocateTobWorkspaces } from '../src/workspaces/space-lifecycle.js';
import { WorkspaceSpaces } from '../src/workspaces/spaces.js';
import { defaultSpaceMemoryPath } from '../src/workspaces/space-memory.js';
import { OWNER_HUMAN_CONTEXT as owner } from '../src/humans/context.js';

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, renameSync: vi.fn(real.renameSync), rmSync: vi.fn(real.rmSync) };
});
const real = await vi.importActual<typeof import('node:fs')>('node:fs');
const owners: OperationalDatabaseOwner[] = [];
afterEach(() => {
  vi.mocked(fs.renameSync).mockImplementation(real.renameSync);
  vi.mocked(fs.rmSync).mockImplementation(real.rmSync);
  for (const db of owners.splice(0)) db.close();
});
function mount(
  home: string,
  faultInjector?: Parameters<typeof mountOperationalDatabase>[0]['faultInjector'],
) {
  const db = mountOperationalDatabase({
    dshHome: home,
    schemaPlan: BOT_HARNESS_SCHEMA_PLAN,
    ...(faultInjector ? { faultInjector } : {}),
  });
  owners.push(db);
  return db;
}
function fixture(
  faultInjector?: Parameters<typeof mountOperationalDatabase>[0]['faultInjector'],
  stopBots?: (slugs: readonly string[]) => Promise<void>,
) {
  vi.mocked(fs.renameSync).mockImplementation(real.renameSync);
  vi.mocked(fs.rmSync).mockImplementation(real.rmSync);
  const home = createTempRoot('m6-space-transaction-');
  const database = mount(home, faultInjector);
  const db = attachOperationalModule(database, 'review');
  db.transaction((connection) => {
    for (const id of ['alice', 'bob'])
      connection.prepare("INSERT INTO humans VALUES (?,?,'active','2026-11-15')").run(id, id);
    connection.prepare('UPDATE team_settings SET enabled=1').run();
  });
  const registry = createTestRegistry({
    database,
    rootDir: join(home, 'botharness/bots'),
    defaultMemoryPath: (slug, human) => defaultSpaceMemoryPath(db, home, human, slug),
    initializeMemory: (memoryDir) => {
      const result = ensureMemoryRepository({ memoryDir });
      if (!result.ok) throw new Error(result.code);
      return { ok: true };
    },
  });
  const channels = createSqliteChannelStore({ database: db, rootDir: join(home, 'channels') });
  let spaces: WorkspaceSpaces;
  const team = new TeamService(db, channels, {
    spaces: () => spaces,
    ...(stopBots ? { stopBots } : {}),
  });
  spaces = new WorkspaceSpaces(db, home, team.roles);
  return { home, database, db, registry, team, spaces };
}
function legacyMemory(f: ReturnType<typeof fixture>) {
  const parent = createTempRoot('external-m6-memory-');
  const result = f.registry.create({
    slug: 'legacy',
    displayName: 'Legacy',
    ownerHumanId: 'alice',
    memoryLocation: parent,
    persona: 'preserve persona',
  });
  expect(result.ok).toBe(true);
  const source = f.registry.memoryDirFor('legacy')!;
  fs.writeFileSync(join(source, 'uncommitted.txt'), 'unsaved content');
  const history = execFileSync('git', ['-C', source, 'rev-list', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  f.db.transaction((connection) =>
    connection
      .prepare('INSERT INTO workspace_memory_moves VALUES (?,NULL,NULL,NULL)')
      .run('legacy'),
  );
  const target = accountMemoryPath(f.home, 'alice', 'legacy');
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (String(from) === source && String(to) === target)
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    real.renameSync(from, to);
  });
  return { source, target, history };
}

describe('M6 durable filesystem transactions', () => {
  it('restores an interrupted Owner rename before excluding accepted erase cleanup', () => {
    const f = fixture();
    const slug = 'owner-pending';
    expect(f.registry.create({ slug, displayName: slug }).ok).toBe(true);
    const source = f.registry.memoryDirFor(slug)!;
    const proof = memoryOwnership(source);
    const target = accountMemoryPath(f.home, owner.humanId, slug);
    f.db.transaction((connection) => {
      connection
        .prepare('INSERT INTO workspace_memory_moves VALUES (?,?,?,?)')
        .run(slug, source, target, JSON.stringify(proof));
      connection.prepare('INSERT INTO persona_bot_deletions VALUES (?,?)').run(
        slug,
        JSON.stringify({
          slug,
          displayName: slug,
          acceptedAt: '2026-11-15',
          memoryDir: source,
          eraseMemory: true,
          phase: 'cleanup',
          memory: 'pending',
          cleanupAccepted: true,
          ownership: proof,
        }),
      );
    });
    fs.mkdirSync(join(target, '..'), { recursive: true });
    fs.renameSync(source, target);
    relocateSpaceMemories(f.db, f.home);
    expect(memoryOwnership(source)).toEqual(proof);
    expect(fs.existsSync(target)).toBe(false);
    expect(
      f.db.read((connection) => connection.prepare('SELECT * FROM workspace_memory_moves').all()),
    ).toEqual([]);
    expect(
      f.db.read(
        (connection) =>
          connection
            .prepare(
              "SELECT json_extract(body,'$.memoryDir') AS path FROM persona_bot_deletions WHERE slug=?",
            )
            .get(slug)?.path,
      ),
    ).toBe(source);
  });

  it('moves legacy Tob workspace files and grants once while preserving nested Owner Memory', () => {
    const f = fixture();
    const slug = 'owner-tob';
    const legacy = join(f.home, 'botharness/tob-workspaces', slug);
    fs.mkdirSync(legacy, { recursive: true });
    expect(
      f.registry.create({
        slug,
        displayName: 'Tob',
        ownerHumanId: owner.humanId,
        memoryLocation: legacy,
        workspaces: [legacy],
        persona: 'Owner persona',
      }).ok,
    ).toBe(true);
    const memory = f.registry.memoryDirFor(slug)!;
    const proof = memoryOwnership(memory);
    fs.writeFileSync(join(legacy, 'report'), 'workspace file');
    f.db.transaction((connection) => {
      connection.prepare('INSERT INTO tob_identity VALUES (?,?)').run(owner.humanId, slug);
      connection
        .prepare(
          `INSERT INTO workspace_grants (id,bot_slug,workspace_id,workspace_path,workspace_title,created_at,orchestrator_write,write_revision) VALUES ('old-owner-grant',?,'old-native-workspace',?,'Tob','2026-11-15',1,1)`,
        )
        .run(slug, legacy);
    });
    relocateTobWorkspaces(f.db, f.home);
    relocateTobWorkspaces(f.db, f.home);
    const target = join(f.home, 'spaces', owner.humanId, 'files');
    expect(fs.readFileSync(join(target, 'report'), 'utf8')).toBe('workspace file');
    expect(f.registry.get(slug)?.workspaces).toEqual([target]);
    expect(f.registry.memoryDirFor(slug)).toBe(memory);
    expect(memoryOwnership(memory)).toEqual(proof);
    expect(
      f.db.read(
        (connection) =>
          connection
            .prepare("SELECT revoked_at FROM workspace_grants WHERE id='old-owner-grant'")
            .get()?.revoked_at,
      ),
    ).toEqual(expect.any(String));
    expect(
      f.db.read(
        (connection) =>
          connection
            .prepare(
              'SELECT COUNT(*) AS count FROM workspace_grants WHERE bot_slug=? AND revoked_at IS NULL',
            )
            .get(slug)?.count,
      ),
    ).toBe(1);
  });

  it('keeps transferred files at the committed destination after a post-commit interruption', async () => {
    let armed = false;
    let commits = 0;
    const stopped = vi.fn(async (_slugs: readonly string[]) => {});
    const f = fixture(({ stage }) => {
      if (armed && stage === 'after-commit-before-notify' && ++commits === 2)
        throw new Error('post-commit');
    }, stopped);
    const disposed = vi.spyOn(f.team, 'disposePeers');
    const closeStreams = vi.fn(() => 0);
    f.team.bindPairing({
      revoke: () => ({ revoked: false, closedStreams: 0 }),
      clearOffers: () => 0,
      closeStreams,
    });
    expect(
      f.registry.create({ slug: 'alice-private', displayName: 'Alice', ownerHumanId: 'alice' }).ok,
    ).toBe(true);
    const source = f.registry.memoryDirFor('alice-private')!;
    fs.writeFileSync(join(source, 'kept'), 'kept');
    fs.writeFileSync(join(f.home, 'spaces/alice/files/report'), 'report');
    armed = true;
    await expect(f.team.transfer(owner, 'alice', 'bob')).rejects.toMatchObject({
      code: 'post-commit-interrupted',
    });
    expect(disposed).toHaveBeenCalled();
    expect(closeStreams).toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledWith(['alice-private']);
    f.database.close();
    const next = mount(f.home);
    const db = attachOperationalModule(next, 'verify');
    const target = accountMemoryPath(f.home, 'bob', 'alice-private');
    expect(fs.readFileSync(join(target, 'kept'), 'utf8')).toBe('kept');
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(join(f.home, 'spaces/bob/files/report'), 'utf8')).toBe('report');
    expect(
      db.read(
        (connection) =>
          connection
            .prepare("SELECT owner_human_id FROM persona_bots WHERE slug='alice-private'")
            .get()?.owner_human_id,
      ),
    ).toBe('bob');
    expect(
      db.read((connection) => connection.prepare('SELECT * FROM workspace_file_transfers').all()),
    ).toEqual([]);
  });

  it.each([0, 3, 4, 5, 6, 7])(
    'recovers a cross-filesystem Memory copy with an interruption after commit %s',
    (stop) => {
      let armed = false;
      let commits = 0;
      const f = fixture(({ stage }) => {
        if (armed && stop && stage === 'after-commit-before-notify' && ++commits === stop)
          throw new Error('copy interrupted');
      });
      const memory = legacyMemory(f);
      armed = true;
      if (stop) expect(() => relocateSpaceMemories(f.db, f.home)).toThrow();
      else relocateSpaceMemories(f.db, f.home);
      f.database.close();
      const next = mount(f.home);
      const db = attachOperationalModule(next, 'verify-copy');
      relocateSpaceMemories(db, f.home);
      expect(fs.existsSync(memory.source)).toBe(false);
      expect(fs.readFileSync(join(memory.target, 'uncommitted.txt'), 'utf8')).toBe(
        'unsaved content',
      );
      expect(
        execFileSync('git', ['-C', memory.target, 'rev-list', 'HEAD'], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
      ).toBe(memory.history);
      expect(
        db.read(
          (connection) =>
            connection
              .prepare("SELECT body FROM persona_bot_memory_ownership WHERE slug='legacy'")
              .get()?.body,
        ),
      ).toBe(JSON.stringify(memoryOwnership(memory.target)));
      expect(
        db.read((connection) => connection.prepare('SELECT * FROM workspace_memory_moves').all()),
      ).toEqual([]);
    },
  );

  it('resumes source retirement after .git was removed, with the destination already durably owned', () => {
    const f = fixture();
    const memory = legacyMemory(f);
    let failed = false;
    vi.mocked(fs.rmSync).mockImplementation((path, options) => {
      if (String(path) === memory.source && !failed) {
        failed = true;
        real.rmSync(join(memory.source, '.git'), { recursive: true });
        throw new Error('partial cleanup');
      }
      real.rmSync(path, options);
    });
    expect(() => relocateSpaceMemories(f.db, f.home)).toThrow('partial cleanup');
    expect(
      f.db.read(
        (connection) =>
          connection
            .prepare(
              "SELECT json_extract(body,'$.path') AS path FROM persona_bot_memory_ownership WHERE slug='legacy'",
            )
            .get()?.path,
      ),
    ).toBe(memory.target);
    relocateSpaceMemories(f.db, f.home);
    expect(fs.existsSync(memory.source)).toBe(false);
    expect(fs.readFileSync(join(memory.target, 'uncommitted.txt'), 'utf8')).toBe('unsaved content');
  });
});
