import { run } from "@jxa/run";
import {
	ToolFailure,
	grantSentence,
	isPermissionDenial,
	phonesMatch,
	throwAppleFailure,
} from "./native";
import { rawBody } from "./failure";
import { isEmailHandle } from "./phone";

interface ContactEntry {
	name: string;
	phones: string[];
	emails: string[];
}

// Maximum contacts to scan (guards against pathological address books).
const MAX_CONTACTS = 1000;

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
 * All contacts with at least one phone or email, with both. Throws a typed `ToolFailure` on a TCC
 * denial, on an unreachable Contacts app, and on a scan where EVERY contact was unreadable.
 *
 * That last case is the one worth naming. Skipping an individual unreadable contact is right: one bad
 * record must not lose the other nine hundred. But if every record we touched threw, "[]" is not an
 * empty address book, it is a broken read reported as a fact about the user's data. So the scan counts
 * what it skipped and keeps the first thing Contacts said, and an all-skipped pass fails loudly.
 */
async function getAllContacts(): Promise<ContactEntry[]> {
	let scan: {
		items: ContactEntry[];
		attempted: number;
		skipped: number;
		firstError: string;
	};
	try {
		scan = (await run((max: number) => {
			const app = Application("Contacts");
			const people = app.people();
			const out: { name: string; phones: string[]; emails: string[] }[] = [];
			const count = Math.min(people.length, max);
			let skipped = 0;
			let firstError = "";
			for (let i = 0; i < count; i++) {
				try {
					const person = people[i];
					const phones = person
						.phones()
						.map((p: { value: () => string }) => p.value())
						.filter((v: string) => typeof v === "string" && v.length > 0);
					const emails = person
						.emails()
						.map((e: { value: () => string }) => e.value())
						.filter((v: string) => typeof v === "string" && v.length > 0);
					if (phones.length > 0 || emails.length > 0) {
						out.push({ name: person.name(), phones, emails });
					}
				} catch (e) {
					// Skip an individual unreadable contact; do not abort the whole scan.
					skipped++;
					if (!firstError) firstError = String(e);
				}
			}
			return { items: out, attempted: count, skipped, firstError };
		}, MAX_CONTACTS)) as typeof scan;
	} catch (error) {
		throwAppleFailure(error, CONTACTS_SUMMARIES);
	}

	if (scan.attempted > 0 && scan.skipped === scan.attempted) {
		throw new ToolFailure(
			"applescript_error",
			`Could not read your contacts: all ${scan.attempted} contacts failed to read.`,
			rawBody(scan.firstError),
		);
	}
	return scan.items;
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

/** Display name of the contact owning a phone OR email handle, or null if none. An iMessage sender
 *  can be either; phone matching is country-code agnostic, email matching is exact (case-insensitive). */
async function findContactByPhone(handle: string): Promise<string | null> {
	if (!handle || handle.trim() === "") return null;
	const trimmed = handle.trim();

	const contacts = await getAllContacts(); // throws ToolFailure on denial

	if (isEmailHandle(trimmed)) {
		const target = trimmed.toLowerCase();
		for (const c of contacts) {
			if (c.emails.some((e) => e.toLowerCase() === target)) return c.name;
		}
		return null;
	}

	for (const c of contacts) {
		if (c.phones.some((num) => phonesMatch(num, trimmed))) return c.name;
	}
	return null;
}

export default {
	getAllNumbers,
	findNumber,
	findContactByPhone,
	requestContactsAccess,
};
