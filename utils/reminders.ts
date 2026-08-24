import { run } from "@jxa/run";
import { ToolFailure, isPermissionDenial, throwAppleFailure } from "./native";
import { rawBody } from "./failure";

// We drive the Reminders app through JXA (@jxa/run) rather than by interpolating user input into an
// AppleScript source string. JXA returns REAL JS objects/arrays (so there is no string-parsing bug),
// and every user-controlled value (search text, names, notes, dates, list ids) is passed as a
// serialized *argument* to the script — never spliced into source — so there is no script injection.
// JXA still rides Apple Events, so the same Automation (kTCCServiceAppleEvents) permission applies; a
// denial surfaces as a thrown error which we convert to a typed ToolFailure (denied is not empty).

// Maximum reminders to materialize in one scan (guards against pathological stores).
const MAX_REMINDERS = 1000;
// Maximum lists to enumerate.
const MAX_LISTS = 1000;

// The one sentence each outcome puts on line 1 of the envelope. It says WHAT DID NOT HAPPEN and
// stops: the envelope spec forbids inventing a remedy, because this server knows what macOS refused
// and knows nothing about what the person should do about it.
const REMINDERS_SUMMARIES = {
	denied: "Could not reach your reminders: macOS denied access to Reminders.",
	notRunning: "Could not reach your reminders: the Reminders app could not be reached.",
	timedOut: "Could not reach your reminders: Reminders did not answer in time.",
	failed: "Could not reach your reminders.",
};
const REMINDERS_CREATE_SUMMARIES = {
	denied: "Could not create the reminder: macOS denied access to Reminders.",
	notRunning: "Could not create the reminder: the Reminders app could not be reached.",
	timedOut: "Could not create the reminder: Reminders did not answer in time.",
	failed: "Could not create the reminder.",
};
const REMINDERS_OPEN_SUMMARIES = {
	denied: "Could not open Reminders: macOS denied access to Reminders.",
	notRunning: "Could not open Reminders: the Reminders app could not be reached.",
	timedOut: "Could not open Reminders: Reminders did not answer in time.",
	failed: "Could not open Reminders.",
};

/** A single reminder, in the exact shape the dispatcher expects. */
interface Reminder {
	name: string;
	id?: string;
	body?: string;
	completed?: boolean;
	dueDate?: string | null;
	listName?: string;
}

/** A reminder list, keyed for the dispatcher by id + display name. */
interface ReminderList {
	id: string;
	name: string;
}

/**
 * Probe Reminders access. Returns the access state; converts a TCC denial into an actionable message
 * but never masks a non-permission failure (that is re-thrown).
 */
async function requestRemindersAccess(): Promise<{
	hasAccess: boolean;
	message: string;
}> {
	try {
		await run(() => {
			// Touching the app's name is enough to trigger the Automation prompt / denial.
			return Application("Reminders").name();
		});
		return { hasAccess: true, message: "Reminders access is granted." };
	} catch (error) {
		if (isPermissionDenial(error)) {
			return { hasAccess: false, message: REMINDERS_SUMMARIES.denied };
		}
		// Not a denial, so this probe cannot answer the question it was asked. Surface it rather than
		// reporting "no access" for something that was never about access.
		throwAppleFailure(error, REMINDERS_SUMMARIES);
	}
}

/**
 * The single reusable scan seam: enumerate reminders across all lists, or a single list by id, and
 * optionally filter by a case-insensitive needle over name + body. Returns real JS objects (no string
 * parsing). A TCC denial throws a ToolFailure; an authorized-but-empty result returns an empty
 * `items` array; a missing list id is reported via `listNotFound` so callers can fail honestly.
 */
async function scan(opts: {
	search?: string | null;
	listId?: string | null;
}): Promise<{ items: Reminder[]; listNotFound: boolean }> {
	let scanned: {
		items: Reminder[];
		listNotFound: boolean;
		listCount: number;
		skippedLists: number;
		firstError: string;
	};
	try {
		const result = await run(
			(args: {
				search: string | null;
				listId: string | null;
				max: number;
				maxLists: number;
			}) => {
				const { search, listId, max, maxLists } = args;
				const R = Application("Reminders");
				const needle = search ? String(search).toLowerCase() : null;

				// Read one reminder into a plain object via JXA method calls, guarding each property so a
				// single unreadable field never aborts the item (and one bad item never aborts the scan).
				const read = (r: any, listName: string): Reminder => {
					const name = String(r.name());
					let body = "";
					try {
						const b = r.body();
						body = b ? String(b) : "";
					} catch (e) {}
					let completed = false;
					try {
						completed = !!r.completed();
					} catch (e) {}
					let dueDate: string | null = null;
					try {
						const d = r.dueDate();
						if (d) dueDate = d.toISOString();
					} catch (e) {}
					let id: string | undefined;
					try {
						id = String(r.id());
					} catch (e) {}
					return { name, id, body, completed, dueDate, listName };
				};

				// Resolve which lists to walk.
				let lists: any[];
				let skippedLists = 0;
				let firstError = "";
				if (listId) {
					const all = R.lists();
					let target: any = null;
					for (let i = 0; i < all.length; i++) {
						try {
							if (String(all[i].id()) === String(listId)) {
								target = all[i];
								break;
							}
						} catch (e) {}
					}
					if (!target)
						return {
							items: [],
							listNotFound: true,
							listCount: 0,
							skippedLists: 0,
							firstError: "",
						};
					lists = [target];
				} else {
					lists = R.lists();
				}

				const items: Reminder[] = [];
				const listCap = Math.min(lists.length, maxLists);
				for (let li = 0; li < listCap; li++) {
					let listName: string;
					let rems: any[];
					try {
						const list = lists[li];
						listName = String(list.name());
						rems = list.reminders();
					} catch (e) {
						// Skip an unreadable list; do not abort the whole scan. Counted, because a scan
						// where EVERY list failed is a broken read, not an empty Reminders store.
						skippedLists++;
						if (!firstError) firstError = String(e);
						continue;
					}
					for (let ri = 0; ri < rems.length; ri++) {
						if (items.length >= max)
							return {
								items,
								listNotFound: false,
								listCount: listCap,
								skippedLists,
								firstError,
							};
						try {
							const rec = read(rems[ri], listName);
							if (needle) {
								const hay = (rec.name + " " + (rec.body || "")).toLowerCase();
								if (hay.indexOf(needle) === -1) continue;
							}
							items.push(rec);
						} catch (e) {
							// Skip an individual unreadable reminder.
						}
					}
				}
				return {
					items,
					listNotFound: false,
					listCount: listCap,
					skippedLists,
					firstError,
				};
			},
			{
				search: opts.search ?? null,
				listId: opts.listId ?? null,
				max: MAX_REMINDERS,
				maxLists: MAX_LISTS,
			},
		);
		scanned = result as {
			items: Reminder[];
			listNotFound: boolean;
			listCount: number;
			skippedLists: number;
			firstError: string;
		};
	} catch (error) {
		throwAppleFailure(error, REMINDERS_SUMMARIES);
	}

	// Every list threw. "[]" here would report a broken read as a fact about the user's reminders,
	// which is the swallowed failure the envelope spec exists to stop.
	if (scanned.listCount > 0 && scanned.skippedLists === scanned.listCount) {
		throw new ToolFailure(
			"applescript_error",
			`Could not read your reminders: all ${scanned.listCount} lists failed to read.`,
			rawBody(scanned.firstError),
		);
	}
	return { items: scanned.items, listNotFound: scanned.listNotFound };
}

/** All reminder lists (id + name). A denial throws; an empty store returns []. */
async function getAllLists(): Promise<ReminderList[]> {
	let scanned: {
		items: ReminderList[];
		attempted: number;
		skipped: number;
		firstError: string;
	};
	try {
		scanned = (await run((max: number) => {
			const R = Application("Reminders");
			const all = R.lists();
			const out: { id: string; name: string }[] = [];
			const count = Math.min(all.length, max);
			let skipped = 0;
			let firstError = "";
			for (let i = 0; i < count; i++) {
				try {
					out.push({ id: String(all[i].id()), name: String(all[i].name()) });
				} catch (e) {
					// Skip an unreadable list.
					skipped++;
					if (!firstError) firstError = String(e);
				}
			}
			return { items: out, attempted: count, skipped, firstError };
		}, MAX_LISTS)) as typeof scanned;
	} catch (error) {
		throwAppleFailure(error, REMINDERS_SUMMARIES);
	}

	if (scanned.attempted > 0 && scanned.skipped === scanned.attempted) {
		throw new ToolFailure(
			"applescript_error",
			`Could not list your reminder lists: all ${scanned.attempted} lists failed to read.`,
			rawBody(scanned.firstError),
		);
	}
	return scanned.items;
}

/** Every reminder across every list (bounded by MAX_REMINDERS). Denial throws; empty store returns []. */
async function getAllReminders(): Promise<Reminder[]> {
	return (await scan({})).items;
}

/** Reminders whose name or body contains `searchText` (case-insensitive). Denial throws. */
async function searchReminders(searchText: string): Promise<Reminder[]> {
	if (!searchText || searchText.trim() === "") return [];
	return (await scan({ search: searchText })).items;
}

/**
 * Bring the Reminders app forward and report the best name match for `searchText`. Returns the
 * matched reminder, or throws when nothing matches. A denial throws too.
 */
async function openReminder(searchText: string): Promise<{
	message: string;
	reminder: { name: string };
}> {
	const matches = await searchReminders(searchText); // throws ToolFailure on denial
	if (matches.length === 0) {
		// Nothing to open is a FAILURE of what was asked, not a successful open of nothing.
		throw new ToolFailure(
			"not_found",
			`Could not open a reminder: nothing matches "${searchText}".`,
		);
	}

	try {
		await run(() => {
			Application("Reminders").activate();
			return true;
		});
	} catch (error) {
		throwAppleFailure(error, REMINDERS_OPEN_SUMMARIES);
	}

	return {
		message: `Opened Reminders. Found reminder: ${matches[0].name}`,
		reminder: { name: matches[0].name },
	};
}

/**
 * Create a reminder. When `listName` is given it is found (or created if absent); otherwise the
 * account's default list is used. `notes` and `dueDate` (ISO string) are optional. Returns the
 * created reminder read back from the store (its real name, id, list, etc.). Denial throws.
 */
async function createReminder(
	name: string,
	listName?: string,
	notes?: string,
	dueDate?: string,
): Promise<Reminder> {
	if (!name || name.trim() === "") {
		throw new ToolFailure(
			"bad_request",
			"Could not create the reminder: no name was given.",
		);
	}

	try {
		const created = (await run(
			(args: {
				name: string;
				listName: string | null;
				notes: string | null;
				dueDate: string | null;
			}) => {
				const R = Application("Reminders");
				// Bring Reminders up first: a detached MCP subprocess can't auto-launch it on write the way
				// Calendar auto-launches on createEvent, so pushing to a closed Reminders throws a connection
				// error. activate() launches it (matching how the other apps here come up) before we script it.
				R.activate();

				// Resolve the destination list: find by name, create it if missing, else the default list.
				let list: any;
				if (args.listName) {
					const all = R.lists();
					for (let i = 0; i < all.length; i++) {
						try {
							if (String(all[i].name()) === args.listName) {
								list = all[i];
								break;
							}
						} catch (e) {}
					}
					if (!list) {
						list = R.List({ name: args.listName });
						R.lists.push(list);
					}
				} else {
					list = R.defaultList();
				}

				const props: { name: string; body?: string; dueDate?: Date } = {
					name: args.name,
				};
				if (args.notes) props.body = args.notes;
				if (args.dueDate) props.dueDate = new Date(args.dueDate);

				const rem = R.Reminder(props);
				list.reminders.push(rem);

				// Read the created reminder back, guarding each property.
				let id: string | undefined;
				try {
					id = String(rem.id());
				} catch (e) {}
				let body = "";
				try {
					const b = rem.body();
					body = b ? String(b) : "";
				} catch (e) {}
				let completed = false;
				try {
					completed = !!rem.completed();
				} catch (e) {}
				let due: string | null = null;
				try {
					const d = rem.dueDate();
					if (d) due = d.toISOString();
				} catch (e) {}

				return {
					name: String(rem.name()),
					id,
					body,
					completed,
					dueDate: due,
					listName: String(list.name()),
				} as Reminder;
			},
			{
				name,
				listName: listName ?? null,
				notes: notes ?? null,
				dueDate: dueDate ?? null,
			},
		)) as Reminder;
		return created;
	} catch (error) {
		throwAppleFailure(error, REMINDERS_CREATE_SUMMARIES);
	}
}

/**
 * Reminders in the list identified by `listId`. `props` is accepted for dispatcher compatibility; the
 * full standard reminder shape is always returned. A denial throws; an unknown list id is a real
 * fault (bad input) and throws rather than masquerading as an empty list.
 */
async function getRemindersFromListById(
	listId: string,
	props?: string[],
): Promise<Reminder[]> {
	if (!listId || listId.trim() === "") {
		throw new ToolFailure(
			"bad_request",
			"Could not read the reminder list: no list id was given.",
		);
	}
	const result = await scan({ listId }); // throws ToolFailure on denial
	if (result.listNotFound) {
		throw new ToolFailure(
			"not_found",
			`Could not read the reminder list: no list has the id "${listId}".`,
		);
	}
	return result.items;
}

export default {
	getAllLists,
	getAllReminders,
	searchReminders,
	createReminder,
	openReminder,
	getRemindersFromListById,
	requestRemindersAccess,
};
