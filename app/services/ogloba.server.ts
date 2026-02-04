type RedeemPayload = {
    giftCardNumber: string;
    pin?: string;
    amount: number;
    currency: string;
  };
  
  export async function mockOglobaRedeem(payload: RedeemPayload) {
    // MOCK — remplacé plus tard par appel HTTP OGLOBA
    return {
      appliedAmount: Math.min(payload.amount, 25),
      remainingBalance: 10,
      currency: payload.currency,
    };
  }
  