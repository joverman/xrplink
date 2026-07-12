import { ethers } from "ethers";
import { config, activeNetwork } from "../src/config.js";

async function main() {
  const txHashRaw = "87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F";
  const txHash = "0x" + txHashRaw;
  const proofOwner = new ethers.Wallet(config.privateKey).address;

  const attestationType = ethers.utils.formatBytes32String("XRPPayment");
  const sourceId = ethers.utils.formatBytes32String(activeNetwork.sourceId);
  const requestBody = ethers.utils.defaultAbiCoder.encode(["bytes32", "address"], [txHash, proofOwner]);
  const mic = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes", "string"],
      [attestationType, sourceId, requestBody, "Flare"]
    )
  );
  const abiEncoded = attestationType + sourceId.slice(2) + mic.slice(2) + requestBody.slice(2);

  console.log("Network:", config.network);
  console.log("FdcHub:", activeNetwork.fdcHub);
  console.log("Source:", activeNetwork.sourceId);
  console.log("Proof owner:", proofOwner);
  console.log("Request:", abiEncoded);
  console.log("Request bytes:", abiEncoded.length / 2 - 1);

  // Check FdcHub code
  const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
  const code = await provider.getCode(activeNetwork.fdcHub);
  console.log("FdcHub has code:", code !== "0x");

  const abi = ["function requestAttestation(bytes _data) external payable"];
  const iface = new ethers.utils.Interface(abi);
  const data = iface.encodeFunctionData("requestAttestation", [abiEncoded]);
  const fee = ethers.utils.parseEther("1");

  // Try static call for revert reason
  console.log("\nAttempting static call...");
  try {
    await provider.call({
      from: proofOwner,
      to: activeNetwork.fdcHub,
      data,
      value: fee,
      gasLimit: 1000000,
    });
    console.log("Static call succeeded (no revert)");
  } catch (e: any) {
    const errData = e?.data || e?.error?.data || "";
    console.log("Revert detected");
    if (errData && errData !== "0x") {
      try {
        const reason = ethers.utils.toUtf8String("0x" + errData.slice(138));
        console.log("Revert reason:", reason);
      } catch {
        console.log("Raw return data:", errData);
      }
    } else {
      console.log("Error:", e.reason || e.message?.slice(0, 200));
    }
  }
}

main().catch((e) => console.error("Fatal:", e.message));
