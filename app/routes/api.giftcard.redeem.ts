import { authenticate } from "../shopify.server";
import db from "../db.server";
import { mockOglobaRedeem } from "../services/ogloba.server";


export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchantConfig = await db.merchantConfig.findUnique({
    where: { shop },
  });

  if (!merchantConfig || !merchantConfig.enabled) {
    return new Response(
      JSON.stringify({ error: "GIFT_CARD_DISABLED" }),
      { status: 400 }
    );
  }

  const { giftCardNumber, pin, amount, currency } = await request.json();

  const result = await mockOglobaRedeem({
    giftCardNumber,
    pin,
    amount,
    currency,
  });

  return new Response(JSON.stringify(result), { status: 200 });
}
