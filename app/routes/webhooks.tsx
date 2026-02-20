import { type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Webhook Handler
 * Process flow:
 * 1. Listen for 'orders/paid'
 * 2. Find any Ogloba discount codes used in that order
 * 3. Step 2 (Ogloba): Confirm Transaction
 * 4. Step 3 (Ogloba): Reconciliation
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("--------------------------------------------------");
  console.log("🔔 WEBHOOK RECEIVED: Start processing...");

  // 1. CLONE THE REQUEST
  // Because the authenticate.webhook(request) consumes the body stream,
  // we clone it so we can read it again if auth fails (e.g., in local dev).
  const clonedRequest = request.clone();

  let topic: string | null = null;
  let shop: string | null = null;
  let payload: any = null;

  try {
    // 2. VALIDATE WEBHOOK SIGNATURE
    const auth = await authenticate.webhook(request);
    topic = auth.topic;
    shop = auth.shop;
    payload = auth.payload;
    console.log("✅ Official Shopify authentication successful.");
  } catch (error: any) {
    console.error("⚠️ Official authentication failed (401).");

    if (process.env.NODE_ENV === "development") {
      // Manual extraction for local testing where signatures might mismatch
      console.warn("🛠️ DEV MODE: Manual reading via clone...");
      try {
        payload = await clonedRequest.json();
        topic = request.headers.get("x-shopify-topic");
        shop = request.headers.get("x-shopify-shop-domain");
      } catch (manualError) {
        return new Response("Unreadable Request", { status: 400 });
      }
    } else {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // Normalize topic string (e.g., "orders/paid" -> "ORDERS_PAID")
  const normalizedTopic = topic ? topic.toUpperCase().replace(/\//g, "_") : "";

  try {
    switch (normalizedTopic) {
      case "ORDERS_PAID":
        const discountCodes = payload.discount_codes || [];
        
        for (const discount of discountCodes) {
          // Check if the discount code used in the order is one of our Ogloba codes
          const transaction = await prisma.oglobaTransaction.findUnique({
            where: { discountCode: discount.code }
          });

          if (transaction && transaction.status === "PENDING") {
            try {
              // --- STEP 2: CONFIRMATION ---
              // Inform Ogloba that the transaction is finalized because payment was successful.
              console.log(`🔄 Calling Ogloba Step 2 (Confirmation)...`);
              const confirmResponse = await fetch("https://srl-ts.ogloba.com/gc-restful-gateway/giftCardService/confirmTransaction", {
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
                }),
              });

              const confirmData = await confirmResponse.json();
              console.log("📥 [OGLOBA CONFIRMATION RESPONSE]:", JSON.stringify(confirmData, null, 2));

              if (confirmData.isSuccessful) {
                // --- STEP 3: RECONCILIATION ---
                // Mandatory accounting step for Ogloba to clear the transaction record.
                console.log(`🔄 Calling Ogloba Step 3 (Reconciliation)...`);
                const reconcileResponse = await fetch("https://srl-ts.ogloba.com/gc-restful-gateway/giftCardService/reconciliation", {
                  method: "POST",
                  headers: { 
                    "Content-Type": "application/json",
                    "X-WSRG-API-Version": "2.18",
                    "Authorization": `Basic ${process.env.OGLOBA_API_KEY}` 
                  },
                  body: JSON.stringify({
                    merchantId: "TestOgloba",
                    businessDate: new Date().toISOString().split('T')[0],
                    reconciliationRecords: [{
                      terminalTxNo: "1",
                      lineCount: 1,
                      terminalId: "demo",
                      cashierId: "Shopify",
                      transactionNumber: Date.now().toString().slice(-10),
                      referenceNumber: transaction.referenceNumber,
                      transactionType: "P",
                      cardNumber: transaction.cardNumber,
                      currency: "EUR",
                      amount: parseFloat(transaction.amount.toString()),
                      finalStatus: "N"
                    }]
                  }),
                });

                const reconcileData = await reconcileResponse.json();
                console.log("📥 [OGLOBA RECONCILIATION RESPONSE]:", JSON.stringify(reconcileData, null, 2));

                // Finalize local DB status
                await prisma.oglobaTransaction.update({
                  where: { id: transaction.id },
                  data: { status: "CONFIRMED" }
                });
                console.log(`🏆 Total success for ${transaction.discountCode}`);
              }
            } catch (err) {
              console.error("❌ Error during Ogloba API calls:", err);
            }
          }
        }
        break;

      default:
        console.warn(`❓ Unhandled topic: ${normalizedTopic}`);
        break;
    }

    return new Response(null, { status: 200 });
  } catch (error: any) {
    console.error("❌ Critical webhook error:", error.message);
    return new Response("Error", { status: 500 });
  }
};