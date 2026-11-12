// Blockchain layer: PYUSD token + escrow contract.
// CHAIN_MODE=local  -> in-process EVM, deploys MockPYUSD + PYUSDEscrow at startup (zero setup).
// CHAIN_MODE=sepolia -> uses real testnet PYUSD and a deployed PYUSDEscrow (see scripts/deploy-sepolia.js).
const path = require("path");
const { ethers } = require("ethers");

const PYUSD_ABI = require(path.join(__dirname, "..", "artifacts", "MockPYUSD.json")).abi;
const ESCROW = require(path.join(__dirname, "..", "artifacts", "PYUSDEscrow.json"));
const TOKEN = require(path.join(__dirname, "..", "artifacts", "MockPYUSD.json"));

const DECIMALS = 6;
const STATUS = ["None", "Funded", "Disputed", "Released", "Refunded"];

const toUnits = (usd) => ethers.parseUnits(Number(usd).toFixed(DECIMALS), DECIMALS);
const fromUnits = (u) => Number(ethers.formatUnits(u, DECIMALS));

class Chain {
  constructor() {
    this.mode = (process.env.CHAIN_MODE || "local").toLowerCase();
    this.ready = false;
    this.merchantAddresses = {};
  }

  async init() {
    if (this.mode === "sepolia") {
      await this._initSepolia();
    } else {
      await this._initLocal();
    }
    this.ready = true;
    return this.info();
  }

  async _initLocal() {
    const hre = require("hardhat");
    this.provider = new ethers.BrowserProvider(hre.network.provider);
    // Account roles on the local chain
    this.platform = await this.provider.getSigner(0); // treasury + arbiter (the AI verification agent)
    this.buyer = await this.provider.getSigner(1); // the demo user's custodial wallet
    for (let i = 0; i < 4; i++) {
      const s = await this.provider.getSigner(2 + i);
      this.merchantAddresses[`m${i + 1}`] = await s.getAddress();
    }

    const tokenFactory = new ethers.ContractFactory(TOKEN.abi, TOKEN.bytecode, this.platform);
    const token = await tokenFactory.deploy();
    await token.waitForDeployment();

    const escrowFactory = new ethers.ContractFactory(ESCROW.abi, ESCROW.bytecode, this.platform);
    const escrow = await escrowFactory.deploy(await token.getAddress(), await this.platform.getAddress());
    await escrow.waitForDeployment();

    this.token = token;
    this.escrow = escrow;
    this.explorer = null;
  }

  async _initSepolia() {
    const need = ["SEPOLIA_RPC_URL", "PLATFORM_PRIVATE_KEY", "BUYER_PRIVATE_KEY", "ESCROW_ADDRESS"];
    for (const k of need) if (!process.env[k]) throw new Error(`CHAIN_MODE=sepolia requires ${k}`);
    this.provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    this.platform = new ethers.Wallet(process.env.PLATFORM_PRIVATE_KEY, this.provider);
    this.buyer = new ethers.Wallet(process.env.BUYER_PRIVATE_KEY, this.provider);
    // Merchants only receive funds, so deterministic addresses are enough.
    const phrase = process.env.MERCHANT_MNEMONIC || "test test test test test test test test test test test junk";
    for (let i = 1; i <= 4; i++) {
      this.merchantAddresses[`m${i}`] = ethers.HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${10 + i}`).address;
    }
    const tokenAddr = process.env.PYUSD_ADDRESS || "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9";
    this.token = new ethers.Contract(tokenAddr, PYUSD_ABI, this.platform);
    this.escrow = new ethers.Contract(process.env.ESCROW_ADDRESS, ESCROW.abi, this.platform);
    this.explorer = "https://sepolia.etherscan.io/tx/";
  }

  async info() {
    return {
      mode: this.mode,
      token: await this.token.getAddress(),
      escrow: await this.escrow.getAddress(),
      buyer: await this.buyer.getAddress(),
      platform: await this.platform.getAddress(),
      explorer: this.explorer,
    };
  }

  merchantAddress(merchantId) {
    const a = this.merchantAddresses[merchantId];
    if (!a) throw new Error(`unknown merchant ${merchantId}`);
    return a;
  }

  async buyerBalance() {
    return fromUnits(await this.token.balanceOf(await this.buyer.getAddress()));
  }

  async merchantBalance(merchantId) {
    return fromUnits(await this.token.balanceOf(this.merchantAddress(merchantId)));
  }

  async escrowBalance() {
    return fromUnits(await this.token.balanceOf(await this.escrow.getAddress()));
  }

  /** Credit PYUSD to the buyer (after a PayPal-funded top-up, or the starting balance). */
  async creditBuyer(usd) {
    const to = await this.buyer.getAddress();
    const tx =
      this.mode === "local"
        ? await this.token.connect(this.platform).mint(to, toUnits(usd))
        : await this.token.connect(this.platform).transfer(to, toUnits(usd));
    const r = await tx.wait();
    return r.hash;
  }

  /** Pay a merchant directly in PYUSD (low-risk orders, no escrow). */
  async payDirect(merchantId, usd) {
    const tx = await this.token.connect(this.buyer).transfer(this.merchantAddress(merchantId), toUnits(usd));
    const r = await tx.wait();
    return { txHash: r.hash };
  }

  /** Lock PYUSD in escrow for a merchant. */
  async createEscrow(merchantId, usd, orderRef, durationSeconds = 7 * 24 * 3600) {
    const amount = toUnits(usd);
    const escrowAddr = await this.escrow.getAddress();
    const approveTx = await this.token.connect(this.buyer).approve(escrowAddr, amount);
    await approveTx.wait();
    const ref = ethers.encodeBytes32String(String(orderRef).slice(0, 31));
    const tx = await this.escrow
      .connect(this.buyer)
      .createEscrow(this.merchantAddress(merchantId), amount, BigInt(durationSeconds), ref);
    const r = await tx.wait();
    const ev = r.logs
      .map((l) => {
        try {
          return this.escrow.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "EscrowCreated");
    return { escrowId: Number(ev.args.id), txHash: r.hash };
  }

  async release(escrowId) {
    const r = await (await this.escrow.connect(this.platform).release(escrowId)).wait();
    return { txHash: r.hash };
  }

  async refund(escrowId) {
    const r = await (await this.escrow.connect(this.platform).refund(escrowId)).wait();
    return { txHash: r.hash };
  }

  async dispute(escrowId) {
    const r = await (await this.escrow.connect(this.buyer).dispute(escrowId)).wait();
    return { txHash: r.hash };
  }

  async getDeal(escrowId) {
    const d = await this.escrow.deals(escrowId);
    return {
      buyer: d.buyer,
      merchant: d.merchant,
      amount: fromUnits(d.amount),
      deadline: Number(d.deadline),
      status: STATUS[Number(d.status)],
    };
  }
}

module.exports = { Chain, toUnits, fromUnits };
