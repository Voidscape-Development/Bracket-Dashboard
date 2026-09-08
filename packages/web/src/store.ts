/**
 * Client state and the live socket.
 *
 * One socket serves the whole app. The dashboard subscribes for data changes;
 * overlays subscribe to a single view. Sets are held in a map keyed by id and
 * patched in place from `sets:changed` messages, so a bracket with hundreds of
 * matches re-renders only what moved.
 */

import type {
  CameraState,
  ConnectionStatus,
  Entrant,
  EventStatus,
  Id,
  OutboxEntry,
  OutputView,
  ServerMessage,
  SessionUser,
  Standing,
  Theme,
  Tournament,
  TournamentEvent,
  TournamentSet,
} from '@bracket/shared';
import { create } from 'zustand';

export interface AppState {
  user: SessionUser | null;
  tournaments: Tournament[];
  statuses: Record<Id, EventStatus>;
  setsByEvent: Record<Id, Record<Id, TournamentSet>>;
  entrantsByEvent: Record<Id, Entrant[]>;
  standingsByEvent: Record<Id, Standing[]>;
  views: OutputView[];
  viewers: Record<string, number>;
  themes: Theme[];
  queue: OutboxEntry[];
  queueCounts: { queued: number; conflicts: number };
  status: ConnectionStatus;
  socketConnected: boolean;

  setUser(user: SessionUser | null): void;
  setTournaments(tournaments: Tournament[], statuses: EventStatus[]): void;
  loadEvent(payload: {
    event: TournamentEvent;
    sets: TournamentSet[];
    entrants: Entrant[];
    standings: Standing[];
  }): void;
  applySets(eventId: Id, upserted: TournamentSet[], removedIds: Id[]): void;
  setViews(views: OutputView[], viewers: Record<string, number>): void;
  upsertView(view: OutputView): void;
  setThemes(themes: Theme[]): void;
  upsertTheme(theme: Theme): void;
  setQueue(entries: OutboxEntry[], counts: { queued: number; conflicts: number }): void;
  patchStatus(status: Partial<ConnectionStatus>): void;
  setSocketConnected(connected: boolean): void;
  eventSets(eventId: Id): TournamentSet[];
}

const EMPTY_STATUS: ConnectionStatus = {
  online: true,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  queuedCommands: 0,
  conflictCount: 0,
  requestsLastMinute: 0,
};

export const useAppStore = create<AppState>((set, get) => ({
  user: null,
  tournaments: [],
  statuses: {},
  setsByEvent: {},
  entrantsByEvent: {},
  standingsByEvent: {},
  views: [],
  viewers: {},
  themes: [],
  queue: [],
  queueCounts: { queued: 0, conflicts: 0 },
  status: EMPTY_STATUS,
  socketConnected: false,

  setUser: (user) => set({ user }),

  setTournaments: (tournaments, statuses) =>
    set({
      tournaments,
      statuses: Object.fromEntries(statuses.map((s) => [s.eventId, s])),
    }),

  loadEvent: ({ event, sets, entrants, standings }) =>
    set((state) => ({
      setsByEvent: {
        ...state.setsByEvent,
        [event.id]: Object.fromEntries(sets.map((s) => [s.id, s])),
      },
      entrantsByEvent: { ...state.entrantsByEvent, [event.id]: entrants },
      standingsByEvent: { ...state.standingsByEvent, [event.id]: standings },
    })),

  applySets: (eventId, upserted, removedIds) =>
    set((state) => {
      const current = state.setsByEvent[eventId];
      // Ignore patches for events we have never loaded; the page that needs them
      // will fetch a full snapshot when it mounts.
      if (!current && upserted.length === 0) return state;
      const next = { ...(current ?? {}) };
      for (const item of upserted) next[item.id] = item;
      for (const id of removedIds) delete next[id];
      return { setsByEvent: { ...state.setsByEvent, [eventId]: next } };
    }),

  setViews: (views, viewers) => set({ views, viewers }),

  upsertView: (view) =>
    set((state) => {
      const index = state.views.findIndex((v) => v.id === view.id);
      const views = state.views.slice();
      if (index >= 0) views[index] = view;
      else views.push(view);
      return { views };
    }),

  setThemes: (themes) => set({ themes }),

  upsertTheme: (theme) =>
    set((state) => {
      const index = state.themes.findIndex((t) => t.id === theme.id);
      const themes = state.themes.slice();
      if (index >= 0) themes[index] = theme;
      else themes.push(theme);
      return { themes };
    }),

  setQueue: (queue, queueCounts) => set({ queue, queueCounts }),

  patchStatus: (status) => set((state) => ({ status: { ...state.status, ...status } })),

  setSocketConnected: (socketConnected) => set({ socketConnected }),

  eventSets: (eventId) => Object.values(get().setsByEvent[eventId] ?? {}),
}));

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

type MessageHandler = (message: ServerMessage) => void;

/**
 * Auto-reconnecting socket. An overlay left running for a weekend has to
 * survive the backend restarting, so reconnection is unconditional with a
 * capped backoff, and every reconnect re-sends the subscription.
 */
export class LiveSocket {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private closed = false;
  private readonly handlers = new Set<MessageHandler>();
  private subscription: object | null = null;
  private pingTimer: number | null = null;

  constructor(private readonly url = defaultSocketUrl()) {}

  connect(): void {
    if (this.socket || this.closed) return;

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      useAppStore.getState().setSocketConnected(true);
      if (this.subscription) socket.send(JSON.stringify(this.subscription));
      this.pingTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        }
      }, 25000);
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.dispatch(message);
      for (const handler of this.handlers) handler(message);
    };

    socket.onclose = () => {
      this.cleanupSocket();
      useAppStore.getState().setSocketConnected(false);
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private cleanupSocket(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Applies messages that belong in global state regardless of the page. */
  private dispatch(message: ServerMessage): void {
    const store = useAppStore.getState();
    switch (message.type) {
      case 'sets:changed':
        store.applySets(message.eventId, message.upserted, message.removedIds);
        break;
      case 'standings:changed':
        useAppStore.setState((state) => ({
          standingsByEvent: {
            ...state.standingsByEvent,
            [message.eventId]: message.standings,
          },
        }));
        break;
      case 'event:status':
        useAppStore.setState({
          statuses: Object.fromEntries(message.statuses.map((s) => [s.eventId, s])),
        });
        break;
      case 'status':
        store.patchStatus(message.status);
        break;
      case 'outbox:changed':
        store.setQueue(message.entries, {
          queued: message.queued,
          conflicts: message.conflicts,
        });
        break;
      case 'view:updated':
        store.upsertView(message.view);
        store.upsertTheme(message.theme);
        break;
      case 'theme:updated':
        store.upsertTheme(message.theme);
        break;
      default:
        break;
    }
  }

  subscribeDashboard(eventIds?: Id[]): void {
    this.subscription = { type: 'subscribe:dashboard', eventIds };
    this.send(this.subscription);
  }

  subscribeView(viewId: string, secret: string): void {
    this.subscription = { type: 'subscribe:view', viewId, secret };
    this.send(this.subscription);
  }

  setCamera(viewId: string, camera: Partial<CameraState>, manualInput = false): void {
    this.send({ type: 'camera:set', viewId, camera, manualInput });
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.cleanupSocket();
  }
}

function defaultSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/** One shared socket for the page. */
export const liveSocket = new LiveSocket();
