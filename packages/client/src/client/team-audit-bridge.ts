import type { BridgeCall } from './bridge.js';
import { list, record, unwrap } from './team-bridge.js';

export const PRIVATE_VIEW = 'privateContent.view';
export const AUDIT_VIEW = 'audit.view';

export type PrivateKind = 'bot' | 'channel' | 'dm' | 'bot-dm';
const KINDS: readonly PrivateKind[] = ['bot', 'channel', 'dm', 'bot-dm'];

export interface PrivateObject {
  readonly objectId: string;
  readonly kind: PrivateKind;
  readonly name: string;
}

export interface PrivateMessage {
  readonly id: string;
  readonly at: string;
  readonly author: string;
  readonly body: string;
}

export interface PrivateView {
  readonly viewId: string;
  readonly messages: readonly PrivateMessage[];
}

export interface AuditRecord {
  readonly auditId: string;
  readonly at: string;
  readonly viewerName: string;
  readonly kind: PrivateKind;
  readonly objectName: string;
  readonly reason?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export function parsePrivateObject(value: unknown): PrivateObject | undefined {
  const row = record(value);
  const objectId = text(row?.['objectId']);
  const kind = row?.['kind'];
  const name = text(row?.['name']);
  return objectId !== undefined && KINDS.includes(kind as PrivateKind)
    ? { objectId, kind: kind as PrivateKind, name: name ?? objectId }
    : undefined;
}

function authorName(value: unknown): string {
  const author = record(value);
  return (
    text(author?.['displayName']) ??
    text(author?.['name']) ??
    text(author?.['slug']) ??
    text(author?.['humanId']) ??
    ''
  );
}

export function parsePrivateMessage(value: unknown): PrivateMessage | undefined {
  const row = record(value);
  const id = text(row?.['id']);
  if (row === undefined || id === undefined) return undefined;
  return {
    id,
    at: text(row['at']) ?? '',
    author: authorName(row['author']),
    body: typeof row['body'] === 'string' ? row['body'] : '',
  };
}

export function parseAuditRecord(value: unknown): AuditRecord | undefined {
  const row = record(value);
  const auditId = text(row?.['auditId']);
  const kind = row?.['kind'];
  if (row === undefined || auditId === undefined || !KINDS.includes(kind as PrivateKind))
    return undefined;
  const reason = text(row['reason']);
  return {
    auditId,
    at: text(row['at']) ?? '',
    viewerName: text(row['viewerName']) ?? text(row['viewerHumanId']) ?? '',
    kind: kind as PrivateKind,
    objectName: text(row['objectName']) ?? text(row['objectId']) ?? '',
    ...(reason === undefined ? {} : { reason }),
  };
}

export async function loadPrivateObjects(
  call: BridgeCall,
  humanId: string,
  signal?: AbortSignal,
): Promise<PrivateObject[]> {
  return list(await unwrap(call, 'privateObjects', { humanId }, signal), parsePrivateObject);
}

export async function openPrivateContent(
  call: BridgeCall,
  object: PrivateObject,
  reason: string,
): Promise<PrivateView> {
  const value = record(
    await unwrap(call, 'privateContentOpen', {
      kind: object.kind,
      objectId: object.objectId,
      ...(reason.trim().length === 0 ? {} : { reason: reason.trim() }),
    }),
  );
  const viewId = text(value?.['viewId']);
  if (viewId === undefined) throw new Error('invalid privateContentOpen response');
  return { viewId, messages: list(value?.['messages'], parsePrivateMessage) };
}

export async function loadAuditLog(call: BridgeCall, signal?: AbortSignal): Promise<AuditRecord[]> {
  const value = await unwrap(call, 'auditLog', { limit: 50 }, signal);
  const page = record(value);
  return list(page?.['records'] ?? page?.['items'] ?? value, parseAuditRecord);
}

export async function verifyAudit(call: BridgeCall): Promise<boolean> {
  return record(await unwrap(call, 'auditVerify', {}))?.['ok'] === true;
}
