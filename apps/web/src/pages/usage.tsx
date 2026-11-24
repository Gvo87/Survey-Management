/** Phase 3B: usage metrics per month (org admins, and super admins for any org). */
import { useQuery } from '@tanstack/react-query';
import type { UsageReport } from '@survey/contracts';
import { errorMessage, get } from '../api';
import { Alert, Card, PageHeader } from '../components/ui';
import { formatNumber } from '../lib/format';

const monthLabel = (month: string) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));

const bytes = (n: number) => (n < 1024 * 1024 ? `${formatNumber(Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function UsageReportView({ report }: { report: UsageReport }) {
  const thisMonth = report.months.at(-1)!;
  const tiles = [
    { label: 'Responses this month', value: formatNumber(thisMonth.responses) },
    { label: 'Versions published this month', value: formatNumber(thisMonth.surveysPublished) },
    { label: 'Campaign emails this month', value: formatNumber(thisMonth.emailsSent) },
    { label: 'AI tokens this month', value: `${formatNumber(thisMonth.aiTokens)} of ${formatNumber(report.limits.aiMonthlyTokenCap)}` },
  ];
  return (
    <div className="grid gap-6">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-line bg-white p-4">
            <dt className="text-xs text-muted">{t.label}</dt>
            <dd className="mt-1 text-xl font-semibold">{t.value}</dd>
          </div>
        ))}
      </dl>
      <Card title="By month">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Usage by month</caption>
            <thead>
              <tr className="text-start text-xs text-muted">
                <th scope="col" className="py-2 pe-4 text-start font-medium">Month</th>
                <th scope="col" className="py-2 pe-4 text-end font-medium">Responses</th>
                <th scope="col" className="py-2 pe-4 text-end font-medium">Published</th>
                <th scope="col" className="py-2 pe-4 text-end font-medium">Emails</th>
                <th scope="col" className="py-2 text-end font-medium">AI tokens</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...report.months].reverse().map((m) => (
                <tr key={m.month}>
                  <th scope="row" className="py-2 pe-4 text-start font-normal">{monthLabel(m.month)}</th>
                  <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(m.responses)}</td>
                  <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(m.surveysPublished)}</td>
                  <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(m.emailsSent)}</td>
                  <td className="py-2 text-end tabular-nums">{formatNumber(m.aiTokens)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line font-medium">
                <th scope="row" className="py-2 pe-4 text-start">Total</th>
                <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(report.totals.responses)}</td>
                <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(report.totals.surveysPublished)}</td>
                <td className="py-2 pe-4 text-end tabular-nums">{formatNumber(report.totals.emailsSent)}</td>
                <td className="py-2 text-end tabular-nums">{formatNumber(report.totals.aiTokens)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      <Card title="Right now">
        <p className="text-sm">
          {formatNumber(report.current.members)} members · {formatNumber(report.current.surveys)} surveys · {formatNumber(report.current.responsesStored)}{' '}
          responses stored · {bytes(report.current.storageBytes)} of uploaded files
        </p>
      </Card>
    </div>
  );
}

export function UsagePage() {
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => get<UsageReport>('/org/usage?months=12') });
  return (
    <>
      <PageHeader title="Usage" description="What your organization used each month. Counts don't go down when responses are deleted." />
      {usage.error ? <Alert tone="error">{errorMessage(usage.error)}</Alert> : null}
      {usage.data ? <UsageReportView report={usage.data} /> : null}
    </>
  );
}
