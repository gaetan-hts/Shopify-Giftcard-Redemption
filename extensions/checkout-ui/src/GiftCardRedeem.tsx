import React, { useState, useEffect, useRef } from "react";
import {
  render,
  BlockStack,
  Button,
  TextField,
  Banner,
  Text,
  InlineStack,
  Divider,
  useExtensionApi,
  useApplyDiscountCodeChange,
  useDiscountCodes,
  reactExtension,
} from "@shopify/ui-extensions-react/checkout";

export default reactExtension("purchase.checkout.block.render", () => <GiftCardRedeem />);

// ─── Types ────────────────────────────────────────────────────────────────────
interface AppliedCard {
  discountCode: string;
  amount: number;
  last4: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const APP_URL = "https://achievements-demands-deer-downtown.trycloudflare.com";

// ─── Component: GiftCardRedeem ────────────────────────────────────────────────
// Renders a gift card input block inside the Shopify checkout.
// Allows customers to:
//   - Enter a gift card number + PIN and apply it as a discount code
//   - See all applied gift cards with their amounts
//   - Remove applied gift cards (triggers a backend void)
function GiftCardRedeem() {
  const { sessionToken } = useExtensionApi() as any;
  const applyDiscountCodeChange = useApplyDiscountCodeChange();

  // Live list of discount codes currently applied to the checkout (from Shopify)
  const appliedDiscounts = useDiscountCodes();

  // Track which OGL- codes we know about, so we can detect external removals
  // (e.g. customer clicks the native Shopify "×" button on a discount code)
  const lastKnownOglobaCodes = useRef<string[]>([]);

  const [cardNumber, setCardNumber] = useState("");
  const [pinCode, setPinCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Local state tracking cards we've applied in this session
  const [appliedCards, setAppliedCards] = useState<AppliedCard[]>([]);

  // ─── Sync: Detect External Code Removal ──────────────────────────────────
  // If the customer removes an OGL- code using Shopify's native UI (the "×"
  // button on the discount pill), we won't receive a button click event.
  // Instead, we watch for codes disappearing from `appliedDiscounts` and
  // trigger a backend void automatically.
  useEffect(() => {
    const currentOglobaCodes = appliedDiscounts
      .map((d) => d.code)
      .filter((code) => code.startsWith("OGL-"));

    // Find codes that were there before but are now gone
    const removedCodes = lastKnownOglobaCodes.current.filter(
      (oldCode) => !currentOglobaCodes.includes(oldCode)
    );

    removedCodes.forEach(async (removedCode) => {
      console.log(`[CHECKOUT EXT] Detected external removal of: ${removedCode}. Voiding on backend...`);
      try {
        const token = await sessionToken.get();
        const res = await fetch(`${APP_URL}/api/cancel-redemption`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ discountCode: removedCode }),
        });
        const data = await res.json();
        console.log(`[CHECKOUT EXT] Backend cancel response for ${removedCode}:`, data);
      } catch (err) {
        console.error(`[CHECKOUT EXT] Backend cancel failed for ${removedCode}:`, err);
      }

      // Remove from local UI state regardless of backend result
      setAppliedCards((prev) => prev.filter((c) => c.discountCode !== removedCode));
    });

    lastKnownOglobaCodes.current = currentOglobaCodes;
  }, [appliedDiscounts, sessionToken]);

  // ─── Apply Gift Card ──────────────────────────────────────────────────────
  // Sends card details to our backend, which:
  //   1. Redeems + confirms with Ogloba
  //   2. Creates a Shopify discount code
  //   3. Returns the code + amount to apply here
  const handleApply = async () => {
    if (!cardNumber) return;
    setLoading(true);
    setStatusMessage(null);

    try {
      const token = await sessionToken.get();
      console.log(`[CHECKOUT EXT] Applying gift card ending: ...${cardNumber.slice(-4)}`);

      const response = await fetch(`${APP_URL}/api/redemption`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ cardNumber, pinCode }),
      });

      const data = await response.json();
      console.log("[CHECKOUT EXT] Redemption response:", data);

      if (data.success) {
        // Apply the generated discount code to the checkout
        await applyDiscountCodeChange({ type: "addDiscountCode", code: data.discountCode });

        setAppliedCards((prev) => [
          ...prev,
          { discountCode: data.discountCode, amount: data.amount, last4: cardNumber.slice(-4) },
        ]);

        setCardNumber("");
        setPinCode("");
        setStatusMessage({ type: "success", text: "Gift card applied successfully!" });
        console.log(`[CHECKOUT EXT] ✅ Applied: ${data.discountCode} (${data.amount}€)`);
      } else {
        console.warn("[CHECKOUT EXT] Backend returned failure:", data.message);
        setStatusMessage({ type: "error", text: data.message });
      }
    } catch (err) {
      console.error("[CHECKOUT EXT] Network or unexpected error:", err);
      setStatusMessage({ type: "error", text: "A technical error occurred. Please try again." });
    } finally {
      setLoading(false);
    }
  };

  // ─── Remove Gift Card (Manual Button) ────────────────────────────────────
  // Explicitly triggered when the customer clicks "Remove" in our UI.
  // Removes the Shopify discount code and voids the Ogloba transaction.
  const handleRemove = async (card: AppliedCard) => {
    console.log(`[CHECKOUT EXT] Removing gift card: ${card.discountCode}`);
    try {
      const token = await sessionToken.get();

      // Remove the discount code from the checkout first
      await applyDiscountCodeChange({ type: "removeDiscountCode", code: card.discountCode });

      // Then void the transaction on the backend
      const res = await fetch(`${APP_URL}/api/cancel-redemption`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ discountCode: card.discountCode }),
      });

      const data = await res.json();
      console.log(`[CHECKOUT EXT] Cancel response for ${card.discountCode}:`, data);

      setAppliedCards((prev) => prev.filter((c) => c.discountCode !== card.discountCode));
    } catch (err) {
      console.error(`[CHECKOUT EXT] Failed to remove card ${card.discountCode}:`, err);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <BlockStack spacing="base">
      <TextField
        label="Gift Card Number"
        value={cardNumber}
        onChange={setCardNumber}
      />
      <TextField
        label="PIN"
        type="password"
        value={pinCode}
        onChange={setPinCode}
      />

      {statusMessage && (
        <Banner status={statusMessage.type === "error" ? "critical" : "success"}>
          {statusMessage.text}
        </Banner>
      )}

      <Button
        onPress={handleApply}
        loading={loading}
        disabled={!cardNumber || loading}
      >
        Apply Card
      </Button>

      {/* List of applied gift cards for this checkout session */}
      {appliedCards.length > 0 && (
        <BlockStack spacing="tight">
          <Divider />
          <Text size="medium" emphasis="bold">Applied Gift Cards:</Text>
          {appliedCards.map((card, index) => (
            <InlineStack key={index} inlineAlignment="space-between">
              <Text>****{card.last4} ({card.amount}€)</Text>
              <Button kind="secondary" size="minor" onPress={() => handleRemove(card)}>
                Remove
              </Button>
            </InlineStack>
          ))}
        </BlockStack>
      )}
    </BlockStack>
  );
}