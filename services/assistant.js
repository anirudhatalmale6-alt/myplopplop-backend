// Public site assistant — the chat bubble on myplopplop.com talks to this.
//
// Deliberately grounded: everything the assistant is allowed to state as fact
// lives in KNOWLEDGE below, taken from help.html. Anything outside it must be
// handed to a human on WhatsApp rather than guessed, because an invented
// delivery time or price costs the business a customer.
const https = require('https');

const MODEL = 'gpt-4o-mini';
const SUPPORT_WHATSAPP = '50946859702';

const KNOWLEDGE = `
BRANDS
- MyPlopPlop (myplopplop.com): Haiti's marketplace. Shop from local stores, delivery in Haiti,
  and diaspora abroad can order for family in Haiti. Also: San Cash wallet, Sol savings, rides.
- MsouWout (msouwout.com): ride-hailing, moto and car. Currently in soft launch — riders can
  register and request, and the team contacts them as drivers are activated in their zone.
- HaitiBiznis (haitibiznis.com): the parent company; events, tickets, POS, business services.
- Koutye Biznis: broker / ambassador programme, you earn commission for bringing in businesses
  and drivers.
- 48HoursReady: business creation packages (logo, documents, website, videos).

ORDERING ON MYPLOPPLOP
- Browse stores by category or search, add to cart, choose delivery address, choose payment,
  confirm. Order status updates in the Orders tab, with live tracking of the rider.
- Payment methods: San Cash wallet, credit/debit card (Visa, Mastercard), mobile money
  (MonCash, Natcom), and cash on delivery for local orders. Diaspora can pay by international card.
- Delivery fee depends on distance and merchant, usually between 50 and 250 HTG. Some merchants
  offer free delivery above a certain amount.
- New customers: code WELCOME10 gives 10% off the first order.

DIASPORA
- Someone abroad (USA, Canada, France...) can order groceries, medicine or food for family in
  Haiti. Add the recipient's address and phone, pay from abroad, they receive it at their door.
  Recipients can be saved for reordering.

SAN CASH WALLET
- Built-in digital wallet. Top up by card, mobile money or bank transfer, then one-tap checkout.
  Can receive funds from family abroad and transfer balance to other MyPlopPlop users.

REFUNDS
- Report a problem from Orders > select the order > Report Issue, within 24 hours of delivery.
  Support reviews it and refunds usually take 1 to 2 business days, to the wallet or the original
  payment method.

BECOMING A MERCHANT
- Sign up for a merchant account, give business name, location and category, add your products,
  submit for verification. Approval usually 24 to 48 hours. Then the store is live and the
  merchant dashboard manages orders, products and earnings.

BECOMING A RIDER / DRIVER
- Sign up as a rider with a valid ID, proof of vehicle (moto or car) and a phone number. After
  verification you can accept deliveries, earn per delivery plus tips, and cash out to the wallet
  or mobile money.

REFERRALS
- Every user has a referral code on their Account page. 5% on sales from a referred business,
  2% on earnings from a referred driver, once they are approved and active. No limit.

SUPPORT
- WhatsApp is the fastest channel, 7am to 10pm daily: +509 4685 9702.
`;

const SYSTEM_PROMPT = `You are the assistant on the MyPlopPlop website, part of the HaitiBiznis
family of businesses in Haiti. You help visitors understand the services and get started.

LANGUAGE — the rule that matters most
- ALWAYS reply in the same language the visitor used in their LAST message. If they wrote English,
  reply in English. French, French. Spanish, Spanish. Haitian Creole, Creole.
- This holds even when they switch language halfway through the conversation: follow the switch
  immediately, do not go back to the earlier language.
- Only when the message is too short to tell (a greeting, a number) fall back to the site language
  given below.
- Write the way people actually speak, not like a manual.

STYLE
- Short. Two or three sentences is usually enough. Never more than 500 characters.
- Warm and direct. A little emoji is fine, not in every sentence.
- Ask one question at a time when you need something from them.

WHAT YOU MAY SAY
- Only the facts in the KNOWLEDGE block below. That is the whole of what you know.
- You must NEVER invent a price, a delivery time, an address, a phone number, a promotion, a
  product, or whether a particular shop or driver exists. If you do not know, say so plainly and
  offer to pass them to the team on WhatsApp +509 4685 9702.
- Never claim to have placed an order, cancelled an order, issued a refund, or checked an account.
  You cannot do any of those. Tell them where on the site to do it, or hand them to WhatsApp.
- If someone is angry, has lost money, or has an order problem, do not try to solve it yourself.
  Apologise briefly and hand them to WhatsApp.

HANDOFF
- End your reply with the tag [HANDOFF] whenever a person should take over. The website turns that
  tag into a WhatsApp button, so the visitor can reach a human in one tap.
- Always add it when: you do not know the answer, you had to say you cannot check something, the
  visitor has an order/money/refund problem, they are upset, or they ask for a specific price,
  stock level or shop that is not in your knowledge.
- Write the tag once, at the very end, and never mention the tag itself in your text.

KNOWLEDGE
${KNOWLEDGE}`;

const LANG_NAME = { ht: 'Haitian Creole', fr: 'French', en: 'English', es: 'Spanish' };

// Asking the model to "match the visitor's language" was not reliable enough on
// its own: after a Creole exchange it kept answering an English question in
// Creole. So the language of the last message is decided here, in code, and
// handed to the model as an instruction rather than a hope.
const MARKERS = {
  en: ['the', 'how', 'what', 'do', 'does', 'i', 'my', 'you', 'your', 'can', 'need', 'want', 'is',
       'are', 'order', 'delivery', 'price', 'please', 'thanks', 'hello', 'much', 'and', 'for',
       'with', 'when', 'where', 'why', 'send', 'buy', 'help', 'about', 'have', 'documents'],
  fr: ['bonjour', 'comment', 'je', 'vous', 'merci', 'commande', 'combien', 'est-ce', 'quel',
       'quelle', 'livraison', 'prix', 'les', 'des', 'une', 'mon', 'ma', 'pour', 'avec', 'faire',
       'puis-je', 'votre', 'nous', 'sur', 'dans', 'qui', 'que', 'pas', 'plus', 'aide'],
  es: ['hola', 'cómo', 'como', 'qué', 'que', 'puedo', 'pedido', 'gracias', 'cuánto', 'cuanto',
       'los', 'las', 'una', 'mi', 'para', 'con', 'hacer', 'necesito', 'quiero', 'dónde', 'donde',
       'por', 'favor', 'entrega', 'precio', 'ayuda', 'usted', 'está', 'muy'],
  ht: ['mwen', 'ou', 'kijan', 'konbyen', 'nan', 'yon', 'gen', 'sa', 'mèsi', 'kòman', 'vle', 'pa',
       'ki', 'pou', 'ak', 'li', 'yo', 'nou', 'fè', 'jan', 'bezwen', 'lajan', 'kote', 'lè', 'anpil',
       'byen', 'tanpri', 'machann', 'boutik', 'kounye', 'ap', 'se', 'te', 'eske', 'èske',
       'livrezon', 'koute', 'achte', 'vann', 'voye', 'peye', 'kilè', 'kisa', 'poukisa', 'ede',
       'chofè', 'kliyan', 'kòb', 'goud', 'jodi', 'toujou', 'genyen', 'mande', 'louvri']
};

function detectLang(text, fallback) {
  const t = String(text || '').toLowerCase();
  if (/[¿¡ñ]/.test(t)) return 'es';

  const words = t.match(/[a-zàâçéèêëîïôùûüÿñæœ'-]+/g) || [];
  if (words.length < 2) return fallback;

  const score = { en: 0, fr: 0, es: 0, ht: 0 };
  for (const w of words) {
    for (const lang of Object.keys(MARKERS)) {
      if (MARKERS[lang].indexOf(w) >= 0) score[lang]++;
    }
  }

  let best = fallback;
  let bestScore = 0;
  for (const lang of Object.keys(score)) {
    if (score[lang] > bestScore) { bestScore = score[lang]; best = lang; }
  }
  // One stray shared word ("pa", "que") is not evidence of a language switch —
  // unless it is the only hit in a short question, which is what most real
  // questions look like ("Konbyen livrezon an koute?").
  if (bestScore >= 2) return best;
  const others = Object.keys(score).filter(l => l !== best).every(l => score[l] === 0);
  if (bestScore === 1 && others && words.length <= 6) return best;
  return fallback;
}

function callOpenAI(key, messages, lang) {
  return new Promise(function (resolve, reject) {
    const last = messages.length ? messages[messages.length - 1].content : '';
    const replyLang = detectLang(last, lang);

    const system = SYSTEM_PROMPT +
      '\n\nREPLY LANGUAGE: write your entire reply in ' + (LANG_NAME[replyLang] || LANG_NAME.ht) +
      '. This is not a suggestion — the visitor wrote their last message in that language.';

    // The language rule is repeated immediately after the conversation as well.
    // With it only at the top, a Creole exchange kept pulling replies back into
    // Creole after the visitor switched to English mid-chat.
    const tail = {
      role: 'system',
      content: 'Answer the message above in ' + (LANG_NAME[replyLang] || LANG_NAME.ht) +
        ', whatever language the earlier messages were in. Keep it short.'
    };

    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      temperature: 0.4,
      messages: [{ role: 'system', content: system }].concat(messages, [tail])
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { return reject(new Error('bad json from openai')); }
        if (res.statusCode >= 400) {
          return reject(new Error('openai ' + res.statusCode + ': ' + ((parsed.error && parsed.error.message) || raw.slice(0, 200))));
        }
        const text = parsed.choices && parsed.choices[0] && parsed.choices[0].message
          ? parsed.choices[0].message.content : '';
        resolve(text || '');
      });
    });

    req.on('timeout', function () { req.destroy(new Error('openai timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Said when the assistant cannot answer at all (no key, API down, rate limited).
// It never pretends — it points at a human.
const FALLBACK = {
  ht: 'Mèsi pou mesaj ou! Pou kesyon sa a, pi bon fason an se pale ak yon moun nan ekip nou an sou WhatsApp. 🙏',
  fr: "Merci pour votre message ! Pour cette question, le mieux est d'écrire à notre équipe sur WhatsApp. 🙏",
  en: 'Thanks for your message! For this one the quickest way is to talk to our team on WhatsApp. 🙏',
  es: '¡Gracias por tu mensaje! Para esto lo mejor es hablar con nuestro equipo por WhatsApp. 🙏'
};

function fallbackReply(lang) {
  return { reply: FALLBACK[lang] || FALLBACK.ht, handoff: true, ai: false };
}

async function ask(history, lang) {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return fallbackReply(lang);

  try {
    const raw = await callOpenAI(key, history, lang);
    const handoff = /\[HANDOFF\]/i.test(raw);
    const reply = raw.replace(/\[HANDOFF\]/gi, '').trim();
    if (!reply) return fallbackReply(lang);
    return { reply: reply, handoff: handoff, ai: true };
  } catch (err) {
    console.error('Assistant error:', err.message);
    return fallbackReply(lang);
  }
}

module.exports = { ask, detectLang, SUPPORT_WHATSAPP };
