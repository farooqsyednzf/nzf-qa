/**
 * GET /api/qa
 * Fetches all rows from the NZF Zakat Q&A Coda table and returns them
 * as a flat JSON array for the QA page to search client-side.
 *
 * Coda's `query` param only searches the display column (QID — a number),
 * so we fetch ALL rows (paginated, up to 500/page) and let the client score.
 */

const CODA_API_KEY  = process.env.CODA_API_KEY;
const CODA_DOC_ID   = 'cKc2cGnJOT';
const CODA_TABLE_ID = 'grid-l-jaTOjaOG';

// In-process cache: avoids hammering Coda on every page load
// (Netlify functions stay warm ~15 min between invocations)
let _cache   = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  // private: CDN should not cache — data belongs to this org
  'Cache-Control': 'private, max-age=300',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: COMMON_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Validate Coda API key is configured
  if (!CODA_API_KEY) {
    console.error('qa.js: CODA_API_KEY env var is not set');
    return {
      statusCode: 503,
      headers: COMMON_HEADERS,
      body: JSON.stringify({ error: 'Service temporarily unavailable' }),
    };
  }

  // Return from in-process cache if fresh
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) {
    return { statusCode: 200, headers: COMMON_HEADERS, body: JSON.stringify(_cache) };
  }

  try {
    const rows = await fetchAllCodaRows();
    _cache   = rows;
    _cacheTs = Date.now();
    return { statusCode: 200, headers: COMMON_HEADERS, body: JSON.stringify(rows) };
  } catch (err) {
    console.error('qa.js error:', err.message);
    return {
      statusCode: 500,
      headers: COMMON_HEADERS,
      body: JSON.stringify({ error: 'Unable to load the Q&A library. Please refresh.' }),
    };
  }
};

async function fetchAllCodaRows() {
  const all = [];
  let pageToken = null;

  do {
    const url = new URL(
      `https://coda.io/apis/v1/docs/${CODA_DOC_ID}/tables/${CODA_TABLE_ID}/rows`
    );
    url.searchParams.set('limit', '500');
    url.searchParams.set('valueFormat', 'simpleWithArrays');
    url.searchParams.set('useColumnNames', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${CODA_API_KEY}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Coda API ${res.status}: ${text}`);
    }

    const data = await res.json();

    for (const row of (data.items || [])) {
      const v = row.values || {};
      // Strip any HTML/script from Coda values before sending to client
      all.push({
        qid:      sanitise(v['QID']      ?? v['Id']  ?? ''),
        category: sanitise(v['Category'] ?? ''),
        question: sanitise(v['Question'] ?? ''),
        answer:   sanitise(v['Answer']   ?? ''),
        tags:     sanitise(v['Tags']     ?? ''),
      });
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return all;
}

// Strip any script tags or event handlers that might have crept into Coda data
function sanitise(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
}
