import { parsePhoneNumberFromString } from "libphonenumber-js";

// Phone / handle normalization shared by message.ts (matching chat.db handles) and contacts.ts.
// iMessage handles are EITHER a phone number (stored E.164 in chat.db's handle.id, e.g.
// "+393331234567") OR an email address (iMessage by Apple ID). We must treat those two cases
// differently and never assume a country: a number already in "+CC…" form is honoured as-is, and
// bare local numbers are parsed against a configurable default region — no hardcoded +1.

/** True if the handle is an email address (iMessage by Apple ID) rather than a phone number. */
export function isEmailHandle(handle: string): boolean {
	return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(handle.trim());
}

/**
 * Default region (ISO 3166-1 alpha-2) for parsing bare local numbers. Faced passes the user's region
 * via APPLE_REGION (derived from the system locale); falls back to "US". Only used for numbers that
 * lack a country code — an already-E.164 number ignores it.
 */
export function defaultRegion(): string {
	const r = (process.env.APPLE_REGION || "").trim().toUpperCase();
	return /^[A-Z]{2}$/.test(r) ? r : "US";
}

/**
 * Candidate strings to match a phone/email against Messages' stored handle (handle.id).
 *  - Email handles → [lowercased email].
 *  - Phone numbers → E.164 (libphonenumber-js; "+CC…" honoured, bare numbers use the default region)
 *    plus the national-digits and raw-cleaned variants, so a handle stored either way still matches.
 */
export function handleCandidates(input: string): string[] {
	const trimmed = input.trim();
	if (!trimmed) return [];
	if (isEmailHandle(trimmed)) return [trimmed.toLowerCase()];

	const set = new Set<string>();
	const cleaned = trimmed.replace(/[^0-9+]/g, "");
	if (cleaned) set.add(cleaned);

	const parsed = parsePhoneNumberFromString(trimmed, defaultRegion() as never);
	if (parsed) {
		set.add(parsed.number); // E.164, e.g. +393331234567
		if (parsed.nationalNumber) set.add(parsed.nationalNumber); // digits sans country code
	}
	return Array.from(set).filter(Boolean);
}
