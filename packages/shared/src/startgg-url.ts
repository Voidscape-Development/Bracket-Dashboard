/**
 * start.gg URL parsing.
 *
 * Users paste whatever they have in the address bar: a tournament page, an
 * event page, a specific phase group, or just the slug. All of those resolve to
 * a tournament slug, which is the only thing the importer needs.
 */

export interface ParsedStartggUrl {
  tournamentSlug: string;
  eventSlug: string | null;
  /** Full `tournament/x/event/y` slug when the URL pointed at an event. */
  fullEventSlug: string | null;
  phaseGroupId: string | null;
}

const TOURNAMENT_RE = /(?:^|\/)tournament\/([^/?#]+)/i;
const EVENT_RE = /(?:^|\/)event\/([^/?#]+)/i;
const BRACKET_RE = /(?:^|\/)brackets\/(?:\d+\/)*(\d+)(?:\/|$)/i;

/**
 * Accepts a full URL, a `tournament/...` path, or a bare slug. Returns null when
 * nothing tournament-shaped can be found.
 */
export function parseStartggUrl(input: string): ParsedStartggUrl | null {
  const raw = input.trim();
  if (!raw) return null;

  // Strip protocol/host if present so the same regexes handle both forms.
  let path = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      if (!/(^|\.)(start\.gg|smash\.gg)$/i.test(url.hostname)) return null;
      path = url.pathname;
    }
  } catch {
    return null;
  }

  const tournamentMatch = TOURNAMENT_RE.exec(path);
  let tournamentSlug: string;

  if (tournamentMatch?.[1]) {
    tournamentSlug = tournamentMatch[1];
  } else if (/^[a-z0-9][a-z0-9-]*$/i.test(path.replace(/^\//, '').replace(/\/$/, ''))) {
    // A bare slug like "genesis-9".
    tournamentSlug = path.replace(/^\//, '').replace(/\/$/, '');
  } else {
    return null;
  }

  const eventMatch = EVENT_RE.exec(path);
  const eventSlug = eventMatch?.[1] ?? null;
  const bracketMatch = BRACKET_RE.exec(path);

  return {
    tournamentSlug,
    eventSlug,
    fullEventSlug: eventSlug ? `tournament/${tournamentSlug}/event/${eventSlug}` : null,
    phaseGroupId: bracketMatch?.[1] ?? null,
  };
}

export function tournamentUrl(slug: string): string {
  return `https://www.start.gg/tournament/${slug}`;
}

export function eventUrl(fullEventSlug: string): string {
  return `https://www.start.gg/${fullEventSlug}`;
}
