// Compiles the Solidity contracts with solc-js and writes ABI + bytecode to artifacts/.
// Usage: npm run compile
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const contractsDir = path.join(__dirname, "..", "contracts");
const outDir = path.join(__dirname, "..", "artifacts");

const sources = {};
for (const file of fs.readdirSync(contractsDir)) {
  if (file.endsWith(".sol")) {
    sources[file] = { content: fs.readFileSync(path.join(contractsDir, file), "utf8") };
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((e) => e.severity === "error");
for (const e of output.errors || []) console.log(e.formattedMessage);
if (errors.length) process.exit(1);

fs.mkdirSync(outDir, { recursive: true });
for (const file of Object.keys(output.contracts)) {
  for (const [name, c] of Object.entries(output.contracts[file])) {
    fs.writeFileSync(
      path.join(outDir, `${name}.json`),
      JSON.stringify({ contractName: name, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
    );
    console.log(`compiled ${name}`);
  }
}
