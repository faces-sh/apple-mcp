import { run } from "@jxa/run";
import { APP_NAME, PermissionError, isPermissionDenial } from "./native";

// We drive the Reminders app through JXA (@jxa/run) rather than by interpolating user input into an
// AppleScript source string. JXA returns REAL JS objects/arrays (so there is no string-parsing bug),
// and every user-controlled value (search text, names, notes, dates, list ids) is passed as a
// serialized *argument* to the script — never spliced into source — so there is no script injection.
// JXA still rides Apple Events, so the same Automation (kTCCServiceAppleEvents) permission applies; a
// denial surfaces as a thrown error which we convert to a typed PermissionError (denied ≠ empty).

// Maximum reminders to materialize in one scan (guards against pathological stores).
const MAX_REMINDERS = 1000;

// ── Native EventKit helper ────────────────────────────────────────────────────────────────────────
// Scripting the Reminders app costs ~5 seconds PER LIST per query; on a 50-list store every search
// blew the upstream timeout and read as "no matches". The compiled helper (dist/reminders-helper)
// queries the EventKit store directly: one indexed fetch over every list, sub-second. Reads go
// native-first; the JXA paths remain as the fallback when the helper is missing or denied.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";

const HELPER_PATH = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "reminders-helper");

function runHelper(args: string[]): Promise<Reminder[]> {
	return new Promise((resolve, reject) => {
		execFile(HELPER_PATH, args, { timeout: 40_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
			if (err && !stdout) {
				reject(new Error(`reminders-helper failed: ${err.message}`));
				return;
			}
			try {
				const parsed = JSON.parse(stdout);
				if (parsed && typeof parsed === "object" && "error" in parsed) {
					reject(new Error(String((parsed as { error: unknown }).error)));
					return;
				}
				resolve(parsed as Reminder[]);
			} catch (e) {
				reject(new Error(`reminders-helper returned unparseable output: ${String(e)}`));
			}
		});
	});
}
// Maximum lists to enumerate.
const MAX_LISTS = 1000;

const REMINDERS_DENIED =
	`Reminders access is not granted. In System Settings ▸ Privacy & Security, grant ${APP_NAME} access ` +
	"to Reminders (and Automation ▸ Reminders), then try again.";

/** A single reminder, in the exact shape the caller expects. */
interface Reminder {
	name: string;
	id?: string;
	body?: string;
	completed?: boolean;
	dueDate?: string | null;
	listName?: string;
}

/** A reminder list, keyed for the caller by id + display name. */
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
}): Promise<{ items: Reminder[]; listNotFound: boolean; truncated?: boolean; scannedLists?: number; totalLists?: number }> {
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
				// Reminders is SLOW: even a whose() query costs ~5s per list, and a 50-list iCloud
				// store blows any upstream timeout, which then reads as "no matches" for reminders
				// that exist. So a search is default-list-first (where creations land), returns on
				// first hits, and sweeps the remaining lists under a hard time budget, reporting the
				// coverage HONESTLY when it stops early: a silent cap is a lie shaped like an answer.
				const readMatches = (list: any, listName: string) => {
					let rems: any[];
					try {
						rems = needle
							? list.reminders.whose({ name: { _contains: search } })()
							: list.reminders();
					} catch (e) {
						try {
							rems = list.reminders();
						} catch (e2) {
							return;
						}
					}
					for (let ri = 0; ri < rems.length; ri++) {
						if (items.length >= max) return;
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
				};

				let defaultListName: string | null = null;
				if (needle && !listId) {
					try {
						const dl = R.defaultList();
						defaultListName = String(dl.name());
						readMatches(dl, defaultListName);
						if (items.length > 0) {
							return { items, listNotFound: false, truncated: false,
								scannedLists: 1, totalLists: lists.length };
						}
					} catch (e) {
						// No default list readable; sweep below covers everything.
					}
				}

				const budgetMs = needle ? 25000 : 60000;
				const t0 = Date.now();
				let scanned = defaultListName ? 1 : 0;
				let truncated = false;
				const listCap = Math.min(lists.length, maxLists);
				for (let li = 0; li < listCap; li++) {
					if (Date.now() - t0 > budgetMs) { truncated = true; break; }
					let listName: string;
					let list: any;
					try {
						list = lists[li];
						listName = String(list.name());
					} catch (e) {
						continue;
					}
					if (defaultListName && listName === defaultListName) continue; // already searched
					scanned++;
					readMatches(list, listName);
					if (items.length >= max) break;
				}
				return { items, listNotFound: false, truncated,
					scannedLists: scanned, totalLists: lists.length };
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
	try {
		return await runHelper(["search", searchText.trim()]);
	} catch (_e) {
		return (await scan({ search: searchText })).items;
	}
}

/**
 * Search with coverage: the items PLUS how much of the store was actually searched, so the tool
 * layer can say "searched 12 of 50 lists" instead of passing a partial sweep off as a full one.
 */
async function searchRemindersDetailed(searchText: string): Promise<{
	items: Reminder[];
	truncated: boolean;
	scannedLists: number;
	totalLists: number;
}> {
	if (!searchText || searchText.trim() === "") {
		return { items: [], truncated: false, scannedLists: 0, totalLists: 0 };
	}
	try {
		const items = await runHelper(["search", searchText.trim()]);
		return { items, truncated: false, scannedLists: -1, totalLists: -1 }; // native: full coverage
	} catch (_e) {
		// Helper missing or denied → the budgeted JXA sweep, with its honest partial coverage.
	}
	const r = await scan({ search: searchText });
	return {
		items: r.items,
		truncated: r.truncated ?? false,
		scannedLists: r.scannedLists ?? 0,
		totalLists: r.totalLists ?? 0,
	};
}

/**
 * The first reminder whose name OR body contains `name` (case-insensitive), or null when nothing
 * matches. A convenience read for "get me that one reminder" callers; a denial throws PermissionError,
 * and an authorized-but-no-match returns null (never a masked error).
 */
async function getReminderByName(name: string): Promise<Reminder | null> {
	if (!name || name.trim() === "") return null;
	const matches = await searchReminders(name); // throws PermissionError on denial
	return matches.length > 0 ? matches[0] : null;
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
 * values we SET (name, list, notes, dueDate) — never a re-read of the new item, because every property
 * read on a just-created reminder forces a store/iCloud round-trip that blocks for seconds. Denial throws.
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

				// Resolve the destination list (by name, creating it if missing, else the default list).
				let list: any;
				let resolvedListName: string;
				if (args.listName) {
					try {
						list = R.lists.byName(args.listName);
						resolvedListName = String(list.name()); // forces resolution; throws if absent
					} catch (e) {
						list = R.List({ name: args.listName });
						R.lists.push(list);
						resolvedListName = args.listName;
					}
				} else {
					list = R.defaultList();
					resolvedListName = String(list.name());
				}

				const props: { name: string; body?: string; dueDate?: Date } = {
					name: args.name,
				};
				if (args.notes) props.body = args.notes;
				if (args.dueDate) props.dueDate = new Date(args.dueDate);

				const rem = R.Reminder(props);
				list.reminders.push(rem);

				// Do NOT read the new reminder back: every property read on a just-created reminder forces
				// a store/iCloud round-trip that blocks for SECONDS each. Return the values we set instead.
				return { listName: resolvedListName };
			},
			{
				name,
				listName: listName ?? null,
				notes: notes ?? null,
				dueDate: dueDate ?? null,
			},
		)) as { listName: string };

		return {
			name,
			body: notes ?? "",
			completed: false,
			dueDate: dueDate ?? null,
			listName: created.listName,
		};
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(REMINDERS_DENIED);
		throw error instanceof Error
			? error
			: new Error(`Failed to create reminder: ${String(error)}`);
	}
}

/**
 * Reminders in the list identified by `listId`. `props` is accepted for caller compatibility; the
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

/**
 * Update the first reminder whose name contains `searchText` IN PLACE — change any of name / notes /
 * dueDate / completed without creating a duplicate. Returns whether one was found and updated. A
 * permission denial throws PermissionError.
 */
async function updateReminder(opts: {
	searchText: string;
	name?: string;
	notes?: string;
	dueDate?: string;
	completed?: boolean;
}): Promise<{ updated: boolean; name?: string }> {
	if (!opts.searchText || opts.searchText.trim() === "") {
		throw new Error("searchText is required to find the reminder to update.");
	}
	try {
		return (await run(
			(a: {
				searchText: string;
				name: string | null;
				notes: string | null;
				dueDate: string | null;
				completed: boolean | null;
			}) => {
				const R = Application("Reminders");
				const needle = a.searchText.toLowerCase();
				const lists = R.lists();
				let target: any = null;
				let targetName = "";
				for (let li = 0; li < lists.length && !target; li++) {
					let matches: any[] = [];
					try {
						// Let Reminders filter by name (one round-trip per list, not per reminder).
						matches = lists[li].reminders
							.whose({ name: { _contains: a.searchText } })();
					} catch (e) {
						// Fallback: scan this list's reminders by name.
						try {
							const rems = lists[li].reminders();
							for (let ri = 0; ri < rems.length; ri++) {
								try {
									if (String(rems[ri].name()).toLowerCase().indexOf(needle) !== -1) {
										matches = [rems[ri]];
										break;
									}
								} catch (e2) {}
							}
						} catch (e2) {}
					}
					if (matches && matches.length > 0) {
						target = matches[0];
						try {
							targetName = String(target.name());
						} catch (e) {}
					}
				}
				if (!target) return { updated: false };

				// Mutate in place. Do NOT read the reminder back afterwards (a post-write read forces an
				// expensive iCloud round-trip); return the name we captured / the new one we set.
				if (a.name != null) target.name = a.name;
				if (a.notes != null) target.body = a.notes;
				if (a.dueDate != null) target.dueDate = new Date(a.dueDate);
				if (a.completed != null) target.completed = a.completed;

				return { updated: true, name: a.name != null ? a.name : targetName };
			},
			{
				searchText: opts.searchText,
				name: opts.name ?? null,
				notes: opts.notes ?? null,
				dueDate: opts.dueDate ?? null,
				completed: opts.completed ?? null,
			},
		)) as { updated: boolean; name?: string };
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(REMINDERS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * Mark the first reminder matching `searchText` done (`completed=true`) or not-done (`completed=false`).
 * Thin, intent-revealing wrapper over `updateReminder` — same find-then-mutate-in-place semantics, no
 * read-back, no duplicate — so "complete"/"uncomplete" is a first-class reachable operation. Denial throws.
 */
async function setReminderCompleted(
	searchText: string,
	completed: boolean,
): Promise<{ updated: boolean; name?: string }> {
	return updateReminder({ searchText, completed });
}

/**
 * Delete the first reminder whose name contains `searchText` (case-insensitive). Finds the target with
 * the same server-side `whose` filter as update (one round-trip per list, early-exit on first match),
 * then calls `Application('Reminders').delete(target)`. The delete is the whole operation — we do NOT
 * read the item back (a post-mutation read forces an expensive iCloud round-trip). Returns whether a
 * reminder was found and removed; an authorized-but-no-match returns `{ deleted: false }`. Denial throws.
 */
async function deleteReminder(
	searchText: string,
): Promise<{ deleted: boolean; name?: string }> {
	if (!searchText || searchText.trim() === "") {
		throw new Error("searchText is required to find the reminder to delete.");
	}
	try {
		return (await run(
			(a: { searchText: string }) => {
				const R = Application("Reminders");
				const needle = a.searchText.toLowerCase();
				const lists = R.lists();
				let target: any = null;
				let targetName = "";
				for (let li = 0; li < lists.length && !target; li++) {
					let matches: any[] = [];
					try {
						// Let Reminders filter by name (one round-trip per list, not per reminder).
						matches = lists[li].reminders
							.whose({ name: { _contains: a.searchText } })();
					} catch (e) {
						// Fallback: scan this list's reminders by name, early-exit on first hit.
						try {
							const rems = lists[li].reminders();
							for (let ri = 0; ri < rems.length; ri++) {
								try {
									if (String(rems[ri].name()).toLowerCase().indexOf(needle) !== -1) {
										matches = [rems[ri]];
										break;
									}
								} catch (e2) {}
							}
						} catch (e2) {}
					}
					if (matches && matches.length > 0) {
						target = matches[0];
						// Capture the name BEFORE deletion (the reference is invalid afterwards). This single
						// read is on a still-live item, not a post-mutation read-back.
						try {
							targetName = String(target.name());
						} catch (e) {}
					}
				}
				if (!target) return { deleted: false };

				// Remove it. delete() is the entire operation — no read-back of the (now gone) item.
				R.delete(target);
				return { deleted: true, name: targetName };
			},
			{ searchText },
		)) as { deleted: boolean; name?: string };
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(REMINDERS_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}
}

export default {
	searchRemindersDetailed,
	getAllLists,
	getAllReminders,
	searchReminders,
	getReminderByName,
	createReminder,
	updateReminder,
	setReminderCompleted,
	deleteReminder,
	openReminder,
	getRemindersFromListById,
	requestRemindersAccess,
};