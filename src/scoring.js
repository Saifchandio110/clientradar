export const DEFAULT_KEYWORDS = [
  "looking to commission", "need an artist", "looking for an artist",
  "looking for an illustrator", "can anyone recommend an artist",
  "need someone to draw", "looking for a character designer",
  "need an illustrator", "want to commission", "looking for a graphic designer",
  "need a logo designer", "need a book cover", "custom profile picture",
  "paid commission", "commission an artist"
];
export const DEFAULT_EXCLUDED = [
  "commissions open", "open for commissions", "taking commissions",
  "accepting commissions", "for hire", "dm for prices"
];
export const DEFAULT_MIN_SCORE = 4;

// Scoring weights: edit the numbers here to tune the app.
// strong: true marks a signal that can make a post HIGH intent (together with score 7+).
const POSITIVE = [
  { re: /\b(?:looking|searching|hunting|seeking|wanting|want|need|needing|hiring)\b[^.!?\n]{0,25}\b(?:to commission|to hire|commission an?|commission some|hire an?|hire some)/i, w: 3, label: "says they want to commission or hire" },
  { re: /\b(?:looking|searching|seeking|hiring|need|needing|want|wanting)\b[^.!?\n]{0,40}\b(?:artist|illustrator|designer|animator|cover artist)\b/i, w: 5, strong: true, label: "looking for an artist or designer" },
  { re: /\b(?:commission(?:ing)?|hire|hiring)\b[^.!?\n]{0,40}\b(?:art|artwork|artist|illustrat\w*|draw\w*|design\w*|logo|portrait|oc|ocs|character|emotes?|vtuber|cover|animation|sketch)\b/i, w: 4, strong: true, label: "commission or hire tied to art or design work" },
  { re: /\bwho (?:takes|does|is taking|is open for) commissions\b/i, w: 3, label: "asking who takes commissions" },
  { re: /\b(?:can|could|does) (?:anyone|someone|somebody)\b[^.!?\n]{0,30}\b(?:recommend|suggest|draw|design|make)\b/i, w: 3, label: "asking for recommendations or help" },
  { re: /\b(?:recommend(?:ations?)?|recs?|suggestions?)\b[^.!?\n]{0,40}\b(?:artist|illustrator|designer)\b/i, w: 3, label: "seeking recommendations" },
  { re: /(?:\b(?:paid|paying|budget|pay you)\b|[$£€]\s?\d)/i, w: 2, label: "mentions payment or budget" },
  { re: /\b(?:oc|ocs|character|fursona|vtuber|logo|book cover|cover art|profile picture|pfp|avatar|emotes?|mascot)\b/i, w: 1, label: "specific project type" }
];
const NEGATIVE = [
  { re: /\b(?:commissions? (?:are )?(?:open|closed)|open for commissions|taking commissions|accepting commissions|available for (?:hire|commissions?)|for hire|dm (?:me )?for (?:prices|rates|commissions?))\b/i, w: -8, label: "artist advertising services" },
  { re: /\b(?:commission|hire) (?:me|us)\b|\bmy (?:commissions?|shop|store|etsy|ko-?fi|patreon)\b|\bget in touch\b|\blink in bio\b|\bi made these\b/i, w: -8, label: "artist promoting their own work" },
  { re: /\b(?:not|never|no longer|stopped|(?:don|doesn|didn|isn|aren|wasn|won|can)(?:'|’)?t)\b[^.!?\n]{0,15}\b(?:looking|searching|hiring|seeking|need|want)\b/i, w: -8, label: "says they are NOT looking" },
  { re: /\b(?:are you|are u|you(?:'|’)?re|you are|if you|did you)\b[^.!?\n]{0,25}\b(?:looking|need|want|searching|hiring)\b/i, w: -8, label: "talking to someone else, not asking" },
  { re: /\b(?:they|he|she|the company|the brand|the studio|the team)\b[^.!?\n]{0,30}\b(?:decided to|chose to|hired|commissioned)\b/i, w: -5, label: "about someone else's commission" },
  { re: /\bi(?:'|’)?d be down\b|\bi can (?:draw|do|make|design)\b|\bi(?:'|’)?d love to (?:draw|design|do)\b|\bi(?:'|’)?m an? (?:artist|illustrator|designer)\b/i, w: -6, label: "offering their own help" },
  { re: /\bcommission (?:you|them|him|her|your|their|this|that)\b/i, w: -4, label: "talking about a specific artist" },
  { re: /\b(?:can(?:'|’)?t (?:afford|warrant)|cannot afford|someday|one day|wish i could|once the holidays|when i have (?:the )?money)\b/i, w: -3, label: "not ready to hire yet" },
  { re: /\b(?:tutorial|how to draw|speed ?paint|time-?lapse|art tips)\b/i, w: -4, label: "tutorial or process content" },
  { re: /\b(?:i (?:just )?(?:drew|painted|finished)|here(?:'|’)?s my|my (?:latest|new) (?:art|drawing|piece))\b/i, w: -3, label: "sharing own artwork" }
];

function detectCategory(t) {
  if (/book cover|cover art|novel cover|cover illustrator/.test(t)) return "Book cover";
  if (/\blogo|branding|brand identity/.test(t)) return "Logo and branding";
  if (/graphic design|flyer|poster|banner|business card/.test(t)) return "Graphic design";
  if (/\b(?:oc|ocs|character|fursona|vtuber|pfp|profile picture|avatar|emotes?)\b/.test(t)) return "Character art";
  if (/illustrat|artist|draw|commission/.test(t)) return "Illustration";
  return "Other";
}

// High needs a strong signal AND score 7+. Medium is 4+. Everything else is low.
export function scorePost(text, cfg, meta) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  for (const phrase of cfg.excluded) {
    if (phrase && lower.includes(String(phrase).toLowerCase())) {
      return { skip: true, reason: "excluded phrase: " + phrase };
    }
  }
  let score = 0;
  let strong = false;
  const reasons = [];
  for (const r of POSITIVE) {
    if (r.re.test(t)) {
      score += r.w;
      reasons.push(r.label + " (+" + r.w + ")");
      if (r.strong) strong = true;
    }
  }
  for (const r of NEGATIVE) {
    if (r.re.test(t)) { score += r.w; reasons.push(r.label + " (" + r.w + ")"); }
  }
  if (meta && meta.is_reply) { score -= 5; reasons.push("reply to another post (-5)"); }
  let intent = "low";
  if (strong && score >= 7) intent = "high";
  else if (score >= 4) intent = "medium";
  return { skip: false, score: score, intent: intent, reasons: reasons, category: detectCategory(lower) };
}
