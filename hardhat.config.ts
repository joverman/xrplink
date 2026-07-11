import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.25",
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 200 },
        },
      },
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
});
