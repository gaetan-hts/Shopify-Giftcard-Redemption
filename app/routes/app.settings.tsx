import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form as RemixForm, useLoaderData } from "react-router";
import { useState } from "react";

import {
  Page,
  Card,
  FormLayout,
  TextField,
  Button,
  Checkbox,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";


export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { session } = await authenticate.admin(request);
  
    const config = await (prisma as any).merchantConfig.findUnique({
      where: { shop: session.shop },
    });
  
    return { config };
  };
  
  export const action = async ({ request }: ActionFunctionArgs) => {
    const { session } = await authenticate.admin(request);
    const formData = await request.formData();
  
    const oglobaMerchantId = String(formData.get("oglobaMerchantId") || "");
    const oglobaApiKey = String(formData.get("oglobaApiKey") || "");
    const oglobaApiSecret = String(formData.get("oglobaApiSecret") || "");
    const redemptionEnabled = formData.get("redemptionEnabled") === "on";
  
    await (prisma as any).merchantConfig.upsert({
      where: { shop: session.shop },
      update: {
        oglobaMerchantId,
        oglobaApiKey,
        oglobaApiSecret,
        redemptionEnabled,
      },
      create: {
        shop: session.shop,
        oglobaMerchantId,
        oglobaApiKey,
        oglobaApiSecret,
        redemptionEnabled,
      },
    });
  
    return { success: true };
  };
  export default function SettingsPage() {
    const { config } = useLoaderData<typeof loader>();
  const [oglobaMerchantId, setOglobaMerchantId] = useState(
    config?.oglobaMerchantId ?? "",
  );
  const [oglobaApiKey, setOglobaApiKey] = useState(config?.oglobaApiKey ?? "");
  const [oglobaApiSecret, setOglobaApiSecret] = useState(
    config?.oglobaApiSecret ?? "",
  );
  const [redemptionEnabled, setRedemptionEnabled] = useState(
    config?.redemptionEnabled ?? true,
  );
  
    return (
      <Page title="OGLOBA Gift Card Settings">
        <Card>
          <RemixForm method="post">
            <FormLayout>
              <TextField
                label="OGLOBA Merchant ID"
                name="oglobaMerchantId"
                value={oglobaMerchantId}
                onChange={setOglobaMerchantId}
                autoComplete="off"
              />
  
              <TextField
                label="OGLOBA API Key"
                name="oglobaApiKey"
                value={oglobaApiKey}
                onChange={setOglobaApiKey}
                autoComplete="off"
              />
  
              <TextField
                label="OGLOBA API Secret"
                name="oglobaApiSecret"
                type="password"
                value={oglobaApiSecret}
                onChange={setOglobaApiSecret}
                autoComplete="off"
              />
  
              <Checkbox
                label="Enable gift card redemption"
                name="redemptionEnabled"
                checked={redemptionEnabled}
                onChange={setRedemptionEnabled}
              />
  
              <Button submit variant="primary">
                Save
              </Button>
            </FormLayout>
          </RemixForm>
        </Card>
      </Page>
    );
  }
  