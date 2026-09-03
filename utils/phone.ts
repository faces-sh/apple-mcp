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
 *
 * DEPRECATED FOR MATCHING: it invents a country. Kept only where a caller has already established that
 * the input carries its own country code. Prefer `matchKnownHandles`, which matches against the
 * handles that ACTUALLY EXIST and refuses when it genuinely cannot tell.
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

/** Just the digits of a handle, so punctuation never decides whether two numbers are the same. */
export function digitsOf(handle: string): string {
	return handle.replace(/\D/g, "");
}

/** What a match against the real handle list came to. */
export type HandleMatch =
	/** These are the stored handles that mean this address. Usually one. */
	| { kind: "ids"; ids: string[] }
	/** Nothing on this Mac matches; the caller decides whether that is an error or a new contact. */
	| { kind: "none" }
	/**
	 * Several DIFFERENT numbers fit, and only a country code could separate them.
	 *
	 * THE CASE THIS EXISTS FOR. "(604) 730-4051" is a Canadian number; "+33 6 04 73 04 051" is a real
	 * French subscriber, and the second ends with the first. Guessing a country turned one into the
	 * other and sent a message to France. Suffix matching alone conflates them just as badly, in the
	 * other direction: it would read a stranger's thread and present it as yours. Neither the digits
	 * nor the Mac's own region can settle it, so nothing here pretends to.
	 */
	| { kind: "ambiguous"; ids: string[] };

/**
 * Which of the handles that ACTUALLY EXIST mean the address the caller gave.
 *
 * NOTHING IS INVENTED. Every id returned is a string already present in the user's message database,
 * so a match can never conjure a subscriber in another country the way parsing against the Mac's
 * region did. Order of preference, strongest first:
 *
 *   1. the same string, or the same string ignoring punctuation
 *   2. the same digits exactly
 *   3. one is a suffix of the other by at least 7 digits, which is how a national number relates to
 *      its own E.164 form
 *
 * Rule 3 is the one that can be wrong, so it is only trusted when everything it finds is the SAME
 * number. Two different numbers matching that loosely is exactly the Canada/France collision, and it
 * comes back `ambiguous` for the caller to refuse or ask about.
 */
export function matchKnownHandles(input: string, known: readonly string[]): HandleMatch {
	const uniq = (xs: string[]) => Array.from(new Set(xs));
	const trimmed = input.trim();
	if (!trimmed) return { kind: "none" };
	if (isEmailHandle(trimmed)) {
		const want = trimmed.toLowerCase();
		const ids = known.filter((k) => k.trim().toLowerCase() === want);
		return ids.length ? { kind: "ids", ids: uniq(ids) } : { kind: "none" };
	}
	const exact = known.filter((k) => k.trim() === trimmed);
	if (exact.length) return { kind: "ids", ids: uniq(exact) };

	const want = digitsOf(trimmed);
	if (!want) {
		// Not a number at all: a short code or a carrier name like "Free Mobile". Only itself will do.
		const named = known.filter((k) => k.trim().toLowerCase() === trimmed.toLowerCase());
		return named.length ? { kind: "ids", ids: uniq(named) } : { kind: "none" };
	}
	const same = known.filter((k) => digitsOf(k) === want);
	if (same.length) return { kind: "ids", ids: uniq(same) };

	// SEVEN DIGITS, because a local subscriber number is seven and anything shorter starts matching
	// unrelated people: on this machine a 4-digit rule joins short codes to real numbers.
	const loose = known.filter((k) => {
		const d = digitsOf(k);
		if (!d || d === want) return false;
		const [long, short] = d.length >= want.length ? [d, want] : [want, d];
		return short.length >= 7 && long.endsWith(short);
	});
	if (!loose.length) return { kind: "none" };
	const distinct = new Set(loose.map(digitsOf));
	return distinct.size === 1 ? { kind: "ids", ids: uniq(loose) } : { kind: "ambiguous", ids: uniq(loose) };
}

/**
 * The spelling to hand Messages when SENDING to a phone number.
 *
 * IT NEVER GUESSES A COUNTRY, and that restraint is the whole function. The first version ran the
 * number through `handleCandidates`, which parses a bare national number against the MAC'S OWN REGION.
 * On a machine in Paris that turned a Canadian home number, "(604) 730-4051", into "+336047304051" and
 * sent a message to France. It was in the wild for thirteen minutes and put one more undeliverable
 * message in somebody's thread with their mother.
 *
 * A number with no country code is ambiguous and nothing here can resolve it: the area code is
 * Vancouver, the Mac is in France, and the digits alone do not say which. So it is passed through
 * exactly as given, and only a number that ALREADY carries its country code (+1..., +33...) is
 * tidied, because there the country is stated rather than assumed.
 *
 * The real defence against sending to the wrong number is not spelling, it is choosing: prefer the
 * handle the person actually messages from (`resolveRecipient`). This function only ensures that
 * whatever was chosen is not silently rewritten into a different country on the way out.
 */
export function sendableHandle(input: string): string {
	const trimmed = input.trim();
	if (!trimmed || isEmailHandle(trimmed)) return trimmed;
	// Only when the country is STATED. Everything else goes through untouched.
	if (!trimmed.startsWith("+")) return trimmed;
	const e164 = handleCandidates(trimmed).find((h) => h.startsWith("+"));
	return e164 ?? trimmed;
}
