import Stripe from "stripe";
import { config } from "./config.js";
import { store } from "./store.js";
import { userStore, StoredUser, SubscriptionStatus } from "./user-store.js";
import { Tier } from "./types.js";
import { ATTESTATION_LIMITS } from "./attestation-quota.js";

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
  paid: { priceId: "", lookupKey: "xrplink_paid", unitAmount: 2900, receipts: ATTESTATION_LIMITS.paid, rateLimit: 100 },
  pro: { priceId: "", lookupKey: "xrplink_pro", unitAmount: 9900, receipts: ATTESTATION_LIMITS.pro, rateLimit: Infinity },
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
      // Only used when creating a *new* Stripe product. Existing lookup-key prices are left untouched.
      description:
        tier === "paid"
          ? `${ATTESTATION_LIMITS.paid} verified receipts per month`
          : `${ATTESTATION_LIMITS.pro} verified receipts per month`,
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

export function lookupKeyToTier(lookupKey: string | null | undefined): Tier | null {
  if (!lookupKey) return null;
  for (const [tier, info] of Object.entries(TIER_PRODUCTS)) {
    if (info.lookupKey === lookupKey) return tier as Tier;
  }
  return null;
}

export function priceIdFromCheckoutSession(
  session: {
    line_items?: {
      data?: Array<{ price?: string | { id?: string; lookup_key?: string | null } | null }>;
    };
  },
  subscription?: {
    items?: { data?: Array<{ price?: { id?: string; lookup_key?: string | null } | null }> };
  } | null
): { priceId: string; lookupKey?: string | null } | null {
  const subPrice = subscription?.items?.data?.[0]?.price;
  if (subPrice?.id) return { priceId: subPrice.id, lookupKey: subPrice.lookup_key };
  const line = session.line_items?.data?.[0]?.price;
  if (!line) return null;
  if (typeof line === "string") return { priceId: line };
  if (line.id) return { priceId: line.id, lookupKey: line.lookup_key };
  return null;
}

export async function getPriceInfo(priceId: string): Promise<{ tier: Tier; lookupKey: string } | null> {
  for (const [tier, info] of Object.entries(TIER_PRODUCTS)) {
    if (info.priceId && info.priceId === priceId) {
      return { tier: tier as Tier, lookupKey: info.lookupKey };
    }
  }

  if (!stripe) return null;

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

export async function resolveCheckoutTier(
  session: {
    line_items?: {
      data?: Array<{ price?: string | { id?: string; lookup_key?: string | null } | null }>;
    };
    metadata?: Record<string, string> | null;
  },
  subscription?: {
    items?: { data?: Array<{ price?: { id?: string; lookup_key?: string | null } | null }> };
  } | null
): Promise<Tier | null> {
  // Entitlement comes from the Stripe price, never from client metadata or query params.
  const priced = priceIdFromCheckoutSession(session, subscription);
  if (!priced) return null;
  const fromLookup = lookupKeyToTier(priced.lookupKey);
  if (fromLookup) return fromLookup;
  const info = await getPriceInfo(priced.priceId);
  return info?.tier ?? null;
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
      metadata: { userId: user.id },
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
    billingPeriodStart?: number;
    billingPeriodEnd?: number;
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

export async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.log("Checkout completed but missing userId in metadata");
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

  let retrievedSubscription: Stripe.Subscription | null = null;
  let billingPeriodStart: number | undefined;
  let billingPeriodEnd: number | undefined;

  if (stripe && subscriptionId) {
    try {
      retrievedSubscription = await stripe.subscriptions.retrieve(subscriptionId);
      const sub = retrievedSubscription as Stripe.Subscription & {
        current_period_start?: number;
        current_period_end?: number;
      };
      billingPeriodStart = sub.current_period_start;
      billingPeriodEnd = sub.current_period_end;
    } catch (err) {
      console.error("Failed to fetch subscription for billing period:", err);
    }
  }

  const tier = await resolveCheckoutTier(session, retrievedSubscription);
  if (!tier) {
    console.log(
      `Checkout completed for user ${userId} but price is missing or unknown; ignoring metadata.tier=${session.metadata?.tier || ""}`
    );
    return;
  }

  await updateUserSubscription(user, {
    tier,
    subscriptionStatus: "active",
    stripeCustomerId: session.customer as string,
    stripeSubscriptionId: subscriptionId || "",
    billingPeriodStart,
    billingPeriodEnd,
  });

  console.log(`Upgraded user ${userId} to ${tier} via checkout (period: ${billingPeriodStart} - ${billingPeriodEnd})`);
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

  // Always update billing period from subscription
  const sub = subscription as any;
  const billingPeriodStart = sub.current_period_start as number;
  const billingPeriodEnd = sub.current_period_end as number;

  await updateUserSubscription(user, {
    tier: priceInfo.tier,
    subscriptionStatus: status,
    stripeSubscriptionId: subscription.id,
    billingPeriodStart,
    billingPeriodEnd,
  });

  console.log(
    `Updated user ${user.id} subscription: tier=${priceInfo.tier}, status=${status}, period=${billingPeriodStart}-${billingPeriodEnd}`
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

  // Check if this invoice has subscription billing period info
  // This indicates a subscription renewal, so we should update the billing period
  const inv = invoice as unknown as { subscription?: string | { id: string } };
  const subscriptionId = typeof inv.subscription === "string" 
    ? inv.subscription 
    : inv.subscription?.id;
    
  if (subscriptionId && stripe) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId) as any;
      const newPeriodStart = subscription.current_period_start as number;
      const newPeriodEnd = subscription.current_period_end as number;
      
      // Check if this is a new billing period (period start changed)
      const isNewPeriod = user.billingPeriodStart !== newPeriodStart;
      
      if (isNewPeriod) {
        // Update billing period - usage will automatically reset because
        // attestation usage is keyed by billing period start timestamp
        await updateUserSubscription(user, {
          subscriptionStatus: "active",
          billingPeriodStart: newPeriodStart,
          billingPeriodEnd: newPeriodEnd,
        });
        console.log(`New billing period for user ${user.id}: ${newPeriodStart} - ${newPeriodEnd}`);
      } else if (user.subscriptionStatus === "past_due") {
        await updateUserSubscription(user, {
          subscriptionStatus: "active",
        });
        console.log(`Cleared past_due status for user ${user.id} after successful payment`);
      }
    } catch (err) {
      console.error("Failed to fetch subscription for billing period update:", err);
      // Still clear past_due if applicable
      if (user.subscriptionStatus === "past_due") {
        await updateUserSubscription(user, {
          subscriptionStatus: "active",
        });
        console.log(`Cleared past_due status for user ${user.id} after successful payment`);
      }
    }
  } else if (user.subscriptionStatus === "past_due") {
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
