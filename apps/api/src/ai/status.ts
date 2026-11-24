import type { AiStatus } from '@survey/contracts';
import type { Tx } from '@survey/db';
import type { Deps } from '../deps';
import { aiTokensThisMonth } from '../lib/usage';

/** `organizations.settings.ai`: the org admin's opt-in, and a cap only a super admin sets. */
export function readAiSettings(settings: Record<string, unknown>): { enabled: boolean; monthlyTokenCap: number | null } {
  const ai = (settings.ai ?? {}) as { enabled?: unknown; monthlyTokenCap?: unknown };
  return {
    enabled: ai.enabled === true,
    monthlyTokenCap: typeof ai.monthlyTokenCap === 'number' ? ai.monthlyTokenCap : null,
  };
}

export async function aiStatus(deps: Deps, tx: Tx, orgId: string, settings: Record<string, unknown>): Promise<AiStatus> {
  const ai = readAiSettings(settings);
  return {
    available: deps.ai !== null,
    enabled: ai.enabled,
    provider: deps.ai?.name ?? null,
    model: deps.ai?.model ?? null,
    monthlyTokenCap: ai.monthlyTokenCap ?? deps.config.ai.defaultMonthlyTokenCap,
    tokensUsedThisMonth: await aiTokensThisMonth(tx, orgId),
  };
}
