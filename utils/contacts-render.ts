/**
 * TURNING THE ADDRESS BOOK INTO THE TEXT THE MODEL READS.
 *
 * Its own module for the same reason `reminders-render` is: the bug it fixes was a rendering decision
 * hiding inside a dispatch switch, where nothing could hold it to account.
 *
 * Listing "all contacts" called `getAllNumbers`, which drops every card with no phone number. On a real
 * address book that answered `Found 252 contacts` when there were 1,645, because 1,507 people have an
 * email and no phone. Nothing was capped, so the truncation note stayed silent. The list simply was not
 * the list, and there was no way to tell from the answer.
 */

export interface ContactCard {
	id: string;
	name: string;
	emails: string[];
	phones: string[];
}

/** One card: everything you could reach them by, emails first, because that is what people ask for. */
export function contactLine(c: ContactCard): string {
	const ways = [...c.emails, ...c.phones];
	return ways.length > 0
		? `${c.name}: ${ways.join(", ")}`
		: `${c.name}: (no email or phone on the card)`;
}

/**
 * The whole book as an index. Every card, including the ones with no way to reach anybody: a name with
 * nothing attached still answers "do I know a Jane Smith", and it is SAID rather than dropped, because
 * dropping it silently is the whole bug.
 */
export function contactsIndex(cards: ContactCard[]): string {
	if (cards.length === 0) {
		// Nothing FAILED to get here: a denial, an unreachable Maestro and a broken read all throw first.
		// (The old text hedged with "make sure you have granted access to Contacts", which invited a
		// reader to treat an empty address book as a permission problem it is not.)
		return "No contacts found in the address book.";
	}
	return `Found ${cards.length} contacts:\n\n${cards.map(contactLine).join("\n")}`;
}
