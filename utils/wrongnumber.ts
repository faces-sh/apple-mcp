import { handleCandidates } from "./phone";

/**
 * A number that has NEVER carried a message, when the same person has one that has.
 *
 * THE FIX THAT ORDERS A PERSON'S HANDLES ONLY WORKS WHEN A NAME IS BEING RESOLVED. Watched six times on
 * a real machine: the model read a number off the conversation it had already been shown ("Linda
 * Therrien at (604) 730-4051") and passed it straight through, so nothing ever consulted Contacts and
 * the send went to her home landline. That number has carried 0 messages in five years; the one she
 * writes from has 5,325. Every attempt failed with error 22, and Messages itself crashed seconds later,
 * each time.
 *
 * REFUSES, NEVER REDIRECTS. Sending is the act that cannot be taken back, and "you probably meant her
 * other number" is a guess: somebody who has just changed number has no history on the new one either,
 * and silently rerouting to the old one would send a private message to a phone they no longer hold.
 * So this hands back the sentence and the caller sends again, which is the same shape as answering
 * "more than one person is called Linda".
 *
 * Only fires when BOTH are true, so a genuinely new contact is untouched: the target has no history at
 * all, and Contacts says the same person has a handle that does.
 */
export async function unusedNumberFor(
	target: string,
	// INJECTED, so the rule can be tested without Contacts and without sending anything. Learned the
	// expensive way: the first version was "verified" by running a real send at the very number already
	// known to crash Messages, which duly crashed it again. A safety rule must be checkable in a test.
	deps: {
		seenByHandle: () => Promise<Map<string, string>>;
		whoOwns: (h: string) => Promise<string | null>;
		cardsFor: (name: string) => Promise<{ name: string; phones: string[]; emails: string[] }[]>;
	},
): Promise<{ name: string; better: string } | null> {
	try {
		const seen = await deps.seenByHandle();
		const known = (h: string) => handleCandidates(h).some((c) => seen.has(c)) || seen.has(h);
		if (known(target)) return null;                      // it is in use: nothing to say
		const name = await deps.whoOwns(target);
		if (!name) return null;                              // nobody owns it: a new number, allowed
		const cards = await deps.cardsFor(name);
		const theirs = cards.flatMap((c) => [...c.phones, ...c.emails])
			.map((h) => h.trim()).filter(Boolean);
		// Their handle with the most recent traffic, if any has any.
		let best: { handle: string; at: string } | null = null;
		for (const h of theirs) {
			for (const c of [h, ...handleCandidates(h)]) {
				const at = seen.get(c);
				if (at && (!best || at > best.at)) best = { handle: c, at };
			}
		}
		return best ? { name, better: best.handle } : null;
	} catch {
		return null;   // Contacts unreadable, or the store is: never block a send on a nicety
	}
}
