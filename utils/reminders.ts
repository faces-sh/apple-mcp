import { run } from "@jxa/run";
import { PermissionError, isPermissionDenial } from "./native";
import { runEventKit, type Recurrence } from "./eventkit";

// All reminder data access goes through the native EventKit helper (see utils/eventkit.ts for
// why: speed, full-store coverage, recurrence). The only Apple Events call left in this module is
// activating the Reminders app for `open` — EventKit reads databases, it cannot bring an app
// forward.

/** A single reminder, in the exact shape the caller expects. */
interface Reminder {
	name: string;
	id?: string;
	body?: string;
	completed?: boolean;
	dueDate?: string | null;
	listName?: string;
	/** Human-readable repeat rule when the reminder recurs, e.g. "every day". */
	recurrence?: string;
}

/** A reminder list, keyed for the caller by id + display name. */
interface ReminderList {
	id: string;
	name: string;
}

/** Probe Reminders access. A denial becomes an actionable message; any other failure re-throws. */
async function requestRemindersAccess(): Promise<{
	hasAccess: boolean;
	message: string;
}> {
	try {
		await runEventKit<ReminderList[]>("reminders", "lists");
		return { hasAccess: true, message: "Reminders access is granted." };
	} catch (error) {
		if (error instanceof PermissionError) {
			return { hasAccess: false, message: error.message };
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/** All reminder lists (id + name). A denial throws; an empty store returns []. */
async function getAllLists(): Promise<ReminderList[]> {
	return runEventKit<ReminderList[]>("reminders", "lists");
}

/** Every reminder across every list (bounded by the helper). Denial throws; empty store returns []. */
async function getAllReminders(): Promise<Reminder[]> {
	return runEventKit<Reminder[]>("reminders", "list");
}

/** Reminders whose name or body contains `searchText` (case-insensitive), across ALL lists. */
async function searchReminders(searchText: string): Promise<Reminder[]> {
	if (!searchText || searchText.trim() === "") return [];
	return runEventKit<Reminder[]>("reminders", "search", { text: searchText.trim() });
}

/**
 * The first reminder whose name OR body contains `name` (case-insensitive), or null when nothing
 * matches. A denial throws PermissionError; an authorized-but-no-match returns null.
 */
async function getReminderByName(name: string): Promise<Reminder | null> {
	if (!name || name.trim() === "") return null;
	const matches = await searchReminders(name);
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
		if (isPermissionDenial(error)) {
			throw new PermissionError(
				"Automation access to Reminders is not granted, so the app cannot be brought forward.",
			);
		}
		throw error instanceof Error ? error : new Error(String(error));
	}

	return {
		success: true,
		message: `Opened Reminders. Found reminder: ${matches[0].name}`,
		reminder: { name: matches[0].name },
	};
}

/** Parse an ISO due date to epoch ms, throwing precisely on garbage rather than silently dropping. */
function dueMs(dueDate: string | undefined): number | undefined {
	if (dueDate === undefined) return undefined;
	const ms = new Date(dueDate).getTime();
	if (Number.isNaN(ms)) {
		throw new Error(`Invalid dueDate "${dueDate}". Use ISO-8601 (e.g. 2026-07-08T08:30:00).`);
	}
	return ms;
}

/**
 * Create a reminder. When `listName` is given it is found (or created if absent); otherwise the
 * default list is used. `notes`, `dueDate` (ISO string), and `recurrence` are optional; a
 * recurrence without a due date is an honest error (a repeat needs an anchor). Denial throws.
 */
async function createReminder(
	name: string,
	listName?: string,
	notes?: string,
	dueDate?: string,
	recurrence?: Recurrence,
): Promise<Reminder> {
	if (!name || name.trim() === "") {
		throw new Error("Reminder name cannot be empty.");
	}
	return runEventKit<Reminder>("reminders", "create", {
		name: name.trim(),
		listName,
		notes,
		dueMs: dueMs(dueDate),
		recurrence,
	});
}

/**
 * Update the first reminder whose name contains `searchText` IN PLACE — change any of name /
 * notes / dueDate / completed / recurrence without creating a duplicate. Returns whether one was
 * found and updated. A denial throws PermissionError.
 */
async function updateReminder(opts: {
	searchText: string;
	name?: string;
	notes?: string;
	dueDate?: string;
	completed?: boolean;
	recurrence?: Recurrence;
}): Promise<{ updated: boolean; name?: string; recurrence?: string }> {
	if (!opts.searchText || opts.searchText.trim() === "") {
		throw new Error("searchText is required to find the reminder to update.");
	}
	const result = await runEventKit<{ updated: boolean; reminder?: Reminder }>(
		"reminders",
		"update",
		{
			search: opts.searchText.trim(),
			name: opts.name,
			notes: opts.notes,
			dueMs: dueMs(opts.dueDate),
			completed: opts.completed,
			recurrence: opts.recurrence,
		},
	);
	return {
		updated: result.updated,
		name: result.reminder?.name,
		recurrence: result.reminder?.recurrence,
	};
}

/**
 * Mark the first reminder matching `searchText` done (`completed=true`) or not-done
 * (`completed=false`). Thin, intent-revealing wrapper over `updateReminder`. Denial throws.
 */
async function setReminderCompleted(
	searchText: string,
	completed: boolean,
): Promise<{ updated: boolean; name?: string }> {
	return updateReminder({ searchText, completed });
}

/**
 * Delete the first reminder whose name contains `searchText` (case-insensitive). Returns whether a
 * reminder was found and removed; an authorized-but-no-match returns `{deleted:false}`. Denial throws.
 */
async function deleteReminder(
	searchText: string,
): Promise<{ deleted: boolean; name?: string }> {
	if (!searchText || searchText.trim() === "") {
		throw new Error("searchText is required to find the reminder to delete.");
	}
	return runEventKit<{ deleted: boolean; name?: string }>("reminders", "delete", {
		search: searchText.trim(),
	});
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
	return runEventKit<Reminder[]>("reminders", "list", { listId: listId.trim() });
}

export default {
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
