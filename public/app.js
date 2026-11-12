// Milo frontend (no build step).
const $ = (s) => document.querySelector(s);
const money = (n) => "$" + Number(n || 0).toFixed(2);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let CONFIG = null;
let sdkReady = Promise.resolve(false);

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

// ---------------- config + PayPal SDK ----------------
function loadScript(src, ns) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.setAttribute("data-namespace", ns);
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function init() {
  CONFIG = await api("/api/config");
  const b = [];
  b.push(`<span class="badge ${CONFIG.paypalMode === "sandbox" ? "live" : "warn"}">PayPal: <b>${CONFIG.paypalMode}</b></span>`);
  b.push(`<span class="badge ${CONFIG.aiMode.startsWith("offline") ? "warn" : "live"}">AI: <b>${esc(CONFIG.aiMode)}</b></span>`);
  b.push(`<span class="badge live">Chain: <b>${CONFIG.chain.mode}</b> · escrow ${CONFIG.chain.escrow.slice(0, 8)}…</span>`);
  $("#badges").innerHTML = b.join("");

  if (CONFIG.paypalClientId) {
    const base = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CONFIG.paypalClientId)}&currency=USD&components=buttons`;
    sdkReady = Promise.all([loadScript(base + "&intent=capture", "paypal_capture"), loadScript(base + "&intent=authorize", "paypal_auth")])
      .then(() => true)
      .catch((e) => {
        console.error("PayPal SDK failed to load", e);
        return false;
      });
  }

  addBot(
    "Hi Alex 👋 I'm Milo, your checkout agent. Tell me what you'd like to buy. I compare merchants on price and trust, then choose how to pay: PYUSD for instant settlement and cashback, with escrow or an authorization hold when a seller looks risky.",
    null
  );
  refresh();
  setInterval(refresh, 4000);
}

/**
 * Render PayPal checkout for a purchase or top-up.
 * In sandbox mode this uses the real PayPal JS SDK buttons; otherwise a clearly labelled simulated button.
 */
async function renderPayPal(container, { intent, purpose, orderId, amount, onDone }) {
  container.innerHTML = "";
  const createOrder = async () => (await api("/api/paypal/create", { purpose, orderId, amount })).id;
  const complete = async (paypalOrderId) => {
    const r = await api("/api/paypal/complete", { purpose, orderId, amount, paypalOrderId });
    onDone && onDone(r);
    refresh();
  };

  const live = await sdkReady;
  if (live && CONFIG.paypalClientId) {
    const ns = intent === "AUTHORIZE" ? window.paypal_auth : window.paypal_capture;
    ns.Buttons({
      style: { layout: "horizontal", height: 38, tagline: false, label: "pay" },
      createOrder,
      onApprove: async (data) => {
        container.innerHTML = '<span class="muted small">Completing with PayPal…</span>';
        try {
          await complete(data.orderID);
        } catch (e) {
          container.innerHTML = `<span class="small" style="color:var(--red)">${esc(e.message)}</span>`;
        }
      },
      onError: (err) => {
        console.error(err);
        container.innerHTML = `<span class="small" style="color:var(--red)">PayPal error — check console</span>`;
      },
    }).render(container);
  } else {
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = intent === "AUTHORIZE" ? "Authorize with PayPal (simulated)" : "Pay with PayPal (simulated)";
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await complete(await createOrder());
        container.innerHTML = "";
      } catch (e) {
        btn.disabled = false;
        alertInline(container, e.message);
      }
    };
    container.appendChild(btn);
  }
}

function alertInline(container, msg) {
  const d = document.createElement("div");
  d.className = "small";
  d.style.color = "var(--red)";
  d.textContent = msg;
  container.appendChild(d);
}

// ---------------- chat ----------------
function addUser(text) {
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = text;
  $("#messages").appendChild(d);
  scrollChat();
}
function addBot(text, mode) {
  const d = document.createElement("div");
  d.className = "msg bot";
  d.innerHTML = esc(text) + (mode ? `<span class="mode">agent · ${esc(mode)}</span>` : "");
  $("#messages").appendChild(d);
  scrollChat();
}
function addNode(node) {
  $("#messages").appendChild(node);
  scrollChat();
}
function scrollChat() {
  const m = $("#messages");
  m.scrollTop = m.scrollHeight;
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  addUser(text);
  $("#input").value = "";
  $("#sendBtn").disabled = true;
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.textContent = "Agent is working";
  addNode(typing);
  try {
    const r = await api("/api/chat", { message: text });
    typing.remove();
    // Show product results first, then the reply, then the checkout card
    for (const c of r.cards.filter((c) => c.type === "products")) addNode(renderProducts(c.items));
    addBot(r.reply, r.aiMode);
    for (const c of r.cards.filter((c) => c.type !== "products")) {
      if (c.type === "checkout") addNode(renderCheckout(c.proposal));
      if (c.type === "insight") addNode(renderInsightInline(c.insight));
    }
  } catch (e) {
    typing.remove();
    addBot("Something went wrong: " + e.message);
  } finally {
    $("#sendBtn").disabled = false;
    refresh();
  }
}

function trustClass(p) {
  if (p.merchant_dispute_rate >= 0.03 || p.merchant_age_months < 6) return ["bad", "Higher risk seller"];
  if (p.merchant_dispute_rate >= 0.015 || p.cross_border) return ["mid", "Moderate risk"];
  return ["good", "Trusted seller"];
}

function renderProducts(items) {
  const wrap = document.createElement("div");
  wrap.className = "products";
  for (const p of items) {
    const [cls, label] = trustClass(p);
    const el = document.createElement("div");
    el.className = "product";
    el.innerHTML = `
      <div class="pname">${esc(p.name)}</div>
      <div class="pprice">${money(p.price)}</div>
      <div class="pmerch">${esc(p.merchant)} · ★ ${p.merchant_rating}${p.cross_border ? " · intl" : ""}</div>
      <span class="trust ${cls}">${label}</span>`;
    const b = document.createElement("button");
    b.className = "secondary small";
    b.textContent = "Check out this one";
    b.onclick = () => send(`Prepare checkout for ${p.name} from ${p.merchant} (product ${p.id})`);
    el.appendChild(b);
    wrap.appendChild(el);
  }
  return wrap;
}

const ROUTE_LABEL = { PYUSD: "PYUSD balance", PAYPAL_CHECKOUT: "PayPal checkout" };
const PROTECTION_LABEL = {
  ESCROW: "PYUSD smart-contract escrow until delivery is verified",
  AUTHORIZE_THEN_CAPTURE: "PayPal authorization hold, captured only after delivery is verified",
  NONE: "standard (low-risk order)",
};

function renderCheckout(p) {
  const el = document.createElement("div");
  el.className = "checkout";
  const riskColor = p.risk.score >= 60 ? "var(--red)" : p.risk.score >= 40 ? "var(--amber)" : p.risk.score >= 20 ? "#d9a400" : "var(--green)";
  const routes = p.options
    .map(
      (o) => `
      <div class="route ${o.route === p.route ? "chosen" : ""} ${o.available ? "" : "na"}">
        ${o.route === p.route ? '<span class="tag">AGENT PICK</span>' : ""}
        <div class="rname">${ROUTE_LABEL[o.route]}</div>
        <div>Cashback: <b>${money(o.userCashback)}</b></div>
        <div>Platform cost: <b>${money(o.platformCost)}</b></div>
        <div>${esc(o.settlement)}</div>
        ${o.available ? "" : '<div style="color:var(--red)">insufficient balance</div>'}
      </div>`
    )
    .join("");
  let plan = `Pay via <b>${ROUTE_LABEL[p.route]}</b> · protection: <b>${PROTECTION_LABEL[p.protection]}</b>.`;
  if (p.route === "PYUSD") plan += ` You earn <b>${money(p.economics.userCashback)}</b> cashback; PayPal saves <b>${money(p.economics.platformFundingCostSaved)}</b> in funding cost.`;
  else if (p.shortfall > 0) plan += ` PYUSD balance is short by <b>${money(p.shortfall)}</b> — top up to earn ${money(p.economics.potentialCashbackIfPyusd)} cashback instead.`;
  if (p.economics.expectedDisputeCostAvoided > 0) plan += ` Expected dispute cost avoided: <b>${money(p.economics.expectedDisputeCostAvoided)}</b>.`;

  el.innerHTML = `
    <div class="checkout-head">
      <div><div class="t">${esc(p.product)}</div><div class="m">${esc(p.merchant)}</div></div>
      <div class="price">${money(p.amount)}</div>
    </div>
    <div class="checkout-body">
      <div class="risk">
        <div class="risk-top"><span>Merchant & order risk</span><b style="color:${riskColor}">${p.risk.level.toUpperCase()} · ${p.risk.score}/100</b></div>
        <div class="risk-bar"><i style="width:${Math.max(4, p.risk.score)}%;background:${riskColor}"></i></div>
        <ul>${p.risk.factors.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      </div>
      <div class="routes">${routes}</div>
      <div class="plan-line">${plan}</div>
      <div class="checkout-actions"><button class="confirm">Confirm & pay ${money(p.amount)}</button><span class="muted small">Nothing is charged until you confirm.</span></div>
      <div class="paypal-slot"></div>
    </div>`;
  const btn = el.querySelector(".confirm");
  const actions = el.querySelector(".checkout-actions");
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Processing…";
    try {
      const r = await api(`/api/checkout/${p.id}/confirm`, {});
      if (r.needsPayPal) {
        actions.innerHTML = `<span class="small">Complete payment with PayPal${r.intent === "AUTHORIZE" ? " (funds are only <b>authorized</b> now)" : ""}:</span>`;
        renderPayPal(el.querySelector(".paypal-slot"), {
          intent: r.intent,
          purpose: "order",
          orderId: r.order.id,
          onDone: (res) => {
            actions.innerHTML = `<span class="done">✓ ${res.order.status === "protected" ? "Authorized — held until delivery is verified" : "Paid with PayPal"} · ${res.order.id}</span>`;
            el.querySelector(".paypal-slot").innerHTML = "";
          },
        });
      } else {
        const o = r.order;
        actions.innerHTML = `<span class="done">✓ ${o.protection === "ESCROW" ? `Locked in escrow #${o.escrowId}` : "Paid in PYUSD"} · ${o.id}</span>`;
      }
      refresh();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Try again";
      alertInline(actions, e.message);
    }
  };
  return el;
}

function renderInsightInline(ins) {
  const d = document.createElement("div");
  d.className = "checkout";
  d.innerHTML = `<div class="checkout-body"><div class="plan-line">Idle balance: <b>${money(ins.idleBalance)}</b> for ${ins.daysIdle} days.
  At an illustrative ${(ins.rewardsApy * 100).toFixed(1)}% rewards rate that's about <b>${money(ins.projectedYearlyRewards)}/year</b>.</div>
  <div class="checkout-actions"><button class="ok">Move ${money(ins.idleBalance)} to PYUSD</button></div></div>`;
  d.querySelector("button").onclick = async (ev) => {
    ev.target.disabled = true;
    await convertIdle(ins.idleBalance);
    d.querySelector(".checkout-actions").innerHTML = '<span class="done" style="color:var(--green);font-weight:600">✓ Moved to PYUSD</span>';
  };
  return d;
}

async function convertIdle(amount) {
  await api("/api/insights/convert", { amount });
  refresh();
}

// ---------------- state rendering ----------------
let lastOrdersJson = "";
async function refresh() {
  let s;
  try {
    s = await api("/api/state");
  } catch {
    return;
  }
  $("#pyusdBal").textContent = money(s.wallet.pyusd);
  $("#ppBal").textContent = money(s.wallet.paypalBalance);
  $("#escrowBal").textContent = money(s.wallet.escrowLocked);
  $("#cashBal").textContent = money(s.wallet.cashbackEarned);
  $("#vCash").textContent = money(s.value.userCashback);
  $("#vClaims").textContent = s.value.claimsAutoResolved;
  $("#vFund").textContent = money(s.value.platformFundingCostSaved);
  $("#vDisp").textContent = money(s.value.expectedDisputeCostAvoided);
  $("#vRet").textContent = money(s.value.balanceRetained);

  $("#activity").innerHTML = s.activity
    .map((a) => `<li><time>${new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>${esc(a.text)}</span></li>`)
    .join("");

  const n = $("#nudge");
  if (s.idle.show) {
    n.classList.remove("hidden");
    n.innerHTML = `<h4>💡 ${money(s.idle.idleBalance)} has been idle for ${s.idle.daysIdle} days</h4>
      <p>Move it to PYUSD to earn about <b>${money(s.idle.projectedYearlyRewards)}/yr</b> in rewards (illustrative ${(s.idle.rewardsApy * 100).toFixed(1)}%), and get cashback when the agent pays with it.</p>
      <div class="row"><button class="ok small" id="nudgeGo">Move to PYUSD</button><button class="ghost small" id="nudgeAsk">Ask the agent</button></div>`;
    $("#nudgeGo").onclick = () => convertIdle(s.idle.idleBalance);
    $("#nudgeAsk").onclick = () => send("Should I move my idle balance to PYUSD?");
  } else n.classList.add("hidden");

  const j = JSON.stringify(s.orders);
  if (j !== lastOrdersJson && !document.activeElement?.closest?.(".claim-box")) {
    lastOrdersJson = j;
    renderOrders(s.orders);
  }
}

const STATUS_LABEL = {
  awaiting_payment: "awaiting payment",
  paid: "paid",
  protected: "funds held",
  shipped: "shipped · funds held",
  released: "released to merchant",
  refunded: "refunded",
  in_review: "human review",
  completed: "completed",
  dispute_opened: "standard dispute",
};

function renderOrders(orders) {
  const box = $("#orders");
  if (!orders.length) {
    box.innerHTML = '<div class="empty">No orders yet. Ask the agent to buy something.</div>';
    return;
  }
  box.innerHTML = "";
  for (const o of orders) {
    const el = document.createElement("div");
    el.className = "order";
    const explorer = CONFIG?.chain?.explorer;
    const txs = (o.txs || [])
      .map((t) => `<div>${esc(t.label)}: ${explorer ? `<a target="_blank" href="${explorer}${t.hash}">${t.hash.slice(0, 14)}…</a>` : t.hash.slice(0, 18) + "…"}</div>`)
      .join("");
    const res = o.resolution
      ? `<div class="resolution ${o.resolution.decision}"><b>Verification: ${esc(o.resolution.decision || "")}</b>${o.resolution.confidence ? ` (${Math.round(o.resolution.confidence * 100)}%)` : ""} — ${esc(o.resolution.reasoning || "")}${o.resolution.reviewer ? ` <b>Reviewer: ${o.resolution.reviewer}</b>` : ""}<div class="eng">${esc(o.resolution.engine || "")}</div></div>`
      : "";
    const open = ["paid", "protected", "shipped"].includes(o.status);
    el.innerHTML = `
      <div class="order-top">
        <div><div class="oname">${esc(o.product)}</div><div class="omerch">${esc(o.merchant)} · ${o.id}</div></div>
        <div class="oamt">${money(o.amount)}</div>
      </div>
      <div class="pills">
        <span class="pill status-${o.status}">${STATUS_LABEL[o.status] || o.status}</span>
        <span class="pill">${o.route === "PYUSD" ? "PYUSD" : "PayPal"}</span>
        <span class="pill">${o.protection === "ESCROW" ? `escrow #${o.escrowId}` : o.protection === "AUTHORIZE_THEN_CAPTURE" ? "auth hold" : "no hold"}</span>
        <span class="pill">risk ${o.risk?.score ?? "-"}</span>
      </div>
      ${res}
      ${txs ? `<div class="txs">${txs}</div>` : ""}
      ${o.paypalOrderId ? `<div class="txs"><div>PayPal order: ${esc(o.paypalOrderId)}</div></div>` : ""}
      <div class="controls"></div>`;
    const ctr = el.querySelector(".controls");
    const ev = async (body, btn) => {
      if (btn) btn.disabled = true;
      try {
        await api(`/api/orders/${o.id}/events`, body);
      } catch (e) {
        alertInline(ctr, e.message);
      }
      lastOrdersJson = "";
      refresh();
    };
    if (open) {
      const mk = (label, cls, body) => {
        const b = document.createElement("button");
        b.className = `small ${cls}`;
        b.textContent = label;
        b.onclick = () => ev(body, b);
        ctr.appendChild(b);
      };
      if (!o.events.some((e) => e.type === "shipped")) mk("📦 Merchant ships", "secondary", { type: "shipped" });
      mk("✅ Carrier: delivered", "ok", { type: "carrier_delivered", note: "Carrier scan: delivered, left at front door" });
      mk("❌ Carrier: lost", "danger", { type: "carrier_lost", note: "Carrier: parcel lost in transit" });
      const claim = document.createElement("div");
      claim.className = "claim-box";
      claim.innerHTML = `<input placeholder="Buyer claim, e.g. arrived cracked" /><button class="small ghost" title="Attach photo">📷</button><button class="small danger">Report</button>`;
      let photo = null;
      const [inp, cam, rep] = claim.querySelectorAll("input,button");
      cam.onclick = () => pickPhoto((d) => {
        photo = d;
        cam.textContent = "📷✓";
      });
      rep.onclick = () => {
        if (!inp.value.trim()) return inp.focus();
        ev({ type: "buyer_claim", claim: inp.value.trim(), image: photo }, rep);
      };
      ctr.appendChild(claim);
    }
    if (o.status === "in_review") {
      const rel = document.createElement("button");
      rel.className = "small ok";
      rel.textContent = "Reviewer: release";
      const ref = document.createElement("button");
      ref.className = "small danger";
      ref.textContent = "Reviewer: refund";
      rel.onclick = async () => { await api(`/api/orders/${o.id}/review`, { decision: "release" }); lastOrdersJson = ""; refresh(); };
      ref.onclick = async () => { await api(`/api/orders/${o.id}/review`, { decision: "refund" }); lastOrdersJson = ""; refresh(); };
      ctr.append(rel, ref);
    }
    box.appendChild(el);
  }
}

// Downscale photos before upload so they fit comfortably in a vision model request.
function pickPhoto(cb) {
  const input = $("#photoInput");
  input.value = "";
  input.onchange = () => {
    const f = input.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 768 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = img.width * scale;
      c.height = img.height * scale;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL("image/jpeg", 0.8));
    };
    img.src = URL.createObjectURL(f);
  };
  input.click();
}

// ---------------- wiring ----------------
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("#input").value);
});
$("#suggestions").addEventListener("click", (e) => {
  if (e.target.tagName === "BUTTON") send(e.target.textContent);
});
$("#topupBtn").onclick = () => {
  const amount = Number($("#topupAmt").value);
  if (!(amount > 0)) return;
  renderPayPal($("#topupPaypal"), {
    intent: "CAPTURE",
    purpose: "topup",
    amount,
    onDone: () => ($("#topupPaypal").innerHTML = `<span class="small" style="color:var(--green)">✓ Bought ${money(amount)} PYUSD</span>`),
  });
};
$("#resetBtn").onclick = async () => {
  if (!confirm("Reset all demo state?")) return;
  await api("/api/reset", {});
  await api("/api/chat/reset", {});
  $("#messages").innerHTML = "";
  lastOrdersJson = "";
  addBot("Demo reset. What would you like to buy?", null);
  refresh();
};

init();
