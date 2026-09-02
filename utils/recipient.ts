import { isEmailHandle } from "./phone";

/** One person this name could mean, and whether they have actually been in touch. */
export interface Candidate {
	name: string;
	handles: string[];
	/** When they last exchanged a message, ISO-ish local time, or undefined if never. */
	lastSeen?: string;
}

/** What a name resolved to. */
export type Resolution =
	/** Exactly one person it can be: read their thread. */
	| { kind: "one"; name: string; handles: string[] }
	/** Several people it could be, and nothing decides between them: ask. */
	| { kind: "several"; candidates: Candidate[] }
	/** Contacts was read and knows nobody by that name. NOT the same as "they never messaged you". */
	| { kind: "unknown" }
	/** Contacts could not be read at all, so nothing is known either way.
	 *
	 *  ITS OWN ANSWER, because the sentence differs and one of them would be a lie. Told Contacts was
	 *  denied, "your contacts have nobody called Caroline" states as fact something never looked at;
	 *  the person can fix a permission, and cannot fix a card that does exist. Distinguishing an
	 *  expected absence from something broken is the charter's rule and this is exactly that case. */
	| { kind: "cannot-ask" };

/** Whether a string is already a handle, in which case there is nothing to resolve. */
export function looksLikeHandle(who: string): boolean {
	const t = who.trim();
	if (!t) return false;
	if (isEmailHandle(t)) return true;
	// A phone number is digits, possibly with the punctuation people type them with. A name is not.
	return /^[+()\-.\s\d]+$/.test(t) && (t.match(/\d/g)?.length ?? 0) >= 5;
}

/**
 * Which person a NAME means, given the cards that match it and who has actually been in touch.
 *
 * RECENCY IS A TIE-BREAKER, NOT A FILTER, and that ordering is the whole design. Somebody you have not
 * texted in ten years is still the only person called that, and their thread is still the one you meant;
 * filtering by "has messaged lately" would lose them. So: one matching card wins outright however old
 * the thread is, and only when several people share a name does "who has been in touch" decide between
 * them. Still ambiguous after that is a question, not a guess.
 *
 * NO MATCH IS NEVER A DENIAL. If Contacts knows no "Caroline" this returns `unknown`, and the caller must
 * NOT turn that into "there are no messages from Caroline": plenty of handles have no card at all, so she
 * may be sitting in the list as `+16058177188`. `unknown` means "I could not put a name to a number",
 * which is a different sentence and leads somewhere useful (show the recent threads and let them pick).
 *
 * Pure, so the rule is tested rather than argued about: the caller supplies the cards and the history.
 */
export function resolveRecipient(
	cards: { name: string; phones: string[]; emails: string[] }[],
	lastSeenByHandle: Map<string, string>,
): Resolution {
	const people: Candidate[] = cards
		.map((c) => {
			const handles = [...c.phones, ...c.emails].map((h) => h.trim()).filter(Boolean);
			// The most recent time ANY of this person's handles was in touch.
			const seen = handles
				.map((h) => lastSeenByHandle.get(h))
				.filter((d): d is string => Boolean(d))
				.sort()
				.pop();
			return { name: c.name, handles, lastSeen: seen };
		})
		.filter((p) => p.handles.length > 0);

	if (people.length === 0) return { kind: "unknown" };
	// ONE CARD WINS OUTRIGHT, whether or not they have ever messaged. This is the ten-years-ago case.
	if (people.length === 1) return { kind: "one", name: people[0]!.name, handles: people[0]!.handles };

	// Several people share the name. Who has actually been in touch decides, most recent first.
	const inTouch = people.filter((p) => p.lastSeen).sort((a, b) => (a.lastSeen! < b.lastSeen! ? 1 : -1));
	if (inTouch.length === 1) {
		return { kind: "one", name: inTouch[0]!.name, handles: inTouch[0]!.handles };
	}
	// Nobody has been in touch, or more than one has: nothing here can honestly choose.
	return { kind: "several", candidates: inTouch.length > 0 ? inTouch : people };
}
