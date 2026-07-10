import xrpl from "xrpl";

async function main() {
  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();

  console.log("Requesting XRP testnet wallet from faucet...");
  const wallet = await client.fundWallet();
  const testWallet = wallet.wallet;
  console.log(`  Source address: ${testWallet.classicAddress}`);
  console.log(`  Balance: funded`);

  const destWallet = (await client.fundWallet()).wallet;
  console.log(`  Dest address:   ${destWallet.classicAddress}`);

  const tx = await client.submitAndWait({
    TransactionType: "Payment",
    Account: testWallet.classicAddress,
    Destination: destWallet.classicAddress,
    Amount: xrpl.xrpToDrops("1"),
    Memos: [
      {
        Memo: {
          MemoData: "5852504C696E6B546573740000000000000000000000000000000000000000",
          MemoType: "68747470733A2F2F7872706C696E6B2E696F",
        },
      },
    ],
  }, { wallet: testWallet });

  console.log(`\n✅ XRP testnet transaction sent!`);
  console.log(`  Transaction hash: ${tx.result.hash}`);
  console.log(`  Result: ${tx.result.meta.TransactionResult}`);
  console.log(`  Ledger index: ${tx.result.ledger_index}`);
  console.log(`\nSet this in .env:`);
  console.log(`XRP_TX_HASH=${tx.result.hash}`);

  const fs = await import("fs");
  let env = fs.readFileSync(".env", "utf8");
  env = env.replace(/XRP_TX_HASH=.*/, `XRP_TX_HASH=${tx.result.hash}`);
  env = env.replace(/PROOF_OWNER=.*/, `PROOF_OWNER=${testWallet.classicAddress}`);
  fs.writeFileSync(".env", env);
  console.log("  (Saved to .env)");

  await client.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
