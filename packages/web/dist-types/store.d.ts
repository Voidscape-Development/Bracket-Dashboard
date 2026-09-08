/**
 * Client state and the live socket.
 *
 * One socket serves the whole app. The dashboard subscribes for data changes;
 * overlays subscribe to a single view. Sets are held in a map keyed by id and
 * patched in place from `sets:changed` messages, so a bracket with hundreds of
 * matches re-renders only what moved.
 */
import type { CameraState, ConnectionStatus, Entrant, EventStatus, Id, OutboxEntry, OutputView, ServerMessage, SessionUser, Standing, Theme, Tournament, TournamentEvent, TournamentSet } from '@bracket/shared';
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
    queueCounts: {
        queued: number;
        conflicts: number;
    };
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
    setQueue(entries: OutboxEntry[], counts: {
        queued: number;
        conflicts: number;
    }): void;
    patchStatus(status: Partial<ConnectionStatus>): void;
    setSocketConnected(connected: boolean): void;
    eventSets(eventId: Id): TournamentSet[];
}
export declare const useAppStore: import("zustand").UseBoundStore<import("zustand").StoreApi<AppState>>;
type MessageHandler = (message: ServerMessage) => void;
/**
 * Auto-reconnecting socket. An overlay left running for a weekend has to
 * survive the backend restarting, so reconnection is unconditional with a
 * capped backoff, and every reconnect re-sends the subscription.
 */
export declare class LiveSocket {
    private readonly url;
    private socket;
    private reconnectAttempts;
    private reconnectTimer;
    private closed;
    private readonly handlers;
    private subscription;
    private pingTimer;
    constructor(url?: string);
    connect(): void;
    private cleanupSocket;
    private scheduleReconnect;
    /** Applies messages that belong in global state regardless of the page. */
    private dispatch;
    subscribeDashboard(eventIds?: Id[]): void;
    subscribeView(viewId: string, secret: string): void;
    setCamera(viewId: string, camera: Partial<CameraState>, manualInput?: boolean): void;
    onMessage(handler: MessageHandler): () => void;
    private send;
    close(): void;
}
/** One shared socket for the page. */
export declare const liveSocket: LiveSocket;
export {};
//# sourceMappingURL=store.d.ts.map