/**
 * Overlay host.
 *
 * This is what an OBS browser source or a venue TV loads. It authenticates with
 * the view's secret, renders from a snapshot immediately (so the first paint is
 * correct rather than empty), then stays live over the socket.
 *
 * Deliberately unopinionated about chrome: no headers, no controls, no
 * background. Whatever the theme draws is all that appears.
 */

import type {
  BracketType,
  Entrant,
  OutputView,
  Phase,
  PhaseGroup,
  Standing,
  Theme,
  TournamentSet,
} from '@bracket/shared';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { api } from '../api.js';
import { ThemeStyle } from '../components/ThemeStyle.js';
import { LiveSocket } from '../store.js';
import { BracketOverlay } from './BracketOverlay.js';
import { OnDeckOverlay } from './OnDeckOverlay.js';
import { ScorecardOverlay } from './ScorecardOverlay.js';
import { StandingsOverlay } from './StandingsOverlay.js';

interface OverlayData {
  view: OutputView;
  theme: Theme;
  /** Phase the server resolved this view to; the client never picks one. */
  phase: Phase | null;
  phaseGroup: PhaseGroup | null;
  bracketType: BracketType;
  sets: TournamentSet[];
  entrants: Entrant[];
  standings: Standing[];
}

export function OverlayPage() {
  const { viewId, secret } = useParams<{ viewId: string; secret: string }>();
  const [params] = useSearchParams();
  const [data, setData] = useState<OverlayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the snapshot over REST first: a browser source that starts before the
  // socket connects should still render the right thing on its first frame.
  useEffect(() => {
    if (!viewId || !secret) return;
    let cancelled = false;
    api
      .overlay(viewId, secret)
      .then((result) => {
        if (cancelled) return;
        setData({
          view: result.view,
          theme: result.theme,
          phase: result.phase ?? null,
          phaseGroup: result.phaseGroup ?? null,
          bracketType: result.bracketType ?? 'DOUBLE_ELIMINATION',
          sets: result.sets,
          entrants: result.entrants,
          standings: result.standings,
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'This overlay link is not valid. Copy it again from the Outputs page.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [viewId, secret]);

  // A socket of its own, so an overlay is never coupled to a dashboard session.
  useEffect(() => {
    if (!viewId || !secret) return;
    const socket = new LiveSocket();
    socket.connect();
    socket.subscribeView(viewId, secret);

    const unsubscribe = socket.onMessage((message) => {
      switch (message.type) {
        case 'view:snapshot':
          setData({
            view: message.view,
            theme: message.theme,
            phase: message.phase,
            phaseGroup: message.phaseGroup,
            bracketType: message.bracketType,
            sets: message.sets,
            entrants: message.entrants,
            standings: message.standings,
          });
          setError(null);
          break;
        case 'sets:changed':
          setData((current) => {
            if (!current) return current;
            // Patches arrive for the whole event; keep only what belongs to the
            // phase this overlay resolved to, or a pools update would leak into
            // a top-cut display.
            const belongs = (set: TournamentSet) =>
              current.phaseGroup
                ? set.phaseGroupId === current.phaseGroup.id
                : current.phase
                  ? set.phaseId === current.phase.id
                  : true;
            const byId = new Map(current.sets.map((s) => [s.id, s]));
            for (const set of message.upserted) {
              if (belongs(set)) byId.set(set.id, set);
            }
            for (const id of message.removedIds) byId.delete(id);
            return { ...current, sets: [...byId.values()] };
          });
          break;
        case 'standings:changed':
          setData((current) =>
            current ? { ...current, standings: message.standings } : current,
          );
          break;
        case 'camera:changed':
          setData((current) =>
            current && current.view.id === message.viewId
              ? { ...current, view: { ...current.view, camera: message.camera } }
              : current,
          );
          break;
        case 'view:updated':
          setData((current) =>
            current && current.view.id === message.view.id
              ? { ...current, view: message.view, theme: message.theme }
              : current,
          );
          break;
        case 'theme:updated':
          setData((current) =>
            current && current.theme.id === message.theme.id
              ? { ...current, theme: message.theme }
              : current,
          );
          break;
        case 'error':
          setError(message.message);
          break;
        default:
          break;
      }
    });

    return () => {
      unsubscribe();
      socket.close();
    };
  }, [viewId, secret]);

  // `?chrome=1` shows connection problems on screen; by default an overlay stays
  // silent so a transient hiccup never puts an error card on stream.
  const showChrome = params.get('chrome') === '1';

  const body = useMemo(() => {
    if (!data) return null;
    switch (data.view.kind) {
      case 'bracket':
        return (
          <BracketOverlay
            view={data.view}
            sets={data.sets}
            entrants={data.entrants}
            bracketType={data.bracketType}
            fadeMs={Number(data.theme.tokens.fadeDurationMs) || 420}
          />
        );
      case 'ondeck':
        return <OnDeckOverlay view={data.view} sets={data.sets} />;
      case 'standings':
        return <StandingsOverlay view={data.view} standings={data.standings} />;
      case 'scorecard':
        return <ScorecardOverlay view={data.view} sets={data.sets} />;
      default:
        return null;
    }
  }, [data]);

  if (error && !data) {
    return showChrome ? (
      <div className="overlay-message">{error}</div>
    ) : (
      // Render nothing rather than an error card, so a broken link is invisible
      // on stream instead of embarrassing.
      <div className="overlay-root" />
    );
  }

  if (!data) return <div className="overlay-root" />;

  return (
    <ThemeStyle theme={data.theme} className="overlay-root" transparent>
      {body}
    </ThemeStyle>
  );
}
