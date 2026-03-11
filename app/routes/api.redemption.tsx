import { type ActionFunctionArgs } from "react-router";
import shopify from "../shopify.server";
import prisma from "../db.server";

// ─── CORS Headers ────────────────────────────────────────────────────────────
// Required because the Shopify checkout extension runs in a cross-origin context.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Handle CORS preflight
export const loader = async () => new Response(null, { status: 204, headers: corsHeaders });

// ─── Lazy Cleanup Helper ──────────────────────────────────────────────────────
// On every redemption request, we opportunistically void any previously expired
// CONFIRMED transactions (i.e. abandoned checkouts). This avoids needing a
// separate cron job for low-volume stores, but is non-fatal if it fails.
async function performLazyCleanup(admin: any) {
  console.log("[LAZY CLEANUP] Checking for expired transactions...");

  const expiredTransactions = await prisma.oglobaTransaction.findMany({
    where: {
      status: "CONFIRMED",
      expiresAt: { lt: new Date() },
    },
  });

  if (expiredTransactions.length === 0) {
    console.log("[LAZY CLEANUP] No expired transactions found.");
    return;
  }

  console.log(`[LAZY CLEANUP] Found ${expiredTransactions.length} expired transaction(s).`);

  for (const tx of expiredTransactions) {
    try {
      console.log(`[LAZY CLEANUP] Voiding: ${tx.discountCode} | ref: ${tx.referenceNumber}`);

      const ogRes = await fetch(
        "https://dev.ogloba.com/gc-restful-gateway/giftCardService/voidTransaction",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WSRG-API-Version": "2.7",
            Authorization: `Basic ${Buffer.from(`${process.env.OGLOBA_MERCHANT_ID}:${process.env.OGLOBA_API_KEY}`).toString("base64")}`,
          },
          body: JSON.stringify({
            merchantId: process.env.OGLOBA_MERCHANT_ID,
            terminalId: process.env.OGLOBA_TERMINAL_ID,
            cashierId: process.env.OGLOBA_CASHIER_ID,
            originalMerchantId: process.env.OGLOBA_MERCHANT_ID,
            originalTerminalId: process.env.OGLOBA_TERMINAL_ID,
            originalCashierId: process.env.OGLOBA_CASHIER_ID,
            referenceNumber: tx.referenceNumber,
            transactionNumber: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            note: "Lazy Cleanup - Abandoned Checkout",
            reason: "TIMEOUT",
          }),
        }
      );

      const ogData = await ogRes.json();
      console.log(`[LAZY CLEANUP] Ogloba response for ${tx.discountCode}:`, JSON.stringify(ogData, null, 2));

      // errorCode 239 means "already voided" — treat as success
      if (ogData.isSuccessful || ogData.errorCode === 239) {
        // Delete the temporary Shopify discount code that was created during checkout
        await admin.graphql(
          `#graphql
          mutation delete($id: ID!) {
            discountCodeDelete(id: $id) { deletedCodeDiscountId }
          }`,
          { variables: { id: tx.discountId } }
        );

        await prisma.oglobaTransaction.update({
          where: { id: tx.id },
          data: { status: "EXPIRED_VOID" },
        });

        console.log(`[LAZY CLEANUP] ✅ Successfully voided and cleaned up: ${tx.discountCode}`);
      } else {
        console.warn(
          `[LAZY CLEANUP] ⚠️ Void not successful for ${tx.discountCode} — errorCode: ${ogData.errorCode}, message: ${ogData.errorMessage}`
        );
      }
    } catch (e: any) {
      // Non-fatal: log and continue
      console.error(`[LAZY CLEANUP] ❌ Error processing ${tx.discountCode}:`, e.message);
    }
  }
}

// ─── Action: Gift Card Redemption Flow ───────────────────────────────────────
// Full 4-step flow:
//   1. Redeem on Ogloba (reserves the amount on the gift card)
//   2. Confirm on Ogloba (locks in the reservation)
//   3. Create a temporary Shopify discount code for the checkout
//   4. Save the transaction to DB (with 30-min expiry for lazy cleanup)
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  console.log("─────────────────────────────────────────────");
  console.log("[REDEMPTION] Incoming redemption request...");

  // Track the Ogloba reference so we can roll back if anything fails mid-flow
  let oglobaRef: string | null = null;

  try {
    // --- AUTH ────────────────────────────────────────────────────────────────
    console.log("[REDEMPTION] Authenticating checkout session...");
    let sessionToken, shop, admin;
    try {
      ({ sessionToken } = await shopify.authenticate.public.checkout(request));
      shop = sessionToken.dest.replace("https://", "");
      ({ admin } = await shopify.unauthenticated.admin(shop));
      console.log(`[REDEMPTION] Authenticated for shop: ${shop}`);
    } catch (authErr: any) {
      console.error("[REDEMPTION] Authentication failed:", authErr.message);
      throw new Error(`Auth failed: ${authErr.message}`);
    }

    // --- PARSE BODY ──────────────────────────────────────────────────────────
    let cardNumber: string, pinCode: string;
    try {
      ({ cardNumber, pinCode } = await request.json());
      if (!cardNumber) throw new Error("cardNumber is missing from request body");
      console.log(`[REDEMPTION] Parsed request — card ending: ...${cardNumber.slice(-4)}`);
    } catch (parseErr: any) {
      console.error("[REDEMPTION] Failed to parse request body:", parseErr.message);
      throw new Error(`Invalid request body: ${parseErr.message}`);
    }

    // --- LAZY CLEANUP (non-fatal) ────────────────────────────────────────────
    try {
      await performLazyCleanup(admin);
    } catch (cleanupErr: any) {
      console.warn("[REDEMPTION] Lazy cleanup failed (non-fatal):", cleanupErr.message);
    }

    // --- STEP 1: REDEMPTION ──────────────────────────────────────────────────
    // Initiates a reservation on Ogloba. The gift card balance is not yet
    // deducted — it's held until confirmation (step 2).
    console.log(`[REDEMPTION] [1/4] Starting Ogloba redemption for card ending: ...${cardNumber.slice(-4)}`);

    const redRes = await fetch(
      "https://dev.ogloba.com/gc-restful-gateway/giftCardService/redemption",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WSRG-API-Version": "2.7",
          Authorization: `Basic ${Buffer.from(`${process.env.OGLOBA_MERCHANT_ID}:${process.env.OGLOBA_API_KEY}`).toString("base64")}`,
        },
        body: JSON.stringify({
          merchantId: process.env.OGLOBA_MERCHANT_ID,
          terminalId: process.env.OGLOBA_TERMINAL_ID,
          cashierId: process.env.OGLOBA_CASHIER_ID,
          // Unique transaction number to avoid collision on retries
          transactionNumber: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          amount: 1,
          cardNumber,
          pinCode: pinCode || "",
        }),
      }
    );

    const redData = await redRes.json();
    console.log(`[REDEMPTION] [1/4] Redemption response (HTTP ${redRes.status}):`, JSON.stringify(redData, null, 2));

    if (!redData.isSuccessful) {
      throw new Error(`Redemption failed — errorCode: ${redData.errorCode}, message: ${redData.errorMessage || "No message"}`);
    }

    oglobaRef = redData.referenceNumber;
    console.log(`[REDEMPTION] [1/4] ✅ Redemption successful. ref: ${oglobaRef}, amount: ${redData.amount}`);

    // --- STEP 2: CONFIRMATION ────────────────────────────────────────────────
    // Confirms the reservation — this is when the funds are actually deducted
    // from the gift card. Brief delay to let Ogloba finalize step 1.
    console.log(`[REDEMPTION] [2/4] Waiting 300ms before confirming...`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    console.log(`[REDEMPTION] [2/4] Confirming transaction ref: ${oglobaRef}`);

    const confRes = await fetch(
      "https://dev.ogloba.com/gc-restful-gateway/giftCardService/confirmTransaction",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WSRG-API-Version": "2.7",
          Authorization: `Basic ${Buffer.from(`${process.env.OGLOBA_MERCHANT_ID}:${process.env.OGLOBA_API_KEY}`).toString("base64")}`,
        },
        body: JSON.stringify({
          merchantId: process.env.OGLOBA_MERCHANT_ID,
          terminalId: process.env.OGLOBA_TERMINAL_ID,
          cashierId: process.env.OGLOBA_CASHIER_ID,
          referenceNumber: oglobaRef,
        }),
      }
    );

    const confData = await confRes.json();
    console.log(`[REDEMPTION] [2/4] Confirmation response (HTTP ${confRes.status}):`, JSON.stringify(confData, null, 2));

    if (!confData.isSuccessful) {
      throw new Error(`Confirmation failed — errorCode: ${confData.errorCode}, message: ${confData.errorMessage || "No message"}`);
    }
    console.log(`[REDEMPTION] [2/4] ✅ Confirmation successful.`);

    // --- STEP 3: CREATE SHOPIFY DISCOUNT CODE ────────────────────────────────
    // Create a one-time Shopify discount code mapped to the gift card amount.
    // The code is prefixed with "OGL-" so we can identify it later in webhooks.
    const dynamicCode = `OGL-${Math.random().toString(36).substring(7).toUpperCase()}`;
    console.log(`[REDEMPTION] [3/4] Creating Shopify discount code: ${dynamicCode} for amount: ${redData.amount}€`);

    const shopRes = await admin.graphql(
      `#graphql
      mutation create($input: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $input) {
          codeDiscountNode { id }
          userErrors { message field }
        }
      }`,
      {
        variables: {
          input: {
            title: `Ogloba ${oglobaRef}`,
            code: dynamicCode,
            startsAt: new Date().toISOString(),
            customerSelection: { all: true },
            // Allow stacking with other discounts
            combinesWith: {
              orderDiscounts: true,
              productDiscounts: true,
              shippingDiscounts: true,
            },
            customerGets: {
              value: {
                discountAmount: {
                  amount: String(redData.amount),
                  appliesOnEachItem: false,
                },
              },
              items: { all: true },
            },
            usageLimit: 1, // Single-use only
          },
        },
      }
    );

    const shopData = await shopRes.json();
    console.log(`[REDEMPTION] [3/4] Shopify discount response:`, JSON.stringify(shopData, null, 2));

    const userErrors = shopData.data?.discountCodeBasicCreate?.userErrors;
    if (userErrors?.length > 0) {
      throw new Error(
        `Shopify discount creation failed — ${userErrors.map((e: any) => `[${e.field}] ${e.message}`).join(", ")}`
      );
    }

    const discountId = shopData.data?.discountCodeBasicCreate?.codeDiscountNode?.id;
    if (!discountId) {
      console.error("[REDEMPTION] [3/4] Unexpected Shopify response — discountId is null:", JSON.stringify(shopData, null, 2));
      throw new Error("Shopify discount creation returned no ID");
    }
    console.log(`[REDEMPTION] [3/4] ✅ Shopify discount created. ID: ${discountId}`);

    // --- STEP 4: SAVE TO DB ──────────────────────────────────────────────────
    // Persist the transaction with a 30-minute expiry window.
    // If the customer doesn't complete checkout within this window,
    // the lazy cleanup or cron job will void it.
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 30);
    console.log(`[REDEMPTION] [4/4] Saving to DB. Expires at: ${expiresAt.toISOString()}`);

    await prisma.oglobaTransaction.create({
      data: {
        discountCode: dynamicCode,
        discountId,
        referenceNumber: String(oglobaRef),
        cardNumber,
        amount: parseFloat(redData.amount),
        status: "CONFIRMED",
        expiresAt,
      },
    });
    console.log(`[REDEMPTION] [4/4] ✅ DB save successful.`);
    console.log("─────────────────────────────────────────────");

    return new Response(
      JSON.stringify({ success: true, discountCode: dynamicCode, amount: redData.amount }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("[REDEMPTION] ❌ Redemption flow failed:", error.message);
    console.error("[REDEMPTION] Stack:", error.stack);

    // --- ROLLBACK ────────────────────────────────────────────────────────────
    // If Ogloba redemption succeeded but something downstream failed,
    // cancel the transaction so the gift card funds are not locked.
    if (oglobaRef) {
      console.log(`[REDEMPTION] Rolling back Ogloba transaction ref: ${oglobaRef}`);
      try {
        const cancelRes = await fetch(
          "https://dev.ogloba.com/gc-restful-gateway/giftCardService/cancelTransaction",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-WSRG-API-Version": "2.7",
              Authorization: `Basic ${Buffer.from(`${process.env.OGLOBA_MERCHANT_ID}:${process.env.OGLOBA_API_KEY}`).toString("base64")}`,
            },
            body: JSON.stringify({
              merchantId: process.env.OGLOBA_MERCHANT_ID,
              terminalId: process.env.OGLOBA_TERMINAL_ID,
              cashierId: process.env.OGLOBA_CASHIER_ID,
              referenceNumber: oglobaRef,
            }),
          }
        );
        const cancelData = await cancelRes.json();
        console.log(`[REDEMPTION] Rollback response:`, JSON.stringify(cancelData, null, 2));
      } catch (rollbackErr: any) {
        console.error(`[REDEMPTION] ❌ Rollback also failed:`, rollbackErr.message);
      }
    }

    return new Response(
      JSON.stringify({ success: false, message: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};