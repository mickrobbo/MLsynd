// netlify/functions/google-tts.js
// Calls Google Cloud Text-to-Speech and returns base64-encoded MP3 audio
// for the client to play. Replaces the earlier browser-native
// speechSynthesis approach for Syndy Voice — that had no server cost
// and no API key, but voice quality/character varied wildly by device
// and browser since it used whatever voice the person's phone shipped
// with. This is a real, consistent AI voice instead, at the cost of
// needing this server call.
//
// Needs a NEW env var not used by any other function in this project:
// GOOGLE_TTS_API_KEY — a Google Cloud API key with the Text-to-Speech
// API enabled on a project with billing set up (the free tier covers
// 1M characters/month of WaveNet-quality voices before any charge,
// which should be well beyond what this feature actually uses).
//
// No auth/session verification here, deliberately — unlike the other
// functions in this project, this doesn't touch Firebase, doesn't
// award anything, and doesn't identify who's calling. Worth knowing:
// this means anyone who discovers the endpoint URL could call it and
// consume free-tier quota. Given the free tier is generous (1M
// characters/month) and this app's actual usage is light, that's an
// acceptable risk — but if the deployed URL becomes broadly known and
// this becomes a problem, adding the same idToken verification pattern
// the other functions use is a small follow-up change, not a rebuild.

const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), { status: 500 });
  }

  try {
    const { text } = await req.json();
    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing text' }), { status: 400 });
    }
    // A hard cap, not just good practice — without one, a much longer
    // string than this feature is ever meant to speak would still get
    // billed per character with no client-side limit stopping it.
    const trimmedText = text.slice(0, 500);

    const res = await fetch(`${GOOGLE_TTS_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: trimmedText },
        // WaveNet — free tier covers 1M characters/month at this
        // quality tier, a clear step up from Standard voices and the
        // tier this project's free-tier decision was actually based on.
        voice: { languageCode: 'en-AU', name: 'en-AU-Wavenet-B' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.05 },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('Google TTS error:', res.status, errBody);
      return new Response(JSON.stringify({ error: 'TTS request failed' }), { status: 502 });
    }

    const data = await res.json();
    if (!data.audioContent) {
      return new Response(JSON.stringify({ error: 'No audio returned' }), { status: 502 });
    }

    return new Response(JSON.stringify({ audioContent: data.audioContent }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
