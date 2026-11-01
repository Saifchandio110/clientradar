// Rule-based detection for Discord messages. Read-only: this file only scores text.
// It reuses the Bluesky rules from scoring.js and adds rules for how people write in Discord chat.
import { POSITIVE, NEGATIVE, detectCategory } from "./scoring.js";

const MIN_LENGTH = 12;
const MAX_LENGTH = 1200;

// Questions like "Who is open for commissions?" come from a client, while the same words in a
// statement ("I'm open for commissions") come from an artist advertising. These are told apart here.
const ASKING_WHO_OPEN = /\b(?:who(?:'|’)?s|who is|who are|anyone|anybody)\b[^.!?\n]{0,20}\b(?:open|taking|accepting|available)\b[^.!?\n]{0,15}\bcommissions?\b/i;

// Recommendation questions are MEDIUM at most: they are asking around, not hiring yet.
const RECOMMENDATION_QUESTION = /\b(?:where (?:can|could|do|should) (?:i|we)|can (?:anyone|anybody|someone|somebody) recommend|(?:does|do) (?:anyone|anybody|someone|somebody)\b[^.!?\n]{0,15}\b(?:know|have)|any (?:recommendations?|recs?|suggestions?))\b/i;

const EXPLICIT_PAY = /(?:\b(?:paid|paying|pay you|payment|budget|usd|dollars)\b|[$£€]\s?\d)/i;

const EXTRA_POSITIVE = [
  { re: ASKING_WHO_OPEN, w: 6, strong: true, label: "asking who is open for commissions" },
  { re: /\b(?:draw|design|make|create|illustrate|paint)\b[^.!?\n]{0,20}\b(?:my|our)\b/i, w: 2, label: "wants something made for them" },
  { re: /\bfor (?:my|our)\b[^.!?\n]{0,30}\b(?:oc|ocs|character|characters|book|cover|logo|game|channel|stream|podcast|band|brand|business|project|comic|story|novel|vtuber|model|emotes?)\b/i, w: 2, label: "a project of their own" },
  { re: /\b(?:does|do|did) (?:anyone|anybody|someone|somebody)\b[^.!?\n]{0,15}\b(?:know|have)\b[^.!?\n]{0,30}\b(?:artist|illustrator|designer|animator)\b/i, w: 4, label: "asking if anyone knows an artist" },
  { re: /\bwhere (?:can|could|do|should) (?:i|we)\b[^.!?\n]{0,25}\b(?:commission|hire|find|get)\b[^.!?\n]{0,30}\b(?:art|artist|illustrat\w*|designer?|logo|cover|character|oc|emotes?)\b/i, w: 4, label: "asking where to commission or hire" },
  { re: /\b(?:affordable|cheap|low[- ]cost|reasonably priced|price range)\b/i, w: 1, label: "mentions cost" }
];

const EXTRA_NEGATIVE = [
  { re: /\b(?:my|our) (?:portfolio|prices|price list|rates|commission sheet|carrd|twitter|instagram|socials)\b|\b(?:check out|come see|look at) my\b/i, w: -6, label: "advertising their own work or links" },
  { re: /\bslots? (?:are )?(?:open|available)\b|\b(?:now )?(?:open|accepting)\b[^.!?\n]{0,10}\b(?:slots?|requests)\b/i, w: -8, label: "artist advertising open slots" },
  { re: /\b(?:for free|free of charge|unpaid|for exposure|collab only|collaboration)\b/i, w: -6, label: "asks for free or unpaid work" }
];

// Hints from the channel name. Names like "looking-for-artist" suggest requests, "self-promo" suggests ads.
const CHANNEL_REQUEST = /(?:looking|lf-?artist|request|hire|hiring|wanted|\bjobs?\b|gigs?|client)/i;
const CHANNEL_ADS = /(?:for-?hire|commissions?-?open|open-?commissions|self-?promo|promo|advert|portfolio|showcase|art-?share|my-?art|your-?art)/i;

// Turn Discord markup (mentions, emoji) into plain readable text.
export function cleanDiscordText(s) {
  return String(s || "")
    .replace(/<@[!&]?\d+>/g, "@user")
    .replace(/<#\d+>/g, "#channel")
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns a reason string if this message should never be scored, otherwise null.
export function skipReason(msg) {
  if (!msg || typeof msg !== "object") return "invalid message";
  if (msg.author && msg.author.bot) return "sent by a bot";
  if (msg.webhook_id) return "sent by a webhook";
  if (msg.type !== 0 && msg.type !== 19) return "system message";
  const text = cleanDiscordText(msg.content);
  if (!text) return "no text (message content may be unavailable: check the Message Content Intent)";
  if (text.length < MIN_LENGTH) return "too short";
  if (text.length > MAX_LENGTH) return "too long to be a quick request";
  return null;
}

// msg: a Discord message object. cfg: { excluded: [], keywords: [], minScore }. channel: { name }.
export function scoreDiscordMessage(msg, cfg, channel) {
  const why = skipReason(msg);
  if (why) return { skip: true, reason: why };

  const text = cleanDiscordText(msg.content);
  const lower = text.toLowerCase();
  const askingWho = ASKING_WHO_OPEN.test(text);

  // Excluded phrases. A "who is open for commissions?" question is exempt from the advertising phrases.
  for (const phrase of cfg.excluded || []) {
    const p = String(phrase || "").toLowerCase();
    if (!p) continue;
    if (askingWho && p.includes("commission")) continue;
    if (lower.includes(p)) return { skip: true, reason: "excluded phrase: " + phrase };
  }

  let score = 0;
  let strong = false;
  const reasons = [];
  const add = (r) => {
    if (!r.re.test(text)) return;
    score += r.w;
    reasons.push(r.label + (r.w > 0 ? " (+" + r.w + ")" : " (" + r.w + ")"));
    if (r.strong) strong = true;
  };

  for (const r of POSITIVE) add(r);
  for (const r of EXTRA_POSITIVE) add(r);
  for (const r of NEGATIVE) {
    // The advertising rule must not punish the question form "who is open for commissions?"
    if (askingWho && r.label === "artist advertising services") continue;
    add(r);
  }
  for (const r of EXTRA_NEGATIVE) add(r);

  // Your own configured keywords add a small boost.
  for (const k of cfg.keywords || []) {
    const kw = String(k || "").toLowerCase();
    if (kw && lower.includes(kw)) { score += 3; reasons.push('matches your keyword "' + k + '" (+3)'); break; }
  }

  // Channel name hints.
  const cname = channel && channel.name ? String(channel.name) : "";
  if (cname && CHANNEL_ADS.test(cname)) { score -= 10; reasons.push("posted in an advertising channel (-10)"); }
  else if (cname && CHANNEL_REQUEST.test(cname)) { score += 2; reasons.push("posted in a requests channel (+2)"); }

  if (msg.type === 19) { score -= 2; reasons.push("a reply in a thread of conversation (-2)"); }

  let intent = "low";
  if (strong && score >= 7) intent = "high";
  else if (score >= 4) intent = "medium";
  // Asking around for recommendations is never "definitely hiring".
  if (intent === "high" && RECOMMENDATION_QUESTION.test(text)) {
    intent = "medium";
    reasons.push("asking for recommendations, so capped at medium");
  }

  return {
    skip: false,
    score: score,
    intent: intent,
    reasons: reasons,
    category: detectCategory(lower),
    // Only claim a payment signal when the message itself says so.
    pay_signal: EXPLICIT_PAY.test(text) ? "stated" : "not stated",
    text: text,
    qualifies: score > 0 && score >= (Number.isFinite(cfg.minScore) ? cfg.minScore : 4)
  };
}
