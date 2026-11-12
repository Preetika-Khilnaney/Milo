require("dotenv").config({ quiet: true });
const path = require("path");
const express = require("express");

const { Chain } = require("./chain");
const { PayPal } = require("./paypal");
const { Store } = require("./store");
const { Agent } = require("./agent");
const catalog = require("./catalog");
const engine = require("./engine");
const verifier = require("./verifier");
const ai = require("./ai");

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

let chain = new Chain();
const paypal = new PayPal();
const store = new Store();
const STARTING_PYUSD = Number(process.env.DEMO_STARTING_PYUSD || 250);

const r2 = engine.round2;

// ---------------- services shared by routes and the agent ----------------
const services = {
  async wallet() {
    const escrowLocked = store.orders
      .filter((o) => o.protection === "ESCROW" && ["protected", "shipped", "in_review"].includes(o.status))
      .reduce((s, o) => s + o.amount, 0);
    return {
      pyusd: r2(await chain.buyerBalance()),
      paypalBalance: r2(store.user.paypalBalance),
      escrowLocked: r2(escrowLocked),
      cashbackEarned: r2(store.value.userCashback),
    };
  },

  orderSummary(o) {
    return {
      id: o.id,
      product: o.product,
      merchant: o.merchant,
      amount: o.amount,
      route: o.route,
      protection: o.protection,
      status: o.status,
      escrowId: o.escrowId,
      paypalOrderId: o.paypalOrderId,
      txs: o.txs,
      resolution: o.resolution,
      risk: o.risk,
      events: o.events,
      createdAt: o.createdAt,
    };
  },

  async insights() {
    return {
      idle: engine.idleBalanceInsight(store.user),
      value: store.value,
      wallet: await services.wallet(),
    };
  },

  /** Apply a delivery event / claim to an order and let the verification agent decide. */
  async resolveDelivery(orderId, evidence) {
    const order = store.getOrder(orderId);
    if (!order) throw new Error("order not found");
    if (["released", "refunded", "completed"].includes(order.status))
      return { decision: "none", reasoning: `Order is already ${order.status}.` };

    const event = { at: new Date().toISOString(), type: evidence.type, claim: evidence.claim, note: evidence.note, hasPhoto: Boolean(evidence.image) };
    order.events.push(event);

    if (evidence.type === "shipped") {
      if (order.status === "protected" || order.status === "paid") order.status = order.status === "paid" ? "paid" : "shipped";
      store.log("ship", `${order.merchant} shipped ${order.product}`, { orderId });
      return { decision: "none", reasoning: "Shipment recorded." };
    }

    const merchant = catalog.merchants[order.merchantId];
    const v = await verifier.verify(order, merchant, order.events, evidence);
    order.resolution = { ...v, at: new Date().toISOString(), trigger: evidence.type };
    const isClaim = evidence.type === "buyer_claim" || evidence.type === "carrier_lost";

    if (order.protection === "NONE") {
      // Funds already settled: only a standard (costly) dispute is possible.
      if (v.decision === "release") {
        order.status = "completed";
        store.log("done", `${order.product} delivered — order complete`, { orderId });
      } else if (order.route === "PAYPAL_CHECKOUT" && order.captureId && v.decision === "refund") {
        await paypal.refundCapture(order.captureId, order.amount);
        order.status = "refunded";
        store.log("refund", `Refunded $${order.amount} via PayPal capture refund (standard dispute)`, { orderId });
      } else {
        order.status = "dispute_opened";
        order.resolution.reasoning +=
          " Funds had already settled to the merchant, so this goes through the standard dispute process (slower and costlier). Escrow protection would have avoided this.";
        store.log("dispute", `Standard dispute opened for ${order.product}`, { orderId });
      }
      return order.resolution;
    }

    // Protected orders
    if (v.decision === "release") {
      if (order.protection === "ESCROW") {
        const { txHash } = await chain.release(order.escrowId);
        order.txs.push({ label: "escrow released", hash: txHash });
      } else {
        const c = await paypal.captureAuthorization(order.authorizationId);
        order.captureId = c.id;
      }
      order.status = "released";
      store.log("release", `Delivery verified — $${order.amount} released to ${order.merchant}`, { orderId });
    } else if (v.decision === "refund") {
      if (order.protection === "ESCROW") {
        const { txHash } = await chain.refund(order.escrowId);
        order.txs.push({ label: "escrow refunded", hash: txHash });
      } else {
        await paypal.voidAuthorization(order.authorizationId);
      }
      order.status = "refunded";
      if (isClaim) store.value.claimsAutoResolved += 1;
      store.log("refund", `Claim verified — $${order.amount} returned to buyer instantly, no chargeback`, { orderId });
    } else {
      if (order.protection === "ESCROW") {
        try {
          const { txHash } = await chain.dispute(order.escrowId);
          order.txs.push({ label: "escrow frozen (dispute)", hash: txHash });
        } catch (e) {
          console.warn("dispute failed:", e.message);
        }
      }
      order.status = "in_review";
      store.log("review", `Claim on ${order.product} sent to human review, funds frozen`, { orderId });
    }
    return order.resolution;
  },
};

const agent = new Agent({ store, chain, services });

// ---------------- order execution ----------------
async function executePyusd(order) {
  if (order.protection === "ESCROW") {
    const { escrowId, txHash } = await chain.createEscrow(order.merchantId, order.amount, order.id);
    order.escrowId = escrowId;
    order.txs.push({ label: "PYUSD locked in escrow", hash: txHash });
    order.status = "protected";
    store.value.expectedDisputeCostAvoided += order.economics.expectedDisputeCostAvoided;
    store.log("escrow", `$${order.amount} PYUSD locked in escrow #${escrowId} for ${order.merchant}`, { orderId: order.id });
  } else {
    const { txHash } = await chain.payDirect(order.merchantId, order.amount);
    order.txs.push({ label: "PYUSD paid", hash: txHash });
    order.status = "paid";
    store.log("pay", `Paid $${order.amount} PYUSD to ${order.merchant}`, { orderId: order.id });
  }
  const cashback = order.economics.userCashback;
  if (cashback > 0) {
    const h = await chain.creditBuyer(cashback);
    order.txs.push({ label: `cashback $${cashback}`, hash: h });
    store.value.userCashback = r2(store.value.userCashback + cashback);
    store.value.platformFundingCostSaved = r2(store.value.platformFundingCostSaved + order.economics.platformFundingCostSaved);
    store.log("cashback", `Earned $${cashback} PYUSD cashback (shared from $${order.economics.platformFundingCostSaved} funding cost saved)`, { orderId: order.id });
  }
}

// ---------------- routes ----------------
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });

app.get(
  "/api/config",
  wrap(async (req, res) => {
    res.json({
      paypalMode: paypal.mode(),
      paypalClientId: paypal.live ? paypal.clientId : null,
      chain: await chain.info(),
      aiMode: ai.enabled() ? ai.MODEL : "offline (rule-based)",
      assumptions: engine.ASSUMPTIONS,
    });
  })
);

app.get(
  "/api/state",
  wrap(async (req, res) => {
    res.json({
      wallet: await services.wallet(),
      orders: store.orders.slice().reverse().map(services.orderSummary),
      activity: store.activity,
      value: store.value,
      idle: engine.idleBalanceInsight(store.user),
    });
  })
);

app.post(
  "/api/chat",
  wrap(async (req, res) => {
    const text = String(req.body.message || "").trim();
    if (!text) return res.status(400).json({ error: "empty message" });
    res.json(await agent.respond(text));
  })
);

app.post("/api/chat/reset", (req, res) => {
  agent.reset();
  res.json({ ok: true });
});

app.post(
  "/api/checkout/:proposalId/confirm",
  wrap(async (req, res) => {
    const p = store.proposals.get(req.params.proposalId);
    if (!p) return res.status(404).json({ error: "proposal not found or already used" });
    store.proposals.delete(p.id);
    const product = catalog.getProduct(p.productId);
    // Re-plan at confirmation time so balances are current
    const plan = engine.planPayment(product, await services.wallet(), store.user);
    const order = store.addOrder({
      productId: product.id,
      product: product.name,
      merchantId: product.merchantId,
      merchant: product.merchant.name,
      amount: product.price,
      route: plan.route,
      protection: plan.protection,
      risk: plan.risk,
      economics: plan.economics,
      txs: [],
      status: "awaiting_payment",
    });
    if (plan.route === "PYUSD") {
      await executePyusd(order);
      return res.json({ order: services.orderSummary(order) });
    }
    store.log("checkout", `Checkout started via PayPal for ${order.product} (${plan.protection === "NONE" ? "pay now" : "authorization hold"})`, { orderId: order.id });
    res.json({
      order: services.orderSummary(order),
      needsPayPal: true,
      intent: plan.protection === "NONE" ? "CAPTURE" : "AUTHORIZE",
    });
  })
);

// PayPal: create an order for a purchase or a PYUSD top-up
app.post(
  "/api/paypal/create",
  wrap(async (req, res) => {
    const { purpose, orderId, amount } = req.body;
    if (purpose === "topup") {
      const amt = Number(amount);
      if (!(amt > 0 && amt <= 2000)) return res.status(400).json({ error: "invalid amount" });
      const o = await paypal.createOrder({ amount: amt, description: `Buy ${amt} PYUSD`, referenceId: "TOPUP", intent: "CAPTURE" });
      return res.json({ id: o.id });
    }
    const order = store.getOrder(orderId);
    if (!order || order.status !== "awaiting_payment") return res.status(400).json({ error: "order not payable" });
    const intent = order.protection === "NONE" ? "CAPTURE" : "AUTHORIZE";
    const o = await paypal.createOrder({ amount: order.amount, description: `${order.product} — ${order.merchant}`, referenceId: order.id, intent });
    order.paypalOrderId = o.id;
    res.json({ id: o.id });
  })
);

app.post(
  "/api/paypal/complete",
  wrap(async (req, res) => {
    const { purpose, paypalOrderId, orderId, amount } = req.body;
    if (purpose === "topup") {
      const cap = await paypal.captureOrder(paypalOrderId);
      if (cap.status !== "COMPLETED") return res.status(400).json({ error: `capture status ${cap.status}` });
      const amt = Number(amount);
      const hash = await chain.creditBuyer(amt);
      store.log("topup", `Bought $${amt} PYUSD with PayPal (order ${paypalOrderId})`);
      return res.json({ ok: true, txHash: hash });
    }
    const order = store.getOrder(orderId);
    if (!order) return res.status(404).json({ error: "order not found" });
    if (order.protection === "NONE") {
      const cap = await paypal.captureOrder(paypalOrderId);
      order.captureId = cap.captureId;
      order.status = "paid";
      store.log("pay", `Paid $${order.amount} via PayPal checkout (capture ${cap.captureId})`, { orderId });
    } else {
      const auth = await paypal.authorizeOrder(paypalOrderId);
      order.authorizationId = auth.authorizationId;
      order.status = "protected";
      store.value.expectedDisputeCostAvoided = r2(store.value.expectedDisputeCostAvoided + order.economics.expectedDisputeCostAvoided);
      store.log("hold", `$${order.amount} authorized on PayPal — will capture only after delivery is verified`, { orderId });
    }
    res.json({ order: services.orderSummary(order) });
  })
);

// Move idle PayPal balance into PYUSD
app.post(
  "/api/insights/convert",
  wrap(async (req, res) => {
    const amt = r2(Math.min(Number(req.body.amount) || store.user.paypalBalance, store.user.paypalBalance));
    if (!(amt > 0)) return res.status(400).json({ error: "nothing to convert" });
    store.user.paypalBalance = r2(store.user.paypalBalance - amt);
    const hash = await chain.creditBuyer(amt);
    store.value.balanceRetained = r2(store.value.balanceRetained + amt);
    store.log("convert", `Moved $${amt} idle balance into PYUSD (earning rewards)`);
    res.json({ ok: true, txHash: hash });
  })
);

// Demo controls: carrier / buyer events
app.post(
  "/api/orders/:id/events",
  wrap(async (req, res) => {
    const { type, claim, note, image } = req.body;
    const allowed = ["shipped", "carrier_delivered", "carrier_lost", "buyer_claim"];
    if (!allowed.includes(type)) return res.status(400).json({ error: "bad event type" });
    const result = await services.resolveDelivery(req.params.id, { type, claim, note, image });
    res.json({ result, order: services.orderSummary(store.getOrder(req.params.id)) });
  })
);

// Human reviewer decision for cases the AI escalated
app.post(
  "/api/orders/:id/review",
  wrap(async (req, res) => {
    const order = store.getOrder(req.params.id);
    if (!order || order.status !== "in_review") return res.status(400).json({ error: "order not in review" });
    const decision = req.body.decision === "release" ? "release" : "refund";
    if (decision === "release") {
      if (order.protection === "ESCROW") order.txs.push({ label: "escrow released (reviewer)", hash: (await chain.release(order.escrowId)).txHash });
      else order.captureId = (await paypal.captureAuthorization(order.authorizationId)).id;
      order.status = "released";
    } else {
      if (order.protection === "ESCROW") order.txs.push({ label: "escrow refunded (reviewer)", hash: (await chain.refund(order.escrowId)).txHash });
      else await paypal.voidAuthorization(order.authorizationId);
      order.status = "refunded";
    }
    order.resolution = { ...(order.resolution || {}), reviewer: decision };
    store.log("review", `Reviewer decided: ${decision} for ${order.product}`, { orderId: order.id });
    res.json({ order: services.orderSummary(order) });
  })
);

app.post(
  "/api/reset",
  wrap(async (req, res) => {
    store.reset();
    agent.reset();
    if (chain.mode === "local") {
      chain = new Chain();
      agent.deps.chain = chain;
      await chain.init();
      await chain.creditBuyer(STARTING_PYUSD);
    }
    store.log("system", "Demo reset");
    res.json({ ok: true });
  })
);

async function start() {
  const info = await chain.init();
  if (chain.mode === "local") await chain.creditBuyer(STARTING_PYUSD);
  store.log("system", `Wallet ready with ${await chain.buyerBalance()} PYUSD`);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Milo running at http://localhost:${port}`);
    console.log(`  PayPal: ${paypal.mode()} | AI: ${ai.enabled() ? ai.MODEL : "offline rules"} | Chain: ${info.mode}`);
    console.log(`  PYUSD token ${info.token}`);
    console.log(`  Escrow      ${info.escrow}`);
    selfCheck();
  });
}

// Tests the PayPal and AI keys once at startup and prints a clear result.
async function selfCheck() {
  if (paypal.live) {
    try {
      await paypal._accessToken();
      console.log("  ✓ PayPal sandbox keys work");
    } catch (e) {
      console.log("  ✗ PayPal sandbox keys failed: " + e.message.slice(0, 200));
    }
  } else console.log("  ! PayPal keys not set: running in simulated mode");
  if (ai.enabled()) {
    try {
      const m = await ai.chat([{ role: "user", content: "Reply with the single word OK." }]);
      console.log(`  ✓ AI model works (${ai.MODEL}): ${String(m.content || "").trim().slice(0, 20)}`);
    } catch (e) {
      console.log("  ✗ AI model failed (the app will use offline rules): " + e.message.slice(0, 300));
    }
  } else console.log("  ! LLM_API_KEY not set: AI runs in offline rule-based mode");
}

if (require.main === module) start();
module.exports = { app, start };
