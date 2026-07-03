import { run } from "@jxa/run";
import { PermissionError, isPermissionDenial } from "./native";

// We drive the Reminders app through JXA (@jxa/run) rather than by interpolating user input into an
// AppleScript source string. JXA returns REAL JS objects/arrays (so there is no string-parsing bug),
// and every user-controlled value (search text, names, notes, dates, list ids) is passed as a
// serialized *argument* to the script — never spliced into source — so there is no script injection.
// JXA still rides Apple Events, so the same Automation (kTCCServiceAppleEvents) permission applies; a
// denial surfaces as a thrown error which we convert to a typed PermissionError (denied ≠ empty).

// Maximum reminders to materialize in one scan (guards against pathological stores).
const MAX_REMINDERS = 1000;
// Maximum lists to enumerate.
const MAX_LISTS = 1000;

const REMINDERS_DENIED =
	"Reminders access is not granted. In System Settings ▸ Privacy & Security, grant Faced access " +
	"to Reminders (and Automation ▸ Reminders), then try again.";

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
			return { hasAccess: false, message: REMINDERS_DENIED };
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * The single reusable scan seam: enumerate reminders across all lists, or a single list by id, and
 * optionally filter by a case-insensitive needle over name + body. Returns real JS objects (no string
 * parsing). A TCC denial throws PermissionError; an authorized-but-empty result returns an empty
 * `items` array; a missing list id is reported via `listNotFound` so callers can fail honestly.
 */
async function scan(opts: {
	search?: string | null;
	listId?: string | null;
}): Promise<{ items: Reminder[]; listNotFound: boolean }> {
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
					if (!target) return { items: [], listNotFound: true };
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
						// Skip an unreadable list; do not abort the whole scan.
						continue;
					}
					for (let ri = 0; ri < rems.length; ri++) {
						if (items.length >= max) return { items, listNotFound: false };
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
				return { items, listNotFound: false };
			},
			{
				search: opts.search ?? null,
				listId: opts.listId ?? null,
				max: MAX_REMINDERS,
				maxLists: MAX_LISTS,
			},
		);
		return result as { items: Reminder[]; listNotFound: boolean };
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(REMINDERS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/** All reminder lists (id + name). A denial throws; an empty store returns []. */
async function getAllLists(): Promise<ReminderList[]> {
	try {
		const lists = (await run((max: number) => {
			const R = Application("Reminders");
			const all = R.lists();
			const out: { id: string; name: string }[] = [];
			const count = Math.min(all.length, max);
			for (let i = 0; i < count; i++) {
				try {
					out.push({ id: String(all[i].id()), name: String(all[i].name()) });
				} catch (e) {
					// Skip an unreadable list.
				}
			}
			return out;
		}, MAX_LISTS)) as ReminderList[];
		return lists;
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(REMINDERS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}
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
 * Bring the Reminders app forward and report the best name match for `searchText`. Returns success
 * with the matched reminder, or a clear failure when nothing matches. A denial throws PermissionError.
 */
async function openReminder(searchText: string): Promise<{
	success: boolean;
	message: string;
	reminder?: { name: string };
}> {
	const matches = await searchReminders(searchText); // throws PermissionError on denial
	if (matches.length === 0) {
		return { success: false, message: "No matching reminders found." };
	}

	try {
		await run(() => {
			Application("Reminders").activate();
			return true;
		});
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(REMINDERS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}

	return {
		success: true,
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
		throw new Error("Reminder name cannot be empty.");
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
		if (isPermissionDenial(error)) throw new PermissionError(REMINDERS_DENIED);
		throw error instanceof Error
			? error
			: new Error(`Failed to create reminder: ${String(error)}`);
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
		throw new Error("A reminder list id is required.");
	}
	const result = await scan({ listId }); // throws PermissionError on denial
	if (result.listNotFound) {
		throw new Error(`No reminder list found with id "${listId}".`);
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
