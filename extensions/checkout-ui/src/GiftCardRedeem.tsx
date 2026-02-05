import React, { useState } from 'react';
import {
  render,
  BlockStack,
  Button,
  TextBlock,
  TextField,
  useExtensionApi,
} from '@shopify/ui-extensions-react/checkout';

const TARGET = 'purchase.checkout.block.render';

// On garde le render pour Shopify
render(TARGET, () => <GiftCardRedeem />);

// On ajoute "export default" devant la fonction
export default function GiftCardRedeem() {
  const api = useExtensionApi<typeof TARGET>() as any;
  
  const [cardNumber, setCardNumber] = useState('');
  const [pin, setPin] = useState('');

  const handleApply = () => {
    if (api.ui?.toast) {
      api.ui.toast.show('Mock OGLOBA gift card redeemed!');
    }
  };

  return (
    <BlockStack spacing="base">
      <TextBlock emphasis="bold">Redeem your OGLOBA Gift Card</TextBlock>
      <TextField 
        label="Gift card number" 
        value={cardNumber} 
        onChange={(val: string) => setCardNumber(val)} 
      />
      <TextField 
        label="PIN (if applicable)" 
        value={pin} 
        onChange={(val: string) => setPin(val)} 
      />
      <Button onPress={handleApply}>Apply</Button>
    </BlockStack>
  );
}