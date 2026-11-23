/**
 * Permission matrix (docs/01-architecture.md §1.5). Effective survey role = the role the survey
 * was shared with, capped by the org role; org admins are implicitly owners of every survey.
 */
import type { OrgRole, SurveyRole } from '@survey/contracts';

export type OrgCapability = 'org.update' | 'org.members.manage' | 'surveys.create';

export type SurveyCapability =
  | 'survey.view'
  | 'survey.edit'
  | 'survey.publish'
  | 'survey.distribute'
  | 'survey.close'
  | 'survey.share'
  | 'survey.transfer'
  | 'survey.delete'
  | 'responses.view'
  | 'responses.export'
  | 'responses.delete';

export const ORG_CAPABILITIES: Record<OrgRole, readonly OrgCapability[]> = {
  org_admin: ['org.update', 'org.members.manage', 'surveys.create'],
  creator: ['surveys.create'],
  analyst: [],
};

export const SURVEY_CAPABILITIES: Record<SurveyRole, readonly SurveyCapability[]> = {
  owner: [
    'survey.view',
    'survey.edit',
    'survey.publish',
    'survey.distribute',
    'survey.close',
    'survey.share',
    'survey.transfer',
    'survey.delete',
    'responses.view',
    'responses.export',
    'responses.delete',
  ],
  editor: [
    'survey.view',
    'survey.edit',
    'survey.publish',
    'survey.distribute',
    'survey.close',
    'responses.view',
    'responses.export',
    'responses.delete',
  ],
  viewer: ['survey.view', 'responses.view', 'responses.export'],
};

const RANK: Record<SurveyRole, number> = { viewer: 1, editor: 2, owner: 3 };

/** The highest survey role a member with this org role can hold. */
export function maxSurveyRole(orgRole: OrgRole): SurveyRole {
  return orgRole === 'analyst' ? 'viewer' : 'owner';
}

export function effectiveSurveyRole(orgRole: OrgRole, sharedRole: SurveyRole | null): SurveyRole | null {
  if (orgRole === 'org_admin') return 'owner';
  if (!sharedRole) return null;
  const cap = maxSurveyRole(orgRole);
  return RANK[sharedRole] <= RANK[cap] ? sharedRole : cap;
}

export const orgCan = (role: OrgRole, capability: OrgCapability) =>
  ORG_CAPABILITIES[role].includes(capability);
export const surveyCan = (role: SurveyRole, capability: SurveyCapability) =>
  SURVEY_CAPABILITIES[role].includes(capability);
