import { Router } from "express";
import customCreateLineItem from "./create-line-item";
import {
  FindParams,
  defaultStoreCartFields,
  defaultStoreCartRelations,
  transformStoreQuery,
  wrapHandler,
} from "@medusajs/medusa";

export function attachStoreRoutes(storeRouter: Router) {
  storeRouter.post(
    "/carts/:id/line-items",
    transformStoreQuery(FindParams, {
      defaultRelations: defaultStoreCartRelations,
      defaultFields: defaultStoreCartFields,
      isList: false,
    }),
    wrapHandler(customCreateLineItem)
  );
}
