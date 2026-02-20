import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import shopify from "../shopify.server";
import prisma from "../db.server";

/**
 * CORS configuration to allow the Shopify Checkout UI Extension 
 * to communicate with this backend endpoint.
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * Loader Function
 * MANDATORY to handle CORS pre-flight "OPTIONS" requests.
 * Without this, the browser will block the POST request from the Checkout UI.
 */
export const loader = async () => new Response(null, { status: 204, headers: corsHeaders });

/**
 * Action Function: Handles Gift Card Redemption Cancellation
 * This endpoint is called when a user removes a gift card from their checkout.
 * It performs three main tasks:
 * 1. Notifies Ogloba to release the held funds.
 * 2. Deletes the generated discount code from Shopify.
 * 3. Updates the local database status.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Handle pre-flight request for browsers
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Authenticate the request using the session token provided by the Checkout UI
    const { sessionToken } = await shopify.authenticate.public.checkout(request);
    let shop = sessionToken.dest;
    
    // Extract the hostname (e.g., "myshop.myshopify.com") from the destination URL
    if (shop.startsWith("http")) shop = new URL(shop).hostname;

    const { discountCode } = await request.json();
    console.log("Attempting cancellation for code:", discountCode);

    // Look up the transaction in our database to find the associated Ogloba reference and Shopify ID
    const transaction = await prisma.oglobaTransaction.findUnique({
      where: { discountCode }
    });

    if (!transaction) {
      return new Response(JSON.stringify({ success: false, message: "Transaction not found" }), {
        status: 404,
        headers: corsHeaders
      });
    }

    /**
     * STEP 1: Ogloba API Cancellation
     * We notify Ogloba that the transaction is cancelled so the 
     * card balance is released or the "pending" hold is removed.
     */
    const oglobaResponse = await fetch("https://srl-ts.ogloba.com/gc-restful-gateway/giftCardService/cancelTransaction", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WSRG-API-Version": "2.18",
        "Authorization": `Basic ${process.env.OGLOBA_API_KEY}`
      },
      body: JSON.stringify({
        merchantId: "TestOgloba",
        terminalId: "demo",
        cashierId: "Shopify",
        referenceNumber: transaction.referenceNumber
      })
    });

    const oglobaData = await oglobaResponse.json();
    console.log("📥 [OGLOBA CANCEL RESPONSE]:", JSON.stringify(oglobaData, null, 2));

    /**
     * STEP 2: Shopify Discount Deletion
     * We remove the dynamic discount code from the Shopify store 
     * so it can no longer be used by the customer.
     * Note: 'deletedCodeDiscountId' is used here as per Shopify GraphQL API specifications.
     */
    const { admin } = await shopify.unauthenticated.admin(shop);
    const deleteResponse = await admin.graphql(`#graphql
      mutation discountCodeDelete($id: ID!) {
        discountCodeDelete(id: $id) {
          deletedCodeDiscountId
          userErrors {
            field
            message
          }
        }
      }`, 
      { variables: { id: transaction.discountId } }
    );

    /**
     * STEP 3: Database Update
     * Mark the transaction as 'CANCELLED' in our records for auditing.
     */
    await prisma.oglobaTransaction.update({
      where: { discountCode },
      data: { status: "CANCELLED" }
    });

    return new Response(JSON.stringify({ success: true }), { 
      status: 200, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });

  } catch (error: any) {
    console.error("Full cancellation error:", error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500, 
      headers: corsHeaders 
    });
  }
};