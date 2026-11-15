import { useState, type ReactElement } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';

import type { BridgeCall } from './bridge.js';
import { TextField } from './ds/field.js';
import { FormDialog } from './ds/form-dialog.js';
import { Note } from './ds/note.js';
import { SettingsRow, SettingsSection } from './ds/settings-row.js';
import { color, radius, space, text } from './ds/tokens.stylex.js';
import type { BotHarnessTranslate } from './locale.js';
import { useMountedResource } from './mounted-resource.js';
import type { TeamMember } from './team-bridge.js';
import { teamErrorText } from './team-settings.js';
import {
  auditActionKey,
  loadAuditLog,
  loadPrivateObjects,
  openPrivateContent,
  verifyAudit,
  type AuditRecord,
  type PrivateObject,
  type PrivateView,
} from './team-audit-bridge.js';

const styles = stylex.create({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.x2,
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  message: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.x1,
    paddingBlock: space.x2,
    paddingInline: space.x3,
    borderRadius: radius.md,
    backgroundColor: color.well,
    minWidth: 0,
  },
  meta: { color: color.muted, fontSize: text.metaSize, lineHeight: text.metaLine },
  body: {
    color: color.fg,
    fontSize: text.bodySize,
    lineHeight: text.bodyLine,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  group: { display: 'flex', flexDirection: 'column', gap: space.x2, minWidth: 0 },
  title: {
    margin: 0,
    color: color.muted,
    fontSize: text.metaSize,
    lineHeight: text.metaLine,
    fontWeight: text.strong,
  },
});

function time(at: string): string {
  const date = new Date(at);
  const language = typeof document === 'undefined' ? undefined : document.documentElement.lang;
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString(language || undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function AuditLogSection({
  call,
  t,
}: {
  call: BridgeCall;
  t: BotHarnessTranslate;
}): ReactElement {
  const [rows, setRows] = useState<readonly AuditRecord[]>();
  const [failed, setFailed] = useState(false);
  const [verified, setVerified] = useState<boolean>();
  const mount = useMountedResource<HTMLDivElement>(() => {
    const controller = new AbortController();
    loadAuditLog(call, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setRows(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [call]);
  return (
    <SettingsSection title={t('team.audit.title')}>
      <div ref={mount}>
        <SettingsRow
          title={t('team.audit.integrity')}
          description={
            verified === undefined
              ? t('team.audit.integrityHint')
              : t(verified ? 'team.audit.intact' : 'team.audit.broken')
          }
          data={{ 'data-team-row': 'audit-verify' }}
          control={
            <Button
              variant="outline"
              onClick={() => void verifyAudit(call).then(setVerified, () => setVerified(false))}
            >
              {t('team.audit.verify')}
            </Button>
          }
        />
        {failed ? <Note tone="danger">{t('team.audit.loadFailed')}</Note> : null}
        {rows !== undefined && rows.length === 0 ? <Note>{t('team.audit.empty')}</Note> : null}
        <div role="list" aria-label={t('team.audit.title')}>
          {(rows ?? []).map((row) => {
            const label =
              row.action === undefined
                ? t('team.audit.entry', {
                    viewer: row.viewerName,
                    object: row.objectName,
                    kind: t(`team.private.kind.${row.kind}`),
                  })
                : t(`team.audit.action.${auditActionKey(row.action)}`, {
                    viewer: row.viewerName,
                    object: row.objectName,
                  });
            return (
              <div role="listitem" key={row.auditId} data-audit-record={row.auditId}>
                <SettingsRow
                  title={label}
                  description={
                    row.reason === undefined
                      ? time(row.at)
                      : t('team.audit.entryReason', { at: time(row.at), reason: row.reason })
                  }
                />
              </div>
            );
          })}
        </div>
      </div>
    </SettingsSection>
  );
}

export function PrivateContentEntry({
  call,
  t,
  member,
}: {
  call: BridgeCall;
  t: BotHarnessTranslate;
  member: TeamMember;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div {...stylex.props(styles.group)} data-private-entry={member.username}>
      <p {...stylex.props(styles.title)}>{t('team.private.title')}</p>
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          {t('team.private.open')}
        </Button>
      </div>
      {open ? (
        <PrivateContentDialog call={call} t={t} member={member} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

type Step =
  | { kind: 'list' }
  | { kind: 'confirm'; object: PrivateObject }
  | { kind: 'view'; object: PrivateObject; view: PrivateView };

function PrivateContentDialog({
  call,
  t,
  member,
  onClose,
}: {
  call: BridgeCall;
  t: BotHarnessTranslate;
  member: TeamMember;
  onClose(): void;
}): ReactElement {
  const [objects, setObjects] = useState<readonly PrivateObject[]>();
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mount = useMountedResource<HTMLDivElement>(() => {
    const controller = new AbortController();
    loadPrivateObjects(call, member.humanId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setObjects(next);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(teamErrorText(t, failure));
      });
    return () => controller.abort();
  }, [call, member.humanId]);
  const errorNote = error === undefined ? undefined : <Note tone="danger">{error}</Note>;
  if (step.kind === 'confirm')
    return (
      <FormDialog
        title={t('team.private.confirmTitle', { name: step.object.name })}
        description={t('team.private.confirmBody', { name: member.displayName })}
        labels={{ close: t('common.close'), cancel: t('common.cancel') }}
        submitLabel={t('team.private.view')}
        busy={busy}
        error={errorNote}
        onCancel={() => setStep({ kind: 'list' })}
        onClose={onClose}
        onSubmit={() => {
          setBusy(true);
          setError(undefined);
          openPrivateContent(call, step.object, reason)
            .then((view) => setStep({ kind: 'view', object: step.object, view }))
            .catch((failure: unknown) => setError(teamErrorText(t, failure)))
            .finally(() => setBusy(false));
        }}
      >
        <TextField
          label={t('team.private.reason')}
          value={reason}
          onChange={setReason}
          maxLength={200}
          initialFocus
        />
      </FormDialog>
    );
  if (step.kind === 'view')
    return (
      <FormDialog
        title={step.object.name}
        size="medium"
        scroll
        labels={{ close: t('common.close'), cancel: t('common.close') }}
        submitLabel={t('team.done')}
        showCancel={false}
        onCancel={onClose}
        onClose={onClose}
        onSubmit={onClose}
      >
        <Note tone="warning">{t('team.private.recorded')}</Note>
        {step.view.messages.length === 0 ? (
          <Note>{t('team.private.noMessages')}</Note>
        ) : (
          <ul {...stylex.props(styles.list)} data-private-view={step.view.viewId}>
            {step.view.messages.map((message) => (
              <li key={message.id} {...stylex.props(styles.message)}>
                <span
                  {...stylex.props(styles.meta)}
                >{`${message.author} · ${time(message.at)}`}</span>
                <span {...stylex.props(styles.body)}>{message.body}</span>
              </li>
            ))}
          </ul>
        )}
      </FormDialog>
    );
  return (
    <FormDialog
      title={t('team.private.listTitle', { name: member.displayName })}
      description={t('team.private.listBody')}
      size="medium"
      scroll
      labels={{ close: t('common.close'), cancel: t('common.close') }}
      submitLabel=""
      showCancel={false}
      error={errorNote}
      onCancel={onClose}
      onClose={onClose}
    >
      <div ref={mount}>
        {objects === undefined && error === undefined ? (
          <Note>{t('team.private.loading')}</Note>
        ) : null}
        {objects !== undefined && objects.length === 0 ? (
          <Note>{t('team.private.none')}</Note>
        ) : null}
        <div role="list">
          {(objects ?? []).map((object) => (
            <div
              role="listitem"
              key={`${object.kind}:${object.objectId}`}
              data-private-object={object.objectId}
            >
              <SettingsRow
                title={object.name}
                description={t(`team.private.kind.${object.kind}`)}
                control={
                  <Button
                    variant="outline"
                    aria-label={t('team.private.viewNamed', { name: object.name })}
                    onClick={() => {
                      setReason('');
                      setStep({ kind: 'confirm', object });
                    }}
                  >
                    {t('team.private.view')}
                  </Button>
                }
              />
            </div>
          ))}
        </div>
      </div>
    </FormDialog>
  );
}
