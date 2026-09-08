/**
 * Local users, roles and scopes.
 *
 * Authentication is local to this install: the app holds one start.gg credential
 * for writes, and these roles decide who is allowed to trigger those writes and
 * for which events. Overlay URLs are deliberately outside this system — they
 * authenticate with a per-view secret so a TV or an OBS browser source can
 * display without anyone logging in.
 */

import type { Id } from './domain.js';

export const ROLES = ['admin', 'organizer', 'scorekeeper', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'tournament:import',
  'tournament:sync',
  'set:report',
  'set:markInProgress',
  'set:assignStation',
  'set:assignStream',
  'set:reset',
  'set:dq',
  'seeding:update',
  'view:manage',
  'view:direct',
  'theme:manage',
  'queue:resolve',
  'user:manage',
  'settings:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  organizer: [
    'tournament:import',
    'tournament:sync',
    'set:report',
    'set:markInProgress',
    'set:assignStation',
    'set:assignStream',
    'set:reset',
    'set:dq',
    'seeding:update',
    'view:manage',
    'view:direct',
    'theme:manage',
    'queue:resolve',
  ],
  scorekeeper: [
    'set:report',
    'set:markInProgress',
    'set:assignStation',
    'tournament:sync',
  ],
  viewer: [],
};

export interface User {
  id: string;
  username: string;
  role: Role;
  /**
   * Event ids this user may act on. Empty means every event — organizers and
   * admins are normally unscoped, scorekeepers usually are not.
   */
  eventScope: Id[];
  createdAt: number;
  lastSeenAt: number | null;
  disabled: boolean;
}

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  eventScope: Id[];
  permissions: Permission[];
}

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(user: SessionUser | null, permission: Permission): boolean {
  if (!user) return false;
  return user.permissions.includes(permission);
}

/** Scope check: an empty scope means "all events". */
export function canActOnEvent(user: SessionUser | null, eventId: Id | null): boolean {
  if (!user) return false;
  if (user.eventScope.length === 0) return true;
  if (!eventId) return false;
  return user.eventScope.includes(eventId);
}

export function authorize(
  user: SessionUser | null,
  permission: Permission,
  eventId: Id | null = null,
): boolean {
  return hasPermission(user, permission) && canActOnEvent(user, eventId);
}
