import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Collaborator, Member, PageResult, SurveyDetail, SurveyRole, Theme } from '@survey/contracts';
import { del, errorMessage, get, patch, post, put } from '../../api';
import { useAuth } from '../../auth';
import { Alert, Button, Card, ConfirmDialog, Dialog, SelectField, TextArea, TextField } from '../../components/ui';
import { NotificationRules, TeamAccess } from './collaboration';
import { useSurvey } from './SurveyLayout';

export function SurveySettingsPage() {
  const { survey, refresh } = useSurvey();
  const { me } = useAuth();
  const navigate = useNavigate();
  const isOwner = survey.myRole === 'owner';
  const canEdit = survey.myRole !== 'viewer';
  const [title, setTitle] = useState(survey.title);
  const [confirm, setConfirm] = useState<null | 'delete' | 'archive'>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const rename = useMutation({
    mutationFn: () => patch(`/surveys/${survey.id}`, { title }),
    onSuccess: refresh,
  });
  const duplicate = useMutation({
    mutationFn: () => post<SurveyDetail>(`/surveys/${survey.id}/duplicate`, {}),
    onSuccess: (copy) => navigate(`/surveys/${copy.id}/edit`),
  });
  const archive = useMutation({
    mutationFn: () => post(`/surveys/${survey.id}/archive`),
    onSuccess: () => {
      setConfirm(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/surveys/${survey.id}`),
    onSuccess: () => navigate('/surveys'),
  });
  const canCreate = me?.activeOrg?.role !== 'analyst';

  return (
    <div className="grid max-w-4xl gap-6">
      {canEdit ? (
        <Card title="Title">
          <form
            className="flex items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate();
            }}
          >
            <TextField
              label="Survey title"
              className="flex-1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Button type="submit" busy={rename.isPending} disabled={!title.trim() || title === survey.title}>
              Save
            </Button>
          </form>
          {rename.error ? (
            <Alert tone="error" className="mt-3">
              {errorMessage(rename.error)}
            </Alert>
          ) : null}
        </Card>
      ) : null}

      {canEdit ? <ThemePicker survey={survey} onSaved={refresh} /> : null}

      <Collaborators survey={survey} canShare={isOwner} />
      <TeamAccess survey={survey} canShare={isOwner} />
      <NotificationRules survey={survey} canEdit={canEdit} />

      <Card title="Other actions">
        <div className="flex flex-wrap gap-3">
          {canCreate ? (
            <Button busy={duplicate.isPending} onClick={() => duplicate.mutate()}>
              Duplicate survey
            </Button>
          ) : null}
          {canCreate ? <Button onClick={() => setSavingTemplate(true)}>Save as template</Button> : null}
          {canEdit && survey.status !== 'archived' ? (
            <Button onClick={() => setConfirm('archive')}>Archive</Button>
          ) : null}
          {isOwner ? (
            <Button variant="danger" onClick={() => setConfirm('delete')}>
              Delete survey
            </Button>
          ) : null}
        </div>
        {duplicate.error || remove.error ? (
          <Alert tone="error" className="mt-3">
            {errorMessage(duplicate.error ?? remove.error)}
          </Alert>
        ) : null}
      </Card>

      <SaveTemplateDialog open={savingTemplate} survey={survey} onClose={() => setSavingTemplate(false)} />
      <ConfirmDialog
        open={confirm === 'archive'}
        title="Archive survey?"
        message="It stops accepting responses and moves out of your way. Results stay available, and you can reopen it later."
        confirmLabel="Archive"
        busy={archive.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => archive.mutate()}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete survey?"
        message={`"${survey.title}" and its ${survey.responseCount} responses will be removed. The public link stops working immediately.`}
        confirmLabel="Delete survey"
        danger
        busy={remove.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function ThemePicker({ survey, onSaved }: { survey: SurveyDetail; onSaved: () => void }) {
  const themes = useQuery({ queryKey: ['themes'], queryFn: () => get<Theme[]>('/themes') });
  const queryClient = useQueryClient();
  const choose = useMutation({
    mutationFn: (themeId: string | null) => patch(`/surveys/${survey.id}`, { themeId }),
    onSuccess: () => {
      onSaved();
      void queryClient.invalidateQueries({ queryKey: ['themes'] });
    },
  });
  const orgDefault = themes.data?.find((t) => t.isDefault);
  return (
    <Card title="Theme">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          label="Look of the survey"
          className="min-w-64"
          value={survey.themeId ?? ''}
          disabled={choose.isPending}
          onChange={(e) => choose.mutate(e.target.value || null)}
        >
          <option value="">Organization default{orgDefault ? ` (${orgDefault.name})` : ' (standard look)'}</option>
          {(themes.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>
        <Link to="/settings/themes" className="pb-2 text-sm text-brand-600 hover:underline">
          Manage themes
        </Link>
      </div>
      <p className="mt-2 text-xs text-muted">Themes apply immediately, including to a live survey. The preview in the builder shows it.</p>
      {choose.error ? (
        <Alert tone="error" className="mt-3">
          {errorMessage(choose.error)}
        </Alert>
      ) : null}
    </Card>
  );
}

function SaveTemplateDialog({ open, survey, onClose }: { open: boolean; survey: SurveyDetail; onClose: () => void }) {
  const [name, setName] = useState(survey.title);
  const [description, setDescription] = useState('');
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () => post(`/surveys/${survey.id}/save-as-template`, { name, description }),
    onSuccess: () => setDone(true),
  });
  const close = () => {
    setDone(false);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Save as template"
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" busy={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
              Save template
            </Button>
          </>
        )
      }
    >
      {done ? (
        <Alert tone="success">Saved. Everyone in your organization can now start a new survey from "{name}".</Alert>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Saves a copy of the questions, pages, logic and settings (the latest draft, if there is one). Responses aren't
            included.
          </p>
          <TextField label="Template name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextArea label="Description (optional)" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
        </div>
      )}
    </Dialog>
  );
}

function Collaborators({ survey, canShare }: { survey: SurveyDetail; canShare: boolean }) {
  const queryClient = useQueryClient();
  const key = ['collaborators', survey.id];
  const collaborators = useQuery({
    queryKey: key,
    queryFn: () => get<Collaborator[]>(`/surveys/${survey.id}/collaborators`),
  });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => get<PageResult<Member>>('/org/members'),
    enabled: canShare,
  });
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<SurveyRole>('viewer');
  const [transferTo, setTransferTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => {
    setError(null);
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ['survey', survey.id] });
  };
  const onError = (e: unknown) => setError(errorMessage(e));
  const share = useMutation({
    mutationFn: (v: { userId: string; role: SurveyRole }) =>
      put(`/surveys/${survey.id}/collaborators/${v.userId}`, { role: v.role }),
    onSuccess: invalidate,
    onError,
  });
  const unshare = useMutation({
    mutationFn: (id: string) => del(`/surveys/${survey.id}/collaborators/${id}`),
    onSuccess: invalidate,
    onError,
  });
  const transfer = useMutation({
    mutationFn: (id: string) => post(`/surveys/${survey.id}/transfer`, { userId: id }),
    onSuccess: invalidate,
    onError,
  });

  const shared = new Set(collaborators.data?.map((c) => c.user.id));
  const candidates = (members.data?.data ?? []).filter((m) => !shared.has(m.userId));
  const memberRole = (id: string) => members.data?.data.find((m) => m.userId === id)?.role;
  const owners = (members.data?.data ?? []).filter(
    (m) => m.role !== 'analyst' && collaborators.data?.find((c) => c.role === 'owner')?.user.id !== m.userId,
  );

  return (
    <Card title="Who has access">
      <p className="mb-3 text-sm text-muted">
        Org admins can always see and edit every survey. Analysts can only be given view access.
      </p>
      {error ? (
        <Alert tone="error" className="mb-3">
          {error}
        </Alert>
      ) : null}
      <ul className="flex flex-col divide-y divide-line">
        {(collaborators.data ?? []).map((c) => (
          <li key={c.user.id} className="flex flex-wrap items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{c.user.name}</div>
              <div className="text-xs text-muted">{c.user.email}</div>
            </div>
            {c.role === 'owner' || !canShare ? (
              <span className="text-sm capitalize text-muted">{c.role}</span>
            ) : (
              <>
                <label>
                  <span className="sr-only">Access for {c.user.name}</span>
                  <select
                    className="rounded-md border border-line px-2 py-1 text-sm"
                    value={c.role}
                    onChange={(e) => share.mutate({ userId: c.user.id, role: e.target.value as SurveyRole })}
                  >
                    <option value="viewer">Can view</option>
                    {memberRole(c.user.id) !== 'analyst' ? <option value="editor">Can edit</option> : null}
                  </select>
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => unshare.mutate(c.user.id)}
                  aria-label={`Remove ${c.user.name}`}
                >
                  Remove
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {canShare ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (userId) share.mutate({ userId, role }, { onSuccess: () => setUserId('') });
            }}
          >
            <SelectField
              label="Add a member"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="min-w-56 flex-1"
            >
              <option value="">Choose…</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} ({m.email})
                </option>
              ))}
            </SelectField>
            <SelectField label="Access" value={role} onChange={(e) => setRole(e.target.value as SurveyRole)}>
              <option value="viewer">Can view</option>
              {memberRole(userId) !== 'analyst' ? <option value="editor">Can edit</option> : null}
            </SelectField>
            <Button type="submit" busy={share.isPending} disabled={!userId}>
              Share
            </Button>
          </form>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (transferTo) transfer.mutate(transferTo, { onSuccess: () => setTransferTo('') });
            }}
          >
            <SelectField
              label="Transfer ownership to"
              value={transferTo}
              onChange={(e) => setTransferTo(e.target.value)}
              className="min-w-56 flex-1"
            >
              <option value="">Choose…</option>
              {owners.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </SelectField>
            <Button type="submit" busy={transfer.isPending} disabled={!transferTo}>
              Transfer
            </Button>
          </form>
        </div>
      ) : null}
    </Card>
  );
}
