# Devpost submission draft

**Name:** Milo

**Tagline:** An AI checkout agent that pays the smartest way, protects you with PYUSD escrow, and rewards you for keeping money in PayPal.

## Inspiration
Buying from an unfamiliar online seller means choosing between a cheap price and safety. When things go wrong, disputes take weeks for the buyer and cost the platform money. At the same time, every card-funded payment carries network costs, and money left idle in a PayPal balance earns nothing. We wanted one agent that makes each payment better for both the user and PayPal.

## What it does
- You tell the agent what to buy. It searches merchants and compares them on **price and trust**.
- A risk engine scores the merchant and the order. The agent then picks a route: **PYUSD**, which settles instantly, costs the platform almost nothing, and earns the user cashback; or **PayPal checkout**.
- Risky orders are protected automatically:
  - PYUSD payments are locked in an **on-chain escrow contract**.
  - PayPal payments get an **authorization hold** instead of an immediate capture.
- An **AI verification agent** reviews carrier events and buyer claims, including photos. It then **releases** the funds, **refunds** them, or sends the case to **human review**.
- An **idle-balance nudge** moves unused balance into PYUSD rewards.
- A live dashboard shows value created for the user (cashback, claims auto-resolved) and for PayPal (funding cost saved, expected dispute cost avoided, balance retained).

## How we built it
- **PayPal:**
  - Orders v2: CAPTURE for low-risk orders and PYUSD top-ups; AUTHORIZE for protected orders.
  - Payments v2: authorization capture and void, plus capture refunds.
  - PayPal JS SDK buttons in the sandbox, with two namespaces so capture and authorize flows run side by side.
- **DeFi:** a Solidity `PYUSDEscrow` contract with release, refund, dispute, and an auto-release after the deadline so merchants are protected too. It runs against MockPYUSD on a local EVM, or against the real testnet PYUSD on Sepolia. Built with ethers.js.
- **AI:** an OpenAI-compatible LLM using tool calling for the shopping agent, and structured JSON output (with optional vision) for the verifier. A rule-based fallback keeps the demo working without a key.
- **Design principle:** the LLM decides and explains, but every number comes from an auditable engine. Money moves only after the user confirms.

## AI tools used
- **[Model name, e.g. Gemini 2.5 Flash]**, called through an OpenAI-compatible API:
  - the checkout agent (tool calling)
  - the delivery verification agent (JSON decisions, photo evidence)
- *(List any other AI tools you used while developing, and how.)*

## Challenges
- Combining an on-chain escrow with PayPal's authorize-then-capture flow so both behave the same from the user's side.
- Keeping the LLM useful without letting it invent numbers.
- Being fair to both sides: buyers get fast refunds, and merchants get auto-release if nobody disputes.

## What's next
- Real merchant risk signals.
- Carrier tracking webhooks.
- Settling escrow on PYUSD's Solana deployment.
- Merchant-side dashboard.
