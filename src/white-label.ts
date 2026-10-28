import { readFileSync, existsSync, mkdirSync } from "fs";
import { atomicWriteJson, createMutex } from "./file-lock.js";

export interface WhiteLabelConfig {
  brandName: string;
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  companyUrl: string;
  customDomain: string;
}

const defaults: WhiteLabelConfig = {
  brandName: "XRPLink",
  logoUrl: "",
  primaryColor: "#3b82f6",
  secondaryColor: "#1e293b",
  companyUrl: "https://xrp-link.com",
  customDomain: "",
};

const PATH = "data/white-label.json";
const writeLock = createMutex();

class WhiteLabel {
  private config: WhiteLabelConfig;

  constructor() {
    this.config = this.load();
  }

  private load(): WhiteLabelConfig {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    if (!existsSync(PATH)) {
      atomicWriteJson(PATH, defaults);
      return { ...defaults };
    }
    try {
      return { ...defaults, ...JSON.parse(readFileSync(PATH, "utf8")) };
    } catch {
      return { ...defaults };
    }
  }

  get(): WhiteLabelConfig {
    return { ...this.config };
  }

  update(updates: Partial<WhiteLabelConfig>): WhiteLabelConfig {
    this.config = { ...this.config, ...updates };
    atomicWriteJson(PATH, this.config);
    return this.get();
  }

  async updateLocked(updates: Partial<WhiteLabelConfig>): Promise<WhiteLabelConfig> {
    return writeLock(() => this.update(updates));
  }

  /** Inline CSS for white-label themed dashboard */
  injectCss(): string {
    return `<style>
:root{--brand:${this.config.primaryColor};--bg:${this.config.secondaryColor}}
.brand-header{background:var(--brand);color:#fff;padding:1.5rem 2rem;border-radius:8px;margin-bottom:1.5rem}
.brand-header h1{margin:0;font-size:1.5rem}
.brand-header p{margin:0.25rem 0 0;opacity:0.85;font-size:0.85rem}
${this.config.logoUrl ? `.brand-logo{height:32px;vertical-align:middle;margin-right:0.5rem}` : ""}
</style>`;
  }
}

export const whiteLabel = new WhiteLabel();
