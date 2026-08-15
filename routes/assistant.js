const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const assistant = require('../services/assistant');

// This endpoint is public — anyone on the website can reach it, and every call
// costs money at OpenAI. Two guards: per-visitor rate limit, and a hard daily
// ceiling so a bot hammering the page can never run the AI budget down.
const perVisitor = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: true, reply: '', handoff: true, ai: false, throttled: true }
});

const DAILY_CAP = Number(process.env.ASSISTANT_DAILY_CAP || 2000);
let dayKey = '';
let dayCount = 0;

function underDailyCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  if (dayCount >= DAILY_CAP) return false;
  dayCount++;
  return true;
}

const LANGS = ['ht', 'fr', 'en', 'es'];

// POST /api/assistant/chat  { messages: [{role, content}], lang }
router.post('/chat', perVisitor, async (req, res) => {
  try {
    const lang = LANGS.indexOf(req.body.lang) >= 0 ? req.body.lang : 'ht';
    const incoming = Array.isArray(req.body.messages) ? req.body.messages : [];

    // Only the last 12 turns, only the two roles the API accepts, and each turn
    // capped — the client sends the whole visible conversation back every time.
    const history = incoming
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 1000) }))
      .filter(m => m.content.trim());

    if (!history.length || history[history.length - 1].role !== 'user') {
      return res.status(400).json({ success: false, message: 'No question to answer' });
    }

    if (!underDailyCap()) {
      return res.json(Object.assign({ success: true, throttled: true }, {
        reply: '', handoff: true, ai: false
      }));
    }

    const answer = await assistant.ask(history, lang);
    res.json(Object.assign({ success: true, whatsapp: assistant.SUPPORT_WHATSAPP }, answer));
  } catch (error) {
    console.error('Assistant chat error:', error);
    res.status(500).json({ success: false, message: 'Assistant unavailable' });
  }
});

// GET /api/assistant/status — is the assistant actually able to answer right now?
// Used to check a deploy without spending a token.
router.get('/status', (req, res) => {
  res.json({
    success: true,
    ai: Boolean(process.env.OPENAI_API_KEY),
    dailyCap: DAILY_CAP,
    usedToday: dayKey === new Date().toISOString().slice(0, 10) ? dayCount : 0
  });
});

module.exports = router;
