import { z } from "zod";

export const deliveryZoneSchema = z.object({
  centerLatitude: z.number().min(-90).max(90),
  centerLongitude: z.number().min(-180).max(180),
  radiusKm: z.number().positive().max(100),
});

export type DeliveryZoneInput = z.infer<typeof deliveryZoneSchema>;

export const branchAddressSchema = z.object({
  address: z.string().trim().min(5, "Ingresá una dirección más completa."),
});
