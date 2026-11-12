// Smart-contract tests on the in-process EVM.  Run: npm test
const { test, before } = require("node:test");
const assert = require("node:assert");
const { Chain } = require("../server/chain");

process.env.CHAIN_MODE = "local";
const chain = new Chain();

before(async () => {
  await chain.init();
  await chain.creditBuyer(500);
});

test("buyer is credited PYUSD", async () => {
  assert.strictEqual(await chain.buyerBalance(), 500);
});

test("escrow locks funds, arbiter release pays merchant", async () => {
  const { escrowId } = await chain.createEscrow("m1", 120.5, "ORDER-1");
  assert.strictEqual(await chain.escrowBalance(), 120.5);
  assert.strictEqual((await chain.getDeal(escrowId)).status, "Funded");
  await chain.release(escrowId);
  assert.strictEqual(await chain.merchantBalance("m1"), 120.5);
  assert.strictEqual((await chain.getDeal(escrowId)).status, "Released");
});

test("dispute then arbiter refund returns funds to buyer", async () => {
  const before = await chain.buyerBalance();
  const { escrowId } = await chain.createEscrow("m2", 50, "ORDER-2");
  assert.strictEqual(await chain.buyerBalance(), before - 50);
  await chain.dispute(escrowId);
  assert.strictEqual((await chain.getDeal(escrowId)).status, "Disputed");
  await chain.refund(escrowId);
  assert.strictEqual(await chain.buyerBalance(), before);
  assert.strictEqual((await chain.getDeal(escrowId)).status, "Refunded");
});

test("cannot release twice", async () => {
  const { escrowId } = await chain.createEscrow("m1", 10, "ORDER-3");
  await chain.release(escrowId);
  await assert.rejects(chain.release(escrowId));
});

test("merchant cannot release funds to itself", async () => {
  const { escrowId } = await chain.createEscrow("m3", 10, "ORDER-4");
  const hre = require("hardhat");
  const { ethers } = require("ethers");
  const p = new ethers.BrowserProvider(hre.network.provider);
  const merchantSigner = await p.getSigner(chain.merchantAddress("m3"));
  await assert.rejects(chain.escrow.connect(merchantSigner).release(escrowId));
});

test("direct PYUSD payment", async () => {
  const before = await chain.merchantBalance("m4");
  await chain.payDirect("m4", 25);
  assert.strictEqual(await chain.merchantBalance("m4"), before + 25);
});
