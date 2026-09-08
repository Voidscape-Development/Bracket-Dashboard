/**
 * GraphQL transports.
 *
 * Two are provided:
 *
 *  - `web`      https://www.start.gg/api/-/gql — the endpoint the start.gg site
 *               itself uses. No token, and no query-complexity ceiling, which is
 *               what makes whole-tournament reads practical. It is undocumented,
 *               so it can change without notice; that risk is contained here.
 *  - `official` https://api.start.gg/gql/alpha — the documented endpoint. Needs
 *               a personal access token and enforces complexity limits.
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

export class GqlError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'http' | 'graphql' | 'auth' | 'rateLimit',
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'GqlError';
  }

  /** Whether retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    if (this.kind === 'network' || this.kind === 'rateLimit') return true;
    if (this.kind === 'http') return !this.status || this.status >= 500 || this.status === 429;
    return false;
  }
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

    if (response.status === 401 || response.status === 403) {
      throw new GqlError(
        'start.gg rejected the request as unauthorized. Check the API token in Settings.',
        'auth',
        response.status,
      );
    }
    if (response.status === 429) {
      throw new GqlError('start.gg rate limit hit; backing off.', 'rateLimit', 429);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new GqlError(
        `start.gg returned HTTP ${response.status}`,
        'http',
        response.status,
        body.slice(0, 500),
      );
    }

    let payload: GqlResponse<T>;
    try {
      payload = (await response.json()) as GqlResponse<T>;
    } catch {
      throw new GqlError('start.gg returned a response that was not JSON', 'http', response.status);
    }

    if (payload.errors?.length) {
      const first = payload.errors[0];
      throw new GqlError(
        first?.message ?? 'start.gg returned a GraphQL error',
        'graphql',
        response.status,
        payload.errors,
      );
    }
    if (payload.data === null || payload.data === undefined) {
      throw new GqlError('start.gg returned an empty response', 'graphql', response.status);
    }
    return payload.data;
  }
}

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
      'content-type': 'application/json',
      accept: 'application/json',
      'client-version': '20',
      ...(this.options.headers ?? {}),
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
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      ...(this.options.headers ?? {}),
    };
  }
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
