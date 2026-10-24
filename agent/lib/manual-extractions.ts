// Labeled manual-extraction fallback. These are the typed fields a reader
// would take from the rendered documents. Used only when Claude extraction is
// unavailable; the method is recorded as "manual" on every row it produces.
export type ManualExtraction = {
  documentId: string; invoiceNumber: string; loadReference: string; invoiceAt: string; currency: string;
  linehaulCents: number; accessorialsCents: number; totalCents: number;
  remitTo: { kind: "carrier" | "factor"; id: string }; confidence: number;
};
export const manualExtractions: ManualExtraction[] = [
  { documentId: "D-inv-0612", loadReference: "L-2041", invoiceNumber: "INV-88213", invoiceAt: "2026-06-12T09:00:00Z", currency: "USD", linehaulCents: 240_000, accessorialsCents: 0, totalCents: 240_000, remitTo: { kind: "carrier", id: "C-301" }, confidence: 0.98 },
  { documentId: "D-inv-5521", loadReference: "L-2037", invoiceNumber: "INV-5521", invoiceAt: "2026-06-10T13:30:00Z", currency: "USD", linehaulCents: 185_000, accessorialsCents: 0, totalCents: 185_000, remitTo: { kind: "carrier", id: "C-204" }, confidence: 0.99 },
  { documentId: "D-inv-5521R", loadReference: "L-2037", invoiceNumber: "INV-5521-R", invoiceAt: "2026-06-24T08:00:00Z", currency: "USD", linehaulCents: 185_000, accessorialsCents: 0, totalCents: 185_000, remitTo: { kind: "carrier", id: "C-204" }, confidence: 0.98 },
  { documentId: "D-inv-7710", loadReference: "L-2033", invoiceNumber: "INV-7710", invoiceAt: "2026-06-09T11:00:00Z", currency: "USD", linehaulCents: 92_500, accessorialsCents: 0, totalCents: 92_500, remitTo: { kind: "carrier", id: "C-118" }, confidence: 0.99 },
  { documentId: "D-inv-3302", loadReference: "L-2029", invoiceNumber: "INV-3302", invoiceAt: "2026-06-12T15:00:00Z", currency: "USD", linehaulCents: 310_000, accessorialsCents: 0, totalCents: 310_000, remitTo: { kind: "carrier", id: "C-452" }, confidence: 0.99 },
];
