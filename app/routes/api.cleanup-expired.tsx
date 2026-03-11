import { type ActionFunctionArgs } from "react-router";
import prisma from "../db.server";

// ─── Action: Cron Job — Expire & Void Abandoned Transactions ─────────────────
// This endpoint should be called by an external cron scheduler (e.g. every 5 min).
// It finds all CONFIRMED transactions that have passed their expiry window
// (i.e. the customer started checkout but never completed it), voids them
// on Ogloba to release the funds, and marks them EXPIRED_VOID in our DB.
//
// We process at most 50 records per run to avoid long-running requests.
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("─────────────────────────────────────────────");
  console.log("[CRON] Starting expired transaction cleanup...");

  // --- FETCH EXPIRED TRANSACTIONS ─────────────────────────────────────────────
  // Only target CONFIRMED transactions whose expiry timestamp is in the past.
  const expiredTransactions = await prisma.oglobaTransaction.findMany({
    where: {
      status: "CONFIRMED",
      expiresAt: { lt: new Date() },
    },
    take: 50, // Safety cap — prevents timeout on large backlogs
  });

  console.log(`[CRON] Found ${expiredTransactions.length} expired transaction(s) to process.`);

  if (expiredTransactions.length === 0) {
    console.log("[CRON] Nothing to do. Exiting.");
    return new Response("No expired transactions found.", { status: 200 });
  }

  // --- PROCESS EACH EXPIRED TRANSACTION ──────────────────────────────────────
  for (const tx of expiredTransactions) {
    console.log(`[CRON] Processing: ${tx.discountCode} | ref: ${tx.referenceNumber} | expired at: ${tx.expiresAt}`);

    try {
      // STEP 1: Void on Ogloba
      // This releases the reserved gift card funds back to the customer's card.
      console.log(`[CRON] [1/2] Calling Ogloba voidTransaction for ref: ${tx.referenceNumber}`);

      const res = await fetch(
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
            referenceNumber: tx.referenceNumber,
          }),
        }
      );

      const data = await res.json();
      console.log(`[CRON] [1/2] Ogloba response for ${tx.discountCode} (HTTP ${res.status}):`, JSON.stringify(data, null, 2));

      // Even if Ogloba void fails, we still mark the record to avoid infinite retries.
      // Log the failure clearly so it can be investigated manually.
      if (!data.isSuccessful) {
        console.warn(`[CRON] ⚠️ Ogloba void not successful for ${tx.discountCode} — errorCode: ${data.errorCode}, message: ${data.errorMessage}`);
      }

      // STEP 2: Update DB status regardless of Ogloba response
      // This prevents the cron from retrying the same transaction endlessly.
      console.log(`[CRON] [2/2] Marking ${tx.discountCode} as EXPIRED_VOID in DB.`);
      await prisma.oglobaTransaction.update({
        where: { id: tx.id },
        data: { status: "EXPIRED_VOID" },
      });

      console.log(`[CRON] ✅ Done: ${tx.discountCode}`);

    } catch (e: any) {
      // Non-fatal: log and continue processing remaining transactions.
      console.error(`[CRON] ❌ Failed to process ${tx.discountCode}:`, e.message);
    }
  }

  console.log("[CRON] Cleanup complete.");
  console.log("─────────────────────────────────────────────");
  return new Response("Cleanup finished.", { status: 200 });
};