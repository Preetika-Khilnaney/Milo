// Deploys PYUSDEscrow to Sepolia, pointed at the testnet PYUSD token.
// Requires in .env: SEPOLIA_RPC_URL, PLATFORM_PRIVATE_KEY (funded with Sepolia ETH).
// Optional: PYUSD_ADDRESS (defaults to the PYUSD Sepolia testnet token).
require("dotenv").config({ quiet: true });
const { ethers } = require("ethers");
const ESCROW = require("../artifacts/PYUSDEscrow.json");

(async () => {
  const { SEPOLIA_RPC_URL, PLATFORM_PRIVATE_KEY } = process.env;
  if (!SEPOLIA_RPC_URL || !PLATFORM_PRIVATE_KEY) throw new Error("Set SEPOLIA_RPC_URL and PLATFORM_PRIVATE_KEY in .env");
  const pyusd = process.env.PYUSD_ADDRESS || "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9";
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(PLATFORM_PRIVATE_KEY, provider);
  console.log("Deploying from", wallet.address, "PYUSD token", pyusd);
  const factory = new ethers.ContractFactory(ESCROW.abi, ESCROW.bytecode, wallet);
  const escrow = await factory.deploy(pyusd, wallet.address);
  await escrow.waitForDeployment();
  console.log("PYUSDEscrow deployed at", await escrow.getAddress());
  console.log("Add to .env:  ESCROW_ADDRESS=" + (await escrow.getAddress()) + "  and  CHAIN_MODE=sepolia");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
