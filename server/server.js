'use strict';

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    'https://enferg.github.io',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
  ],
}));

// sessionId → session data
const sessions = new Map();

/* ================================================================
   SPOTIFY HELPERS
   ================================================================ */
async function spotifyGet(path, token) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 204 || res.status === 202) return null;
  if (res.status === 401) throw new Error('TOKEN_EXPIRED');
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message || `Spotify ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function spotifyPut(path, token, body) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 204 || res.status === 202) return null;
  if (res.status === 401) throw new Error('TOKEN_EXPIRED');
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message || `Spotify ${res.status}`);
  }
  return null;
}

async function ensureFreshToken(session) {
  if (Date.now() < session.tokenExp - 60_000) return;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: session.refreshToken,
      client_id:     session.clientId,
    }),
  });

  if (!res.ok) throw new Error('TOKEN_EXPIRED');

  const data = await res.json();
  session.accessToken = data.access_token;
  session.tokenExp    = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) session.refreshToken = data.refresh_token;
}

/* ================================================================
   WATCHDOG
   ================================================================ */
async function snapBack(sessionId, session, playback) {
  session.snapCooldown = true;
  const { trackUris, trackIndex } = session;
  const deviceId = playback?.device?.id;
  const path = `/me/player/play${deviceId ? `?device_id=${deviceId}` : ''}`;

  try {
    await spotifyPut(path, session.accessToken, {
      uris: trackUris.slice(trackIndex),
      position_ms: 0,
    });
    console.log(`[${sessionId}] snapped back → track ${trackIndex}`);
  } catch (e) {
    console.warn(`[${sessionId}] snap-back failed: ${e.message}`);
  }

  setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s) s.snapCooldown = false;
  }, 3000);
}

async function watchdogTick(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  try {
    await ensureFreshToken(session);
    const playback = await spotifyGet('/me/player', session.accessToken);
    if (!playback) return;

    // Podcast — always snap back
    if (playback.currently_playing_type === 'episode') {
      if (playback.is_playing && !session.snapCooldown) {
        await snapBack(sessionId, session, playback);
      }
      return;
    }

    if (!playback.item || !playback.is_playing) return;

    const currentUri  = playback.item.uri;
    const { trackUris, trackIndex } = session;
    const expectedUri = trackUris[trackIndex];
    const nextUri     = trackUris[trackIndex + 1];

    if (currentUri === expectedUri) {
      // On correct track
    } else if (currentUri === nextUri) {
      const prev    = session.lastProgress;
      const nearEnd = prev && prev.uri === expectedUri && prev.duration_ms > 0
        && (prev.duration_ms - prev.progress_ms) < 10_000;

      if (nearEnd) {
        session.trackIndex = trackIndex + 1;
        console.log(`[${sessionId}] natural advance → track ${session.trackIndex}`);
      } else {
        if (!session.snapCooldown) await snapBack(sessionId, session, playback);
      }
    } else {
      if (!session.snapCooldown) await snapBack(sessionId, session, playback);
    }

    session.lastProgress = {
      uri:         currentUri,
      progress_ms: playback.progress_ms,
      duration_ms: playback.item?.duration_ms ?? 0,
    };

  } catch (e) {
    if (e.message === 'TOKEN_EXPIRED') {
      console.warn(`[${sessionId}] token expired — stopping session`);
      clearInterval(session.timer);
      sessions.delete(sessionId);
    } else {
      console.error(`[${sessionId}] watchdog error: ${e.message}`);
    }
  }
}

/* ================================================================
   API
   ================================================================ */
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.post('/api/lock', (req, res) => {
  const { accessToken, refreshToken, tokenExp, clientId, trackUris, trackIndex, albumName, albumArt } = req.body;

  if (!accessToken || !refreshToken || !clientId || !trackUris?.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sessionId = crypto.randomUUID();
  const session = {
    accessToken,
    refreshToken,
    tokenExp:     tokenExp || Date.now() + 3_600_000,
    clientId,
    trackUris,
    trackIndex:   trackIndex ?? 0,
    albumName,
    albumArt,
    snapCooldown: false,
    lastProgress: null,
  };

  session.timer = setInterval(() => watchdogTick(sessionId), 2000);
  sessions.set(sessionId, session);

  console.log(`[${sessionId}] locked — ${trackUris.length} tracks`);
  res.json({ sessionId });
});

app.post('/api/unlock', (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (session) {
    clearInterval(session.timer);
    sessions.delete(sessionId);
    console.log(`[${sessionId}] unlocked`);
  }
  res.json({ ok: true });
});

app.get('/api/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.json({ locked: false });
  res.json({
    locked:     true,
    trackIndex: session.trackIndex,
    trackCount: session.trackUris.length,
    albumName:  session.albumName,
    albumArt:   session.albumArt,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Queue Locker server on :${PORT}`));
