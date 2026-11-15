import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { OperationalDatabaseModulePort } from '../database/owner.js';
import { memoryOwnership } from '../bots/deletion.js';
import { canonicalPath, within } from './space-paths.js';

export const memoryProofSchema = z.object({
  path: z.string(),
  device: z.number(),
  inode: z.number(),
});
const copyBase = z.object({ stage: z.string(), identity: memoryProofSchema });
const copySchema = z.union([
  copyBase.extend({ phase: z.literal('copying') }),
  copyBase.extend({ phase: z.enum(['ready', 'retiring']), digest: z.string() }),
]);
export const relocationProofSchema = memoryProofSchema.extend({ copy: copySchema.optional() });
type RelocationProof = z.infer<typeof relocationProofSchema>;

function sameIdentity(
  path: string,
  proof: z.infer<typeof memoryProofSchema>,
  partial = false,
): void {
  const current = memoryOwnership(path, partial);
  if (current.device !== proof.device || current.inode !== proof.inode)
    throw new Error('space-memory-ownership-invalid');
}
function digestTree(root: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    hash.update(JSON.stringify([relative, stat.mode]));
    if (stat.isSymbolicLink()) hash.update(JSON.stringify(readlinkSync(path)));
    else if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) visit(join(path, name), relative + '/' + name);
    else if (stat.isFile()) {
      const fd = openSync(path, 'r');
      try {
        for (;;) {
          const count = readSync(fd, buffer, 0, buffer.length, null);
          if (!count) break;
          hash.update(buffer.subarray(0, count));
        }
      } finally {
        closeSync(fd);
      }
    } else throw new Error('space-memory-copy-unsupported');
  };
  visit(root, '');
  return hash.digest('hex');
}
function save(db: OperationalDatabaseModulePort, slug: string, proof: RelocationProof): void {
  db.transaction(
    (connection) =>
      connection
        .prepare('UPDATE workspace_memory_moves SET proof_json = ? WHERE slug = ?')
        .run(JSON.stringify(proof), slug),
    ['workspace-spaces'],
  );
}
function validateStage(stage: string, source: string, target: string): void {
  if (
    dirname(stage) !== dirname(target) ||
    !basename(stage).startsWith('.memory-copy-') ||
    canonicalPath(stage) !== stage ||
    within(stage, source) ||
    within(source, stage)
  )
    throw new Error('space-memory-target-unsafe');
}

export function prepareMemoryCopy(
  db: OperationalDatabaseModulePort,
  slug: string,
  source: string,
  target: string,
  proof: RelocationProof,
): RelocationProof {
  let copy = proof.copy;
  if (copy) validateStage(copy.stage, source, target);
  if (!copy || copy.phase === 'copying') {
    sameIdentity(source, proof);
    if (existsSync(target)) throw new Error('space-memory-target-exists');
    if (copy && existsSync(copy.stage)) {
      sameIdentity(copy.stage, copy.identity, true);
      rmSync(copy.stage, { recursive: true });
    }
    mkdirSync(dirname(target), { recursive: true });
    if (realpathSync(dirname(target)) !== dirname(target))
      throw new Error('space-memory-target-unsafe');
    const stage = mkdtempSync(join(dirname(target), '.memory-copy-'));
    copy = { phase: 'copying', stage, identity: memoryOwnership(stage, true) };
    proof = { ...proof, copy };
    save(db, slug, proof);
    const digest = digestTree(source);
    cpSync(source, stage, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    chmodSync(stage, lstatSync(source).mode);
    sameIdentity(source, proof);
    if (digestTree(stage) !== digest || digestTree(source) !== digest)
      throw new Error('space-memory-copy-changed');
    copy = { phase: 'ready', stage, identity: memoryOwnership(stage), digest };
    proof = { ...proof, copy };
    save(db, slug, proof);
  }
  if (existsSync(target)) sameIdentity(target, copy.identity);
  else {
    sameIdentity(copy.stage, copy.identity);
    renameSync(copy.stage, target);
  }
  if (digestTree(target) !== copy.digest) throw new Error('space-memory-copy-changed');
  if (existsSync(source)) {
    sameIdentity(source, proof, copy.phase === 'retiring');
    if (copy.phase === 'ready' && digestTree(source) !== copy.digest)
      throw new Error('space-memory-copy-changed');
  }
  return proof;
}
export function retireMemoryCopy(
  db: OperationalDatabaseModulePort,
  slug: string,
  source: string,
  proof: RelocationProof,
): void {
  if (!proof.copy || proof.copy.phase === 'copying')
    throw new Error('space-memory-copy-incomplete');
  if (proof.copy.phase === 'ready') {
    proof = { ...proof, copy: { ...proof.copy, phase: 'retiring' } };
    save(db, slug, proof);
  }
  if (existsSync(source)) {
    sameIdentity(source, proof, true);
    rmSync(source, { recursive: true });
  }
  db.transaction(
    (connection) =>
      connection.prepare('DELETE FROM workspace_memory_moves WHERE slug = ?').run(slug),
    ['workspace-spaces'],
  );
}
