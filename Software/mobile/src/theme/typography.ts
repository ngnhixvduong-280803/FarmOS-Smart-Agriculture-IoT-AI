/**
 * Shared type scale for FarmOS Mobile.
 *
 * We deliberately rely on the platform UI face (SF Pro on iOS and Roboto on
 * Android) instead of shipping a web font. This keeps the app familiar on
 * each platform while the semantic weight tokens keep screens consistent.
 */
export const fontWeight = {
  regular: "400",
  medium: "500",
  semibold: "500",
  bold: "600",
} as const;

export const typeScale = {
  screenTitle: { fontSize: 22, lineHeight: 28, fontWeight: fontWeight.bold },
  sectionTitle: { fontSize: 18, lineHeight: 24, fontWeight: fontWeight.bold },
  cardTitle: { fontSize: 15, lineHeight: 21, fontWeight: fontWeight.semibold },
  body: { fontSize: 15, lineHeight: 22, fontWeight: fontWeight.regular },
  metadata: { fontSize: 13, lineHeight: 18, fontWeight: fontWeight.regular },
  label: { fontSize: 12, lineHeight: 16, fontWeight: fontWeight.semibold },
  action: { fontSize: 14, lineHeight: 20, fontWeight: fontWeight.semibold },
} as const;
