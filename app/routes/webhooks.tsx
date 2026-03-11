import { type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Action: Webhook — orders/paid ───────────────────────────────────────────
// Triggered by Shopify when an order is successfully paid.
// Flow:
//   1. Validate the Shopify webhook signature (HMAC).
//   2. Find any Ogloba gift card codes (prefixed "OGL-") used in the order.
//   3. Call Ogloba Reconciliation to finalize the accounting for each code.
//   4. Mark the transaction as RECONCILED in our DB.
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("─────────────────────────────────────────────");
  console.log("🔔 [WEBHOOK] Received orders/paid event. Processing...");

  // Clone the request before authenticate.webhook() consumes the body stream,
  // so we can re-read it manually in dev mode if HMAC validation fails.
  const clonedRequest = request.clone();

  let topic: string | null = null;
  let shop: string | null = null;
  let payload: any = null;

  // --- STEP 1: VALIDATE WEBHOOK SIGNATURE ───────────────────────────────────
  try {
    const auth = await authenticate.webhook(request);
    topic = auth.topic;
    shop = auth.shop;
    payload = auth.payload;
    console.log(`✅ [WEBHOOK] Auth successful — topic: ${topic} | shop: ${shop}`);
  } catch (error: any) {
    console.error("⚠️ [WEBHOOK] Official HMAC authentication failed:", error.message);

    // In development, HMAC validation may fail when testing with tools like ngrok
    // or manually triggered webhooks. We fall back to reading the raw payload.
    if (process.env.NODE_ENV === "development") {
      console.warn("🛠️ [WEBHOOK] DEV MODE: Falling back to manual payload extraction...");
      try {
        payload = await clonedRequest.json();
        topic = request.headers.get("x-shopify-topic");
        shop = request.headers.get("x-shopify-shop-domain");
        console.log(`🛠️ [WEBHOOK] DEV: topic=${topic} | shop=${shop}`);
      } catch (manualError) {
        console.error("❌ [WEBHOOK] Could not parse request body manually.");
        return new Response("Unreadable Request", { status: 400 });
      }
    } else {
      // In production, reject unauthenticated webhooks
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // Normalize topic format: "orders/paid" → "ORDERS_PAID"
  const normalizedTopic = topic ? topic.toUpperCase().replace(/\//g, "_") : "";

  try {
    switch (normalizedTopic) {
      case "ORDERS_PAID": {
        console.log(`[WEBHOOK] Processing order: ${payload.name} (ID: ${payload.id})`);

        // --- STEP 2: FIND OGLOBA DISCOUNT CODES ────────────────────────────
        // Filter for codes we created — all prefixed with "OGL-"
        const oglobaCodes = (payload.discount_codes || []).filter((d: any) =>
          d.code.startsWith("OGL-")
        );

        if (oglobaCodes.length === 0) {
          console.log("[WEBHOOK] No Ogloba discount codes in this order. Nothing to do.");
          return new Response(null, { status: 200 });
        }

        console.log(`[WEBHOOK] Found ${oglobaCodes.length} Ogloba code(s) to reconcile.`);

        for (const discount of oglobaCodes) {
          console.log(`[WEBHOOK] Looking up DB record for code: ${discount.code}`);

          const transaction = await prisma.oglobaTransaction.findUnique({
            where: { discountCode: discount.code },
          });

          // Only process transactions in CONFIRMED state.
          // RECONCILED / VOIDED / EXPIRED_VOID are all terminal states — skip them.
          if (!transaction || transaction.status !== "CONFIRMED") {
            console.warn(
              `[WEBHOOK] Skipping ${discount.code} — not found or status is not CONFIRMED (current: ${transaction?.status ?? "NOT FOUND"})`
            );
            continue;
          }

          console.log(`[WEBHOOK] Transaction found — ref: ${transaction.referenceNumber}. Starting Ogloba reconciliation...`);

          // --- STEP 3: RECONCILIATION ──────────────────────────────────────
          // This is the final Ogloba accounting step that permanently deducts
          // the gift card amount and closes out the transaction.
          const businessDate = new Date()
            .toISOString()
            .split("T")[0]
            .replace(/-/g, ""); // Format: YYYYMMDD

          const reconciliationPayload = {
            merchantId: process.env.OGLOBA_MERCHANT_ID,
            businessDate,
            reconciliationRecords: [
              {
                terminalTxNo: "1",
                lineCount: 1,
                terminalId: process.env.OGLOBA_TERMINAL_ID,
                cashierId: process.env.OGLOBA_CASHIER_ID,
                transactionNumber: Date.now().toString().slice(-10),
                referenceNumber: transaction.referenceNumber,
                transactionType: "P",  // P = Purchase/Payment
                cardNumber: transaction.cardNumber,
                currency: "EUR",
                amount: parseFloat(transaction.amount.toString()),
                finalStatus: "N",      // N = Normal (completed successfully)
              },
            ],
          };

          console.log(`[WEBHOOK] Calling Ogloba reconciliation for ref: ${transaction.referenceNumber}`);
          console.log(`[WEBHOOK] Payload:`, JSON.stringify(reconciliationPayload, null, 2));

          const reconcileRes = await fetch(
            "https://dev.ogloba.com/gc-restful-gateway/giftCardService/reconciliation",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-WSRG-API-Version": "2.7",
                Authorization: `Basic ${Buffer.from(`${process.env.OGLOBA_MERCHANT_ID}:${process.env.OGLOBA_API_KEY}`).toString("base64")}`,
              },
              body: JSON.stringify(reconciliationPayload),
            }
          );

          const reconData = await reconcileRes.json();
          console.log(
            `[WEBHOOK] Ogloba reconciliation response for ${discount.code} (HTTP ${reconcileRes.status}):`,
            JSON.stringify(reconData, null, 2)
          );

          // --- STEP 4: UPDATE DB ───────────────────────────────────────────
          if (reconData.isSuccessful) {
            await prisma.oglobaTransaction.update({
              where: { id: transaction.id },
              data: { status: "RECONCILED" },
            });
            console.log(`✅ [WEBHOOK] Reconciliation complete for ${discount.code}. DB updated to RECONCILED.`);
          } else {
            // Reconciliation failed — log for manual follow-up.
            // Do NOT throw here; we still want to return 200 to Shopify
            // so it doesn't retry the webhook unnecessarily.
            console.error(
              `❌ [WEBHOOK] Reconciliation failed for ${discount.code} — errorCode: ${reconData.errorCode}, message: ${reconData.errorMessage}`
            );
          }
        }
        break;
      }

      default:
        console.warn(`❓ [WEBHOOK] Unhandled topic: ${normalizedTopic}`);
        break;
    }

    console.log("─────────────────────────────────────────────");
    return new Response(null, { status: 200 });

  } catch (error: any) {
    console.error("❌ [WEBHOOK] Critical error during processing:", error.message);
    console.error("[WEBHOOK] Stack:", error.stack);
    return new Response("Internal Server Error", { status: 500 });
  }
};