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

/**
 * The spelling to hand Messages when SENDING to a phone number: E.164 wherever one can be parsed.
 *
 * NEVER A FORMATTED NUMBER. Sending to "(604) 730-4051" made Messages open a brand-new chat whose
 * identifier is that literal string, with `is_sent = 0` and `error = 22` on the message, and one second
 * later Messages itself crashed in IMCore sorting its chats (`-[NSString containsString:]` inside
 * `__CFSimpleMergeSort`). It happened twice, on the two occasions a send used that spelling, and never
 * on a send to an E.164 number. The crash is Apple's; handing it a shape it clearly cannot cope with is
 * ours, and there was never a reason to: the number is parsed here already, for reads.
 *
 * Anything that is not a phone number (an email, a short code, a carrier name like "Free Mobile") is
 * returned untouched, because those are handles in their own right and reformatting them is how a
 * working recipient becomes an unreachable one.
 */
export function sendableHandle(input: string): string {
	const trimmed = input.trim();
	if (!trimmed || isEmailHandle(trimmed)) return trimmed;
	const e164 = handleCandidates(trimmed).find((h) => h.startsWith("+"));
	return e164 ?? trimmed;
}
