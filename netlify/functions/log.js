/**
 * POST /api/log
 * Writes usage-log rows to the QA_Usage_Log table in Coda.
 *
 * Fire-and-forget design: the client does not await the response, and this
 * function never breaks the chat agent's UX even if Coda is unreachable.
 *
 * Security hardening:
 * - Server-side input validation (event type whitelist, length limits)
 * - CORS restricted to same origin
 * - Errors logged internally but never leaked to the client
 * - Server-side timestamp (client clocks can't be trusted)
 */

const CODA_API_KEY = process.env.CODA_QA_LOG_API;
const CODA_DOC_ID  = 'cKc2cGnJOT';
const TABLE_ID     = 'grid-5UiNgef5hU';

// Column IDs
const COL_TIMESTAMP     = 'c-mudC9c-XCk';
const COL_EVENT         = 'c-txdFLCxE42';
const COL_QUESTION      = 'c-n8SqHaptJI';
const COL_RESULTS_COUNT = 'c-ma3uEtm5RR';

// Validation
const VALID_EVENTS = new Set(['search_hit', 'search_miss']);
const MAX_QUESTION_LEN = 500;

exports.handler = async (event) => {
  // ── CORS: only accept requests from same origin ───────────────────────────
  const origin = event.headers['origin'] || event.headers['Origin'] || '';
  const host   = event.headers['host']   || event.headers['Host']   || '';
  const sameOrigin = !origin || origin.includes(host);

  const corsHeaders = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  };

  if (!sameOrigin) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Parse + validate ──────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid body' }) };
  }

  const eventType = String(body.event || '').trim();
  const question  = String(body.question || '').trim().slice(0, MAX_QUESTION_LEN);
  const resultsCount = Number.isInteger(body.resultsCount) ? body.resultsCount : 0;

  if (!VALID_EVENTS.has(eventType)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid event type' }) };
  }
  if (!question) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Question required' }) };
  }

  // ── Write to Coda ─────────────────────────────────────────────────────────
  try {
    const timestamp = new Date().toISOString();
    const payload = {
      rows: [{
        cells: [
          { column: COL_TIMESTAMP,     value: timestamp },
          { column: COL_EVENT,         value: eventType },
          { column: COL_QUESTION,      value: question },
          { column: COL_RESULTS_COUNT, value: resultsCount },
        ],
      }],
    };

    const url = `https://coda.io/apis/v1/docs/${CODA_DOC_ID}/tables/${TABLE_ID}/rows`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${CODA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`Coda log write failed: ${res.status} ${errText}`);
      // Return 200 to the client anyway — logging is non-critical, don't alarm anyone
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: false }) };
    }

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('log.js error:', err.message);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: false }) };
  }
};
