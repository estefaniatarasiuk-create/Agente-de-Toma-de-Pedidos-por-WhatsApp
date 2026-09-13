import { z } from "zod";

// CUIT argentino: 11 dígitos, con o sin guiones (XX-XXXXXXXX-X).
const cuitRegex = /^\d{2}-?\d{8}-?\d{1}$/;
// CBU argentino: 22 dígitos.
const cbuRegex = /^\d{22}$/;

export const paymentMethodSchema = z
  .object({
    cashEnabled: z.boolean(),
    transferEnabled: z.boolean(),
    transferAlias: z.string().trim().max(100).optional().or(z.literal("")),
    transferCbu: z.string().trim().optional().or(z.literal("")),
    transferHolder: z.string().trim().max(150).optional().or(z.literal("")),
    transferCuit: z.string().trim().optional().or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    if (!data.cashEnabled && !data.transferEnabled) {
      ctx.addIssue({
        code: "custom",
        message: "Tenés que habilitar al menos un medio de pago.",
        path: ["cashEnabled"],
      });
    }

    if (data.transferEnabled) {
      if (!data.transferAlias && !data.transferCbu) {
        ctx.addIssue({
          code: "custom",
          message: "Cargá al menos el alias o el CBU para transferencias.",
          path: ["transferAlias"],
        });
      }
      if (data.transferCbu && !cbuRegex.test(data.transferCbu)) {
        ctx.addIssue({ code: "custom", message: "El CBU debe tener 22 dígitos.", path: ["transferCbu"] });
      }
      if (!data.transferHolder) {
        ctx.addIssue({
          code: "custom",
          message: "Cargá el nombre del titular de la cuenta.",
          path: ["transferHolder"],
        });
      }
      if (!data.transferCuit) {
        ctx.addIssue({ code: "custom", message: "Cargá el CUIT de la cuenta.", path: ["transferCuit"] });
      } else if (!cuitRegex.test(data.transferCuit)) {
        ctx.addIssue({
          code: "custom",
          message: "El CUIT debe tener el formato 20-12345678-9.",
          path: ["transferCuit"],
        });
      }
    }
  });

export type PaymentMethodInput = z.infer<typeof paymentMethodSchema>;
