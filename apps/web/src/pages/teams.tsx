import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Member, PageResult, Team } from '@survey/contracts';
import { del, errorMessage, get, patch, post, put } from '../api';
import { useAuth } from '../auth';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  PageHeader,
  TextField,
} from '../components/ui';

/** Teams (Phase 3A): groups of members that surveys can be shared with. Admins manage them. */
export function TeamsPage() {
  const { me } = useAuth();
  const isAdmin = me?.activeOrg?.role === 'org_admin';
  const queryClient = useQueryClient();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/org/teams') });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => get<PageResult<Member>>('/org/members'),
    enabled: isAdmin,
  });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<Team | null>(null);
  const [deleting, setDeleting] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['teams'] });

  const create = useMutation({
    mutationFn: () => post<Team>('/org/teams', { name }),
    onSuccess: (team) => {
      setName('');
      setError(null);
      reload();
      setEditing(team);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (team: Team) => del(`/org/teams/${team.id}`),
    onSuccess: () => {
      setDeleting(null);
      reload();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <>
      <PageHeader
        title="Teams"
        description="Share surveys with a whole team at once. Each member gets the team's role, but analysts can only ever view."
      />
      {error ? (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          {teams.data?.length === 0 ? (
            <EmptyState title="No teams yet">
              {isAdmin ? 'Create a team, then share surveys with it.' : null}
            </EmptyState>
          ) : null}
          {(teams.data ?? []).map((team) => (
            <Card
              key={team.id}
              title={team.name}
              actions={
                isAdmin ? (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setEditing(team)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeleting(team)}
                      aria-label={`Delete ${team.name}`}
                    >
                      Delete
                    </Button>
                  </div>
                ) : null
              }
            >
              {team.members.length === 0 ? (
                <p className="text-sm text-muted">No members.</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {team.members.map((m) => (
                    <li key={m.id} className="rounded-full bg-gray-100 px-3 py-1 text-sm">
                      {m.name}
                      {m.role === 'analyst' ? <span className="text-muted"> · views only</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
        {isAdmin ? (
          <Card title="New team">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <TextField label="Team name" value={name} onChange={(e) => setName(e.target.value)} />
              <Button type="submit" variant="primary" busy={create.isPending} disabled={!name.trim()}>
                Create team
              </Button>
            </form>
          </Card>
        ) : null}
      </div>
      {editing ? (
        <TeamDialog
          team={editing}
          members={members.data?.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            reload();
            setEditing(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name}?`}
        message="Surveys shared with this team stop being shared with its members (unless shared with them directly)."
        confirmLabel="Delete team"
        danger
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}

function TeamDialog({
  team,
  members,
  onClose,
  onSaved,
}: {
  team: Team;
  members: Member[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(team.name);
  const [chosen, setChosen] = useState(new Set(team.members.map((m) => m.id)));
  const save = useMutation({
    mutationFn: async () => {
      if (name !== team.name) await patch(`/org/teams/${team.id}`, { name });
      await put(`/org/teams/${team.id}/members`, { userIds: [...chosen] });
    },
    onSuccess: onSaved,
  });
  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${team.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!name.trim()}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField label="Team name" value={name} onChange={(e) => setName(e.target.value)} />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Members</legend>
          {members.map((m) => (
            <Checkbox
              key={m.userId}
              label={m.name}
              hint={`${m.email}${m.role === 'analyst' ? ' · analyst (view only)' : ''}`}
              checked={chosen.has(m.userId)}
              onChange={() => toggle(m.userId)}
            />
          ))}
        </fieldset>
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      </div>
    </Dialog>
  );
}
