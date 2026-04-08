/**
 * POST /api/ticket
 * Creates a Zoho Desk support ticket from the QA page's chat agent.
 *
 * Expected request body (JSON):
 *   { name: string, email: string, question: string }
 *
 * Key lessons baked in:
 * - OAuth token exchange MUST go through accounts.zoho.com (global),
 *   NOT accounts.zoho.com.au — the AU endpoint returns invalid_client
 * - Desk API calls go to desk.zoho.com (global), not desk.zoho.com.au
 * - orgId must be sent as a request HEADER, not a query param
 * - After ticket creation, verification via GET /tickets/:id can fail
 *   immediately due to propagation delay — use retry with backoff
 */

const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID        = '914791857';

// Department + agent routing for Zakat Q&A tickets
// All tickets from the QA page go to Zakat Education (Ahmed Mostafa)
// — he handles inbound knowledge queries
const DEPT_ID   = '1253395000000428001'; // Zakat Education
const AGENT_ID  = '1253395000000428005'; // Ahmed Mostafa

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { name, email, question } = body;

  if (!name || !email || !question) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'name, email and question are required' }),
    };
  }

  try {
    const token  = await getZohoAccessToken();
    const result = await createTicket({ token, name, email, question });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('ticket.js error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ─── Zoho OAuth ──────────────────────────────────────────────────────────────
async function getZohoAccessToken() {
  // IMPORTANT: must use global accounts.zoho.com, not accounts.zoho.com.au
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
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ─── Create ticket ────────────────────────────────────────────────────────────
async function createTicket({ token, name, email, question }) {
  // Zoho requires at least a lastName on the contact object
  const parts    = name.trim().split(/\s+/);
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];

  const description = `${question}\n\n──\nSubmitted via NZF Zakat Q&A page`;

  const payload = {
    subject:      `[QA] ${question.slice(0, 120)}`,
    description,
    departmentId: DEPT_ID,
    assigneeId:   AGENT_ID,
    status:       'Open',
    channel:      'Web',
    contact: {
      lastName,
      email,
    },
  };

  // IMPORTANT: orgId as a HEADER, not query param
  const res = await fetch('https://desk.zoho.com/api/v1/tickets', {
    method:  'POST',
    headers: {
      Authorization:  `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
      orgId:          ZOHO_ORG_ID,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!data.id) {
    throw new Error(`Ticket creation failed: ${JSON.stringify(data)}`);
  }

  // Propagation delay: verify the ticket exists before returning success.
  // Zoho sometimes takes a moment to make a newly created ticket retrievable.
  await verifyTicketWithRetry(token, data.id);

  return {
    success:      true,
    ticketId:     data.id,
    ticketNumber: data.ticketNumber || null,
  };
}

// ─── Verification with retry + exponential backoff ────────────────────────────
async function verifyTicketWithRetry(token, ticketId, maxAttempts = 3) {
  // Wait before first attempt — propagation delay is real
  await sleep(800);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`https://desk.zoho.com/api/v1/tickets/${ticketId}`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          orgId:         ZOHO_ORG_ID,
        },
      });

      if (res.ok) return true; // verified

      const data = await res.json();
      console.warn(`Ticket verify attempt ${attempt} — status ${res.status}:`, data);
    } catch (err) {
      console.warn(`Ticket verify attempt ${attempt} — network error:`, err.message);
    }

    if (attempt < maxAttempts) {
      await sleep(800 * Math.pow(2, attempt - 1)); // 800ms, 1600ms
    }
  }

  // All retries failed — but the ticket was created (we got an ID back).
  // Log and return rather than throwing, to avoid false failure UX.
  console.warn(`Could not verify ticket ${ticketId} after ${maxAttempts} attempts — trusting creation response`);
  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
