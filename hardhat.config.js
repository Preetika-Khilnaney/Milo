// Used only to provide an in-process local EVM for the demo (no Hardhat compilation needed;
// contracts are compiled by scripts/compile.js).
module.exports = {
  solidity: "0.8.24",
  networks: {
    hardhat: {
      chainId: 31337,
      allowBlocksWithSameTimestamp: true,
    },
  },
};
