import {render, BlockStack, Button, Text, TextField} from '@shopify/ui-extensions-react/checkout';

render('purchase.checkout.block.render', () => {
  return (
    <BlockStack spacing="base">
      <Text>Redeem your OGLOBA Gift Card</Text>
      <TextField label="Gift card number" />
      <TextField label="PIN (if applicable)" />
      <Button onPress={() => alert('Mock redeem executed')}>Apply</Button>
    </BlockStack>
  );
});
