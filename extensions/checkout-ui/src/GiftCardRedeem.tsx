import React, { useState } from 'react';
import {
  render,
  BlockStack,
  Button,
  TextField,
  useExtensionApi,
} from '@shopify/ui-extensions-react/checkout';

render('purchase.checkout.block.render', () => <GiftCardRedeem />);

export default function GiftCardRedeem() {
  const api = useExtensionApi() as any;
  const [cardNumber, setCardNumber] = useState('');
  const [loading, setLoading] = useState(false);

  const APP_URL = 'https://stood-finest-coleman-incoming.trycloudflare.com'; //edit when server restart and provide new url

  const handleApply = async () => {
    if (!cardNumber) return;
    setLoading(true);

    try {
      // Use the Absolute URL here
      const response = await fetch(`${APP_URL}/api/ogloba`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardNumber }),
      });

      const data = await response.json();
      const toast = api.ui?.toast;

      if (data.success) {
        toast?.show(`Success: ${data.message}`);
      } else {
        toast?.show(`Error: ${data.message}`);
      }
    } catch (error) {
      console.error("Fetch error:", error);
      api.ui?.toast?.show("Network error: Check tunnel URL");
    } finally {
      setLoading(false);
    }
  };


  return (
    <BlockStack spacing="base">
      <TextField 
        label="OGLOBA Card Number" 
        value={cardNumber} 
        onChange={setCardNumber} 
      />
      <Button onPress={handleApply} loading={loading}>
        Apply
      </Button>
    </BlockStack>
  );
}