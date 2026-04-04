/**
 * Netlify Function: coda-proxy
 *
 * Acts as a server-side proxy for the Coda API.
 * - Keeps the API key out of the browser entirely
 * - Solves CORS (Coda blocks direct browser requests)
 * - Returns the full Q&A dataset as JSON
 *
 * The API key is stored as a Netlify environment variable: CODA_API_KEY
 */

const DOC_ID   = 'cKc2cGnJOT';
const TABLE_ID = 'grid-l-jaTOjaOG';

const COL = {
  qid:      'c-q-Qj_PFtN-',
  category: 'c-Y9s81kR1xZ',
  question: 'c-ysZv6rkJbo',
  tags:     'c-pqNO0TdwYM',
  answer:   'c-w2yMvgV2RI',
};

exports.handler = async function (event) {
  // Only allow GET
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.CODA_API_KEY;
  if (!apiKey) {
    console.error('CODA_API_KEY environment variable is not set');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server configuration error: API key missing' }),
    };
  }

  const url =
    `https://coda.io/apis/v1/docs/${DOC_ID}/tables/${TABLE_ID}/rows` +
    `?valueFormat=simple&limit=200&sortBy=natural`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.error('Coda fetch error:', err);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Failed to reach Coda API', detail: err.message }),
    };
  }

  if (!response.ok) {
    const body = await response.text();
    console.error(`Coda API ${response.status}:`, body);
    return {
      statusCode: response.status,
      body: JSON.stringify({ error: `Coda API error ${response.status}`, detail: body }),
    };
  }

  const data = await response.json();

  // Map Coda rows to clean objects
  const qa = data.items
    .map(row => ({
      qid:      row.values[COL.qid]      ?? '',
      category: row.values[COL.category] ?? '',
      question: row.values[COL.question] ?? '',
      tags:     row.values[COL.tags]     ?? '',
      answer:   row.values[COL.answer]   ?? '',
    }))
    .filter(q => q.question && q.answer)
    .sort((a, b) => Number(a.qid) - Number(b.qid));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Allow browser to cache for 1 hour (CDN edge cache)
      'Cache-Control': 'public, max-age=3600',
    },
    body: JSON.stringify(qa),
  };
};
