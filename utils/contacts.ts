import { run } from "@jxa/run";
import {
	ToolFailure,
	assertAlignedColumns,
	grantSentence,
	isPermissionDenial,
	phonesMatch,
	throwAppleFailure,
} from "./native";
import { rawBody } from "./failure";
import { isEmailHandle } from "./phone";

interface ContactEntry {
	/** The card's stable identifier, which survives edits and renames.
	 *
	 *  It is `CNContact.identifier` (verified: JXA's `person.id()` and CNContact return the same
	 *  "UUID:ABPerson" string for the same card), so a caller holding this can act on the card through
	 *  the Contacts framework. Maestro uses it to remember which address somebody chose, keyed on
	 *  something that a rename cannot break and two people called John Smith cannot collide on. */
	id: string;
	name: string;
	phones: string[];
	emails: string[];
}

// ONE APPLE EVENT PER PROPERTY, NOT PER CARD. The cost of talking to Contacts is the NUMBER of Apple
// Events, not the volume of data, and the obvious code gets that backwards. Measured against this Mac's
// real address book of 1,647 cards:
//
//     app.people.name() / .id() / .emails.value() / .phones.value()   1.8s   FOUR events, whole book
//     person.phones() + person.emails() + person.id() + person.name(), one card at a time   179.2s
//
// The nested arrays come back correctly: `emails.value()` on the collection returns one array of
// addresses per card, in card order. So the read below is four events whatever the book holds.
//
// WHAT THIS COSTS: the old loop guarded each card individually, so one unreadable card lost only
// itself. A collection read is a single event and has no per-card granularity to skip with; Contacts
// answers with `missing value` for a field it cannot give, which is coerced exactly as before, and a
// read that fails OUTRIGHT now fails the call loudly instead of returning part of the book as if it
// were all of it.

// Maximum contacts to look at (guards against pathological address books).
//
// RAISED FROM 1000, and the truncation is now REPORTED rather than silent, because 1000 was not a
// pathological address book, it was this one: a real Mac here holds 1,647 cards, so 647 people were
// invisible to every lookup, and the scan takes the FIRST n, which means the invisible ones are the
// most recently added. A person searched for and not found was indistinguishable from a person who was
// never looked at.
//
// The cap still exists because an unbounded result on a very large book is a response nobody can read,
// and it still takes the first n. What must never happen again is losing people QUIETLY.
const MAX_CONTACTS = 5000;

/** How many cards the last read looked at, and how many there were. Read by the caller so a
 *  "not found" can say whether the whole book was searched. Null once the cap stops biting. */
export let lastScanTruncation: { shown: number; total: number } | null = null;

// The one sentence each outcome puts on line 1 of the envelope. It says WHAT DID NOT HAPPEN, and for
// a denial it also NAMES the permission that is missing and the app to enable it for.
//
// Naming it is not inventing a remedy. Only this server can tell a denied Automation grant from a
// denied Contacts one, so nothing upstream could reconstruct that sentence, and dropping it deletes it
// rather than moving it somewhere better. What stays out is anything we would be guessing: no "then
// try again", no theory about why the grant is missing.
export const CONTACTS_SUMMARIES = {
	denied:
		"Could not read your contacts: macOS denied access to Contacts. " +
		grantSentence("Contacts", "Automation > Contacts"),
	notRunning: "Could not read your contacts: the Contacts app could not be reached.",
	timedOut: "Could not read your contacts: Contacts did not answer in time.",
	failed: "Could not read your contacts.",
};

// We drive Contacts through JXA (@jxa/run) rather than by interpolating user input into an
// AppleScript source string. JXA returns REAL JS objects/arrays (so there is no string-parsing bug),
// and all user input is passed as serialized *arguments* to the script (so there is no script
// injection). JXA still goes through Apple Events, so the same Automation (kTCCServiceAppleEvents)
// permission applies: a denial surfaces as a thrown error which we convert to a typed ToolFailure.

/** Probe Contacts access. Returns access state; never masks a non-permission failure. */
async function requestContactsAccess(): Promise<{
	hasAccess: boolean;
	message: string;
}> {
	try {
		await run(() => {
			// Touching the app's name is enough to trigger the Automation prompt / denial.
			return Application("Contacts").name();
		});
		return { hasAccess: true, message: "Contacts access is granted." };
	} catch (error) {
		if (isPermissionDenial(error)) {
			return { hasAccess: false, message: CONTACTS_SUMMARIES.denied };
		}
		// Not a denial, so this probe cannot answer the question it was asked. Surface it rather than
		// reporting "no access" for something that was never about access.
		throwAppleFailure(error, CONTACTS_SUMMARIES);
	}
}

/**
 * All contacts with at least one phone or email, with both. Four Apple Events, whatever the book holds.
 *
 * Throws a typed `ToolFailure` on a TCC denial, on an unreachable Contacts app, and on a read whose
 * columns come back different lengths. That last one is the one worth naming: two of these four reads
 * are separate events, so a card added in between shifts every card after it by one, and filing one
 * person's number under another person's name is worse than filing nothing. The read is retaken once
 * and then it fails, loudly, saying what it saw.
 */
async function getAllContacts(): Promise<ContactEntry[]> {
	let columns: {
		ids: unknown[];
		names: unknown[];
		emails: unknown[][];
		phones: unknown[][];
	};
	try {
		columns = (await run(() => {
			const app = Application("Contacts");
			let ids: unknown[] = [];
			let names: unknown[] = [];
			let emails: unknown[][] = [];
			let phones: unknown[][] = [];
			// Four events, four columns. Retaken once if the book moves between them, because an
			// off-by-one column would put one person's number under another person's name.
			for (let attempt = 0; attempt < 2; attempt++) {
				ids = app.people.id();
				names = app.people.name();
				emails = app.people.emails.value();
				phones = app.people.phones.value();
				if (
					ids.length === names.length &&
					ids.length === emails.length &&
					ids.length === phones.length
				) {
					break;
				}
			}
			return { ids, names, emails, phones };
		})) as typeof columns;
	} catch (error) {
		throwAppleFailure(error, CONTACTS_SUMMARIES);
	}

	assertAlignedColumns(
		[
			columns.ids.length,
			columns.names.length,
			columns.emails.length,
			columns.phones.length,
		],
		"Could not read your contacts: the address book changed while it was being read.",
	);

	const total = columns.ids.length;
	const looked = Math.min(total, MAX_CONTACTS);
	const out: ContactEntry[] = [];
	for (let i = 0; i < looked; i++) {
		const phones = onlyStrings(columns.phones[i]);
		const emails = onlyStrings(columns.emails[i]);
		if (phones.length === 0 && emails.length === 0) continue;
		out.push({
			id: typeof columns.ids[i] === "string" ? (columns.ids[i] as string) : "",
			name: typeof columns.names[i] === "string" ? (columns.names[i] as string) : "",
			phones,
			emails,
		});
	}
	lastScanTruncation = total > looked ? { shown: looked, total } : null;
	return out;
}

/** The non-empty strings of one card's value column; anything Contacts could not give us is dropped,
 *  exactly as the per-card read dropped it. */
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
 *  ASKS CONTACTS TO DO THE FILTERING, which is the whole difference. The obvious implementation reads
 *  every card into JavaScript and filters there, and on a real address book of 1,647 cards that took
 *  **211 seconds**: JXA fetches each card over AppleEvents one at a time. Handing the same query to the
 *  app as a `whose` clause takes **0.8 seconds**, because Contacts answers it against its own index.
 *
 *  Two things follow for free. It searches the WHOLE book, so the scan cap cannot silently hide anybody
 *  from a search; and `_contains` is case-insensitive, so no normalising is needed for that.
 *
 *  The ladder is deliberately short: the full query, then each word of it. It replaces a seven-strategy
 *  cleanName ladder that could only exist because everything was already in memory. Every rung here
 *  costs a round trip, so the rungs have to earn their place, and "Rollie" and "Stanich" both finding
 *  Rollie Stanich is what people actually type.
 *
 *  `findNumber` still exists beside this and returns phone numbers only, because it feeds the messaging
 *  path where a phone IS the answer. This one exists because that path got asked for EMAILS: it goes
 *  through `getAllNumbers`, which drops every contact with no phone, and on this address book that is
 *  1,370 of 1,647 cards, so a caller looking for an address got nothing back from the one source that
 *  reliably has it.
 */
async function findContacts(name: string): Promise<ContactEntry[]> {
	if (!name || name.trim() === "") return [];
	const query = name.trim();
	// Words long enough to be worth a round trip. One and two letter fragments match half an address
	// book and answer nothing.
	const words = query.split(/\s+/).filter((w) => w.length >= 3);
	const terms = [query, ...words.filter((w) => w.toLowerCase() !== query.toLowerCase())];

	let matched: ContactEntry[] = [];
	try {
		matched = (await run((needles: string[]) => {
			const app = Application("Contacts");
			const out: { id: string; name: string; phones: string[]; emails: string[] }[] = [];
			const seen: { [id: string]: true } = {};
			for (const needle of needles) {
				let people: unknown[] = [];
				try {
					people = app.people.whose({ name: { _contains: needle } })();
				} catch (e) {
					continue;              // one bad term must not lose the others
				}
				for (const person of people as {
					id: () => string; name: () => string;
					phones: () => { value: () => string }[];
					emails: () => { value: () => string }[];
				}[]) {
					try {
						const id = person.id();
						if (seen[id]) continue;
						seen[id] = true;
						const phones = person.phones().map((p) => p.value())
							.filter((v: string) => typeof v === "string" && v.length > 0);
						const emails = person.emails().map((e) => e.value())
							.filter((v: string) => typeof v === "string" && v.length > 0);
						if (phones.length > 0 || emails.length > 0) {
							out.push({ id, name: person.name(), phones, emails });
						}
					} catch (e) {
						// Skip an individual unreadable contact; do not abort the search.
					}
				}
				if (out.length > 0) break;   // the most precise term that found anybody wins
			}
			return out;
		}, terms)) as ContactEntry[];
	} catch (error) {
		throwAppleFailure(error, CONTACTS_SUMMARIES);
	}
	// A search asks the app, which sees every card, so nothing was skipped for being past a cap.
	lastScanTruncation = null;
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
	truncation: () => lastScanTruncation,
	getAllNumbers,
	findNumber,
	findContacts,
	findContactByPhone,
	namesForHandles,
	requestContactsAccess,
};
