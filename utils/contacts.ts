import { ToolFailure, grantSentence, phonesMatch } from "./native";
import { isEmailHandle } from "./phone";
import { ask } from "./maestro";

interface ContactEntry {
	/** The card's stable identifier, which survives edits and renames.
	 *
	 *  It is `CNContact.identifier`, so a caller holding this can act on the card through the Contacts
	 *  framework. Maestro uses it to remember which address somebody chose, keyed on something that a
	 *  rename cannot break and two people called John Smith cannot collide on. */
	id: string;
	name: string;
	phones: string[];
	emails: string[];
}

// CONTACTS IS NOT READ HERE. Maestro reads it, through the Contacts framework, and this asks.
//
// Scripting the Contacts app for this worked, after a fashion, and the fashion is the problem. The cost
// of Apple Events is the NUMBER of them, so the read had to be four collection reads (ids, names, emails,
// phones) zipped back together by position, which carried two faults a single native fetch cannot have.
//
// The first was a correctness hazard defended against by hand: four separate events mean a card added
// between two of them shifts every card after it by one, filing one person's number under another
// person's name. There was a re-read and an alignment check for exactly this.
//
// The second is what a person actually saw. Listing "all contacts" went through the phone-only path, so
// on this Mac's real address book it answered with 252 cards out of 1,645. Not capped, not truncated, no
// note: the 1,507 people with an email and no phone number simply were not there.
//
//     scripted, four collection reads       1.8s, and 252 of 1,645 for a list
//     Maestro, one CNContactStore fetch    0.79s, 1,645 of 1,645
//
// The cap went with it. MAX_CONTACTS existed to bound a scan that cost an event per card, along with a
// truncation note every caller had to remember to print; one indexed fetch needs neither.

// The one sentence each outcome puts on line 1 of the envelope. It says WHAT DID NOT HAPPEN, and for a
// denial it NAMES the permission that is missing and where to grant it.
//
// The permission NAMED here changed with the path: Contacts access for Maestro, not Automation consent
// for the Contacts app. Pointing at the old one would send somebody to flip a switch that cannot fix it.
export const CONTACTS_SUMMARIES = {
	denied:
		"Could not read your contacts: macOS denied access to Contacts. " +
		grantSentence("Contacts"),
	notRunning: "Could not read your contacts: Maestro could not be reached.",
	timedOut: "Could not read your contacts: Maestro did not answer in time.",
	failed: "Could not read your contacts.",
};

/** Every card in the address book, whole. */
async function getAllContacts(): Promise<ContactEntry[]> {
	const body = await ask("contacts", "all", {}, CONTACTS_SUMMARIES);
	return (body.cards ?? []) as ContactEntry[];
}

async function requestContactsAccess(): Promise<{
	hasAccess: boolean;
	message: string;
}> {
	try {
		await getAllContacts();
		return { hasAccess: true, message: "Contacts access is granted." };
	} catch (error) {
		if (error instanceof ToolFailure && error.code === "permission_denied") {
			return { hasAccess: false, message: CONTACTS_SUMMARIES.denied };
		}
		throw error;
	}
}

function onlyStrings(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** All contacts that have at least one phone number, keyed by display name. */
async function getAllNumbers(): Promise<{ [name: string]: string[] }> {
	const contacts = await getAllContacts(); // throws ToolFailure on denial
	const result: { [name: string]: string[] } = {};
	for (const contact of contacts) {
		if (!contact || !contact.name || contact.phones.length === 0) continue;
		result[contact.name] = (result[contact.name] ?? []).concat(contact.phones);
	}
	return result;
}

/** Normalize a name for fuzzy matching: lowercase, strip emoji/symbols, collapse whitespace. */
function cleanName(name: string): string {
	return name
		.toLowerCase()
		.replace(
			/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu,
			"",
		)
		.replace(/[☀-➿⬀-⯿️]/g, "") // misc symbols, dingbats, variation selectors
		.replace(/\s+/g, " ")
		.trim();
}

/** Phone numbers for the contact whose name best matches `name`. Empty array = no match found
 *  (a permission denial throws instead, it never silently returns empty). */
async function findNumber(name: string): Promise<string[]> {
	if (!name || name.trim() === "") return [];

	const allNumbers = await getAllNumbers(); // throws ToolFailure on denial
	const names = Object.keys(allNumbers);
	if (names.length === 0) return [];

	const search = cleanName(name);

	// Ordered from most to least precise; first hit wins.
	const strategies: Array<(candidate: string) => boolean> = [
		(c) => cleanName(c) === search,
		(c) => cleanName(c).startsWith(search),
		(c) => cleanName(c).includes(search),
		(c) => search.includes(cleanName(c)),
		(c) => cleanName(c).split(" ")[0] === search,
		(c) => {
			const parts = cleanName(c).split(" ");
			return parts[parts.length - 1] === search;
		},
		(c) => cleanName(c).split(" ").some((w) => w === search || w.startsWith(search)),
	];

	for (const matches of strategies) {
		const hit = names.find(matches);
		if (hit) return allNumbers[hit];
	}
	return [];
}

/** Every contact matching a name, WHOLE: id, emails and phones.
 *
 *  Filtered HERE, over the whole book, which is only reasonable because the whole book now arrives in
 *  0.79s from one native fetch. The version this replaces handed each search term to the Contacts app as
 *  a `whose` clause, because reading every card over Apple Events took 211 seconds and filtering in
 *  JavaScript was therefore unthinkable. That is no longer true, and one fetch beats a round trip per
 *  word: "Rollie Stanich" cost three.
 *
 *  The ladder stays short and stays ordered: the exact query first, then each word of it. Words shorter
 *  than three letters are skipped because they match half an address book and answer nothing.
 *
 *  `findNumber` still exists beside this and returns phone numbers only, because it feeds the messaging
 *  path where a phone IS the answer.
 */
async function findContacts(name: string): Promise<ContactEntry[]> {
	if (!name || name.trim() === "") return [];
	const query = name.trim();
	const words = query.split(/\s+/).filter((w) => w.length >= 3);
	const terms = [query, ...words.filter((w) => w.toLowerCase() !== query.toLowerCase())];

	const contacts = await getAllContacts(); // throws ToolFailure on denial
	const matched: ContactEntry[] = [];
	const seen = new Set<string>();

	// Term order is match order, so the whole query's hits come before a single word's. Somebody who
	// typed a full name gets that person first even when a surname matches ten others.
	for (const term of terms) {
		const needle = term.toLowerCase();
		for (const c of contacts) {
			if (seen.has(c.id)) continue;
			if (!c.name.toLowerCase().includes(needle)) continue;
			seen.add(c.id);
			matched.push(c);
		}
	}
	return matched;
}

/**
 * Display names for a BATCH of iMessage handles, resolved in ONE pass over the address book.
 *
 * This exists because the single-handle version was being called in a loop. Maestro's `unread` path
 * mapped over the messages with `Promise.all` and asked for a name per message, and since nothing here
 * caches, each of those read the entire address book over Apple Events: `{"operation":"unread",
 * "limit":2}` measured **306.0s** on this Mac, of which the sqlite query that actually finds the
 * messages was 0.05s. The book is read once here instead, so the cost stops scaling with the number of messages.
 *
 * DELIBERATELY NOT CACHED ACROSS CALLS. Somebody who adds a contact and immediately asks who just
 * texted them is exactly the case a cache gets wrong, and being briefly wrong about who a person is is
 * worse than being slow.
 *
 * An iMessage handle is either a phone number or an email address (iMessage by Apple ID): phone
 * matching is country-code agnostic, email matching is exact but case-insensitive. Address-book order
 * decides ties, which is what the single-handle lookup did when it walked the same list and took the
 * first match. Handles with no contact are simply absent from the map.
 */
async function namesForHandles(handles: string[]): Promise<Map<string, string>> {
	const wanted = Array.from(
		new Set(handles.map((h) => (h ?? "").trim()).filter((h) => h.length > 0)),
	);
	const resolved = new Map<string, string>();
	// No handles to resolve is not a reason to open Contacts at all.
	if (wanted.length === 0) return resolved;

	const contacts = await getAllContacts(); // throws ToolFailure on denial

	const emailTargets = new Map<string, string>(); // lowercased address -> the handle as given
	const phoneTargets: string[] = [];
	for (const handle of wanted) {
		if (isEmailHandle(handle)) emailTargets.set(handle.toLowerCase(), handle);
		else phoneTargets.push(handle);
	}

	for (const c of contacts) {
		for (const email of c.emails) {
			const handle = emailTargets.get(email.toLowerCase());
			if (handle !== undefined && !resolved.has(handle)) resolved.set(handle, c.name);
		}
		for (const handle of phoneTargets) {
			if (resolved.has(handle)) continue;
			if (c.phones.some((num) => phonesMatch(num, handle))) resolved.set(handle, c.name);
		}
		if (resolved.size === wanted.length) break;
	}
	return resolved;
}

/** Display name of the contact owning a phone OR email handle, or null if none. The batch version is
 *  the implementation: a single lookup is a batch of one, never a second way of doing the same thing. */
async function findContactByPhone(handle: string): Promise<string | null> {
	if (!handle || handle.trim() === "") return null;
	const trimmed = handle.trim();
	const resolved = await namesForHandles([trimmed]); // throws ToolFailure on denial
	return resolved.has(trimmed) ? (resolved.get(trimmed) as string) : null;
}

export default {
	getAllContacts,
	getAllNumbers,
	findNumber,
	findContacts,
	findContactByPhone,
	namesForHandles,
	requestContactsAccess,
};
