// Cheap rule-based router: skips retrieval only when a message is obviously
// chit-chat. False negatives (skipping when memory was needed) hurt more than a
// wasted search, so anything ambiguous retrieves.

const SMALL_TALK = /^(hi+|hey+|hello+|yo|sup|thanks?( you)?|thx|ty|ok(ay)?|k|cool|nice|great|good|lol|haha+|yes|yeah|yep|no|nope|bye|good ?(night|morning|evening)|see (you|ya)|gm|gn)[\s!.?]*$/i;

export interface RouteDecision {
  retrieve: boolean;
  reason: string;
}

export function route(text: string, hasMemory: boolean): RouteDecision {
  if (!hasMemory) return { retrieve: false, reason: 'no stored memory yet' };
  const t = text.trim();
  if (SMALL_TALK.test(t)) return { retrieve: false, reason: 'small talk' };
  return { retrieve: true, reason: 'default' };
}
