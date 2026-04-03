const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://sebastianpantea-pixel.github.io', 'http://localhost'],
  credentials: true
}));

const REDIRECT_URI = process.env.REDIRECT_URI || 'https://family-calendar-backend-b40h.onrender.com/auth/callback';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

if (process.env.REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    authenticated: !!process.env.REFRESH_TOKEN,
    message: process.env.REFRESH_TOKEN ? 'Calendar backend running' : 'Visit /auth/login'
  });
});

app.get('/auth/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent'
  });
  res.redirect(url);
});

// Stateless callback - no session needed
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send('<h2 style="color:red">Eroare: '+error+'</h2><a href="/auth/login">Retry</a>');
  if (!code) return res.send('<h2 style="color:red">No code</h2><a href="/auth/login">Retry</a>');

  try {
    const tokenResponse = await oauth2Client.getToken(code);
    const tokens = tokenResponse.tokens;
    const refreshToken = tokens.refresh_token;

    res.send(`<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;padding:40px;background:#0F1117;color:#F0EDE8;text-align:center;">
  <h2 style="color:#4CAF8A;">✓ Autentificare reușită!</h2>
  <p style="color:#9A95A0;margin-bottom:8px;">Copiază Refresh Token-ul de mai jos:</p>
  <textarea onclick="this.select()" style="width:90%;height:100px;padding:12px;background:#181B23;color:#4CAF8A;border:1px solid #2A2E3E;border-radius:8px;font-size:12px;font-family:monospace;">${refreshToken}</textarea>
  <br><br>
  <div style="background:#1E2230;border-radius:12px;padding:20px;max-width:500px;margin:0 auto;text-align:left;">
    <p style="color:#9A95A0;font-size:14px;margin-bottom:8px;"><strong style="color:#F0EDE8;">Pasul următor:</strong></p>
    <p style="color:#9A95A0;font-size:13px;line-height:1.6;">
      1. Copiază tokenul de mai sus<br>
      2. Mergi pe <strong style="color:#4CAF8A;">render.com</strong> → serviciul tău → <strong>Environment</strong><br>
      3. Adaugă variabila: <strong style="color:#4CAF8A;">REFRESH_TOKEN</strong><br>
      4. Lipește tokenul → Save → Redeploy
    </p>
  </div>
</body>
</html>`);
  } catch (e) {
    res.send('<h2 style="color:red">Eroare: '+e.message+'</h2><a href="/auth/login" style="color:#4CAF8A;">Retry</a>');
  }
});

app.get('/events', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not authenticated. Visit /auth/login first.' });
  try {
    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth();
    const timeMin = new Date(year, month - 1, 1).toISOString();
    const timeMax = new Date(year, month + 2, 0, 23, 59, 59).toISOString();

    const calList = await calendar.calendarList.list();
    const cals = calList.data.items || [];
    const allEvents = [];

    for (const cal of cals) {
      try {
        const evRes = await calendar.events.list({
          calendarId: cal.id,
          timeMin, timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 200
        });
        const items = evRes.data.items || [];

        // For recurring events without colorId, fetch the base event to get its color
        const recurringColors = {};
        const toFetch = [...new Set(
          items
            .filter(ev => !ev.colorId && ev.recurringEventId)
            .map(ev => ev.recurringEventId)
        )];
        for (const rid of toFetch) {
          try {
            const base = await calendar.events.get({ calendarId: cal.id, eventId: rid });
            if (base.data.colorId) recurringColors[rid] = base.data.colorId;
          } catch(e) {}
        }

        items.forEach(ev => allEvents.push({
          ...ev,
          colorId: ev.colorId || recurringColors[ev.recurringEventId] || null,
          _calName: cal.summary,
          _calBg: cal.backgroundColor || '',
          _calId: cal.id
        }));
      } catch (e) {}
    }

    allEvents.sort((a, b) => (a.start?.dateTime || a.start?.date || '').localeCompare(b.start?.dateTime || b.start?.date || ''));
    res.json({ events: allEvents, calendars: cals });
  } catch (e) {
    if (e.code === 401) return res.status(401).json({ error: 'Token invalid' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/events', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { calendarId = 'primary', ...eventBody } = req.body;
    const result = await calendar.events.insert({ calendarId, requestBody: eventBody });
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/events/:calendarId/:eventId', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await calendar.events.patch({
      calendarId: decodeURIComponent(req.params.calendarId),
      eventId: req.params.eventId,
      requestBody: req.body
    });
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/events/:calendarId/:eventId', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await calendar.events.delete({
      calendarId: decodeURIComponent(req.params.calendarId),
      eventId: req.params.eventId
    });
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/calendars', async (req, res) => {
  if (!process.env.REFRESH_TOKEN) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await calendar.calendarList.list();
    res.json({ calendars: result.data.items || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Calendar backend running on port ' + PORT));
