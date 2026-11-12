// PayPal REST API (sandbox) client: Orders v2 + Payments v2 (authorize / capture / void).
// If PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set, the client runs in a clearly
// labelled "simulated" mode so the rest of the app can still be explored locally.
const crypto = require("crypto");

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

class PayPal {
  constructor() {
    this.clientId = process.env.PAYPAL_CLIENT_ID || "";
    this.secret = process.env.PAYPAL_CLIENT_SECRET || "";
    this.live = Boolean(this.clientId && this.secret);
    this._token = null;
    this._tokenExp = 0;
    this._sim = new Map();
  }

  mode() {
    return this.live ? "sandbox" : "simulated";
  }

  async _accessToken() {
    if (this._token && Date.now() < this._tokenExp) return this._token;
    const res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    this._token = j.access_token;
    this._tokenExp = Date.now() + (j.expires_in - 60) * 1000;
    return this._token;
  }

  async _call(method, path, body) {
    const token = await this._accessToken();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": crypto.randomUUID(),
        Prefer: "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = json.details?.[0]?.description || json.message || text;
      throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${msg}`);
    }
    return json;
  }

  /**
   * Create an order.  intent: "CAPTURE" (pay now) or "AUTHORIZE" (hold funds until delivery is verified).
   */
  async createOrder({ amount, description, referenceId, intent = "CAPTURE" }) {
    const body = {
      intent,
      purchase_units: [
        {
          reference_id: referenceId,
          description: String(description).slice(0, 127),
          amount: { currency_code: "USD", value: Number(amount).toFixed(2) },
        },
      ],
    };
    if (!this.live) {
      const id = "SIM-" + crypto.randomBytes(6).toString("hex").toUpperCase();
      this._sim.set(id, { ...body, status: "CREATED" });
      return { id, status: "CREATED", simulated: true };
    }
    const o = await this._call("POST", "/v2/checkout/orders", body);
    return { id: o.id, status: o.status };
  }

  async captureOrder(orderId) {
    if (!this.live) {
      return { id: orderId, status: "COMPLETED", captureId: "SIMCAP-" + orderId.slice(4), simulated: true };
    }
    const o = await this._call("POST", `/v2/checkout/orders/${orderId}/capture`, {});
    const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
    return { id: o.id, status: o.status, captureId: cap?.id, payer: o.payer?.email_address };
  }

  async authorizeOrder(orderId) {
    if (!this.live) {
      return { id: orderId, status: "COMPLETED", authorizationId: "SIMAUTH-" + orderId.slice(4), simulated: true };
    }
    const o = await this._call("POST", `/v2/checkout/orders/${orderId}/authorize`, {});
    const auth = o.purchase_units?.[0]?.payments?.authorizations?.[0];
    return { id: o.id, status: o.status, authorizationId: auth?.id, payer: o.payer?.email_address };
  }

  async captureAuthorization(authorizationId) {
    if (!this.live) return { id: "SIMCAP-" + authorizationId, status: "COMPLETED", simulated: true };
    const c = await this._call("POST", `/v2/payments/authorizations/${authorizationId}/capture`, {
      final_capture: true,
    });
    return { id: c.id, status: c.status };
  }

  async voidAuthorization(authorizationId) {
    if (!this.live) return { status: "VOIDED", simulated: true };
    await this._call("POST", `/v2/payments/authorizations/${authorizationId}/void`);
    return { status: "VOIDED" };
  }

  async refundCapture(captureId, amount) {
    if (!this.live) return { status: "COMPLETED", simulated: true };
    const body = amount ? { amount: { currency_code: "USD", value: Number(amount).toFixed(2) } } : {};
    const r = await this._call("POST", `/v2/payments/captures/${captureId}/refund`, body);
    return { id: r.id, status: r.status };
  }
}

module.exports = { PayPal };
