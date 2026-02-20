import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import shopify from "../shopify.server";
import prisma from "../db.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const loader = async () => new Response(null, { status: 204, headers: corsHeaders });

// [Imports omitted for brevity...]

/**
 * Handles the initial "Redemption" call to Ogloba and creates a Shopify Discount.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    console.log("🚀 Starting Redemption process...");
    
    // 1. Authenticate Checkout Session (Ensures request comes from a valid checkout)
    const { sessionToken } = await shopify.authenticate.public.checkout(request);
    let shop = sessionToken.dest.replace("https://", "");
    console.log(`✅ Authenticated for shop: ${shop}`);

    const { admin } = await shopify.unauthenticated.admin(shop);
    const body = await request.json();
    const { cardNumber, pinCode } = body;

    // 2. Call Ogloba API
    // Note: This is an "Authorize/Redeem" call. Funds are held but not yet fully confirmed.
    console.log(`📡 Calling Ogloba for card: ${cardNumber.slice(-4)}`);
    const oglobaResponse = await fetch(
      "https://srl-ts.ogloba.com/gc-restful-gateway/giftCardService/redemption",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WSRG-API-Version": "2.18",
          Authorization: `Basic ${process.env.OGLOBA_API_KEY}`,
        },
        body: JSON.stringify({
          merchantId: "TestOgloba",
          terminalId: "demo",
          cashierId: "Shopify",
          transactionNumber: Date.now().toString().slice(-10),
          amount: 1, // Currently hardcoded for testing
          cardNumber,
          pinCode: pinCode || "",
        }),
      },
    );

    const oglobaData = await oglobaResponse.json();
    console.log("📥 [OGLOBA REDEMPTION RESPONSE]:", JSON.stringify(oglobaData, null, 2));

    if (oglobaData.isSuccessful) {
      const redeemedAmount = String(oglobaData.amount);
      const dynamicCode = `OGL-${Math.random().toString(36).substring(7).toUpperCase()}`;

      // 3. Create a temporary Shopify Discount Code for this specific amount
      console.log(`✨ Creating Shopify discount: ${dynamicCode}`);
      const discountResponse = await admin.graphql(
        `#graphql
        mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
            codeDiscountNode { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            basicCodeDiscount: {
              title: `Ogloba ${oglobaData.referenceNumber}`,
              code: dynamicCode,
              startsAt: new Date().toISOString(),
              customerSelection: { all: true },
              combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
              customerGets: { 
                value: { discountAmount: { amount: redeemedAmount, appliesOnEachItem: false } }, 
                items: { all: true } 
              },
              usageLimit: 1,
            },
          },
        },
      );

      const discountResult = await discountResponse.json();
      
      if (discountResult.data?.discountCodeBasicCreate?.userErrors?.length > 0) {
        console.error("❌ Shopify GraphQL Error:", JSON.stringify(discountResult));
        throw new Error("Failed to create Shopify discount");
      }

      const discountId = discountResult.data.discountCodeBasicCreate.codeDiscountNode.id;

      // 4. Save Transaction to DB
      // We set status to "PENDING" because the user hasn't finished the checkout yet.
      console.log("💾 Saving to DB...");
      try {
        await prisma.oglobaTransaction.create({
          data: {
            discountCode: dynamicCode,
            discountId: discountId,
            referenceNumber: String(oglobaData.referenceNumber),
            cardNumber: cardNumber,
            amount: parseFloat(redeemedAmount),
            status: "PENDING",
          }
        });
      } catch (dbError: any) {
        console.error("❌ Prisma DB Error:", dbError.message);
        throw new Error(`Database error: ${dbError.message}`);
      }

      return new Response(
        JSON.stringify({
          success: true,
          discountCode: dynamicCode,
          discountId: discountId,
          referenceNumber: oglobaData.referenceNumber,
          amount: redeemedAmount,
          message: `${redeemedAmount}€ applied`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: false, message: oglobaData.errorMessage || "Ogloba rejection" }), 
      { status: 400, headers: corsHeaders }
    );
  } catch (error: any) {
    console.error("💥 CRITICAL ERROR in /api/redemption:", error);
    return new Response(
      JSON.stringify({ success: false, message: error.message || "Internal Error" }), 
      { status: 500, headers: corsHeaders }
    );
  }
};