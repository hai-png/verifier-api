const NEW_CBE_URL_REGEX = /^https?:\/\/mbreciept\.cbe\.com\.et\/([A-Za-z0-9-]+)\/?$/i;
const NEW_CBE_TOKEN_REGEX = /^[A-Za-z0-9]{15,40}$/;
const LEGACY_CBE_REFERENCE_REGEX = /^FT[A-Z0-9]{10}$/i;
const LEGACY_CBE_COMBINED_ID_REGEX = /^(FT[A-Z0-9]{10})(\d{8})$/i;

export function extractNewCbeToken(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(NEW_CBE_URL_REGEX);
  if (urlMatch) return urlMatch[1] ?? null;
  if (!trimmed.toUpperCase().startsWith("FT") && NEW_CBE_TOKEN_REGEX.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * A receipt that prints the reference and the account tail next to each other,
 * pasted as one unbroken string.
 *
 * CBE legacy is FT + 10 characters + 8 digits; Abyssinia is the same reference
 * with a 5-digit tail. The combined shape was already described by
 * LEGACY_CBE_COMBINED_ID_REGEX but only ever read out of a receipt URL's `id`
 * parameter, so pasting the bare string failed — and under auto-detection it was
 * worse than failing: 20 characters with no separate suffix matched the generic
 * "long reference, nothing else supplied" rule and the receipt was routed to
 * Awash/Zemen, so a CBE payment was looked up against the wrong bank.
 */
export function splitLegacyCbeCombinedId(
  input: string,
): { reference: string; suffix: string; provider: 'cbe' | 'abyssinia' } | null {
  const trimmed = input.trim();

  const cbe = trimmed.match(/^(FT[A-Z0-9]{10})(\d{8})$/i);
  if (cbe) return { reference: (cbe[1] ?? "").toUpperCase(), suffix: cbe[2] ?? "", provider: 'cbe' };

  const abyssinia = trimmed.match(/^(FT[A-Z0-9]{10})(\d{5})$/i);
  if (abyssinia) return { reference: (abyssinia[1] ?? "").toUpperCase(), suffix: abyssinia[2] ?? "", provider: 'abyssinia' };

  return null;
}

export function isNewCbeReference(input: string): boolean {
  return extractNewCbeToken(input) !== null;
}

export function extractLegacyCbeUrlData(
  input: string,
): { reference: string; suffix: string } | null {
  const trimmed = input.trim();

  try {
    const url = new URL(trimmed);
    if (!/^https?:$/i.test(url.protocol)) return null;
    if (url.hostname.toLowerCase() !== "apps.cbe.com.et") return null;
    if (url.port && url.port !== "100") return null;

    const combinedId = url.searchParams.get("id")?.trim();
    if (!combinedId) return null;

    const match = combinedId.match(LEGACY_CBE_COMBINED_ID_REGEX);
    if (!match) return null;

    return {
      reference: (match[1] ?? "").toUpperCase(),
      suffix: match[2] ?? "",
    };
  } catch {
    return null;
  }
}

export function isLegacyCbeUrlReference(input: string): boolean {
  return extractLegacyCbeUrlData(input) !== null;
}

export function isLegacyCbeReference(reference: string): boolean {
  return LEGACY_CBE_REFERENCE_REGEX.test(reference.trim());
}
