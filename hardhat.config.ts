import type { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.25",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: 114,
    },
    coston2: {
      type: "http",
      url: "https://coston2-api.flare.network/ext/C/rpc",
      chainId: 114,
      accounts,
    },
    flare: {
      type: "http",
      url: "https://flare-api.flare.network/ext/C/rpc",
      chainId: 14,
      accounts,
    },
  },
};

export default config;
