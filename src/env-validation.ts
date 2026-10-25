/**
 * Environment validation for production deployments.
 * Validates that required secrets are set and not using development defaults.
 */

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const DEV_SESSION_SECRET = "dev-secret-change-in-prod";

// Note: The all-zeros UUID is Flare's documented public API key for its hosted verifiers.
// It's valid for production use, though a dedicated key may have higher rate limits.
const PUBLIC_VERIFIER_API_KEY = "00000000-0000-0000-0000-000000000000";

function isValidEthereumAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Check if an env value is effectively unset.
 * Treats empty string, "undefined", and actual undefined as unset.
 * This handles the edge case where assigning undefined to process.env
 * results in the string "undefined".
 */
export function isEffectivelyUnset(value: string | undefined): boolean {
  return !value || value === "" || value === "undefined";
}

export function isProduction(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    !!process.env.FLY_APP_NAME ||
    !!process.env.FLY_REGION
  );
}

export function validateEnv(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProd = isProduction();

  // --- Required in production ---

  // SESSION_SECRET - used for JWT signing
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret === DEV_SESSION_SECRET) {
    if (isProd) {
      errors.push(
        "SESSION_SECRET is not set or uses development default. " +
          "Set a secure random string (e.g., `openssl rand -base64 32`)."
      );
    } else {
      warnings.push("SESSION_SECRET using development default (OK for local dev).");
    }
  }

  // VERIFIER_API_KEY - FDC verifier API key
  // The all-zeros UUID is Flare's public API key and is valid for production.
  // A dedicated key may offer higher rate limits.
  const verifierApiKey = process.env.VERIFIER_API_KEY;
  if (!verifierApiKey || verifierApiKey === PUBLIC_VERIFIER_API_KEY) {
    if (isProd) {
      warnings.push(
        "VERIFIER_API_KEY is not set or uses Flare's public API key. " +
          "This works but a dedicated key may have higher rate limits."
      );
    } else {
      warnings.push("VERIFIER_API_KEY using public key (OK for local dev).");
    }
  }

  // PRIVATE_KEY - required for submitting attestation requests to blockchain
  // Without this, receipt lookup still works but new attestations cannot be created.
  const network = process.env.FLARE_NETWORK || "coston2";
  const privateKeyEnv = network === "flare" ? "PRIVATE_KEY_FLARE" : "PRIVATE_KEY_COSTON2";
  const privateKey = process.env[privateKeyEnv] || process.env.PRIVATE_KEY;
  if (!privateKey) {
    if (isProd) {
      warnings.push(
        `${privateKeyEnv} (or PRIVATE_KEY) is not set. ` +
          "Receipt lookup works but new attestation requests cannot be submitted."
      );
    } else {
      warnings.push(`${privateKeyEnv} not set (blockchain features disabled).`);
    }
  }

  // PAYMENT_VERIFIER_ADDRESS - deployed contract address (optional)
  // On-chain verification is disabled when not set, but the app still works
  const verifierAddressEnv =
    network === "flare" ? "PAYMENT_VERIFIER_ADDRESS_FLARE" : "PAYMENT_VERIFIER_ADDRESS_COSTON2";
  const verifierAddressRaw = process.env[verifierAddressEnv] || process.env.PAYMENT_VERIFIER_ADDRESS;
  if (isEffectivelyUnset(verifierAddressRaw)) {
    warnings.push(
      `${verifierAddressEnv} not set. On-chain proof verification is disabled. ` +
        "Deploy the PaymentVerifier contract and set this address to enable verification."
    );
  } else if (!isValidEthereumAddress(verifierAddressRaw as string)) {
    errors.push(
      `${verifierAddressEnv} is not a valid Ethereum address. ` +
        "Expected format: 0x followed by 40 hex characters (e.g., 0x1234...abcd)."
    );
  }

  // --- Optional but recommended in production ---

  // STRIPE_SECRET_KEY - for billing
  if (!process.env.STRIPE_SECRET_KEY) {
    warnings.push("STRIPE_SECRET_KEY not set (billing features disabled).");
  }

  // STRIPE_WEBHOOK_SECRET - for secure Stripe webhook handling
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    if (isProd) {
      errors.push(
        "STRIPE_WEBHOOK_SECRET is not set but STRIPE_SECRET_KEY is. " +
          "Webhook signature verification will fail."
      );
    }
  }

  // RESEND_API_KEY - for email delivery
  if (!process.env.RESEND_API_KEY) {
    warnings.push("RESEND_API_KEY not set (email features disabled).");
  }

  // WEBHOOK_SIGNING_SECRET - for signing outbound webhooks
  if (!process.env.WEBHOOK_SIGNING_SECRET) {
    if (isProd) {
      warnings.push(
        "WEBHOOK_SIGNING_SECRET not set. Outbound webhooks will not be signed. " +
          "Consider setting a secure random string for webhook payload signing."
      );
    }
  }

  // DATABASE_URL - for Postgres storage
  if (!process.env.DATABASE_URL) {
    warnings.push(
      "DATABASE_URL not set. Using JSON file storage. " +
        "Consider using Postgres for production reliability."
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function printValidationResult(result: EnvValidationResult): void {
  if (result.warnings.length > 0) {
    console.log("\n⚠️  Environment warnings:");
    for (const warning of result.warnings) {
      console.log(`   - ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    console.error("\n❌ Environment validation failed:");
    for (const error of result.errors) {
      console.error(`   - ${error}`);
    }
    console.error("\nRequired environment variables for production:");
    console.error("  SESSION_SECRET         - Secure random string for JWT signing");
    console.error("\nOptional (receipt lookup works without these):");
    console.error("  VERIFIER_API_KEY       - Flare Data Connector API key (public key works)");
    console.error("  PRIVATE_KEY_FLARE      - Wallet private key (for new attestations)");
    console.error("  PAYMENT_VERIFIER_ADDRESS_FLARE - PaymentVerifier contract (for on-chain verification)");
    console.error("\nOptional but recommended:");
    console.error("  STRIPE_SECRET_KEY      - Stripe API key for billing");
    console.error("  STRIPE_WEBHOOK_SECRET  - Stripe webhook signing secret");
    console.error("  RESEND_API_KEY         - Resend API key for emails");
    console.error("  WEBHOOK_SIGNING_SECRET - Secret for signing outbound webhooks");
    console.error("  DATABASE_URL           - Postgres connection string (Neon recommended)");
    console.error("");
  }
}

/**
 * Validate environment and exit if invalid in production.
 * Call this early in the startup sequence.
 */
export function requireValidEnv(): void {
  const result = validateEnv();
  printValidationResult(result);

  if (!result.valid && isProduction()) {
    console.error("Refusing to start in production with invalid environment.\n");
    process.exit(1);
  }

  if (result.valid && result.warnings.length === 0) {
    console.log("✅ Environment validation passed.\n");
  } else if (result.valid) {
    console.log("✅ Environment validation passed (with warnings).\n");
  }
}
