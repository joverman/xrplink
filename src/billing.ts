import Stripe from "stripe";
import { config } from "./config.js";
import { store } from "./store.js";
import { userStore, StoredUser } from "./user-store.js";

const stripeKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeKey ? new Stripe(stripeKey) : null;

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const DOMAIN = process.env.DOMAIN || "https://xrp-link.com";

interface TierProduct {
  priceId: string;
  receipts: number;
  rateLimit: number;
}

const TIER_PRODUCTS: Record<string, TierProduct> = {
  paid: { priceId: "", receipts: 5, rateLimit: 100 },
  pro: { priceId: "", receipts: 25, rateLimit: Infinity },
};

export async function initProducts() {
  if (!stripe) { console.log("Stripe not configured — skipping product sync"); return; }
  for (const [tier, info] of Object.entries(TIER_PRODUCTS)) {
    const existing = await stripe.prices.list({
      lookup_keys: [`xrplink_${tier}`],
      limit: 1,
    });
    if (existing.data.length > 0) {
      info.priceId = existing.data[0].id;
      continue;
    }
    // Create the product and price
    await stripe.products.create({
      name: `XRPLink ${tier.charAt(0).toUpperCase() + tier.slice(1)}`,
      lookup_key: `xrplink_${tier}`,
    });
    const price = await stripe.prices.create({
      product_data: { lookup_key: `xrplink_${tier}` },
      unit_amount: tier === "paid" ? 2900 : 9900, // $29, $99
      currency: "usd",
      recurring: { interval: "month" },
      lookup_key: `xrplink_${tier}`,
    });
    info.priceId = price.id;
    console.log(`Created Stripe product for ${tier}: ${price.id}`);
  }
}

export async function createCheckoutSession(user: StoredUser, tier: string): Promise<{ url: string } | null> {
  if (!stripe) return null;
  const product = TIER_PRODUCTS[tier];
  if (!product) return null;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: user.email,
      line_items: [{ price: product.priceId, quantity: 1 }],
      metadata: { userId: user.id, tier },
      success_url: `${DOMAIN}/dashboard?upgraded=${tier}`,
      cancel_url: `${DOMAIN}/pricing`,
    });
    return { url: session.url! };
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return null;
  }
}

export async function createPortalSession(user: StoredUser): Promise<{ url: string } | null> {
  if (!stripe) return null;
  if (!user.stripeCustomerId) return null;
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${DOMAIN}/dashboard`,
    });
    return { url: session.url };
  } catch {
    return null;
  }
}

export async function handleWebhook(
  body: any,
  signature: string
): Promise<{ status: number; body: any }> {
  if (!stripe) return { status: 200, body: { ok: true } };

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, WEBHOOK_SECRET);
  } catch (err: any) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return { status: 400, body: { error: "Invalid signature" } };
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;
    const tier = session.metadata?.tier;

    if (userId && tier && userStore.findById(userId)) {
      userStore.update(userId, {
        tier: tier as "paid" | "pro",
        stripeCustomerId: session.customer as string,
      });
      // Upgrade the user's API key tier
      const user = userStore.findById(userId)!;
      for (const keyId of user.apiKeyIds) {
        store.updateApiKeyTier(keyId, tier as "paid" | "pro");
      }
      console.log(`Upgraded user ${userId} to ${tier}`);
    }
  }

  return { status: 200, body: { received: true } };
}
