import { run } from "@jxa/run";
import { APP_NAME, PermissionError, isPermissionDenial, phonesMatch } from "./native";
import { isEmailHandle } from "./phone";

interface ContactEntry {
	name: string;
	phones: string[];
	emails: string[];
}

// Maximum contacts to scan (guards against pathological address books).
const MAX_CONTACTS = 1000;

const CONTACTS_DENIED =
	`Contacts access is not granted. In System Settings ▸ Privacy & Security, grant ${APP_NAME} access ` +
	"to Contacts (and Automation ▸ Contacts), then try again.";

// We drive Contacts through JXA (@jxa/run) rather than by interpolating user input into an
// AppleScript source string. JXA returns REAL JS objects/arrays (so there is no string-parsing bug),
// and all user input is passed as serialized *arguments* to the script (so there is no script
// injection). JXA still goes through Apple Events, so the same Automation (kTCCServiceAppleEvents)
// permission applies — a denial surfaces as a thrown error which we convert to PermissionError.
//
// MUTATIONS (create/update/delete) have two Contacts-specific quirks baked into every write path:
//   1. `Contacts.save()` is REQUIRED for a change to persist — unlike Messages/Reminders/Notes, a
//      bare push/property-set is discarded when the bridge tears down unless we explicitly save.
//   2. We NEVER read a just-created/just-mutated property back: a read on a fresh contact forces a
//      store/iCloud round-trip that blocks for SECONDS each (a create that re-read 4 props measured
//      ~2 minutes). We return the values we SET, not values we re-read.
// After any write we drop the in-process cache (`invalidateCache()`) so the next read sees the change.

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
			return { hasAccess: false, message: CONTACTS_DENIED };
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
}

// A full address-book scan costs several Apple Events per contact, so it is expensive on a large
// Contacts list. The unread-messages path resolves a display name for EVERY sender, so without this
// we'd launch one full scan per message, concurrently (dozens of `osascript` at once → thrash). Cache
// the scan briefly and dedupe in-flight callers, so a burst of lookups shares a single scan. Contacts
// rarely change mid-conversation; the cache is per-process and short-lived, and any write through this
// module invalidates it immediately so a create/update/delete is reflected on the very next read.
let contactsCache: { at: number; promise: Promise<ContactEntry[]> } | null = null;
const CONTACTS_TTL_MS = 30_000;

/** Drop the cached scan so the next read re-scans. Called after every mutation (create/update/delete). */
function invalidateCache(): void {
	contactsCache = null;
}

/** One full JXA scan of the address book (phones + emails). Throws PermissionError on TCC denial. */
async function scanAllContacts(): Promise<ContactEntry[]> {
	try {
		return (await run((max: number) => {
			const app = Application("Contacts");
			const people = app.people();
			const out: { name: string; phones: string[]; emails: string[] }[] = [];
			const count = Math.min(people.length, max);
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
				} catch {
					// Skip an individual unreadable contact; do not abort the whole scan.
				}
			}
			return out;
		}, MAX_CONTACTS)) as ContactEntry[];
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(CONTACTS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/** All contacts with phones + emails. Cached briefly and in-flight-deduped so a burst of lookups
 *  (e.g. resolving every unread-message sender) shares ONE scan. Throws PermissionError on denial. */
async function getAllContacts(): Promise<ContactEntry[]> {
	const now = Date.now();
	if (contactsCache && now - contactsCache.at < CONTACTS_TTL_MS) {
		return contactsCache.promise;
	}
	const promise = scanAllContacts();
	contactsCache = { at: now, promise };
	// On failure, drop the cache so the next call retries instead of re-throwing a stale error.
	promise.catch(() => {
		if (contactsCache?.promise === promise) contactsCache = null;
	});
	return promise;
}

/** All contacts that have at least one phone number, keyed by display name. */
async function getAllNumbers(): Promise<{ [name: string]: string[] }> {
	const contacts = await getAllContacts(); // throws PermissionError on denial
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

/** The contact whose name best matches `name` (phones + emails), or null. Fast server-side `whose`
 *  filter first, falling back to a full fuzzy scan. A permission denial throws (never silent empty). */
async function findBestContact(name: string): Promise<ContactEntry | null> {
	const trimmed = name.trim();
	if (!trimmed) return null;

	// Fast path: Contacts filters by name server-side (one query returning only matches).
	try {
		const hit = (await run((needle: string) => {
			const app = Application("Contacts");
			let people: {
				name: () => string;
				phones: () => { value: () => string }[];
				emails: () => { value: () => string }[];
			}[] = [];
			try {
				people = app.people.whose({ name: { _contains: needle } })();
			} catch {
				people = []; // whose unsupported → fall through to the thorough scan below
			}
			if (!people || people.length === 0) return null;
			const p = people[0];
			const phones = p
				.phones()
				.map((x) => x.value())
				.filter((v) => typeof v === "string" && v.length > 0);
			const emails = p
				.emails()
				.map((x) => x.value())
				.filter((v) => typeof v === "string" && v.length > 0);
			return { name: p.name(), phones, emails };
		}, trimmed)) as ContactEntry | null;
		if (hit && (hit.phones.length > 0 || hit.emails.length > 0)) return hit;
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(CONTACTS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}

	// Thorough fallback: full (cached) scan + fuzzy strategies (emoji/nickname edge cases, no whose match).
	const all = await getAllContacts(); // throws PermissionError on denial
	if (all.length === 0) return null;
	const search = cleanName(trimmed);
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
		const hit = all.find((c) => matches(c.name));
		if (hit) return hit;
	}
	return null;
}

/** Phone numbers for the contact whose name best matches `name` ([] if none; denial throws). */
async function findNumber(name: string): Promise<string[]> {
	return (await findBestContact(name))?.phones ?? [];
}

/** All handles (phones + emails) for the best name match — to query a person's whole message thread
 *  in one shot regardless of which number/address they use ([] if none; denial throws). */
async function findHandles(name: string): Promise<string[]> {
	const hit = await findBestContact(name);
	return hit ? [...hit.phones, ...hit.emails] : [];
}

/** Display name of the contact owning a phone OR email handle, or null if none. An iMessage sender
 *  can be either; phone matching is country-code agnostic, email matching is exact (case-insensitive). */
async function findContactByPhone(handle: string): Promise<string | null> {
	if (!handle || handle.trim() === "") return null;
	const trimmed = handle.trim();

	const contacts = await getAllContacts(); // throws PermissionError on denial

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

/** Up to MAX_CONTACTS contacts whose display name contains `name` (case-insensitive). Full entries
 *  (name + phones + emails) for display/disambiguation. [] if none match; a denial throws. The
 *  server-side `whose` filter returns only matches in one round-trip, with a cached-scan fallback. */
async function searchContacts(name: string): Promise<ContactEntry[]> {
	const trimmed = name.trim();
	if (!trimmed) return [];

	try {
		const hits = (await run(
			(args: { needle: string; max: number }) => {
				const app = Application("Contacts");
				let people: {
					name: () => string;
					phones: () => { value: () => string }[];
					emails: () => { value: () => string }[];
				}[] = [];
				try {
					people = app.people.whose({ name: { _contains: args.needle } })();
				} catch {
					return null; // whose unsupported → signal the TS fallback scan below
				}
				const out: { name: string; phones: string[]; emails: string[] }[] = [];
				const count = Math.min(people.length, args.max);
				for (let i = 0; i < count; i++) {
					try {
						const p = people[i];
						const phones = p
							.phones()
							.map((x) => x.value())
							.filter((v) => typeof v === "string" && v.length > 0);
						const emails = p
							.emails()
							.map((x) => x.value())
							.filter((v) => typeof v === "string" && v.length > 0);
						out.push({ name: p.name(), phones, emails });
					} catch {
						// Skip an individual unreadable contact.
					}
				}
				return out;
			},
			{ needle: trimmed, max: MAX_CONTACTS },
		)) as ContactEntry[] | null;
		if (hits !== null) return hits;
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(CONTACTS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}

	// Fallback: cached full scan + case-insensitive name substring (whose unsupported).
	const all = await getAllContacts(); // throws PermissionError on denial
	const search = cleanName(trimmed);
	return all.filter((c) => cleanName(c.name).includes(search));
}

/** Compose a display name the way Contacts will from the fields we set (so we can echo it back without
 *  an expensive post-write read). Mirrors Contacts' "First Last" / org-only fallback. */
function composeName(opts: {
	firstName?: string | null;
	lastName?: string | null;
	organization?: string | null;
}): string {
	const parts = [opts.firstName, opts.lastName]
		.map((p) => (p ?? "").trim())
		.filter((p) => p.length > 0);
	if (parts.length > 0) return parts.join(" ");
	return (opts.organization ?? "").trim();
}

/**
 * Create a new person. At least one of firstName / lastName / organization is required (an entirely
 * nameless contact is rejected, not silently created). `phones` and `emails` are added with the given
 * labels (default "mobile" / "home"). Returns the values we SET — never a post-create read (which
 * would force a multi-second iCloud round-trip). `Contacts.save()` is called so the create persists,
 * and the cache is invalidated so the next read sees the new person. A TCC denial throws PermissionError.
 */
async function createContact(opts: {
	firstName?: string;
	lastName?: string;
	organization?: string;
	phones?: string[];
	emails?: string[];
	phoneLabel?: string;
	emailLabel?: string;
}): Promise<ContactEntry> {
	const firstName = (opts.firstName ?? "").trim();
	const lastName = (opts.lastName ?? "").trim();
	const organization = (opts.organization ?? "").trim();
	if (!firstName && !lastName && !organization) {
		throw new Error(
			"A new contact needs at least a first name, last name, or organization.",
		);
	}
	const phones = (opts.phones ?? [])
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	const emails = (opts.emails ?? [])
		.map((e) => e.trim())
		.filter((e) => e.length > 0);
	const phoneLabel = (opts.phoneLabel ?? "mobile").trim() || "mobile";
	const emailLabel = (opts.emailLabel ?? "home").trim() || "home";

	try {
		await run(
			(a: {
				firstName: string;
				lastName: string;
				organization: string;
				phones: string[];
				emails: string[];
				phoneLabel: string;
				emailLabel: string;
			}) => {
				const app = Application("Contacts");
				const props: {
					firstName?: string;
					lastName?: string;
					organization?: string;
				} = {};
				if (a.firstName) props.firstName = a.firstName;
				if (a.lastName) props.lastName = a.lastName;
				if (a.organization) props.organization = a.organization;

				const person = app.Person(props);
				app.people.push(person);
				for (let i = 0; i < a.phones.length; i++) {
					person.phones.push(app.Phone({ label: a.phoneLabel, value: a.phones[i] }));
				}
				for (let i = 0; i < a.emails.length; i++) {
					person.emails.push(app.Email({ label: a.emailLabel, value: a.emails[i] }));
				}
				// REQUIRED: without save() the new person is discarded when the bridge tears down.
				app.save();
				// Do NOT read the person back — return nothing; the TS layer echoes the values we set.
				return true;
			},
			{ firstName, lastName, organization, phones, emails, phoneLabel, emailLabel },
		);
	} catch (error) {
		invalidateCache();
		if (isPermissionDenial(error)) throw new PermissionError(CONTACTS_DENIED);
		throw error instanceof Error
			? error
			: new Error(`Failed to create contact: ${String(error)}`);
	}

	invalidateCache();
	return {
		name: composeName({ firstName, lastName, organization }),
		phones,
		emails,
	};
}

/**
 * Update the first contact whose display name matches `name`: rename (firstName / lastName /
 * organization), add phones/emails, and/or remove phones/emails. Removals match loosely — a phone by
 * its digits (country-code agnostic), an email case-insensitively — so the caller can pass a
 * human-formatted value. Returns `{ updated:false }` when no contact matches (an honest "not found",
 * not a thrown fault). `Contacts.save()` persists the change and the cache is invalidated. Reads the
 * existing phone/email VALUES only to locate removals (a pre-write read of existing items, not a
 * post-write re-read of mutated ones). A TCC denial throws PermissionError.
 */
async function updateContact(opts: {
	name: string;
	firstName?: string;
	lastName?: string;
	organization?: string;
	addPhones?: string[];
	addEmails?: string[];
	removePhones?: string[];
	removeEmails?: string[];
	phoneLabel?: string;
	emailLabel?: string;
}): Promise<{ updated: boolean; name?: string }> {
	const target = opts.name.trim();
	if (!target) {
		throw new Error("A contact name is required to identify which contact to update.");
	}
	const addPhones = (opts.addPhones ?? []).map((p) => p.trim()).filter(Boolean);
	const addEmails = (opts.addEmails ?? []).map((e) => e.trim()).filter(Boolean);
	const removePhones = (opts.removePhones ?? []).map((p) => p.trim()).filter(Boolean);
	const removeEmails = (opts.removeEmails ?? []).map((e) => e.trim()).filter(Boolean);
	const hasRename =
		opts.firstName != null || opts.lastName != null || opts.organization != null;
	if (
		!hasRename &&
		addPhones.length === 0 &&
		addEmails.length === 0 &&
		removePhones.length === 0 &&
		removeEmails.length === 0
	) {
		throw new Error("Nothing to update: provide a rename and/or phones/emails to add or remove.");
	}
	const phoneLabel = (opts.phoneLabel ?? "mobile").trim() || "mobile";
	const emailLabel = (opts.emailLabel ?? "home").trim() || "home";

	let result: { updated: boolean; name?: string };
	try {
		result = (await run(
			(a: {
				needle: string;
				firstName: string | null;
				lastName: string | null;
				organization: string | null;
				addPhones: string[];
				addEmails: string[];
				removePhones: string[];
				removeEmails: string[];
				phoneLabel: string;
				emailLabel: string;
				max: number;
			}) => {
				const app = Application("Contacts");

				// Locate the target person: server-side `whose` first, bounded scan fallback.
				let person: any = null;
				try {
					const hits = app.people.whose({ name: { _contains: a.needle } })();
					if (hits && hits.length > 0) person = hits[0];
				} catch (e) {
					person = null;
				}
				if (!person) {
					const people = app.people();
					const lower = a.needle.toLowerCase();
					const count = Math.min(people.length, a.max);
					for (let i = 0; i < count; i++) {
						try {
							if (String(people[i].name()).toLowerCase().indexOf(lower) !== -1) {
								person = people[i];
								break;
							}
						} catch (e2) {}
					}
				}
				if (!person) return { updated: false };

				// Capture the existing display name BEFORE mutating (so we can report it without a
				// post-write re-read). This reads an existing, unmutated property — cheap by comparison.
				let existingName = "";
				try {
					existingName = String(person.name());
				} catch (e) {}

				// Rename.
				if (a.firstName != null) person.firstName = a.firstName;
				if (a.lastName != null) person.lastName = a.lastName;
				if (a.organization != null) person.organization = a.organization;

				const digits = (s: string) => s.replace(/[^0-9]/g, "");
				const phonesMatchLoose = (x: string, y: string) => {
					const dx = digits(x);
					const dy = digits(y);
					if (!dx || !dy) return false;
					if (dx === dy) return true;
					const shorter = dx.length <= dy.length ? dx : dy;
					const longer = dx.length <= dy.length ? dy : dx;
					return shorter.length >= 7 && longer.lastIndexOf(shorter) === longer.length - shorter.length;
				};

				// Remove matching phones (read existing values to locate them, then delete the element).
				if (a.removePhones.length > 0) {
					const ph = person.phones();
					for (let i = 0; i < ph.length; i++) {
						let val = "";
						try {
							val = String(ph[i].value());
						} catch (e) {
							continue;
						}
						if (a.removePhones.some((r) => phonesMatchLoose(r, val))) {
							try {
								app.delete(ph[i]);
							} catch (e) {}
						}
					}
				}
				// Remove matching emails (case-insensitive value compare).
				if (a.removeEmails.length > 0) {
					const targets = a.removeEmails.map((e) => e.toLowerCase());
					const em = person.emails();
					for (let i = 0; i < em.length; i++) {
						let val = "";
						try {
							val = String(em[i].value()).toLowerCase();
						} catch (e) {
							continue;
						}
						if (targets.indexOf(val) !== -1) {
							try {
								app.delete(em[i]);
							} catch (e) {}
						}
					}
				}

				// Add new phones/emails.
				for (let i = 0; i < a.addPhones.length; i++) {
					person.phones.push(app.Phone({ label: a.phoneLabel, value: a.addPhones[i] }));
				}
				for (let i = 0; i < a.addEmails.length; i++) {
					person.emails.push(app.Email({ label: a.emailLabel, value: a.addEmails[i] }));
				}

				// REQUIRED: persist the mutation.
				app.save();
				return { updated: true, name: existingName };
			},
			{
				needle: target,
				firstName: opts.firstName ?? null,
				lastName: opts.lastName ?? null,
				organization: opts.organization ?? null,
				addPhones,
				addEmails,
				removePhones,
				removeEmails,
				phoneLabel,
				emailLabel,
				max: MAX_CONTACTS,
			},
		)) as { updated: boolean; name?: string };
	} catch (error) {
		invalidateCache();
		if (isPermissionDenial(error)) throw new PermissionError(CONTACTS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}

	if (result.updated) {
		invalidateCache();
		// Prefer the new name if we renamed; otherwise the captured existing name.
		const renamed = composeName({
			firstName: opts.firstName,
			lastName: opts.lastName,
			organization: opts.organization,
		});
		return { updated: true, name: hasRename && renamed ? renamed : result.name };
	}
	return { updated: false };
}

/**
 * Delete the first contact whose display name matches `name`. Returns `{ deleted:false }` when no
 * contact matches (honest "not found", never a masked fault). `Contacts.save()` persists the deletion
 * and the cache is invalidated. A TCC denial throws PermissionError.
 */
async function deleteContact(name: string): Promise<{ deleted: boolean; name?: string }> {
	const target = name.trim();
	if (!target) {
		throw new Error("A contact name is required to identify which contact to delete.");
	}

	let result: { deleted: boolean; name?: string };
	try {
		result = (await run(
			(a: { needle: string; max: number }) => {
				const app = Application("Contacts");

				let person: any = null;
				try {
					const hits = app.people.whose({ name: { _contains: a.needle } })();
					if (hits && hits.length > 0) person = hits[0];
				} catch (e) {
					person = null;
				}
				if (!person) {
					const people = app.people();
					const lower = a.needle.toLowerCase();
					const count = Math.min(people.length, a.max);
					for (let i = 0; i < count; i++) {
						try {
							if (String(people[i].name()).toLowerCase().indexOf(lower) !== -1) {
								person = people[i];
								break;
							}
						} catch (e2) {}
					}
				}
				if (!person) return { deleted: false };

				let existingName = "";
				try {
					existingName = String(person.name());
				} catch (e) {}

				app.delete(person);
				// REQUIRED: persist the deletion.
				app.save();
				return { deleted: true, name: existingName };
			},
			{ needle: target, max: MAX_CONTACTS },
		)) as { deleted: boolean; name?: string };
	} catch (error) {
		invalidateCache();
		if (isPermissionDenial(error)) throw new PermissionError(CONTACTS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}

	if (result.deleted) invalidateCache();
	return result;
}

export default {
	getAllNumbers,
	findNumber,
	findHandles,
	findContactByPhone,
	searchContacts,
	createContact,
	updateContact,
	deleteContact,
	requestContactsAccess,
};
