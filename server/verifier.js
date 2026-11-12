// Delivery verification agent: decides whether held funds go to the merchant or back to the buyer.
const ai = require("./ai");

const VERIFIER_PROMPT = `You are the delivery verification agent for a payments platform.
Funds for an order are held (in a PYUSD smart-contract escrow or a PayPal authorization hold).
Decide from the evidence whether to RELEASE funds to the merchant, REFUND the buyer, or send the case to
human REVIEW. Be fair to both sides:
- Carrier-confirmed delivery with no credible buyer complaint -> release.
- Carrier reports lost / returned to sender / no movement past the delivery window -> refund.
- Buyer reports damage or wrong item: if supported by a photo or detailed description consistent with the
  order, refund; if vague and the carrier shows delivered, review.
- Weigh merchant history (dispute rate, account age) as context, never as the only reason.
Respond with JSON only: {"decision":"release"|"refund"|"review","confidence":0-1,"reasoning":"one or two sentences"}`;

function ruleBased(order, events, evidence) {
  const types = events.map((e) => e.type);
  if (evidence.type === "carrier_lost" || types.includes("carrier_lost"))
    return { decision: "refund", confidence: 0.95, reasoning: "Carrier reported the parcel as lost, so the buyer is refunded." };
  if (evidence.type === "buyer_claim") {
    const c = (evidence.claim || "").toLowerCase();
    const delivered = types.includes("carrier_delivered");
    if (evidence.image || /(photo|picture|crack|shatter|broken|smashed|wrong item|different|counterfeit|fake|never arrived|didn.?t arrive|not arrived|missing)/.test(c)) {
      if (/(never arrived|didn.?t arrive|not arrived|missing)/.test(c) && delivered)
        return { decision: "review", confidence: 0.55, reasoning: "Carrier shows delivered but the buyer says it never arrived; sending to a human reviewer with funds frozen." };
      return { decision: "refund", confidence: 0.8, reasoning: "The buyer's claim is specific and consistent with the order, so funds are returned to the buyer." };
    }
    return { decision: "review", confidence: 0.5, reasoning: "The claim is vague; funds stay frozen while a reviewer checks it." };
  }
  if (evidence.type === "carrier_delivered")
    return { decision: "release", confidence: 0.9, reasoning: "Carrier confirmed delivery and there is no buyer complaint, so the merchant is paid." };
  return { decision: "review", confidence: 0.4, reasoning: "Not enough evidence to decide automatically." };
}

async function verify(order, merchant, events, evidence) {
  if (!ai.enabled()) return { ...ruleBased(order, events, evidence), engine: "rules" };

  const facts = {
    order: { id: order.id, product: order.product, amount: order.amount, protection: order.protection, placedAt: order.createdAt },
    merchant: { name: merchant.name, accountAgeMonths: merchant.accountAgeMonths, disputeRate: merchant.disputeRate, rating: merchant.rating, crossBorder: merchant.crossBorder },
    timeline: events.map((e) => ({ at: e.at, type: e.type, note: e.note || e.claim || "" })),
    newEvidence: { type: evidence.type, claim: evidence.claim || "", note: evidence.note || "", photoAttached: Boolean(evidence.image) },
  };
  const userContent = [{ type: "text", text: "Case file:\n" + JSON.stringify(facts, null, 2) }];
  if (evidence.image) userContent.push({ type: "image_url", image_url: { url: evidence.image } });

  try {
    const msg = await ai.chat(
      [
        { role: "system", content: VERIFIER_PROMPT },
        { role: "user", content: evidence.image ? userContent : userContent[0].text },
      ],
      { json: true, temperature: 0 }
    );
    const out = ai.parseJson(msg.content);
    if (!out || !["release", "refund", "review"].includes(out.decision)) throw new Error("bad verifier output");
    return { decision: out.decision, confidence: Number(out.confidence) || 0.5, reasoning: String(out.reasoning || ""), engine: ai.MODEL };
  } catch (e) {
    console.error("[verifier] LLM failed, using rules:", e.message);
    return { ...ruleBased(order, events, evidence), engine: "rules (LLM error)" };
  }
}

module.exports = { verify };
