import { useClientFields } from './use-client-store.js';
import { useRef, useState, type ReactElement } from 'react';
import type { ApprovalTemplateDeletionPreview } from '../../../core/src/workspaces/approval-template-deletion-contract.js';
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import * as stylex from '@stylexjs/stylex';

import { templateDescription, templateTitle } from './approval-template-entry.js';
import {
  BridgeCallError,
  createApprovalTemplate,
  deleteApprovalTemplate,
  errorMessage,
  loadApprovalTemplates,
  previewApprovalTemplateDeletion,
  setGlobalApprovalTemplate,
  updateApprovalTemplate,
  type ApprovalTemplateView,
  type BridgeCall,
} from './bridge.js';
import { Callout } from './ds/callout.js';
import { FieldStack, TextAreaField, TextField } from './ds/field.js';
import { ConfirmDialog, DangerTextButton, FormDialog } from './ds/form-dialog.js';
import { Note } from './ds/note.js';
import { Select } from './ds/select.js';
import { SettingsRow, SettingsSection } from './ds/settings-row.js';
import { space } from './ds/tokens.stylex.js';
import type { BotHarnessTranslate } from './locale.js';
import { LoadingSkeleton } from './loading-skeleton.js';
import { useMountedResource } from './mounted-resource.js';
import type { ClientStore } from './store.js';

const TEMPLATE_LIBRARY_FIELDS = ['bots'] as const;

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

const styles = stylex.create({
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space.x2 },
});

type Editor =
  | { mode: 'create'; name: string; text: string }
  | { mode: 'view'; template: ApprovalTemplateView }
  | { mode: 'edit'; template: ApprovalTemplateView; text: string };

function botNames(store: ClientStore, slugs: readonly string[]): string {
  const names = new Map(store.getSnapshot().bots.map((bot) => [bot.slug, bot.displayName]));
  return slugs.map((slug) => names.get(slug) ?? slug).join(', ');
}

type Deleting = { template: ApprovalTemplateView } & (
  | { kind: 'loading' | 'failed' }
  | { kind: 'ready'; preview: ApprovalTemplateDeletionPreview }
);

function copyName(name: string, taken: readonly ApprovalTemplateView[]): string {
  const base = (name + '-copy').slice(0, 58);
  let candidate = base;
  for (let index = 2; taken.some((template) => template.name === candidate); index++)
    candidate = base + '-' + String(index);
  return candidate;
}

function copyText(text: string, suffix: string): string {
  return text.replace(/^(#[ \t]+)(.+)$/mu, (_match, mark: string, title: string) =>
    title.trimEnd().endsWith(suffix) ? mark + title : mark + title.trimEnd() + ' ' + suffix,
  );
}

export function ApprovalTemplateLibrarySettings({
  call,
  store,
  t,
}: {
  call: BridgeCall;
  store: ClientStore;
  t: BotHarnessTranslate;
}): ReactElement {
  const [globalDefault, setGlobalDefault] = useState<string | null>();
  const [globalError, setGlobalError] = useState(false);
  const [templates, setTemplates] = useState<ApprovalTemplateView[]>();
  const [loadError, setLoadError] = useState<string>();
  const [editor, setEditor] = useState<Editor>();
  const [deleting, setDeleting] = useState<Deleting>();
  const deletionGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useClientFields(TEMPLATE_LIBRARY_FIELDS, store);

  const reload = async () => {
    const next = await loadApprovalTemplates(call);
    setTemplates(next.templates);
    setGlobalDefault(next.globalDefault ?? null);
    setGlobalError(false);
    setLoadError(undefined);
    setEditor((current) =>
      current !== undefined &&
      current.mode !== 'create' &&
      !next.templates.some((template) => template.name === current.template.name)
        ? undefined
        : current,
    );
    return next;
  };
  const mount = useMountedResource<HTMLDivElement>(() => {
    let live = true;
    loadApprovalTemplates(call)
      .then((next) => {
        if (live) {
          setTemplates(next.templates);
          setGlobalDefault(next.globalDefault ?? null);
        }
      })
      .catch((cause: unknown) => {
        if (live) setLoadError(errorMessage(cause));
      });
    return () => {
      live = false;
      deletionGeneration.current++;
    };
  }, [call]);

  const updateGlobal = (
    action: { kind: 'reload' } | { kind: 'select'; name: string | null },
  ): void => {
    if (busy) return;
    setBusy(true);
    setGlobalError(false);
    const operation =
      action.kind === 'reload'
        ? reload()
        : setGlobalApprovalTemplate(call, action.name).then(reload);
    void operation
      .catch(() => {
        setGlobalDefault(undefined);
        setGlobalError(true);
      })
      .finally(() => setBusy(false));
  };

  const cancelDeletion = (): void => {
    deletionGeneration.current++;
    setDeleting(undefined);
    setError(undefined);
  };
  const close = (): void => {
    setEditor(undefined);
    cancelDeletion();
    setError(undefined);
  };
  const run = (operation: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void operation()
      .then(async () => {
        close();
        await reload();
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  const beginDeletion = (template: ApprovalTemplateView, notice?: string): void => {
    const generation = ++deletionGeneration.current;
    setError(notice);
    setDeleting({ template, kind: 'loading' });
    void previewApprovalTemplateDeletion(call, template.name).then(
      (preview) => {
        if (deletionGeneration.current === generation)
          setDeleting({ template, kind: 'ready', preview });
      },
      () => {
        if (deletionGeneration.current !== generation) return;
        setDeleting({ template, kind: 'failed' });
        setError(t('autoApproval.library.deletePreviewFailed'));
      },
    );
  };
  const reconcileDeletion = async (name: string, generation: number): Promise<void> => {
    try {
      const next = await reload();
      if (
        deletionGeneration.current === generation &&
        !next.templates.some((template) => template.name === name)
      )
        cancelDeletion();
    } catch {
      setGlobalDefault(undefined);
      setGlobalError(true);
    }
  };
  const recoverDeletion = (template: ApprovalTemplateView): void => {
    if (busy) return;
    const generation = deletionGeneration.current;
    setBusy(true);
    void reload()
      .then((next) => {
        if (deletionGeneration.current !== generation) return;
        if (next.templates.some((entry) => entry.name === template.name)) beginDeletion(template);
        else cancelDeletion();
      })
      .catch(() => {
        setGlobalDefault(undefined);
        setGlobalError(true);
      })
      .finally(() => setBusy(false));
  };
  const confirmDeletion = (): void => {
    if (busy || deleting?.kind !== 'ready') return;
    const selected = deleting;
    const generation = deletionGeneration.current;
    setBusy(true);
    setError(undefined);
    void deleteApprovalTemplate(call, selected.preview)
      .then(async () => {
        setTemplates((current) =>
          current?.filter((template) => template.name !== selected.preview.name),
        );
        if (deletionGeneration.current === generation) close();
        await reconcileDeletion(selected.preview.name, generation);
      })
      .catch(async (cause: unknown) => {
        if (deletionGeneration.current === generation) {
          if (cause instanceof BridgeCallError && cause.code === 'approval-template-delete-changed')
            beginDeletion(selected.template, t('autoApproval.library.deleteChanged'));
          else {
            setDeleting({ template: selected.template, kind: 'failed' });
            setError(t('autoApproval.library.deleteUnconfirmed'));
          }
        }
        setGlobalDefault(undefined);
        setGlobalError(true);
        await reconcileDeletion(selected.preview.name, generation);
      })
      .finally(() => setBusy(false));
  };

  const labels = { close: t('common.close'), cancel: t('common.cancel') };
  const list = templates ?? [];
  const usedBy = (template: ApprovalTemplateView): string | undefined =>
    template.usedBy.length === 0 ? undefined : botNames(store, template.usedBy);

  const dialog = (() => {
    if (deleting !== undefined) {
      const preview = deleting.kind === 'ready' ? deleting.preview : undefined;
      const direct =
        preview?.affectedBots.filter((bot) => bot.source === 'specific').map((bot) => bot.slug) ??
        [];
      const inherited =
        preview?.affectedBots.filter((bot) => bot.source === 'global').map((bot) => bot.slug) ?? [];
      const after = preview?.globalDefaultAfter;
      const effective =
        after === null
          ? t('autoApproval.off')
          : after === undefined
            ? ''
            : preview?.globalDefaultAvailable
              ? templateTitle(t, after, list.find((template) => template.name === after)?.title)
              : t('autoApproval.templateMissing', { name: after });
      return (
        <ConfirmDialog
          title={t('autoApproval.library.deleteTitle', {
            title: templateTitle(t, deleting.template.name, deleting.template.title),
          })}
          labels={labels}
          confirmLabel={t('autoApproval.library.delete')}
          confirmDisabled={preview === undefined}
          scroll
          busy={busy}
          error={error}
          onCancel={cancelDeletion}
          onConfirm={confirmDeletion}
        >
          <Note>{t('autoApproval.library.deleteBody', { name: deleting.template.name })}</Note>
          {deleting.kind === 'loading' ? <Note>{t('autoApproval.loading')}</Note> : null}
          {preview === undefined ? null : (
            <>
              {direct.length === 0 ? null : (
                <Callout tone="warning">
                  {t('autoApproval.library.deleteDirect', { names: botNames(store, direct) })}
                </Callout>
              )}
              {inherited.length === 0 ? null : (
                <Callout tone="warning">
                  {t('autoApproval.library.deleteInherited', { names: botNames(store, inherited) })}
                </Callout>
              )}
              {preview.globalDefaultBefore === preview.name ? (
                <Note>{t('autoApproval.library.deleteClearsGlobal')}</Note>
              ) : null}
              {preview.hiddenBotCount > 0 ? (
                <Callout tone="warning">
                  {t('autoApproval.library.deleteHidden', {
                    count: String(preview.hiddenBotCount),
                  })}
                </Callout>
              ) : null}
              {preview.affectedBots.length === 0 && preview.hiddenBotCount === 0 ? (
                <Note>{t('autoApproval.library.deleteUnused')}</Note>
              ) : (
                <Note>{t('autoApproval.library.deleteEffective', { template: effective })}</Note>
              )}
              <Note>{t('autoApproval.library.deleteRulesUnchanged')}</Note>
            </>
          )}
          {deleting.kind === 'failed' ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => recoverDeletion(deleting.template)}
            >
              {t('autoApproval.reload')}
            </Button>
          ) : null}
        </ConfirmDialog>
      );
    }
    if (editor === undefined) return null;
    if (editor.mode === 'create') {
      const nameProblem =
        editor.name !== '' && !NAME.test(editor.name)
          ? t('autoApproval.library.nameHint')
          : undefined;
      return (
        <FormDialog
          title={t('autoApproval.library.createTitle')}
          size="wide"
          scroll
          labels={labels}
          submitLabel={t('autoApproval.library.createSubmit')}
          submitData={{ 'data-approval-template-submit': 'create' }}
          submitDisabled={!NAME.test(editor.name) || editor.text.trim() === ''}
          busy={busy}
          error={error}
          onCancel={close}
          onSubmit={() =>
            run(() => createApprovalTemplate(call, editor.name, { text: editor.text }))
          }
        >
          <FieldStack>
            <TextField
              label={t('autoApproval.library.name')}
              hint={nameProblem === undefined ? t('autoApproval.library.nameHint') : undefined}
              error={nameProblem}
              value={editor.name}
              monospace
              initialFocus
              spellCheck={false}
              autoComplete="off"
              onChange={(name) => setEditor({ ...editor, name: name.trim() })}
            />
            <TextAreaField
              label={t('autoApproval.library.text')}
              hint={t('autoApproval.library.newHint')}
              value={editor.text}
              rows={16}
              onChange={(text) => setEditor({ ...editor, text })}
            />
          </FieldStack>
        </FormDialog>
      );
    }
    const template = editor.template;
    const title = templateTitle(t, template.name, template.title);
    if (editor.mode === 'view')
      return (
        <FormDialog
          title={title}
          size="wide"
          scroll
          labels={labels}
          submitLabel={t('autoApproval.library.copy')}
          submitData={{ 'data-approval-template-submit': 'copy' }}
          onCancel={close}
          onSubmit={() =>
            setEditor({
              mode: 'create',
              name: copyName(template.name, list),
              text: copyText(template.text ?? '', t('autoApproval.library.copySuffix')),
            })
          }
        >
          <Note>{t('autoApproval.library.readOnly')}</Note>
          <TextAreaField
            label={t('autoApproval.library.text')}
            value={template.text ?? ''}
            rows={16}
            readOnly
            onChange={() => {}}
          />
        </FormDialog>
      );
    const names = usedBy(template);
    return (
      <FormDialog
        title={t('autoApproval.library.editTitle', { title })}
        size="wide"
        scroll
        labels={labels}
        submitLabel={t('autoApproval.library.save')}
        submitData={{ 'data-approval-template-submit': 'save' }}
        submitDisabled={editor.text.trim() === '' || editor.text === template.text}
        busy={busy}
        error={error}
        onCancel={close}
        onSubmit={() => run(() => updateApprovalTemplate(call, template.name, editor.text))}
        secondary={
          <DangerTextButton
            disabled={busy}
            onClick={() => {
              setError(undefined);
              beginDeletion(template);
            }}
          >
            {t('autoApproval.library.delete')}
          </DangerTextButton>
        }
      >
        {names === undefined ? null : (
          <Callout tone="muted">{t('autoApproval.library.inUse', { names })}</Callout>
        )}
        <TextAreaField
          label={t('autoApproval.library.text')}
          hint={t('autoApproval.library.fileHint', { name: template.name })}
          value={editor.text}
          rows={16}
          initialFocus
          onChange={(text) => setEditor({ ...editor, text })}
        />
      </FormDialog>
    );
  })();

  return (
    <div ref={mount} data-approval-template-library="">
      <SettingsSection
        title={t('autoApproval.library.title')}
        description={t('autoApproval.library.description')}
      >
        {templates === undefined ? null : (
          <SettingsRow
            title={t('autoApproval.globalDefault')}
            description={
              globalError ? (
                <Note tone="danger">{t('autoApproval.globalUnknown')}</Note>
              ) : globalDefault !== undefined &&
                globalDefault !== null &&
                !list.some((template) => template.name === globalDefault) ? (
                t('autoApproval.unavailable')
              ) : undefined
            }
            control={
              <>
                <Select
                  label={t('autoApproval.globalDefault')}
                  value={globalDefault === undefined ? '@unknown' : (globalDefault ?? 'off')}
                  disabled={busy || globalDefault === undefined}
                  options={[
                    ...(globalDefault === undefined
                      ? [{ value: '@unknown', label: t('autoApproval.unreadable') }]
                      : globalDefault !== null &&
                          !list.some((template) => template.name === globalDefault)
                        ? [
                            {
                              value: globalDefault,
                              label: t('autoApproval.templateMissing', { name: globalDefault }),
                            },
                          ]
                        : []),
                    { value: 'off', label: t('autoApproval.off') },
                    ...list.map((template) => ({
                      value: template.name,
                      label: templateTitle(t, template.name, template.title),
                    })),
                  ]}
                  onChange={(value) =>
                    updateGlobal({ kind: 'select', name: value === 'off' ? null : value })
                  }
                />
                {globalError ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => updateGlobal({ kind: 'reload' })}
                  >
                    {t('autoApproval.reload')}
                  </Button>
                ) : null}
              </>
            }
          />
        )}
        <SettingsRow
          title={t('autoApproval.library.new')}
          data={{ 'data-approval-template-new': '' }}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={templates === undefined}
              onClick={() => setEditor({ mode: 'create', name: '', text: '' })}
            >
              {t('autoApproval.library.create')}
            </Button>
          }
        />
        {templates === undefined ? (
          loadError === undefined ? (
            <LoadingSkeleton kind="sidebar" label={t('autoApproval.library.title')} />
          ) : (
            <Note tone="danger">{loadError}</Note>
          )
        ) : (
          list.map((template) => {
            const names = usedBy(template);
            return (
              <SettingsRow
                key={template.name}
                title={templateTitle(t, template.name, template.title)}
                data={{ 'data-approval-template': template.name }}
                description={
                  <span {...stylex.props(styles.meta)}>
                    {template.builtIn ? (
                      <Tag tone="neutral">{t('autoApproval.library.builtIn')}</Tag>
                    ) : (
                      <Tag tone="neutral">{template.name}</Tag>
                    )}
                    <span>
                      {[
                        templateDescription(t, template),
                        names === undefined
                          ? t('autoApproval.library.unused')
                          : t('autoApproval.library.usedBy', { names }),
                      ]
                        .filter((part) => part !== '')
                        .join(' · ')}
                    </span>
                  </span>
                }
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setError(undefined);
                      setEditor(
                        template.builtIn
                          ? { mode: 'view', template }
                          : { mode: 'edit', template, text: template.text ?? '' },
                      );
                    }}
                  >
                    {template.builtIn
                      ? t('autoApproval.library.view')
                      : t('autoApproval.library.edit')}
                  </Button>
                }
              />
            );
          })
        )}
      </SettingsSection>
      {dialog}
    </div>
  );
}
