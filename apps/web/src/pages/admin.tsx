/**
 * Phase 3B: the super-admin console. Every organization with its size and this month's usage; suspend or
 * reactivate, change the plan and the monthly AI token cap. Survey content stays out of reach: super admins
 * see counts, not data. Every change is recorded in the organization's own audit log.
 */
import { useState } from 'react';
import { Navigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminOrg, AdminOverview, UsageReport } from '@survey/contracts';
import { errorMessage, get, patch } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Dialog, PageHeader, SelectField, TextField } from '../components/ui';
import { formatDate, formatNumber } from '../lib/format';
import { UsageReportView } from './usage';

export function PlatformAdminPage() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<AdminOrg | null>(null);
  const [usageOf, setUsageOf] = useState<AdminOrg | null>(null);
  const params = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) });
  const overview = useQuery({
    queryKey: ['admin-overview', q, status],
    queryFn: () => get<AdminOverview>(`/admin/overview?${params}`),
    enabled: Boolean(me?.user.isSuperAdmin),
  });
  if (!me?.user.isSuperAdmin) return <Navigate to="/surveys" replace />;
  const t = overview.data?.totals;
  return (
    <>
      <PageHeader title="Platform" description="Organizations on this platform and what they use. Survey content isn't visible here." />
      {overview.error ? <Alert tone="error">{errorMessage(overview.error)}</Alert> : null}
      {t ? (
        <dl className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ['Organizations', `${formatNumber(t.activeOrgs)} active of ${formatNumber(t.orgs)}`],
            ['Members', formatNumber(t.members)],
            ['Surveys', formatNumber(t.surveys)],
            ['Responses this month', formatNumber(t.thisMonth.responses)],
            ['AI tokens this month', formatNumber(t.thisMonth.aiTokens)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line bg-white p-4">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="mt-1 text-lg font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Card
        title="Organizations"
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
            <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </SelectField>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Organizations</caption>
            <thead>
              <tr className="text-xs text-muted">
                <th scope="col" className="py-2 pe-3 text-start font-medium">Organization</th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">Plan</th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">Members</th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">Surveys</th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">Responses (month)</th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">AI tokens (month)</th>
                <th scope="col" className="py-2 text-end font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {overview.data?.orgs.map((o) => (
                <tr key={o.id}>
                  <th scope="row" className="py-2 pe-3 text-start font-normal">
                    <div className="font-medium">{o.name}</div>
                    <div className="text-xs text-muted">
                      {o.slug} · since {formatDate(o.createdAt)} {o.status === 'suspended' ? <Badge className="ms-1 bg-red-100 text-red-800">Suspended</Badge> : null}
                    </div>
                  </th>
                  <td className="py-2 pe-3">{o.plan}</td>
                  <td className="py-2 pe-3 text-end tabular-nums">{formatNumber(o.members)}</td>
                  <td className="py-2 pe-3 text-end tabular-nums">{formatNumber(o.surveys)}</td>
                  <td className="py-2 pe-3 text-end tabular-nums">{formatNumber(o.thisMonth.responses)}</td>
                  <td className="py-2 pe-3 text-end tabular-nums">
                    {formatNumber(o.thisMonth.aiTokens)}
                    <span className="text-xs text-muted"> / {formatNumber(o.aiMonthlyTokenCap)}</span>
                  </td>
                  <td className="py-2 text-end">
                    <span className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setUsageOf(o)} aria-label={`Usage of ${o.name}`}>
                        Usage
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(o)} aria-label={`Manage ${o.name}`}>
                        Manage
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {editing ? <ManageOrgDialog org={editing} onClose={() => setEditing(null)} /> : null}
      {usageOf ? <UsageDialog org={usageOf} onClose={() => setUsageOf(null)} /> : null}
    </>
  );
}

function ManageOrgDialog({ org, onClose }: { org: AdminOrg; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState(org.status);
  const [plan, setPlan] = useState(org.plan);
  const [cap, setCap] = useState(org.aiCapOverridden ? String(org.aiMonthlyTokenCap) : '');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () =>
      patch<AdminOrg>(`/admin/orgs/${org.id}`, {
        status,
        plan,
        aiMonthlyTokenCap: cap.trim() ? Number(cap) : null,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Manage ${org.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={status === 'suspended' && org.status !== 'suspended' ? 'danger' : 'primary'} busy={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as AdminOrg['status'])}>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </SelectField>
        {status === 'suspended' && org.status !== 'suspended' ? (
          <Alert tone="warning">Members lose access, API keys stop working and survey links answer “not found” until you reactivate it. Nothing is deleted.</Alert>
        ) : null}
        <TextField label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)} />
        <TextField
          label="Monthly AI token cap"
          type="number"
          min={0}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          hint="Tokens per calendar month (UTC). Leave empty for the platform default."
        />
        <TextField label="Reason (shown in the organization's audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {save.error ? <Alert tone="error">{errorMessage(save.error)}</Alert> : null}
      </div>
    </Dialog>
  );
}

function UsageDialog({ org, onClose }: { org: AdminOrg; onClose: () => void }) {
  const usage = useQuery({ queryKey: ['admin-usage', org.id], queryFn: () => get<UsageReport>(`/admin/orgs/${org.id}/usage?months=12`) });
  return (
    <Dialog open wide onClose={onClose} title={`Usage of ${org.name}`} footer={<Button onClick={onClose}>Close</Button>}>
      {usage.error ? <Alert tone="error">{errorMessage(usage.error)}</Alert> : null}
      {usage.data ? <UsageReportView report={usage.data} /> : <p className="text-sm text-muted">Loading…</p>}
    </Dialog>
  );
}
