import {
  PricingService as MedusaPricingService,
  MoneyAmount,
} from "@medusajs/medusa";
import {
  PriceSelectionContext,
  PriceType,
} from "@medusajs/medusa/dist/interfaces/price-selection-strategy";
import {
  PricingContext,
  ProductVariantPricing,
} from "@medusajs/medusa/dist/types/pricing";
import { TaxServiceRate } from "@medusajs/medusa/dist/types/tax-service";
import { PriceSelectionResult } from "@medusajs/medusa/dist/interfaces/price-selection-strategy";
import MoneyAmountRepository from "@medusajs/medusa/dist/repositories/money-amount";
import { isDefined } from "medusa-core-utils";

type PriceSelectionResultWithMeta = PriceSelectionResult & {
  metadata?: Record<string, unknown>;
};

class PricingService extends MedusaPricingService {
  protected moneyAmountRepository_: typeof MoneyAmountRepository;

  constructor({ moneyAmountRepository }) {
    super(arguments[0]);
    this.moneyAmountRepository_ = moneyAmountRepository;
  }
  /**
   * Gets the prices for a collection of variants.
   * @param data
   * @param context - the price selection context to use
   * @return The product variant prices
   */
  async getProductVariantPricingWithMeta(
    data: {
      variantId: string;
      quantity?: number;
      metadata?: Record<string, unknown>;
    },
    context: PriceSelectionContext | PricingContext
  ): Promise<ProductVariantPricing> {
    let pricingContext: PricingContext;
    if ("automatic_taxes" in context) {
      pricingContext = context;
    } else {
      pricingContext = await this.collectPricingContext(context);
    }

    const variants = await this.productVariantService
      .withTransaction(this.activeManager_)
      .list({ id: data.variantId }, { select: ["id", "product_id"] });

    let productsRatesMap: Map<string, TaxServiceRate[]> = new Map();

    if (pricingContext.price_selection.region_id) {
      // Here we assume that the variants belongs to the same product since the context is shared
      const productId = variants[0]?.product_id;
      productsRatesMap = await this.taxProviderService
        .withTransaction(this.activeManager_)
        .getRegionRatesForProduct(productId, {
          id: pricingContext.price_selection.region_id,
          tax_rate: pricingContext.tax_rate,
        });

      pricingContext.price_selection.tax_rates =
        productsRatesMap.get(productId)!;
    }

    const variantsPricing = await this.generateProductVariantPricing_(
      data,
      pricingContext
    );

    return variantsPricing;
  }

  private async generateProductVariantPricing_(
    data: {
      variantId: string;
      quantity?: number;
      metadata?: Record<string, unknown>;
    },
    context: PricingContext
  ): Promise<ProductVariantPricing> {
    const pricing = await this.calculateVariantPriceWithMeta_(
      data,
      context.price_selection
    );

    const pricingResult: ProductVariantPricing = {
      prices: pricing.prices,
      original_price: pricing.originalPrice,
      calculated_price: pricing.calculatedPrice,
      calculated_price_type: pricing.calculatedPriceType,
      original_price_includes_tax: pricing.originalPriceIncludesTax,
      calculated_price_includes_tax: pricing.calculatedPriceIncludesTax,
      original_price_incl_tax: null,
      calculated_price_incl_tax: null,
      original_tax: null,
      calculated_tax: null,
      tax_rates: null,
    };

    if (context.automatic_taxes && context.price_selection.region_id) {
      const taxRates = context.price_selection.tax_rates || [];
      const taxResults = this.calculateTaxes(pricingResult, taxRates);

      pricingResult.original_price_incl_tax =
        taxResults.original_price_incl_tax;
      pricingResult.calculated_price_incl_tax =
        taxResults.calculated_price_incl_tax;
      pricingResult.original_tax = taxResults.original_tax;
      pricingResult.calculated_tax = taxResults.calculated_tax;
      pricingResult.tax_rates = taxResults.tax_rates;
    }

    return pricingResult;
  }

  private async calculateVariantPriceWithMeta_(
    data: {
      variantId: string;
      quantity?: number;
      metadata?: Record<string, unknown>;
    },
    context: PriceSelectionContext
  ): Promise<PriceSelectionResultWithMeta> {
    const isWindowLineItem = Boolean(
      data?.metadata?.window_width && data?.metadata?.window_height
    );
    const moneyRepo = this.activeManager_.withRepository(
      this.moneyAmountRepository_
    );

    const [variantPrices] = await moneyRepo.findManyForVariantsInRegion(
      [data.variantId],
      context.region_id,
      context.currency_code,
      context.customer_id,
      context.include_discount_prices
    );
    const prices = variantPrices[data.variantId];
    const result = prices.reduce(
      (finalPrice, currentPrice) => {
        if (currentPrice.price_list_id === null) {
          // The originalPrice is the MoneyAmount that is not associated with a PriceList
          finalPrice.originalPrice = currentPrice.amount;
        }

        const isCurrentPriceForWindow = Boolean(
          currentPrice?.metadata?.window_width &&
            currentPrice?.metadata?.window_height
        );

        // We only want to evaluate this window price, if the line item was for a window
        if (isWindowLineItem && isCurrentPriceForWindow) {
          const isBiggerWindowHeight =
            currentPrice.metadata?.window_height >=
            finalPrice.metadata?.window_height;
          const isBiggerWindowWidth =
            currentPrice.metadata?.window_width >=
            finalPrice.metadata?.window_width;
          const fitsHeightConstraint =
            data?.metadata?.window_height >=
            currentPrice.metadata?.window_height;
          const fitsWidthConstraint =
            data?.metadata?.window_width >= currentPrice.metadata?.window_width;
          const doesMatchConstraints =
            fitsHeightConstraint && fitsWidthConstraint;

          if (
            doesMatchConstraints &&
            (!finalPrice.calculatedPrice ||
              (isBiggerWindowWidth && isBiggerWindowHeight))
          ) {
            // If there is an override for the same dimensions, use the cheaper price
            const isIdenticalDimensions =
              currentPrice.metadata?.window_width ===
                finalPrice.metadata?.window_width &&
              currentPrice.metadata?.window_height ===
                finalPrice.metadata?.window_height;
            const amount = isIdenticalDimensions // If the dimensions are equal, take the lower price
              ? Math.min(currentPrice.amount, finalPrice.calculatedPrice)
              : currentPrice.amount;
            finalPrice.calculatedPrice = amount;
            finalPrice.metadata = currentPrice.metadata;
            finalPrice.calculatedPriceType =
              currentPrice.price_list?.type || PriceType.DEFAULT;
          }
        } else if (!isCurrentPriceForWindow && !isWindowLineItem) {
          // We only want to evaluate this price if the line item was NOT for a window and this price is also not for a window
          if (
            context.region_id &&
            currentPrice.region_id === context.region_id &&
            currentPrice.price_list_id === null &&
            currentPrice.min_quantity === null &&
            currentPrice.max_quantity === null
          ) {
            finalPrice.originalPrice = currentPrice.amount;
          }

          if (
            context.currency_code &&
            currentPrice.currency_code === context.currency_code &&
            currentPrice.price_list_id === null &&
            currentPrice.min_quantity === null &&
            currentPrice.max_quantity === null &&
            finalPrice.originalPrice === null // region prices take precedence
          ) {
            finalPrice.originalPrice = currentPrice.amount;
          }
          if (
            isValidQuantity(currentPrice, data.quantity) &&
            (finalPrice.calculatedPrice === null ||
              currentPrice.amount < finalPrice.calculatedPrice) &&
            ((context.currency_code &&
              currentPrice.currency_code === context.currency_code) ||
              (context.region_id &&
                currentPrice.region_id === context.region_id))
          ) {
            finalPrice.calculatedPrice = currentPrice.amount;
            finalPrice.calculatedPriceType =
              currentPrice.price_list?.type || PriceType.DEFAULT;
          }
        }

        return finalPrice;
      },
      {
        originalPrice: null,
        calculatedPrice: null,
        prices,
      } as PriceSelectionResultWithMeta
    );
    return result;
  }
}

const isValidQuantity = (price, quantity?: number): boolean =>
  (isDefined(quantity) && isValidPriceWithQuantity(price, quantity)) ||
  (typeof quantity === "undefined" && isValidPriceWithoutQuantity(price));

const isValidPriceWithoutQuantity = (price): boolean =>
  (!price.max_quantity && !price.min_quantity) ||
  ((!price.min_quantity || price.min_quantity === 0) && price.max_quantity);

const isValidPriceWithQuantity = (price, quantity): boolean =>
  (!price.min_quantity || price.min_quantity <= quantity) &&
  (!price.max_quantity || price.max_quantity >= quantity);

export default PricingService;
