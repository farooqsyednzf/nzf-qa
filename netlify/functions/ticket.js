/**
 * POST /api/ticket
 * Creates a Zoho Desk support ticket from the QA page's chat agent.
 *
 * Security hardening:
 * - Server-side input validation with length limits + email format check
 * - Sanitised error messages: internal Zoho errors are never sent to the client
 * - CORS restricted to same origin
 * - HTTPS-only OAuth + API calls
 */

const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID        = '914791857';

const DEPT_ID  = '1253395000000457123'; // Zakat Education
const AGENT_ID = '1253395000000428005'; // Ahmed Mostafa

// Validation limits
const MAX_NAME     = 120;
const MAX_EMAIL    = 254;
const MAX_QUESTION = 2000;

// Simple email regex (RFC-lite — adequate for server-side sanity check)
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

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

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  // ── Server-side validation ────────────────────────────────────────────────
  const name     = String(body.name     || '').trim();
  const email    = String(body.email    || '').trim().toLowerCase();
  const question = String(body.question || '').trim();

  const errors = [];
  if (!name)                          errors.push('Name is required');
  else if (name.length > MAX_NAME)    errors.push(`Name must be ${MAX_NAME} characters or fewer`);

  if (!email)                         errors.push('Email is required');
  else if (email.length > MAX_EMAIL)  errors.push('Email address is too long');
  else if (!EMAIL_RE.test(email))     errors.push('Please provide a valid email address');

  if (!question)                          errors.push('Question is required');
  else if (question.length > MAX_QUESTION) errors.push(`Question must be ${MAX_QUESTION} characters or fewer`);

  if (errors.length) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: errors[0] }) };
  }

  // ── Create ticket ─────────────────────────────────────────────────────────
  try {
    const token  = await getZohoAccessToken();
    const result = await createTicket({ token, name, email, question });
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(result) };
  } catch (err) {
    // Log full error internally but return a safe generic message to the client
    console.error('ticket.js error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Unable to submit your question. Please try again or contact us directly.' }),
    };
  }
};

// ─── Zoho OAuth ──────────────────────────────────────────────────────────────
async function getZohoAccessToken() {
  // IMPORTANT: must use accounts.zoho.com (global), NOT accounts.zoho.com.au
  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: ZOHO_REFRESH_TOKEN,
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    // Don't expose token error details externally
    console.error('Zoho token refresh failed:', JSON.stringify(data));
    throw new Error('Authentication error');
  }
  return data.access_token;
}

// ─── Create ticket ────────────────────────────────────────────────────────────
async function createTicket({ token, name, email, question }) {
  const parts    = name.split(/\s+/);
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];

  const description = `${question}\n\n──\nSubmitted via NZF Zakat Q&A page`;

  const payload = {
    subject:      `[QA-Agent] ${question.slice(0, 100)}`,
    description,
    departmentId: DEPT_ID,
    assigneeId:   AGENT_ID,
    status:       'Open',
    channel:      'Web',
    contact: { lastName, email },
  };

  // orgId must be a HEADER, not a query param
  const res = await fetch('https://desk.zoho.com/api/v1/tickets', {
    method: 'POST',
    headers: {
      Authorization:  `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
      orgId:          ZOHO_ORG_ID,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!data.id) {
    console.error('Ticket creation failed:', JSON.stringify(data));
    throw new Error('Ticket creation failed');
  }

  await verifyTicketWithRetry(token, data.id);

  return {
    success:      true,
    ticketId:     data.id,
    ticketNumber: data.ticketNumber || null,
  };
}

// ─── Verify with retry + exponential backoff ──────────────────────────────────
async function verifyTicketWithRetry(token, ticketId, maxAttempts = 3) {
  await sleep(800);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`https://desk.zoho.com/api/v1/tickets/${ticketId}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}`, orgId: ZOHO_ORG_ID },
      });
      if (res.ok) return true;
      console.warn(`Verify attempt ${attempt} — status ${res.status}`);
    } catch (err) {
      console.warn(`Verify attempt ${attempt} — error: ${err.message}`);
    }
    if (attempt < maxAttempts) await sleep(800 * Math.pow(2, attempt - 1));
  }
  // Ticket was created (we have an ID) — trust the creation response
  console.warn(`Could not verify ticket ${ticketId} — trusting creation response`);
  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
