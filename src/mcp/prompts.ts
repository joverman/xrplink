export interface PromptDef {
  name: string;
  description: string;
  args: { name: string; description: string; required?: boolean }[];
}

const prompts: PromptDef[] = [
  {
    name: "welcome",
    description: "Welcome message introducing XRPLink and what it can do",
    args: [],
  },
  {
    name: "verify_flow",
    description: "Step-by-step walkthrough for verifying an XRP payment",
    args: [{ name: "txHash", description: "Optional XRP transaction hash", required: false }],
  },
  {
    name: "admin_setup",
    description: "How to configure API keys, webhooks, branding, and network settings",
    args: [],
  },
  {
    name: "troubleshoot",
    description: "Common issues and their solutions",
    args: [{ name: "issue", description: "Optional specific issue", required: false }],
  },
];

export function getPromptDefs() {
  return prompts;
}

export function getPromptContent(name: string, args?: Record<string, string>): string | null {
  switch (name) {
    case "welcome":
      return [
        "I am XRPLink, an XRP payment attestation service on the Flare Network.",
        "",
        "I can verify any XRP transaction by its hash using Flare's FDC protocol.",
        "",
        "Available tools:",
        "1. **verify_xrp_payment** — Submit an XRP txHash for attestation",
        "2. **get_attestation_status** — Check attestation status by UUID",
        "3. **lookup_attestation_by_tx** — Find attestation by txHash",
        "4. **get_server_info** — Server and network information",
        "",
        "To get started, provide an XRP transaction hash.",
      ].join("\n");

    case "verify_flow":
      return [
        "# Verifying an XRP Payment",
        "",
        "## Step 1: Submit the txHash",
        args?.txHash
          ? `Call \`verify_xrp_payment\` with \`{ "txHash": "${args.txHash}" }\``
          : "Call verify_xrp_payment with a 64-character XRP transaction hash.",
        "",
        "## Step 2: Wait (~90s)",
        "The Flare FDC protocol takes ~90 seconds for its voting round.",
        "",
        "## Step 3: Check status",
        "Call get_attestation_status with the returned UUID.",
        "",
        "## Step 4: Interpret",
        "- **verified** — On-chain confirmation",
        "- **pending** — Round still in progress",
        "- **ready** — Proof available, awaiting on-chain verification",
        "- **failed** — Attestation failed consensus",
      ].join("\n");

    case "admin_setup":
      return [
        "# XRPLink Administration",
        "",
        "## API Keys",
        "- Create: POST /api/v1/admin/keys (requires pro-tier key)",
        "- Tiers: free (10/min), paid (100/min), pro (unlimited)",
        "",
        "## Webhooks",
        "- Register URL to receive attestation completion events",
        "",
        "## White-Label Branding",
        "- Configure brand name, colors, logo via GET/PUT /api/v1/admin/white-label",
        "",
        "## Network",
        "- Set FLARE_NETWORK=coston2 or flare in .env",
        "- Mainnet uses XRP source ID; Coston2 uses testXRP",
      ].join("\n");

    case "troubleshoot":
      return [
        "# XRPLink Troubleshooting",
        "",
        "## \"Attestation not found\"",
        "Wait 90-180s for round finalization, then retry.",
        "",
        "## \"Invalid API key\"",
        "Verify the key exists and is active. Generate a new one if needed.",
        "",
        "## \"INVALID_TX_HASH\"",
        "The hash must be 64 hex characters. Example: 388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22",
        "",
        "## \"Payment not successful\"",
        "The XRP transaction had a non-zero status. Verify it exists on XRPL.",
        "",
        args?.issue ? `## Specific issue: ${args.issue}\nCheck xrplink://docs/tools for more help.` : "",
      ]
        .filter(Boolean)
        .join("\n");

    default:
      return null;
  }
}
