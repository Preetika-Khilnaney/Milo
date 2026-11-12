# Demo video script (target: 2:45)

Before recording: click **Reset demo**. Set the PayPal sandbox and LLM keys so both header badges are green. Keep the sandbox buyer login handy.

**0:00–0:20 · Problem**
"When you shop online with a seller you don't know, you either risk getting scammed or go through a slow dispute. Every card payment and every dispute also costs PayPal money. Milo is an AI checkout agent inside your PayPal wallet that fixes both."

**0:20–1:05 · Risky purchase → PYUSD escrow**
- Type: *Find noise cancelling headphones under $150*.
- Point out: the cheapest option is from a 2-month-old seller with a 5% dispute rate, so the risk score is HIGH.
- Show the checkout card: the agent picked PYUSD with smart-contract escrow. Point out the cashback for the user and the funding cost PayPal saves.
- Click **Confirm**. Show the escrow transaction hash, the "Locked in escrow" balance, and the cashback landing in the wallet.

**1:05–1:40 · AI verification → instant refund**
- In Orders, click **Merchant ships**, type *arrived with a cracked headband*, attach a photo, and click **Report**.
- Show the verifier's decision, confidence and reasoning. The escrow refunds on-chain and the money is back in seconds, with no chargeback.

**1:40–2:15 · PayPal authorization hold**
- Type: *I need a 4K monitor*. The PYUSD balance is too low, so the agent uses PayPal checkout with an authorization hold.
- Pay with the sandbox account in the PayPal popup, then click **Carrier: delivered**. The verifier releases the payment and PayPal captures the authorization.

**2:15–2:35 · Idle balance**
- Click **Move to PYUSD** on the idle-balance card. Your idle money now earns rewards, and future purchases get cashback.

**2:35–2:45 · Close**
- Show the Value created panel. "Users get cashback and instant protection. PayPal saves funding costs, avoids disputes and keeps balances on-platform. One agent, both sides win."
