import { type ActionFunctionArgs } from "react-router";
import shopify from "../shopify.server";
import prisma from "../db.server";

// ─── CORS Headers ────────────────────────────────────────────────────────────
// Allow the Shopify checkout extension (cross-origin) to call this endpoint.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Handle CORS preflight
export const loader = async () => new Response(null, { status: 204, headers: corsHeaders });

// ─── Action: Cancel / Void a Gift Card Redemption ────────────────────────────
// Called when the customer removes a gift card from the checkout UI,
// or when the checkout is abandoned. Voids the Ogloba transaction so
// the funds are returned to the gift card.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  console.log("[CANCEL] Incoming cancel-redemption request...");

  try {
    // --- AUTH ---
    // Validate the request comes from a legitimate Shopify checkout session.
    const { sessionToken } = await shopify.authenticate.public.checkout(request);
    const shop = sessionToken.dest.replace("https://", "");
    console.log(`[CANCEL] Authenticated for shop: ${shop}`);

    // --- PARSE BODY ---
    const { discountCode } = await request.json();
    console.log(`[CANCEL] Discount code to void: ${discountCode}`);

    // --- DB LOOKUP ---
    // Find the matching Ogloba transaction in our database.
    const transaction = await prisma.oglobaTransaction.findUnique({ where: { discountCode } });

    // If there's no record, or it was already voided, nothing to do — return success.
    if (!transaction) {
      console.warn(`[CANCEL] No transaction found for code: ${discountCode}. Skipping.`);
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }

    if (transaction.status === "VOIDED") {
      console.warn(`[CANCEL] Transaction ${discountCode} is already VOIDED. Skipping.`);
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }

    console.log(`[CANCEL] Transaction found — ref: ${transaction.referenceNumber}, status: ${transaction.status}`);

    // --- STEP 1: VOID ON OGLOBA ─────────────────────────────────────────────
    // Call Ogloba's voidTransaction endpoint to release the held funds
    // back onto the customer's gift card.
    console.log(`[CANCEL] [1/2] Calling Ogloba voidTransaction for ref: ${transaction.referenceNumber}`);

    const ogRes = await fetch(
      "https://dev.ogloba.com/gc-restful-gateway/giftCardService/voidTransaction",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WSRG-API-Version": "2.7",
          // Basic auth: base64("merchantId:apiKey")
          Authorization: `Basic ${Buffer.from(`${process.env.OGLOBA_MERCHANT_ID}:${process.env.OGLOBA_API_KEY}`).toString("base64")}`,
        },
        body: JSON.stringify({
          merchantId: process.env.OGLOBA_MERCHANT_ID,
          terminalId: process.env.OGLOBA_TERMINAL_ID,
          cashierId: process.env.OGLOBA_CASHIER_ID,
          originalMerchantId: process.env.OGLOBA_MERCHANT_ID,
          originalTerminalId: process.env.OGLOBA_TERMINAL_ID,
          originalCashierId: process.env.OGLOBA_CASHIER_ID,
          referenceNumber: transaction.referenceNumber,
        }),
      }
    );

    const ogData = await ogRes.json();
    console.log(`[CANCEL] [1/2] Ogloba voidTransaction response (HTTP ${ogRes.status}):`, JSON.stringify(ogData, null, 2));

    if (!ogData.isSuccessful) {
      throw new Error(`Ogloba void failed — errorCode: ${ogData.errorCode}, message: ${ogData.errorMessage || "No message"}`);
    }

    // --- STEP 2: UPDATE DB ──────────────────────────────────────────────────
    // Mark the transaction as VOIDED so it cannot be voided again.
    console.log(`[CANCEL] [2/2] Updating DB status to VOIDED for code: ${discountCode}`);
    await prisma.oglobaTransaction.update({
      where: { discountCode },
      data: { status: "VOIDED" },
    });
    console.log(`[CANCEL] [2/2] DB update complete.`);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("[CANCEL] ❌ Error during cancel-redemption:", error.message);
    console.error("[CANCEL] Stack:", error.stack);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};