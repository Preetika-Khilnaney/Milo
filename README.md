<p align="center"><img src="docs/logo.jpg" width="220" alt="Milo logo"/></p>

# Milo — an AI checkout agent for PayPal + PYUSD

**Milo is an AI agent that lives inside a PayPal wallet.** You tell it what you want to buy. It finds the item, checks how trustworthy the merchant is, and picks the safest, cheapest way to pay:

- **PYUSD** (PayPal USD stablecoin) when you have the balance: settles instantly, costs the platform almost nothing, and **you get part of the saving back as cashback**.
- **Smart-contract escrow** for risky purchases: your PYUSD is locked on-chain and only released to the merchant once an **AI verification agent** confirms delivery.
- **PayPal authorization hold** when paying through standard PayPal checkout: funds are *authorized* now and *captured* only after delivery is verified, or voided if it isn't.
- **Idle-balance nudge**: spots money sitting idle in your PayPal balance and offers to move it into PYUSD so it earns rewards.

## Why it matters: value for both sides

| | For the user | For PayPal |
|---|---|---|
| Smart payment routing | Cashback on PYUSD purchases | Avoids card funding / cross-border costs |
| Escrow + authorization holds | Buyer protection without the dispute hassle | Fewer chargebacks and less dispute handling |
| AI delivery verification | Refunds in seconds instead of weeks | Claims auto-resolved, edge cases sent to humans |
| Idle-balance nudge | Earns rewards on idle money | Balance stays on-platform |

The live dashboard tracks all of these as you use the app. Cost figures are **illustrative estimates**. Every assumption is configurable in `.env`.

## Architecture

```
 Browser (vanilla JS)
   │  chat · checkout cards · PayPal JS SDK buttons · orders + demo controls
   ▼
 Express server ───────────────────────────────────────────────────────────────
   ├─ agent.js     LLM tool-calling agent (search_products, prepare_checkout,
   │               get_wallet, list_orders, report_problem, get_insights)
   ├─ engine.js    deterministic risk scoring, routing & economics (auditable)
   ├─ verifier.js  AI delivery-verification agent (text + optional photo)
   ├─ paypal.js    PayPal Orders v2: create, capture, authorize; Payments v2:
   │               capture authorization, void, refund
   └─ chain.js     ethers.js → MockPYUSD / testnet PYUSD + PYUSDEscrow contract
                      ▼
          contracts/PYUSDEscrow.sol  (lock → release / refund / dispute / timeout)
```

**Why the AI and the numbers are kept separate:** the LLM decides *what to do* and explains it. Every number it quotes (risk score, cost, cashback) comes from the engine, so it can't make figures up. Money only moves after the user presses **Confirm**.

### PayPal integration
- **Orders API v2** with `intent=CAPTURE` for low-risk orders and PYUSD top-ups.
- **Orders API v2** with `intent=AUTHORIZE`, then **Payments API v2** `capture` / `void` on authorizations, for protected orders. Funds are held until the AI verifier decides.
- **Payments API v2** capture `refund` for unprotected orders that get a valid claim.
- **PayPal JS SDK** buttons, loaded twice with different `data-namespace`s so capture and authorize flows can run side by side.

### DeFi integration
- `PYUSDEscrow.sol`: the buyer locks PYUSD for a merchant. The arbiter (the platform's verification agent) releases or refunds it. The buyer can release early or dispute. If nobody disputes before the deadline, anyone can release to the merchant, so merchants never get stuck waiting.
- **Local mode:** a 6-decimal MockPYUSD on an in-process EVM. Contracts are deployed automatically on startup.
- **Sepolia mode:** the real testnet PYUSD token (`0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9`) plus your own deployed escrow.

### AI integration
- Works with any **OpenAI-compatible** model: Gemini (free tier), Groq, OpenAI, OpenRouter, Ollama.
- A **tool-calling agent loop** (up to 6 steps) for shopping and payments.
- A **verification agent** that returns structured JSON: `{decision: release|refund|review, confidence, reasoning}`. It supports photo evidence on vision-capable models.
- If no API key is set, or the model call fails, a rule-based fallback takes over so the demo never breaks. The UI shows which mode is active.

## Run it

Requires Node 18+.

```bash
npm install
cp .env.example .env      # add PayPal sandbox + LLM keys (both optional to start)
npm start                 # http://localhost:3000
npm test                  # smart-contract tests
```

1. **PayPal sandbox:** create an app at developer.paypal.com → Apps & Credentials (Sandbox), then copy the Client ID and Secret into `.env`. To pay in the popup, log in with the **sandbox personal account** from the dashboard's Sandbox → Accounts page.
2. **AI:** get a free Gemini key at aistudio.google.com/apikey and set `LLM_API_KEY`.
3. *(Optional)* **Sepolia:** set `SEPOLIA_RPC_URL` and `PLATFORM_PRIVATE_KEY`, then run `npm run deploy:sepolia`. Fund the buyer and platform wallets with Sepolia ETH, and the platform wallet with testnet PYUSD from the Paxos faucet. Then set `CHAIN_MODE=sepolia`, `BUYER_PRIVATE_KEY` and `ESCROW_ADDRESS`.

To recompile the contracts after editing them, run `npm run compile`. Compiled artifacts are committed in `artifacts/`.

### Deploy (Render)
The repo includes `render.yaml`. Create a new Blueprint on Render, point it at this repo, and fill in the secret env vars.

## Try these
1. "Find noise cancelling headphones under $150": the agent picks a cheap import from a **2-month-old seller with a 5% dispute rate**, scores it high risk, and pays in PYUSD **with escrow** plus cashback.
2. In Orders, click **Merchant ships**, then report "arrived with a cracked headband" (photo optional). The verifier refunds from escrow on-chain within seconds.
3. "I need a 4K monitor": the PYUSD balance is too low, so the agent uses **PayPal checkout with an authorization hold**. Click **Carrier: delivered** and the authorization is captured.
4. Click **Move to PYUSD** on the idle-balance card, then buy again: this time it routes through PYUSD with cashback.
5. Report "it never arrived" on an order the carrier marked delivered: the AI sends it to **human review** and freezes the escrow.

## Project structure
```
contracts/       PYUSDEscrow.sol, MockPYUSD.sol
artifacts/       compiled ABIs + bytecode
server/          index.js (API), agent.js, verifier.js, engine.js, paypal.js, chain.js, catalog.js, store.js, ai.js
public/          index.html, styles.css, app.js
scripts/         compile.js, deploy-sepolia.js
test/            escrow.test.js
```

## Limitations / next steps
- The demo is single-user with in-memory state. Production would need persistent storage and auth.
- The merchant catalog and risk signals are demo data. In production they would come from PayPal's merchant risk data.
- Carrier events are simulated with demo buttons. Next step: carrier tracking webhooks.
- Rewards rates and cost assumptions are illustrative.

## License
MIT. See [LICENSE](LICENSE).
