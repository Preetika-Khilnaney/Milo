// In-memory state for the demo (single user).
let seq = 1000;
const nextId = (p) => `${p}-${++seq}`;

class Store {
  constructor() {
    this.reset();
  }

  reset() {
    this.user = {
      name: "Alex",
      paypalBalance: Number(process.env.DEMO_IDLE_BALANCE || 340), // idle fiat balance in the PayPal account
      paypalBalanceDaysIdle: 23,
      firstTimeWith: ["m2", "m4"],
    };
    this.proposals = new Map();
    this.orders = [];
    this.activity = [];
    this.value = {
      platformFundingCostSaved: 0,
      userCashback: 0,
      expectedDisputeCostAvoided: 0,
      claimsAutoResolved: 0,
      balanceRetained: 0,
    };
  }

  log(kind, text, extra = {}) {
    const a = { id: nextId("A"), at: new Date().toISOString(), kind, text, ...extra };
    this.activity.unshift(a);
    this.activity = this.activity.slice(0, 60);
    return a;
  }

  addProposal(plan) {
    const p = { id: nextId("PR"), createdAt: new Date().toISOString(), ...plan };
    this.proposals.set(p.id, p);
    return p;
  }

  addOrder(o) {
    const order = { id: nextId("ORD"), createdAt: new Date().toISOString(), events: [], ...o };
    this.orders.push(order);
    return order;
  }

  getOrder(id) {
    return this.orders.find((o) => o.id === id);
  }

  latestOpenOrder() {
    return [...this.orders].reverse().find((o) => !["released", "refunded", "completed", "awaiting_payment"].includes(o.status)) || this.orders[this.orders.length - 1];
  }
}

module.exports = { Store };
