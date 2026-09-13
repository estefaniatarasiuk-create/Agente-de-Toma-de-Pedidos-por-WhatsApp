import { z } from "zod";

export const registerSchema = z.object({
  companyName: z.string().trim().min(2, "El nombre de la empresa debe tener al menos 2 caracteres."),
  email: z.string().trim().toLowerCase().email("Ingresá un email válido."),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
