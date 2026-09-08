/**
 * GraphQL transports.
 *
 * Two are provided:
 *
 *  - `web`      https://www.start.gg/api/-/gql — the endpoint the start.gg site
 *               itself uses. No token is needed to read. It is undocumented, so
 *               it can change without notice; that risk is contained here.
 *  - `official` https://api.start.gg/gql/alpha — the documented endpoint. Needs
 *               a personal access token.
 *
 * Both sit in front of the same backend and both enforce the same object-count
 * ceiling ("a maximum of 1000 objects may be returned by each request"). The
 * site endpoint is not a way around it — an earlier version of this file said
 * otherwise, and the result was import failures on tournaments whose structure
 * fanned out past 1000 objects. That ceiling is classified here as its own
 * error kind so the client can respond by asking for less, rather than failing.
 *
 * Everything above this file speaks in terms of `GqlTransport`, so switching is
 * a config change rather than a rewrite.
 */

export interface GqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  /** Used for logging and the request-volume meter. */
  operationName?: string;
}

export interface GqlResponse<T> {
  data: T | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

export type GqlErrorKind =
  | 'network'
  | 'http'
  | 'graphql'
  | 'auth'
  | 'rateLimit'
  /** The request would have returned more objects than start.gg allows. */
  | 'complexity';

/** The numbers start.gg puts in its object-count rejection, when it gives them. */
export interface ComplexityInfo {
  /** Objects allowed per request, e.g. 1000. */
  limit: number | null;
  /** Objects this request would have returned, e.g. 1219. */
  actual: number | null;
}

export class GqlError extends Error {
  constructor(
    message: string,
    readonly kind: GqlErrorKind,
    readonly status?: number,
    readonly detail?: unknown,
    /** Present only when `kind` is 'complexity'. */
    readonly complexity?: ComplexityInfo,
  ) {
    super(message);
    this.name = 'GqlError';
  }

  /** Whether retrying the *same* request could plausibly succeed. */
  get retryable(): boolean {
    if (this.kind === 'network' || this.kind === 'rateLimit') return true;
    if (this.kind === 'http') return !this.status || this.status >= 500 || this.status === 429;
    // A complexity rejection is deterministic: the same request will be
    // rejected again. It is recoverable, but only by asking for less, which is
    // the client's job rather than the transport's.
    return false;
  }
}

/**
 * Recognises start.gg's object-count rejection and pulls the numbers out of it.
 * The wording has drifted over the years ("query complexity is too high",
 * "maximum of 1000 objects"), so match loosely and treat the numbers as
 * optional — the client can still halve its page size without them.
 */
export function parseComplexityError(message: string): ComplexityInfo | null {
  if (!/complexity|maximum of \d+ objects/i.test(message)) return null;
  const limit = /maximum of\s+(\d+)\s+objects/i.exec(message)?.[1];
  const actual = /actual:\s*(\d+)/i.exec(message)?.[1];
  return {
    limit: limit ? Number(limit) : null,
    actual: actual ? Number(actual) : null,
  };
}

export interface GqlTransport {
  readonly name: string;
  readonly endpoint: string;
  /** True when this transport can perform mutations with current config. */
  readonly canMutate: boolean;
  execute<T>(request: GqlRequest, signal?: AbortSignal): Promise<T>;
}

export interface TransportOptions {
  endpoint?: string;
  /** Bearer token; only the official endpoint requires one. */
  token?: string | null;
  /** Extra headers, e.g. a client-version the site expects. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const WEB_ENDPOINT = 'https://www.start.gg/api/-/gql';
const OFFICIAL_ENDPOINT = 'https://api.start.gg/gql/alpha';

abstract class HttpTransport implements GqlTransport {
  abstract readonly name: string;
  readonly endpoint: string;
  protected readonly timeoutMs: number;
  protected readonly fetchImpl: typeof fetch;

  constructor(endpoint: string, protected readonly options: TransportOptions) {
    this.endpoint = options.endpoint ?? endpoint;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  abstract get canMutate(): boolean;
  protected abstract buildHeaders(): Record<string, string>;

  async execute<T>(request: GqlRequest, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          query: request.query,
          variables: request.variables ?? {},
          operationName: request.operationName,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GqlError(`Could not reach start.gg: ${message}`, 'network');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    // Read the body once, up front. start.gg returns GraphQL errors under both
    // 200 and 4xx — the complexity rejection in particular has been seen with
    // each — so classifying on status alone would turn a precise, actionable
    // message into an opaque "HTTP 400".
    const rawBody = await response.text().catch(() => '');
    let payload: GqlResponse<T> | null = null;
    try {
      payload = rawBody ? (JSON.parse(rawBody) as GqlResponse<T>) : null;
    } catch {
      payload = null;
    }

    const errors = (payload?.errors ?? []).filter(Boolean);
    const firstMessage = errors[0]?.message;

    if (firstMessage) {
      const complexity = parseComplexityError(firstMessage);
      if (complexity) {
        throw new GqlError(firstMessage, 'complexity', response.status, errors, complexity);
      }
    }

    if (response.status === 401 || response.status === 403) {
      throw new GqlError(
        firstMessage ??
          'start.gg rejected the request as unauthorized. Check the API token in Settings.',
        'auth',
        response.status,
      );
    }
    if (response.status === 429) {
      throw new GqlError(firstMessage ?? 'start.gg rate limit hit; backing off.', 'rateLimit', 429);
    }
    if (!response.ok) {
      throw new GqlError(
        firstMessage ?? `start.gg returned HTTP ${response.status}`,
        'http',
        response.status,
        rawBody.slice(0, 500),
      );
    }
    if (!payload) {
      throw new GqlError('start.gg returned a response that was not JSON', 'http', response.status);
    }

    if (errors.length > 0) {
      throw new GqlError(
        firstMessage ?? 'start.gg returned a GraphQL error',
        'graphql',
        response.status,
        errors,
      );
    }
    if (payload.data === null || payload.data === undefined) {
      throw new GqlError('start.gg returned an empty response', 'graphql', response.status);
    }
    return payload.data;
  }
}

/**
 * What the site's own XHR looks like on the wire.
 *
 * Node's fetch sends no `User-Agent` a site would recognise and no `Origin`,
 * `Referer` or `Sec-Fetch-*` headers at all, which is exactly the shape a WAF
 * scores as a bot. Requests to the site endpoint therefore carry a current
 * desktop Chrome header set, kept together here so it can be refreshed in one
 * place. Every value is overridable through `options.headers`.
 */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://www.start.gg',
  referer: 'https://www.start.gg/',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
});

/**
 * The site's own endpoint. Sends the headers a browser would; start.gg has at
 * times required a client-version header, so it is configurable rather than
 * hard-coded.
 */
export class WebGqlTransport extends HttpTransport {
  override readonly name = 'web';

  constructor(options: TransportOptions = {}) {
    super(WEB_ENDPOINT, options);
  }

  override get canMutate(): boolean {
    // Mutations against the site endpoint need whatever session the site itself
    // uses; without a configured credential we only claim read capability.
    return Boolean(this.options.token || this.options.headers?.['cookie']);
  }

  protected override buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...BROWSER_HEADERS,
      'content-type': 'application/json',
      accept: '*/*',
      'client-version': '20',
      ...normalizeHeaderKeys(this.options.headers),
    };
    if (this.options.token) headers['authorization'] = `Bearer ${this.options.token}`;
    return headers;
  }
}

/** The documented endpoint. Requires a personal access token. */
export class OfficialGqlTransport extends HttpTransport {
  override readonly name = 'official';

  constructor(options: TransportOptions = {}) {
    super(OFFICIAL_ENDPOINT, options);
  }

  override get canMutate(): boolean {
    return Boolean(this.options.token);
  }

  protected override buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      // A named client rather than a browser disguise: this endpoint is a
      // documented API and the token already identifies the caller.
      'user-agent': 'bracket-dashboard/0.1 (+https://github.com/Voidscape-Development/Bracket-Dashboard)',
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      ...normalizeHeaderKeys(this.options.headers),
    };
  }
}

/**
 * Lowercases configured header names so a user-supplied `User-Agent` actually
 * replaces the default rather than being sent alongside it.
 */
function normalizeHeaderKeys(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

export type TransportKind = 'web' | 'official' | 'mock';

export function createTransport(
  kind: TransportKind,
  options: TransportOptions = {},
): GqlTransport {
  switch (kind) {
    case 'official':
      return new OfficialGqlTransport(options);
    case 'web':
    default:
      return new WebGqlTransport(options);
  }
}
