import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  UpdateMemberRequest,
  UpdateOrgRequest,
  type Invitation,
  type InvitationPreview,
  type Member,
  type Org,
} from '@survey/contracts';
import {
  invitations,
  memberships,
  newId,
  newToken,
  organizations,
  sessions,
  sha256,
  surveyCollaborators,
  teamMembers,
  users,
  withGlobal,
  withTenant,
  type Tx,
} from '@survey/db';
import type { Deps } from '../deps';
import { audit } from '../audit';
import { requireOrg } from '../auth/context';
import { createSession, loadSession, sessionCookieName } from '../auth/session';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { iso } from '../lib/misc';
import { parse } from '../lib/validate';
import { hashPassword, isUniqueViolation, startSession, toMe } from './auth';

const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

interface InvitationRow {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: Member['role'];
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

async function findInvitation(tx: Tx, token: string): Promise<InvitationRow> {
  const { rows } = await tx.client.query<InvitationRow>('select * from invitation_by_token($1)', [
    sha256(token),
  ]);
  const inv = rows[0];
  if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at.getTime() < Date.now())
    throw notFound('Invitation');
  return inv;
}

async function countAdmins(tx: Tx, orgId: string): Promise<number> {
  const [row] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'org_admin')));
  return row?.n ?? 0;
}

export function registerOrgRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, jobs } = deps;

  const toOrg = (org: typeof organizations.$inferSelect): Org => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    approvalRequired: org.settings.approvalRequired === true,
    approverIds: Array.isArray(org.settings.approverIds) ? (org.settings.approverIds as string[]) : [],
  });

  app.get('/api/v1/org', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const [org] = await tx.db.select().from(organizations).where(eq(organizations.id, auth.orgId));
      if (!org) throw notFound('Organization');
      return toOrg(org);
    });
  });

  app.patch('/api/v1/org', async (req) => {
    const auth = requireOrg(req, 'org.update');
    const body = parse(UpdateOrgRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const [current] = await tx.db.select().from(organizations).where(eq(organizations.id, auth.orgId));
      if (!current) throw notFound('Organization');
      const settings = { ...current.settings };
      if (body.approvalRequired !== undefined) settings.approvalRequired = body.approvalRequired;
      if (body.approverIds !== undefined) {
        // Approvers must be admins or creators here (analysts can't edit, so they can't review either).
        const ids = [...new Set(body.approverIds)];
        const found = ids.length
          ? await tx.db
              .select({ userId: memberships.userId, role: memberships.role })
              .from(memberships)
              .where(and(eq(memberships.orgId, auth.orgId), inArray(memberships.userId, ids)))
          : [];
        if (found.length !== ids.length || found.some((m) => m.role === 'analyst'))
          throw unprocessable('invalid_approvers', 'Approvers must be admins or creators in this organization.');
        settings.approverIds = ids;
      }
      const [org] = await tx.db
        .update(organizations)
        .set({ ...(body.name !== undefined ? { name: body.name } : {}), settings, updatedAt: new Date() })
        .where(eq(organizations.id, auth.orgId))
        .returning();
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'org.updated',
        metadata: { fields: Object.keys(body) },
        ip: req.ip,
      });
      return toOrg(org!);
    });
  });

  app.get('/api/v1/org/members', async (req) => {
    const auth = requireOrg(req);
    return withTenant(pool, auth.orgId, async (tx) => {
      const rows = await tx.db
        .select({ m: memberships, u: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, auth.orgId))
        .orderBy(asc(users.name));
      const data: Member[] = rows.map(({ m, u }) => ({
        userId: u.id,
        name: u.name,
        email: u.email,
        role: m.role,
        joinedAt: m.createdAt.toISOString(),
        lastLoginAt: iso(u.lastLoginAt),
      }));
      return { data, nextCursor: null };
    });
  });

  app.patch<{ Params: { userId: string } }>('/api/v1/org/members/:userId', async (req) => {
    const auth = requireOrg(req, 'org.members.manage');
    const { role } = parse(UpdateMemberRequest, req.body);
    return withTenant(pool, auth.orgId, async (tx) => {
      const [current] = await tx.db
        .select()
        .from(memberships)
        .where(and(eq(memberships.orgId, auth.orgId), eq(memberships.userId, req.params.userId)));
      if (!current) throw notFound('Member');
      if (current.role === 'org_admin' && role !== 'org_admin' && (await countAdmins(tx, auth.orgId)) <= 1)
        throw conflict('last_admin', 'An organization needs at least one admin.');
      await tx.db
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.orgId, auth.orgId), eq(memberships.userId, req.params.userId)));
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'member.role_changed',
        entityType: 'user',
        entityId: req.params.userId,
        metadata: { from: current.role, to: role },
        ip: req.ip,
      });
      return { userId: req.params.userId, role };
    });
  });

  app.delete<{ Params: { userId: string }; Querystring: { transferTo?: string } }>(
    '/api/v1/org/members/:userId',
    async (req, reply) => {
      const auth = requireOrg(req, 'org.members.manage');
      const removed = req.params.userId;
      const transferTo = req.query.transferTo ?? auth.userId;
      await withTenant(pool, auth.orgId, async (tx) => {
        const rows = await tx.db
          .select()
          .from(memberships)
          .where(and(eq(memberships.orgId, auth.orgId), inArray(memberships.userId, [removed, transferTo])));
        const target = rows.find((r) => r.userId === removed);
        const heir = rows.find((r) => r.userId === transferTo);
        if (!target) throw notFound('Member');
        if (transferTo === removed)
          throw unprocessable(
            'invalid_transfer',
            "Surveys can't be transferred to the member being removed.",
          );
        if (!heir || heir.role === 'analyst')
          throw unprocessable('invalid_transfer', 'Surveys must be transferred to an admin or creator.');
        if (target.role === 'org_admin' && (await countAdmins(tx, auth.orgId)) <= 1)
          throw conflict('last_admin', 'An organization needs at least one admin.');

        // Hand over ownership, then drop every survey share the removed member had.
        const owned = await tx.db
          .select({ surveyId: surveyCollaborators.surveyId })
          .from(surveyCollaborators)
          .where(and(eq(surveyCollaborators.userId, removed), eq(surveyCollaborators.role, 'owner')));
        await tx.db.delete(surveyCollaborators).where(eq(surveyCollaborators.userId, removed));
        await tx.db.delete(teamMembers).where(eq(teamMembers.userId, removed));
        for (const { surveyId } of owned) {
          await tx.db
            .insert(surveyCollaborators)
            .values({ orgId: auth.orgId, surveyId, userId: transferTo, role: 'owner', addedBy: auth.userId })
            .onConflictDoUpdate({
              target: [surveyCollaborators.surveyId, surveyCollaborators.userId],
              set: { role: 'owner' },
            });
        }
        await tx.db
          .delete(memberships)
          .where(and(eq(memberships.orgId, auth.orgId), eq(memberships.userId, removed)));
        await tx.db
          .update(sessions)
          .set({ activeOrgId: null })
          .where(and(eq(sessions.userId, removed), eq(sessions.activeOrgId, auth.orgId)));
        await audit(tx, {
          orgId: auth.orgId,
          actorId: auth.userId,
          action: 'member.removed',
          entityType: 'user',
          entityId: removed,
          metadata: { surveysTransferred: owned.length, transferTo },
          ip: req.ip,
        });
      });
      return reply.code(204).send();
    },
  );

  // ── Invitations ───────────────────────────────────────────────────
  const toInvitation = (row: typeof invitations.$inferSelect, invitedBy: string): Invitation => ({
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });

  app.get('/api/v1/org/invitations', async (req) => {
    const auth = requireOrg(req, 'org.members.manage');
    return withTenant(pool, auth.orgId, async (tx) => {
      const rows = await tx.db
        .select({ i: invitations, by: users.name })
        .from(invitations)
        .innerJoin(users, eq(users.id, invitations.invitedBy))
        .where(
          and(
            eq(invitations.orgId, auth.orgId),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(invitations.createdAt));
      return { data: rows.map(({ i, by }) => toInvitation(i, by)), nextCursor: null };
    });
  });

  app.post('/api/v1/org/invitations', async (req, reply) => {
    const auth = requireOrg(req, 'org.members.manage');
    const { email, role } = parse(CreateInvitationRequest, req.body);
    const invitation = await withTenant(pool, auth.orgId, async (tx) => {
      const [member] = await tx.db
        .select({ id: users.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.orgId, auth.orgId), eq(users.email, email)));
      if (member) throw conflict('already_member', 'That person is already a member.');
      // A new invitation replaces any pending one for the same email.
      await tx.db
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.orgId, auth.orgId),
            eq(invitations.email, email),
            isNull(invitations.acceptedAt),
          ),
        );
      const [row] = await tx.db
        .insert(invitations)
        .values({
          id: newId(),
          orgId: auth.orgId,
          email,
          role,
          // Placeholder: the email job generates the real token, so it never sits in the job queue.
          tokenHash: sha256(newToken()),
          invitedBy: auth.userId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        })
        .returning();
      await jobs.enqueue(tx, 'email.send', { type: 'invitation', orgId: auth.orgId, invitationId: row!.id });
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'member.invited',
        entityType: 'invitation',
        entityId: row!.id,
        metadata: { role },
        ip: req.ip,
      });
      return toInvitation(row!, auth.name);
    });
    reply.code(201);
    return invitation;
  });

  app.delete<{ Params: { id: string } }>('/api/v1/org/invitations/:id', async (req, reply) => {
    const auth = requireOrg(req, 'org.members.manage');
    await withTenant(pool, auth.orgId, async (tx) => {
      const [row] = await tx.db
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.id, req.params.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (!row) throw notFound('Invitation');
      await audit(tx, {
        orgId: auth.orgId,
        actorId: auth.userId,
        action: 'member.invitation_revoked',
        entityType: 'invitation',
        entityId: row.id,
        ip: req.ip,
      });
    });
    return reply.code(204).send();
  });

  // Public: preview an invitation from its emailed link.
  app.get<{ Params: { token: string } }>(
    '/api/v1/invitations/:token',
    async (req): Promise<InvitationPreview> => {
      return withGlobal(pool, async (tx) => {
        const inv = await findInvitation(tx, req.params.token);
        const [user] = await tx.db.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
        return { orgName: inv.org_name, email: inv.email, role: inv.role, userExists: Boolean(user) };
      });
    },
  );

  app.post<{ Params: { token: string } }>('/api/v1/invitations/:token/accept', async (req, reply) => {
    const body = parse(AcceptInvitationRequest, req.body);
    const inv = await withGlobal(pool, (tx) => findInvitation(tx, req.params.token));
    const [existing] = await withGlobal(pool, (tx) =>
      tx.db.select().from(users).where(eq(users.email, inv.email)),
    );

    let userId: string;
    let createdUser = false;
    let passwordHash: string | null = null;
    if (existing) {
      // Existing account: must be logged in as that account (the link alone isn't enough to join).
      if (!req.auth || req.auth.userId !== existing.id)
        throw forbidden(`Log in as ${inv.email} to accept this invitation.`, 'login_required');
      userId = existing.id;
    } else {
      if (!body.name || !body.password)
        throw unprocessable('validation_failed', 'Enter your name and a password.', [
          ...(body.name ? [] : [{ path: 'name', code: 'required', message: 'Enter your name.' }]),
          ...(body.password ? [] : [{ path: 'password', code: 'required', message: 'Choose a password.' }]),
        ]);
      userId = newId();
      createdUser = true;
      passwordHash = await hashPassword(body.password);
    }

    let token: string | null = null;
    try {
      token = await withTenant(pool, inv.org_id, async (tx) => {
        if (createdUser) {
          // They proved control of the address by opening the emailed link.
          await tx.db.insert(users).values({
            id: userId,
            email: inv.email,
            name: body.name!,
            passwordHash,
            emailVerifiedAt: new Date(),
          });
        }
        const [claimed] = await tx.db
          .update(invitations)
          .set({ acceptedAt: new Date() })
          .where(
            and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)),
          )
          .returning({ id: invitations.id });
        if (!claimed) throw notFound('Invitation');
        await tx.db
          .insert(memberships)
          .values({ orgId: inv.org_id, userId, role: inv.role })
          .onConflictDoNothing();
        await audit(tx, {
          orgId: inv.org_id,
          actorId: userId,
          action: 'member.joined',
          entityType: 'user',
          entityId: userId,
          metadata: { role: inv.role },
          ip: req.ip,
        });
        if (createdUser)
          return createSession(tx, {
            userId,
            orgId: inv.org_id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
        await tx.db
          .update(sessions)
          .set({ activeOrgId: inv.org_id })
          .where(eq(sessions.idHash, req.auth!.sessionHash));
        return null;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw conflict('email_taken', 'An account with this email already exists. Log in first.');
      throw error;
    }

    if (token) return startSession(deps, reply, token);
    // Existing user: their current session now points at the org they joined.
    const auth = await loadSession(pool, deps.config, req.cookies[sessionCookieName(deps.config)]!);
    return toMe(auth!);
  });
}
