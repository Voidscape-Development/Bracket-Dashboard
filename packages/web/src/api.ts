/**
 * REST client.
 *
 * Thin wrapper that unwraps errors into something a person can read — these
 * messages end up in front of a tournament organiser mid-event, so a raw status
 * code is not good enough.
 */

import type {
  ConflictResolution,
  Entrant,
  EventStatus,
  Id,
  OutboxEntry,
  OutputView,
  ReportCommand,
  SessionUser,
  Standing,
  Theme,
  Tournament,
  TournamentEvent,
  TournamentSet,
  User,
  ViewKind,
} from '@bracket/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: 'same-origin',
  });

  let payload: any = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!response.ok) {
    throw new ApiError(
      payload?.error ?? `Request failed (${response.status})`,
      response.status,
      payload?.detail,
    );
  }
  return payload as T;
}

export const api = {
  // ---- auth ----
  me: () => request<{ user: SessionUser | null }>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      json: { username, password },
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  // ---- tournaments ----
  tournaments: () =>
    request<{ tournaments: Tournament[]; statuses: EventStatus[] }>('/api/tournaments'),
  importTournament: (url: string) =>
    request<{ tournament: Tournament; events: number }>('/api/tournaments/import', {
      method: 'POST',
      json: { url },
    }),
  deleteTournament: (id: Id) =>
    request<{ ok: true }>(`/api/tournaments/${id}`, { method: 'DELETE' }),
  event: (eventId: Id) =>
    request<{
      event: TournamentEvent;
      sets: TournamentSet[];
      entrants: Entrant[];
      standings: Standing[];
      status: EventStatus | null;
    }>(`/api/events/${eventId}`),
  setEventTracked: (eventId: Id, tracked: boolean) =>
    request<{ event: TournamentEvent }>(`/api/events/${eventId}`, {
      method: 'PATCH',
      json: { tracked },
    }),
  sync: (eventId?: Id, full = false) =>
    request<{ ok: true }>('/api/sync', { method: 'POST', json: { eventId, full } }),
  syncStatus: () => request<any>('/api/sync/status'),
  stations: (eventId: Id) =>
    request<{
      stations: { id: Id; number: number | null }[];
      streams: { id: Id; name: string }[];
    }>(`/api/events/${eventId}/stations`),

  // ---- reporting ----
  report: (command: Extract<ReportCommand, { kind: 'reportSet' }>) =>
    request<{ entry: OutboxEntry; set: TournamentSet | null; online: boolean }>(
      '/api/report/set',
      { method: 'POST', json: stripKind(command) },
    ),
  markInProgress: (setId: Id, eventId: Id) =>
    request<any>('/api/report/in-progress', { method: 'POST', json: { setId, eventId } }),
  resetSet: (setId: Id, eventId: Id, resetDependents: boolean) =>
    request<any>('/api/report/reset', {
      method: 'POST',
      json: { setId, eventId, resetDependents },
    }),
  assignStation: (
    setId: Id,
    eventId: Id,
    stationId: Id | null,
    stationNumber: number | null,
  ) =>
    request<any>('/api/report/station', {
      method: 'POST',
      json: { setId, eventId, stationId, stationNumber },
    }),
  assignStream: (setId: Id, eventId: Id, streamId: Id | null, streamName: string | null) =>
    request<any>('/api/report/stream', {
      method: 'POST',
      json: { setId, eventId, streamId, streamName },
    }),
  updateSeeding: (
    phaseId: Id,
    eventId: Id,
    seedMapping: { seedId: Id; seedNum: number }[],
  ) =>
    request<any>('/api/report/seeding', {
      method: 'POST',
      json: { phaseId, eventId, seedMapping },
    }),

  // ---- queue ----
  queue: () =>
    request<{
      entries: OutboxEntry[];
      counts: { queued: number; conflicts: number };
      online: boolean;
    }>('/api/queue'),
  resolveConflict: (id: string, resolution: ConflictResolution) =>
    request<{ entry: OutboxEntry }>(`/api/queue/${id}/resolve`, {
      method: 'POST',
      json: { resolution },
    }),
  drainQueue: () => request<any>('/api/queue/drain', { method: 'POST' }),
  deleteQueueEntry: (id: string) =>
    request<{ ok: true }>(`/api/queue/${id}`, { method: 'DELETE' }),

  // ---- views ----
  views: () =>
    request<{ views: OutputView[]; viewers: Record<string, number> }>('/api/views'),
  createView: (input: {
    name: string;
    kind: ViewKind;
    eventId: Id | null;
    phaseGroupId: Id | null;
    themeId?: string;
    width?: number;
    height?: number;
  }) => request<{ view: OutputView; url: string }>('/api/views', { method: 'POST', json: input }),
  updateView: (id: string, patch: Partial<OutputView>) =>
    request<{ view: OutputView; url: string }>(`/api/views/${id}`, {
      method: 'PATCH',
      json: patch,
    }),
  deleteView: (id: string) => request<{ ok: true }>(`/api/views/${id}`, { method: 'DELETE' }),
  duplicateView: (id: string) =>
    request<{ view: OutputView; url: string }>(`/api/views/${id}/duplicate`, { method: 'POST' }),
  rotateViewSecret: (id: string) =>
    request<{ view: OutputView; url: string }>(`/api/views/${id}/rotate-secret`, {
      method: 'POST',
    }),
  setCamera: (id: string, camera: Partial<OutputView['camera']>) =>
    request<{ view: OutputView }>(`/api/views/${id}/camera`, { method: 'POST', json: camera }),
  setAutoFollow: (id: string, autoFollow: Partial<OutputView['autoFollow']>) =>
    request<{ view: OutputView }>(`/api/views/${id}/autofollow`, {
      method: 'POST',
      json: autoFollow,
    }),

  // ---- themes ----
  themes: () => request<{ themes: Theme[] }>('/api/themes'),
  createTheme: (theme: Partial<Theme> & { name: string }) =>
    request<{ theme: Theme }>('/api/themes', { method: 'POST', json: theme }),
  updateTheme: (id: string, patch: Partial<Theme>) =>
    request<{ theme: Theme }>(`/api/themes/${id}`, { method: 'PATCH', json: patch }),
  duplicateTheme: (id: string) =>
    request<{ theme: Theme }>(`/api/themes/${id}/duplicate`, { method: 'POST' }),
  deleteTheme: (id: string) =>
    request<{ ok: true }>(`/api/themes/${id}`, { method: 'DELETE' }),

  // ---- admin ----
  users: () => request<{ users: User[] }>('/api/users'),
  createUser: (input: {
    username: string;
    password: string;
    role: string;
    eventScope?: Id[];
  }) => request<{ user: User }>('/api/users', { method: 'POST', json: input }),
  updateUser: (id: string, patch: Record<string, unknown>) =>
    request<{ user: User }>(`/api/users/${id}`, { method: 'PATCH', json: patch }),
  deleteUser: (id: string) => request<{ ok: true }>(`/api/users/${id}`, { method: 'DELETE' }),
  settings: () => request<any>('/api/settings'),
  updateSettings: (patch: { transport?: string; token?: string | null }) =>
    request<any>('/api/settings', { method: 'PATCH', json: patch }),

  // ---- overlay bootstrap (secret-gated, no session) ----
  overlay: (id: string, secret: string) =>
    request<{
      view: OutputView;
      theme: Theme;
      event: TournamentEvent | null;
      sets: TournamentSet[];
      entrants: Entrant[];
      standings: Standing[];
    }>(`/api/overlay/${id}/${secret}`),
};

/** The server infers `kind` from the route, so it is not sent in the body. */
function stripKind<T extends { kind: string }>(command: T): Omit<T, 'kind'> {
  const { kind, ...rest } = command;
  void kind;
  return rest;
}
