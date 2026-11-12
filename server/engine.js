// Deterministic risk + routing + economics engine.
// The AI agent calls this as a tool and explains its output; the numbers themselves are
// computed here so they are auditable and never hallucinated.
//
// All cost figures are ILLUSTRATIVE ESTIMATES, configurable via env vars.
const num = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);

const ASSUMPTIONS = {
  cardFundingPct: num("CARD_FUNDING_PCT", 0.022), // est. card network cost borne by the platform
  cardFundingFixed: num("CARD_FUNDING_FIXED", 0.1),
  crossBorderPct: num("CROSS_BORDER_PCT", 0.015), // extra FX / cross-border cost on card rails
  pyusdNetworkCost: num("PYUSD_NETWORK_COST", 0.01), // on-chain transfer cost (absorbed)
  disputeHandlingCost: num("DISPUTE_HANDLING_COST", 20), // ops + chargeback fees per dispute
  cashbackShare: num("CASHBACK_SHARE", 0.4), // share of savings returned to the user
  rewardsApy: num("REWARDS_APY", 0.037), // illustrative PYUSD rewards rate
  escrowRiskThreshold: num("ESCROW_RISK_THRESHOLD", 40),
  escrowAmountThreshold: num("ESCROW_AMOUNT_THRESHOLD", 250),
};

const round2 = (x) => Math.round(x * 100) / 100;

/** Risk score 0-100 using platform signals about the merchant and order. */
function assessRisk(product, user) {
  const m = product.merchant;
  const factors = [];
  let score = 0;

  if (m.accountAgeMonths < 6) {
    score += 30;
    factors.push(`merchant account is only ${m.accountAgeMonths} months old`);
  } else if (m.accountAgeMonths < 24) {
    score += 10;
    factors.push(`merchant account is ${m.accountAgeMonths} months old`);
  }
  if (m.disputeRate >= 0.03) {
    score += 30;
    factors.push(`high dispute rate (${(m.disputeRate * 100).toFixed(1)}%)`);
  } else if (m.disputeRate >= 0.015) {
    score += 12;
    factors.push(`moderate dispute rate (${(m.disputeRate * 100).toFixed(1)}%)`);
  }
  if (m.rating < 4.0) {
    score += 15;
    factors.push(`low seller rating (${m.rating}/5)`);
  }
  if (m.crossBorder) {
    score += 10;
    factors.push(`ships cross-border from ${m.country}`);
  }
  if (product.price >= 300) {
    score += 15;
    factors.push(`high order value ($${product.price})`);
  } else if (product.price >= 150) {
    score += 7;
    factors.push(`mid-to-high order value ($${product.price})`);
  }
  if (user && user.firstTimeWith && user.firstTimeWith.includes(m.id)) {
    score += 5;
    factors.push("first purchase from this merchant");
  }
  score = Math.min(100, score);
  const level = score >= 60 ? "high" : score >= ASSUMPTIONS.escrowRiskThreshold ? "elevated" : score >= 20 ? "moderate" : "low";
  if (!factors.length) factors.push("established merchant with a clean record");
  return { score, level, factors };
}

/** Cost to the platform of each funding route + recommended route. */
function planPayment(product, wallet, user) {
  const risk = assessRisk(product, user);
  const amount = product.price;
  const m = product.merchant;

  const cardCost =
    amount * ASSUMPTIONS.cardFundingPct + ASSUMPTIONS.cardFundingFixed + (m.crossBorder ? amount * ASSUMPTIONS.crossBorderPct : 0);
  const pyusdCost = ASSUMPTIONS.pyusdNetworkCost;
  const fundingSaved = Math.max(0, cardCost - pyusdCost);
  const cashback = fundingSaved * ASSUMPTIONS.cashbackShare;

  const protect = risk.score >= ASSUMPTIONS.escrowRiskThreshold || amount >= ASSUMPTIONS.escrowAmountThreshold;
  // Expected cost of a dispute on this order without protection
  const expectedDisputeCost = m.disputeRate * (amount + ASSUMPTIONS.disputeHandlingCost) * (risk.score >= 60 ? 1.5 : 1);
  const canUsePyusd = wallet.pyusd >= amount;

  let route, protection;
  if (canUsePyusd) {
    route = "PYUSD";
    protection = protect ? "ESCROW" : "NONE";
  } else {
    route = "PAYPAL_CHECKOUT";
    protection = protect ? "AUTHORIZE_THEN_CAPTURE" : "NONE";
  }

  const options = [
    {
      route: "PYUSD",
      available: canUsePyusd,
      userCost: amount,
      userCashback: round2(cashback),
      platformCost: round2(pyusdCost),
      settlement: "instant, on-chain",
      protection: protect ? "smart-contract escrow until delivery verified" : "standard",
    },
    {
      route: "PAYPAL_CHECKOUT",
      available: true,
      userCost: amount,
      userCashback: 0,
      platformCost: round2(cardCost),
      settlement: "card rails",
      protection: protect ? "authorization hold, captured after delivery verified" : "standard",
    },
  ];

  const shortfall = canUsePyusd ? 0 : round2(amount - wallet.pyusd);

  return {
    productId: product.id,
    product: product.name,
    merchant: m.name,
    amount,
    risk,
    route,
    protection,
    shortfall,
    economics: {
      platformFundingCostSaved: route === "PYUSD" ? round2(fundingSaved) : 0,
      userCashback: route === "PYUSD" ? round2(cashback) : 0,
      expectedDisputeCostAvoided: protection !== "NONE" ? round2(expectedDisputeCost) : 0,
      potentialCashbackIfPyusd: round2(cashback),
    },
    options,
  };
}

/** Idle-balance insight: money sitting in the PayPal balance not earning anything. */
function idleBalanceInsight(user) {
  const idle = user.paypalBalance;
  const yearly = idle * ASSUMPTIONS.rewardsApy;
  return {
    idleBalance: round2(idle),
    daysIdle: user.paypalBalanceDaysIdle,
    rewardsApy: ASSUMPTIONS.rewardsApy,
    projectedYearlyRewards: round2(yearly),
    projectedMonthlyRewards: round2(yearly / 12),
    show: idle >= 25,
  };
}

module.exports = { ASSUMPTIONS, assessRisk, planPayment, idleBalanceInsight, round2 };
