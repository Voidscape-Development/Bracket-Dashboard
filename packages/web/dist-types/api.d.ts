/**
 * REST client.
 *
 * Thin wrapper that unwraps errors into something a person can read — these
 * messages end up in front of a tournament organiser mid-event, so a raw status
 * code is not good enough.
 */
import type { BracketType, ConflictResolution, Entrant, EventStatus, Id, OutboxEntry, OutputView, Phase, PhaseGroup, ReportCommand, SessionUser, Standing, Theme, Tournament, TournamentEvent, TournamentSet, User, ViewKind } from '@bracket/shared';
export declare class ApiError extends Error {
    readonly status: number;
    readonly detail?: unknown | undefined;
    constructor(message: string, status: number, detail?: unknown | undefined);
}
export declare const api: {
    me: () => Promise<{
        user: SessionUser | null;
    }>;
    login: (username: string, password: string) => Promise<{
        user: SessionUser;
    }>;
    logout: () => Promise<{
        ok: true;
    }>;
    tournaments: () => Promise<{
        tournaments: Tournament[];
        statuses: EventStatus[];
    }>;
    importTournament: (url: string) => Promise<{
        tournament: Tournament;
        events: number;
    }>;
    deleteTournament: (id: Id) => Promise<{
        ok: true;
    }>;
    event: (eventId: Id) => Promise<{
        event: TournamentEvent;
        sets: TournamentSet[];
        entrants: Entrant[];
        standings: Standing[];
        status: EventStatus | null;
    }>;
    setEventTracked: (eventId: Id, tracked: boolean) => Promise<{
        event: TournamentEvent;
    }>;
    sync: (eventId?: Id, full?: boolean) => Promise<{
        ok: true;
    }>;
    syncStatus: () => Promise<any>;
    stations: (eventId: Id) => Promise<{
        stations: {
            id: Id;
            number: number | null;
        }[];
        streams: {
            id: Id;
            name: string;
        }[];
    }>;
    report: (command: Extract<ReportCommand, {
        kind: "reportSet";
    }>) => Promise<{
        entry: OutboxEntry;
        set: TournamentSet | null;
        online: boolean;
    }>;
    markInProgress: (setId: Id, eventId: Id) => Promise<any>;
    resetSet: (setId: Id, eventId: Id, resetDependents: boolean) => Promise<any>;
    assignStation: (setId: Id, eventId: Id, stationId: Id | null, stationNumber: number | null) => Promise<any>;
    assignStream: (setId: Id, eventId: Id, streamId: Id | null, streamName: string | null) => Promise<any>;
    updateSeeding: (phaseId: Id, eventId: Id, seedMapping: {
        seedId: Id;
        seedNum: number;
    }[]) => Promise<any>;
    queue: () => Promise<{
        entries: OutboxEntry[];
        counts: {
            queued: number;
            conflicts: number;
        };
        online: boolean;
    }>;
    resolveConflict: (id: string, resolution: ConflictResolution) => Promise<{
        entry: OutboxEntry;
    }>;
    drainQueue: () => Promise<any>;
    deleteQueueEntry: (id: string) => Promise<{
        ok: true;
    }>;
    views: () => Promise<{
        views: OutputView[];
        viewers: Record<string, number>;
    }>;
    createView: (input: {
        name: string;
        kind: ViewKind;
        eventId: Id | null;
        phaseId?: Id | null;
        phaseGroupId: Id | null;
        followActivePhase?: boolean;
        themeId?: string;
        width?: number;
        height?: number;
    }) => Promise<{
        view: OutputView;
        url: string;
    }>;
    updateView: (id: string, patch: Partial<OutputView>) => Promise<{
        view: OutputView;
        url: string;
    }>;
    deleteView: (id: string) => Promise<{
        ok: true;
    }>;
    duplicateView: (id: string) => Promise<{
        view: OutputView;
        url: string;
    }>;
    rotateViewSecret: (id: string) => Promise<{
        view: OutputView;
        url: string;
    }>;
    setCamera: (id: string, camera: Partial<OutputView["camera"]>) => Promise<{
        view: OutputView;
    }>;
    setAutoFollow: (id: string, autoFollow: Partial<OutputView["autoFollow"]>) => Promise<{
        view: OutputView;
    }>;
    themes: () => Promise<{
        themes: Theme[];
    }>;
    createTheme: (theme: Partial<Theme> & {
        name: string;
    }) => Promise<{
        theme: Theme;
    }>;
    updateTheme: (id: string, patch: Partial<Theme>) => Promise<{
        theme: Theme;
    }>;
    duplicateTheme: (id: string) => Promise<{
        theme: Theme;
    }>;
    deleteTheme: (id: string) => Promise<{
        ok: true;
    }>;
    users: () => Promise<{
        users: User[];
    }>;
    createUser: (input: {
        username: string;
        password: string;
        role: string;
        eventScope?: Id[];
    }) => Promise<{
        user: User;
    }>;
    updateUser: (id: string, patch: Record<string, unknown>) => Promise<{
        user: User;
    }>;
    deleteUser: (id: string) => Promise<{
        ok: true;
    }>;
    settings: () => Promise<any>;
    updateSettings: (patch: {
        transport?: string;
        token?: string | null;
    }) => Promise<any>;
    overlay: (id: string, secret: string) => Promise<{
        view: OutputView;
        theme: Theme;
        event: TournamentEvent | null;
        phase: Phase | null;
        phaseGroup: PhaseGroup | null;
        bracketType: BracketType;
        sets: TournamentSet[];
        entrants: Entrant[];
        standings: Standing[];
    }>;
};
//# sourceMappingURL=api.d.ts.map