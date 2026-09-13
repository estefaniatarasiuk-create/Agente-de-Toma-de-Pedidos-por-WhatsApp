const ARS_FORMATTER = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Formatea centavos como pesos argentinos: 123456 -> "$ 1.234,56".
export function formatCentsAsArs(cents: number): string {
  return ARS_FORMATTER.format(cents / 100);
}
