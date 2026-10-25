import Stripe from "stripe";
import { config } from "./config.js";
import { store } from "./store.js";
import { userStore, StoredUser, SubscriptionStatus } from "./user-store.js";
import { Tier } from "./types.js";

const stripeKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeKey ? new Stripe(stripeKey) : null;

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const DOMAIN = process.env.DOMAIN || "https://xrp-link.com";
const AUTOMATIC_TAX = process.env.STRIPE_AUTOMATIC_TAX === "true";

interface TierProduct {
  priceId: string;
  lookupKey: string;
  unitAmount: number;
  receipts: number;
  rateLimit: number;
}

const TIER_PRODUCTS: Record<string, TierProduct> = {
  paid: { priceId: "", lookupKey: "xrplink_paid", unitAmount: 2900, receipts: 5, rateLimit: 100 },
  pro: { priceId: "", lookupKey: "xrplink_pro", unitAmount: 9900, receipts: 25, rateLimit: Infinity },
};

let portalConfigId: string | null = null;

export async function initProducts() {
  if (!stripe) {
    console.log("Stripe not configured — skipping product sync");
    return;
  }

  for (const [tier, info] of Object.entries(TIER_PRODUCTS)) {
    const existing = await stripe.prices.list({
      lookup_keys: [info.lookupKey],
      limit: 1,
    });

    if (existing.data.length > 0) {
      info.priceId = existing.data[0].id;
      console.log(`Found existing price for ${tier}: ${info.priceId}`);
      continue;
    }

    const product = await stripe.products.create({
      name: `XRPLink ${tier.charAt(0).toUpperCase() + tier.slice(1)}`,
      description: tier === "paid" ? "5 verified receipts per month" : "25 verified receipts per month",
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: info.unitAmount,
      currency: "usd",
      recurring: { interval: "month" },
      lookup_key: info.lookupKey,
    });

    info.priceId = price.id;
    console.log(`Created Stripe product/price for ${tier}: product=${product.id} price=${price.id}`);
  }
}

function lookupKeyToTier(lookupKey: string): Tier | null {
  for (const [tier, info] of Object.entries(TIER_PRODUCTS)) {
    if (info.lookupKey === lookupKey) return tier as Tier;
  }
  return null;
}

async function getPriceInfo(priceId: string): Promise<{ tier: Tier; lookupKey: string } | null> {
  if (!stripe) return null;

  for (const [tier, info] of Object.entries(TIER_PRODUCTS)) {
    if (info.priceId === priceId) {
      return { tier: tier as Tier, lookupKey: info.lookupKey };
    }
  }

  try {
    const price = await stripe.prices.retrieve(priceId);
    if (price.lookup_key) {
      const tier = lookupKeyToTier(price.lookup_key);
      if (tier) return { tier, lookupKey: price.lookup_key };
    }
  } catch {
  }

  return null;
}

async function ensurePortalConfiguration(): Promise<string | null> {
  if (!stripe) return null;
  if (portalConfigId) return portalConfigId;

  try {
    const configs = await stripe.billingPortal.configurations.list({ limit: 1 });
    if (configs.data.length > 0 && configs.data[0].is_default) {
      portalConfigId = configs.data[0].id;
      console.log(`Using existing billing portal config: ${portalConfigId}`);
      return portalConfigId;
    }
  } catch (err) {
    console.error("Error listing portal configurations:", err);
  }

  try {
    const products: string[] = [];
    for (const info of Object.values(TIER_PRODUCTS)) {
      if (info.priceId) {
        try {
          const price = await stripe.prices.retrieve(info.priceId);
          if (price.product && typeof price.product === "string") {
            products.push(price.product);
          }
        } catch {
        }
      }
    }

    const config = await stripe.billingPortal.configurations.create({
      business_profile: {
        headline: "Manage your XRPLink subscription",
      },
      features: {
        customer_update: {
          enabled: true,
          allowed_updates: ["email", "name"],
        },
        payment_method_update: {
          enabled: true,
        },
        invoice_history: {
          enabled: true,
        },
        subscription_cancel: {
          enabled: true,
          mode: "at_period_end",
          cancellation_reason: {
            enabled: true,
            options: ["too_expensive", "missing_features", "switched_service", "unused", "other"],
          },
        },
        subscription_update: {
          enabled: products.length > 0,
          default_allowed_updates: ["price"],
          products: products.length > 0
            ? products.map((productId) => ({
                product: productId,
                prices: Object.values(TIER_PRODUCTS)
                  .filter((t) => t.priceId)
                  .map((t) => t.priceId),
              }))
            : undefined,
        },
      },
      default_return_url: `${DOMAIN}/dashboard`,
    });

    portalConfigId = config.id;
    console.log(`Created billing portal config: ${portalConfigId}`);
    return portalConfigId;
  } catch (err) {
    console.error("Error creating portal configuration:", err);
    return null;
  }
}

export async function createCheckoutSession(
  user: StoredUser,
  tier: string
): Promise<{ url: string } | null> {
  if (!stripe) return null;
  const product = TIER_PRODUCTS[tier];
  if (!product || !product.priceId) return null;

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      customer_email: user.stripeCustomerId ? undefined : user.email,
      customer: user.stripeCustomerId || undefined,
      line_items: [{ price: product.priceId, quantity: 1 }],
      metadata: { userId: user.id, tier },
      success_url: `${DOMAIN}/dashboard?upgraded=${tier}`,
      cancel_url: `${DOMAIN}/pricing`,
    };

    if (AUTOMATIC_TAX) {
      sessionParams.automatic_tax = { enabled: true };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return { url: session.url! };
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return null;
  }
}

export async function createPortalSession(
  user: StoredUser
): Promise<{ url: string } | null> {
  if (!stripe) return null;
  if (!user.stripeCustomerId) return null;

  try {
    const configId = await ensurePortalConfiguration();

    const sessionParams: Stripe.BillingPortal.SessionCreateParams = {
      customer: user.stripeCustomerId,
      return_url: `${DOMAIN}/dashboard`,
    };

    if (configId) {
      sessionParams.configuration = configId;
    }

    const session = await stripe.billingPortal.sessions.create(sessionParams);
    return { url: session.url };
  } catch (err) {
    console.error("Stripe portal error:", err);
    return null;
  }
}

async function updateUserSubscription(
  user: StoredUser,
  updates: {
    tier?: Tier;
    subscriptionStatus?: SubscriptionStatus;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
  }
): Promise<void> {
  userStore.update(user.id, updates);

  if (updates.tier !== undefined) {
    const updatedUser = userStore.findById(user.id);
    if (updatedUser) {
      for (const keyId of updatedUser.apiKeyIds) {
        await store.updateApiKeyTier(keyId, updates.tier);
      }
    }
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.userId;
  const tier = session.metadata?.tier as Tier | undefined;

  if (!userId || !tier) {
    console.log("Checkout completed but missing userId or tier in metadata");
    return;
  }

  const user = userStore.findById(userId);
  if (!user) {
    console.log(`Checkout completed but user ${userId} not found`);
    return;
  }

  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  await updateUserSubscription(user, {
    tier,
    subscriptionStatus: "active",
    stripeCustomerId: session.customer as string,
    stripeSubscriptionId: subscriptionId || "",
  });

  console.log(`Upgraded user ${userId} to ${tier} via checkout`);
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;

  const user = userStore.findByStripeCustomerId(customerId);
  if (!user) {
    console.log(`Subscription updated but no user found for customer ${customerId}`);
    return;
  }

  if (user.stripeSubscriptionId && user.stripeSubscriptionId !== subscription.id) {
    console.log(`Ignoring subscription ${subscription.id} - user has different subscription`);
    return;
  }

  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId) {
    console.log("Subscription updated but no price found");
    return;
  }

  const priceInfo = await getPriceInfo(priceId);
  if (!priceInfo) {
    console.log(`Subscription updated but unknown price ${priceId}`);
    return;
  }

  let status: SubscriptionStatus = "active";
  if (subscription.status === "past_due") {
    status = "past_due";
  } else if (
    subscription.status === "canceled" ||
    subscription.status === "unpaid"
  ) {
    status = "canceled";
  }

  await updateUserSubscription(user, {
    tier: priceInfo.tier,
    subscriptionStatus: status,
    stripeSubscriptionId: subscription.id,
  });

  console.log(
    `Updated user ${user.id} subscription: tier=${priceInfo.tier}, status=${status}`
  );
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;

  const user = userStore.findByStripeCustomerId(customerId);
  if (!user) {
    console.log(`Subscription deleted but no user found for customer ${customerId}`);
    return;
  }

  if (user.stripeSubscriptionId && user.stripeSubscriptionId !== subscription.id) {
    console.log(`Ignoring deleted subscription ${subscription.id} - user has different subscription`);
    return;
  }

  await updateUserSubscription(user, {
    tier: "free",
    subscriptionStatus: "canceled",
    stripeSubscriptionId: "",
  });

  console.log(`Downgraded user ${user.id} to free after subscription deletion`);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId =
    typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

  if (!customerId) return;

  const user = userStore.findByStripeCustomerId(customerId);
  if (!user) {
    console.log(`Invoice payment failed but no user found for customer ${customerId}`);
    return;
  }

  if (user.subscriptionStatus === "past_due") {
    return;
  }

  await updateUserSubscription(user, {
    subscriptionStatus: "past_due",
  });

  console.log(`Marked user ${user.id} as past_due after payment failure`);
}

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId =
    typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;

  if (!customerId) return;

  const user = userStore.findByStripeCustomerId(customerId);
  if (!user) {
    console.log(`Invoice paid but no user found for customer ${customerId}`);
    return;
  }

  if (user.subscriptionStatus === "past_due") {
    await updateUserSubscription(user, {
      subscriptionStatus: "active",
    });
    console.log(`Cleared past_due status for user ${user.id} after successful payment`);
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

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case "invoice.paid":
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      default:
        console.log(`Unhandled Stripe event type: ${event.type}`);
    }
  } catch (err) {
    console.error(`Error handling Stripe event ${event.type}:`, err);
  }

  return { status: 200, body: { received: true } };
}

export function isAutomaticTaxEnabled(): boolean {
  return AUTOMATIC_TAX;
}

export { TIER_PRODUCTS };
