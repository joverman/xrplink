import { ethers } from "ethers";
import { config, activeNetwork } from "./config.js";
import { store, getStoreHealth } from "./store.js";
import { whiteLabel } from "./white-label.js";

export type PublicStatus = {
  status: "online" | "degraded";
  network: string;
  chainId: number;
  brand: string;
  attestationsAvailable: boolean;
};

export type AdminStatus = PublicStatus & {
  companyUrl: string;
  paymentVerifier: string;
  sourceId: string;
  fdcHub: string;
  walletAddress: string | null;
  walletBalanceFlr: string | null;
  fdcFeeFlr: string;
  attestationCount: number;
  apiKeyCount: number;
  uptime: number;
  storage: ReturnType<typeof getStoreHealth>;
};

type WalletSnapshot = {
  address: string | null;
  balanceFlr: string | null;
  funded: boolean;
};

/**
 * Compare the fee-wallet balance to the FLR amount this process submits
 * with each FdcHub request (config.submitFeeFlr). Do not expose the
 * balance or address on public surfaces.
 */
async function getWalletSnapshot(): Promise<WalletSnapshot> {
  const fee = ethers.utils.parseEther(config.submitFeeFlr);
  if (!config.privateKey) {
    return { address: null, balanceFlr: null, funded: false };
  }
  try {
    const provider = new ethers.providers.JsonRpcProvider({
      url: activeNetwork.rpc,
      timeout: 2500,
    });
    const wallet = new ethers.Wallet(config.privateKey);
    const balance = await provider.getBalance(wallet.address);
    return {
      address: wallet.address,
      balanceFlr: ethers.utils.formatEther(balance),
      funded: balance.gte(fee),
    };
  } catch {
    return { address: null, balanceFlr: null, funded: false };
  }
}

export async function getPublicStatus(): Promise<PublicStatus> {
  const storeHealth = getStoreHealth();
  const wallet = await getWalletSnapshot();
  return {
    status: storeHealth.ok ? "online" : "degraded",
    network: config.network,
    chainId: activeNetwork.chainId,
    brand: whiteLabel.get().brandName,
    attestationsAvailable: storeHealth.ok && wallet.funded,
  };
}

export async function getAdminStatus(): Promise<AdminStatus> {
  const storeHealth = getStoreHealth();
  const [wallet, attestations, apiKeys] = await Promise.all([
    getWalletSnapshot(),
    store.listAttestations(),
    store.listApiKeys(),
  ]);
  const wl = whiteLabel.get();
  return {
    status: storeHealth.ok ? "online" : "degraded",
    network: config.network,
    chainId: activeNetwork.chainId,
    brand: wl.brandName,
    attestationsAvailable: storeHealth.ok && wallet.funded,
    companyUrl: wl.companyUrl,
    paymentVerifier: config.paymentVerifierAddress || "not configured",
    sourceId: activeNetwork.sourceId,
    fdcHub: activeNetwork.fdcHub,
    walletAddress: wallet.address,
    walletBalanceFlr: wallet.balanceFlr,
    fdcFeeFlr: config.submitFeeFlr,
    attestationCount: attestations.length,
    apiKeyCount: apiKeys.length,
    uptime: process.uptime(),
    storage: storeHealth,
  };
}

export function formatPublicStatusMarkdown(status: PublicStatus): string {
  return [
    "# Network Status",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Status | ${status.status} |`,
    `| Network | ${status.network} |`,
    `| Chain ID | ${status.chainId} |`,
    `| Brand | ${status.brand} |`,
    `| Attestations available | ${status.attestationsAvailable} |`,
  ].join("\n");
}
