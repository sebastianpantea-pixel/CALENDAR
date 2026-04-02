const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://sebastianpantea-pixel.github.io', 'http://localhost'],
  credentials: true
}));

// ── OAuth2 client ──
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI || 'https://family-calendar-backend.onrender.com/auth/callback'
);

// Load saved refresh token if exists
if (process.env.REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ── ROUTES ──

// Health check
app.get('/', (req, res) => {
  const hasToken = !!process.env.REFRESH_TOKEN;
  res.json({
    status: 'ok',
    authenticated: hasToken,
    message: hasToken ? 'Calendar backend running' : 'Not authenticated yet - visit /auth/login'
  });
});

// Step 1: redirect to Google login (run once from browser)
app.get('/auth/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent'  // forces refresh token
  });
  res.redirect(url);
});

// Step 2: Google redirects here with code
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0F1117;color:#F0EDE8;text-align:center;">
        <h2 style="color:#4CAF8A;">✓ Autentificare reușită!</h2>
        <p>Copiază acest refresh token și adaugă-l în Render ca variabilă de mediu:</p>
        <p style="font-size:12px;color:#9A95A0;">Variabila: <strong>REFRESH_TOKEN</strong></p>
        <textarea style="width:90%;height:80px;padding:10px;background:#181B23;color:#4CAF8A;border:1px solid #2A2E3E;border-radius:8px;font-size:11px;">${tokens.refresh_token || 'TOKEN_DEJA_SALVAT_FOLOSESTE_CEL_EXISTENT'}</textarea>
        <br><br>
        <p style="color:#9A95A0;font-size:13px;">Adaugă variabila în Render → Environment → REFRESH_TOKEN → Save → Redeploy</p>
        <p style="color:#9A95A0;font-size:13px;">Dacă nu apare tokenul, înseamnă că era deja salvat și funcționează.</p>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send('Eroare: ' + e.message);
  }
});

// ── CALENDAR API ROUTES ──

// Get all calendars + events for a month range
app.get('/events', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/login first.' });
  }

  try {
    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth();

    const timeMin = new Date(year, month - 1, 1).toISOString();
    const timeMax = new Date(year, month + 2, 0, 23, 59, 59).toISOString();

    // Get calendar list
    const calList = await calendar.calendarList.list();
    const cals = calList.data.items || [];

    // Fetch events from all calendars
    const allEvents = [];
    for (const cal of cals) {
      try {
        const evRes = await calendar.events.list({
          calendarId: cal.id,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 200
        });
        const items = evRes.data.items || [];
        items.forEach(ev => allEvents.push({
          ...ev,
          _calName: cal.summary,
          _calBg: cal.backgroundColor || ''
        }));
      } catch (e) {
        // skip calendars with no access
      }
    }

    allEvents.sort((a, b) => {
      const ta = a.start?.dateTime || a.start?.date || '';
      const tb = b.start?.dateTime || b.start?.date || '';
      return ta.localeCompare(tb);
    });

    res.json({ events: allEvents, calendars: cals });
  } catch (e) {
    if (e.code === 401) {
      return res.status(401).json({ error: 'Token expired or invalid. Visit /auth/login.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// Create event
app.post('/events', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { calendarId = 'primary', ...eventBody } = req.body;
    const result = await calendar.events.insert({
      calendarId,
      requestBody: eventBody
    });
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update event
app.patch('/events/:calendarId/:eventId', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await calendar.events.patch({
      calendarId: decodeURIComponent(req.params.calendarId),
      eventId: req.params.eventId,
      requestBody: req.body
    });
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete event
app.delete('/events/:calendarId/:eventId', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await calendar.events.delete({
      calendarId: decodeURIComponent(req.params.calendarId),
      eventId: req.params.eventId
    });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Calendar list (for select dropdown)
app.get('/calendars', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await calendar.calendarList.list();
    res.json({ calendars: result.data.items || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Calendar backend running on port ${PORT}`));
