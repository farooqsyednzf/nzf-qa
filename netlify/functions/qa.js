/**
 * GET /api/qa
 * Fetches all rows from the NZF Zakat Q&A Coda table and returns them
 * as a flat JSON array for the QA page to search client-side.
 *
 * Coda's `query` param only searches the display column (QID — a number),
 * so we fetch ALL rows and let the client do keyword scoring instead.
 *
 * Response shape per item:
 *   { qid, category, question, answer, tags }
 */

const CODA_API_KEY  = process.env.CODA_API_KEY;
const CODA_DOC_ID   = 'cKc2cGnJOT';
const CODA_TABLE_ID = 'grid-l-jaTOjaOG';

// In-process cache: avoids hammering Coda on every page load
// (Netlify functions are warm for ~15 min between invocations)
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

exports.handler = async (event) => {
  // Only allow GET
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Return from in-process cache if fresh
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300', // browser can cache 5 min
      },
      body: JSON.stringify(_cache),
    };
  }

  try {
    const rows = await fetchAllCodaRows();
    _cache   = rows;
    _cacheTs = Date.now();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
      body: JSON.stringify(rows),
    };
  } catch (err) {
    console.error('qa.js error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

async function fetchAllCodaRows() {
  const all  = [];
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
      all.push({
        qid:      v['QID']      || v['Id'] || '',
        category: v['Category'] || '',
        question: v['Question'] || '',
        answer:   v['Answer']   || '',
        tags:     v['Tags']     || '',
      });
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return all;
}
