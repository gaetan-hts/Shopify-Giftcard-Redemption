import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

// Define headers once
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-WSRG-API-Version",
  "Access-Control-Max-Age": "86400",
};

// Handle OPTIONS and GET
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // This handles the browser's Preflight (OPTIONS)
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
};

// Handle POST
export const action = async ({ request }: ActionFunctionArgs) => {
  // Security check: also handle OPTIONS inside action just in case
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const { cardNumber } = body;

    console.log("---> OGLOBA REQUEST FOR CARD:", cardNumber);

    // Call Ogloba
    const oglobaUrl = "https://srl-ts.ogloba.com/gc-restful-gateway/giftCardService/redemption";
    const oglobaResponse = await fetch(oglobaUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WSRG-API-Version': '2.18'
      },
      body: JSON.stringify({
        merchantId: "TestOgloba",
        terminalId: "demo",
        cashierId: "ShopifyApp",
        transactionNumber: Date.now().toString(),
        amount: 50,
        cardNumber: cardNumber
      })
    });

    const oglobaData = await oglobaResponse.json();
    console.log("---> OGLOBA RESPONSE:", oglobaData);

    return new Response(
      JSON.stringify({ 
        success: oglobaData.responseCode === "00", 
        message: oglobaData.responseMessage,
        balance: oglobaData.remainingBalance 
      }), 
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );

  } catch (error) {
    console.error("SERVER ERROR:", error);
    return new Response(
      JSON.stringify({ success: false, message: "Server communication error" }), 
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
};