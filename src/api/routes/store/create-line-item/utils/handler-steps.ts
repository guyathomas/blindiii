import { AwilixContainer } from "awilix";
import {
  Cart,
  CartService,
  LineItemService,
  defaultStoreCartFields,
  defaultStoreCartRelations,
  WithRequiredProperty,
} from "@medusajs/medusa";

import { FlagRouter } from "@medusajs/medusa/dist/utils/flag-router";
import { EntityManager } from "typeorm";
import { IdempotencyCallbackResult } from "@medusajs/medusa/dist/types/idempotency-key";
import PricingService from "src/services/pricing";

export const CreateLineItemSteps = {
  STARTED: "started",
  FINISHED: "finished",
};

export async function handleAddOrUpdateLineItem(
  cartId: string,
  data: {
    metadata?: Record<string, unknown>;
    customer_id?: string;
    variant_id: string;
    quantity: number;
  },
  { container, manager }: { container: AwilixContainer; manager: EntityManager }
): Promise<IdempotencyCallbackResult> {
  const cartService: CartService = container.resolve("cartService");
  const lineItemService: LineItemService = container.resolve("lineItemService");
  const featureFlagRouter: FlagRouter = container.resolve("featureFlagRouter");

  const pricingService: PricingService = container.resolve("pricingService");
  const txCartService = cartService.withTransaction(manager);

  let cart = await txCartService.retrieve(cartId, {
    select: ["id", "region_id", "customer_id"],
  });

  const variantPricing = await pricingService.getProductVariantPricingWithMeta(
    {
      variantId: data.variant_id,
      quantity: data.quantity,
      metadata: data.metadata,
    },
    {
      region_id: cart.region_id,
      customer_id: cart.customer_id,
      include_discount_prices: true,
    }
  );

  const line = await lineItemService
    .withTransaction(manager)
    .generate(data.variant_id, cart.region_id, data.quantity, {
      customer_id: data.customer_id || cart.customer_id,
      metadata: data.metadata,
      unit_price: variantPricing.calculated_price,
    });

  await txCartService.addLineItem(cart.id, line, {
    validateSalesChannels: featureFlagRouter.isFeatureEnabled("sales_channels"),
  });

  cart = await txCartService.retrieveWithTotals(cart.id, {
    select: defaultStoreCartFields,
    relations: [
      ...defaultStoreCartRelations,
      "billing_address",
      "region.payment_providers",
      "payment_sessions",
      "customer",
    ],
  });

  if (cart.payment_sessions?.length) {
    await txCartService.setPaymentSessions(
      cart as WithRequiredProperty<Cart, "total">
    );
  }

  return {
    response_code: 200,
    response_body: { cart },
  };
}
