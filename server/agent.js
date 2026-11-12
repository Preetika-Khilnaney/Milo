// The Milo shopping & payments agent.
// It searches the catalog, asks the engine for a risk-aware payment plan, and proposes a
// checkout that the user must confirm. It never moves money without an explicit confirmation.
const ai = require("./ai");
const catalog = require("./catalog");
const engine = require("./engine");

const SYSTEM_PROMPT = `You are Milo, a friendly AI checkout agent that lives inside a PayPal wallet.
Your job: help the user buy things safely and cheaply, and help them get more out of their balance.

How you work:
- Use search_products to find items. Compare merchants on price AND trust, not price alone.
- Before recommending a purchase, ALWAYS call prepare_checkout for the item you recommend. It returns
  a risk assessment and a payment plan computed by the platform. Never invent numbers; only use numbers
  returned by tools.
- Payment routes: "PYUSD" (pay from the user's PayPal USD stablecoin balance: instant, cheapest for the
  platform, user earns cashback) or "PAYPAL_CHECKOUT" (card or PayPal via standard checkout).
- Protection: "ESCROW" locks PYUSD in a smart contract until delivery is verified; "AUTHORIZE_THEN_CAPTURE"
  places a PayPal authorization hold that is only captured after delivery is verified.
- If a cheaper item comes from a risky merchant, say so plainly and explain how protection covers it.
- If the user reports a problem with an order (damaged, missing, wrong item), call report_problem.
- If the user asks about saving, idle money, or rewards, call get_insights.
- The user confirms a checkout by pressing the Confirm button on the card you prepared. Do not claim a
  payment happened unless a tool result says so.
Style: concise, friendly, concrete. 2-5 short sentences. Use $ amounts. No markdown tables.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search the merchant network for products. Returns items with price and merchant trust signals.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What the user wants, e.g. 'noise cancelling headphones'" },
          max_price: { type: "number", description: "Optional budget in USD" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_checkout",
      description:
        "Compute risk + the optimal payment route and protection for one product, and show the user a checkout card to confirm.",
      parameters: {
        type: "object",
        properties: { product_id: { type: "string" } },
        required: ["product_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_wallet",
      description: "Get the user's PYUSD balance, idle PayPal balance and cashback earned.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_orders",
      description: "List the user's recent orders with payment route, protection and status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "report_problem",
      description: "Open a delivery claim on an order. The verification agent reviews evidence and refunds or releases.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Order id; omit to use the most recent open order" },
          description: { type: "string", description: "What went wrong, in the user's words" },
        },
        required: ["description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_insights",
      description: "Get idle-balance and rewards insights plus value created so far.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const slimProduct = (p) => ({
  id: p.id,
  name: p.name,
  price: p.price,
  merchant: p.merchant.name,
  merchant_rating: p.merchant.rating,
  merchant_age_months: p.merchant.accountAgeMonths,
  merchant_dispute_rate: p.merchant.disputeRate,
  cross_border: p.merchant.crossBorder,
});

class Agent {
  /** @param {object} deps { store, chain, services } */
  constructor(deps) {
    this.deps = deps;
    this.history = [];
  }

  reset() {
    this.history = [];
  }

  async runTool(name, args, cards) {
    const { store, services } = this.deps;
    switch (name) {
      case "search_products": {
        const results = catalog.searchProducts(args.query, args.max_price);
        cards.push({ type: "products", items: results.map(slimProduct) });
        return { results: results.map(slimProduct) };
      }
      case "prepare_checkout": {
        const product = catalog.getProduct(args.product_id);
        if (!product) return { error: "unknown product_id" };
        const wallet = await services.wallet();
        const plan = engine.planPayment(product, wallet, store.user);
        const proposal = store.addProposal(plan);
        cards.push({ type: "checkout", proposal });
        return { proposal_id: proposal.id, ...plan, note: "Card shown to user; waiting for Confirm." };
      }
      case "get_wallet":
        return await services.wallet();
      case "list_orders":
        return { orders: store.orders.slice(-8).map(services.orderSummary) };
      case "report_problem": {
        const order = args.order_id ? store.getOrder(args.order_id) : store.latestOpenOrder();
        if (!order) return { error: "No open order found to report a problem on." };
        const result = await services.resolveDelivery(order.id, {
          type: "buyer_claim",
          claim: args.description,
        });
        cards.push({ type: "resolution", orderId: order.id, result });
        return result;
      }
      case "get_insights":
        return await services.insights();
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  async respond(userText) {
    const cards = [];
    if (!ai.enabled()) {
      const reply = await this.offline(userText, cards);
      return { reply, cards, aiMode: "offline" };
    }

    // History is kept as whole turns (user msg + tool calls + results + reply) so tool context
    // such as product ids carries over, and a turn is never split mid tool-call.
    const turn = [{ role: "user", content: userText }];
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...this.history.slice(-6).flat(), ...turn];
    const commit = (reply) => {
      turn.push({ role: "assistant", content: reply });
      this.history.push(turn);
      this.history = this.history.slice(-6);
    };

    try {
      for (let step = 0; step < 6; step++) {
        const msg = await ai.chat(messages, { tools: TOOLS });
        const toolCalls = msg.tool_calls || [];
        if (!toolCalls.length) {
          const reply = (msg.content || "").trim() || "Done.";
          commit(reply);
          return { reply, cards, aiMode: ai.MODEL };
        }
        const callMsg = { role: "assistant", content: msg.content || "", tool_calls: toolCalls };
        messages.push(callMsg);
        turn.push(callMsg);
        for (const tc of toolCalls) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {}
          let result;
          try {
            result = await this.runTool(tc.function.name, args, cards);
          } catch (e) {
            result = { error: e.message };
          }
          const toolMsg = { role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) };
          messages.push(toolMsg);
          turn.push(toolMsg);
        }
      }
      commit("I've prepared the details above.");
      return { reply: "I've prepared the details above.", cards, aiMode: ai.MODEL };
    } catch (e) {
      console.error("[agent] LLM failed, using offline fallback:", e.message);
      const reply = await this.offline(userText, cards);
      return { reply, cards, aiMode: "offline (LLM error)" };
    }
  }

  // ---------- Rule-based fallback so the demo still works without an API key ----------
  async offline(text, cards) {
    const t = text.toLowerCase();
    if (/(damag|broken|never arrived|didn.?t arrive|not arrived|missing|wrong item|lost|fake|scam)/.test(t)) {
      const r = await this.runTool("report_problem", { description: text }, cards);
      if (r.error) return r.error;
      return `I opened a claim. Verification result: ${r.decision.toUpperCase()} — ${r.reasoning}`;
    }
    if (/(idle|save|saving|earn|reward|interest|yield)/.test(t)) {
      const ins = await this.runTool("get_insights", {}, cards);
      cards.push({ type: "insight", insight: ins.idle });
      return `You have $${ins.idle.idleBalance} sitting idle in your PayPal balance. Moving it to PYUSD could earn about $${ins.idle.projectedYearlyRewards}/year at the illustrative ${(ins.idle.rewardsApy * 100).toFixed(1)}% rewards rate, and lets me pay for future orders at lower cost with cashback.`;
    }
    if (/(order|status|track)/.test(t)) {
      const { orders } = await this.runTool("list_orders", {}, cards);
      if (!orders.length) return "You don't have any orders yet.";
      return "Your recent orders:\n" + orders.map((o) => `• ${o.id}: ${o.product} — ${o.status}`).join("\n");
    }
    const budget = t.match(/(?:under|below|less than|max|budget)\s*\$?\s*(\d+)/);
    const { results } = await this.runTool("search_products", { query: text, max_price: budget ? Number(budget[1]) : undefined }, cards);
    if (!results.length) return "I couldn't find anything matching that. Try headphones, keyboard, monitor, chair, tent or smartwatch.";
    const best = results[0];
    const plan = await this.runTool("prepare_checkout", { product_id: best.id }, cards);
    const others = results.slice(1, 3).map((r) => `${r.name} from ${r.merchant} ($${r.price})`);
    let msg = `Best match: ${best.name} from ${best.merchant} for $${best.price}. Risk is ${plan.risk.level} (${plan.risk.score}/100).`;
    if (plan.route === "PYUSD")
      msg += ` I'll pay from your PYUSD balance${plan.protection === "ESCROW" ? " and lock it in escrow until delivery is verified" : ""}, earning you $${plan.economics.userCashback} cashback.`;
    else msg += ` Your PYUSD balance is short by $${plan.shortfall}, so I'll use PayPal checkout${plan.protection !== "NONE" ? " with an authorization hold until delivery is verified" : ""}.`;
    if (others.length) msg += ` Also considered: ${others.join("; ")}.`;
    return msg;
  }
}

module.exports = { Agent, SYSTEM_PROMPT, TOOLS };
