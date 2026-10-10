// Only these fields cross the log boundary. Never serialize an Error or URL.
export interface Diagnostic {
  requestId: string;
  playbackId?: string;
  stationId?: string;
  stage: string;
  startedAt: number;
  host?: string;
  upstreamStatus?: number;
  contentType?: string;
}

export class UpstreamFault extends Error {
  code: string;
  constructor(code: string, message = 'Upstream request failed') {
    super(message); this.code = code;
  }
}

export class StageError extends Error {
  diagnostic: Diagnostic;
  constructor(cause: unknown, diagnostic: Diagnostic) {
    super('Upstream operation failed', { cause }); this.diagnostic = diagnostic;
  }
}

export async function atStage<T>(context: Diagnostic | undefined, stage: string, operation: (trace?: Diagnostic) => Promise<T>): Promise<T> {
  const trace = context ? { ...context, stage, startedAt: performance.now() } : undefined;
  try { return await operation(trace); }
  catch (error) {
    if (!trace || error instanceof StageError) throw error;
    throw new StageError(error, trace);
  }
}

export function noteResponse(trace: Diagnostic | undefined, response: Response) {
  if (!trace) return;
  trace.upstreamStatus = response.status;
  // MIME type only: parameters can contain arbitrary upstream text.
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  trace.contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : 'unknown';
}

const safeCodes = new Set([
  'UPSTREAM_HTTP', 'INVALID_PLAYLIST', 'HTML_RESPONSE', 'AUTH_HEADERS', 'STREAM_LOOKUP',
  'URL_NOT_ALLOWED', 'INVALID_REDIRECT', 'REDIRECT_LIMIT', 'HTTP_ERROR',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const safeNames = new Set(['Error', 'TypeError', 'TimeoutError', 'AbortError', 'HttpError']);

export function logFailure(context: Diagnostic, error: unknown, level: 'error' | 'warn' = 'error') {
  const trace = error instanceof StageError ? error.diagnostic : context;
  const cause = error instanceof StageError ? error.cause : error;
  const name = cause instanceof Error ? cause.name : '';
  let code: unknown;
  if (cause && typeof cause === 'object' && 'code' in cause) code = cause.code;
  if (!code && cause instanceof Error && cause.cause && typeof cause.cause === 'object' && 'code' in cause.cause) code = cause.cause.code;
  console[level](JSON.stringify({
    event: 'radio_upstream_failure', requestId: trace.requestId, playbackId: trace.playbackId,
    stage: trace.stage, stationId: trace.stationId, host: trace.host,
    upstreamStatus: trace.upstreamStatus, contentType: trace.contentType,
    elapsedMs: Math.round(performance.now() - trace.startedAt),
    errorName: safeNames.has(name) ? name : 'Error',
    errorCode: typeof code === 'string' && safeCodes.has(code) ? code : name === 'TimeoutError' ? 'TIMEOUT' : name === 'AbortError' ? 'ABORTED' : 'UPSTREAM_FAILURE',
  }));
}
