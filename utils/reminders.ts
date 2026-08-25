import { run } from "@jxa/run";
import { ToolFailure, grantSentence, throwAppleFailure } from "./native";
import { ask as askMaestro } from "./maestro";

// REMINDERS DOES NOT GO THROUGH THE REMINDERS APP, and it is the only one here that does not.
//
// Every other app in this server is scripted over Apple Events, which is fine for them and was unusable
// for Reminders. The numbers were not marginal:
//
//     one property read on ONE reminder     ~35s   (name() 36.4s, again warm 35.0s, completed() 33.9s)
//     `reminders list` over stdio           no answer in 420s
//     the bulk trick that fixes every other app, 5 properties x 1,217 reminders:   286s, and unstable
//
// So list and search did not work. Not slowly: they never returned, which is worse, because a hang looks
// like thinking. The usual repair (ask the app to do the work in one Apple Event instead of thousands)
// does not reach it, because the cost is IN the per-element read.
//
// Maestro reads the same store through EventKit, in its own process, with no Apple Events at all. Same
// machine, same data, measured on the same 1,217-reminder store:
//
//     lists      155s   ->  0.05s
//     everything  never ->  0.15s
//
// It has to be Maestro that does it rather than this process, because a Reminders grant attaches to a
// process and Maestro is the process that holds one. A helper would key its own grant, which is how you
// get a correctly-granted app whose reminders still fail.
//
// The tools, their names and their arguments are UNCHANGED. Only what happens underneath moved.

// The one sentence each outcome puts on line 1 of the envelope. It says WHAT DID NOT HAPPEN, and for a
// denial it also NAMES the permission that is missing and where to grant it.
//
// The permission NAMED here changed with the path. Reminders no longer needs Automation consent for the
// Reminders app; it needs Reminders access, which is a different switch in a different pane, so pointing
// at the old one would send somebody to flip a control that cannot fix it.
export const REMINDERS_SUMMARIES = {
	denied:
		"Could not reach your reminders: macOS denied access to Reminders. " +
		grantSentence("Reminders"),
	notRunning: "Could not reach your reminders: Maestro could not be reached.",
	timedOut: "Could not reach your reminders: Maestro did not answer in time.",
	failed: "Could not reach your reminders.",
};
export const REMINDERS_CREATE_SUMMARIES = {
	denied:
		"Could not create the reminder: macOS denied access to Reminders. " +
		grantSentence("Reminders"),
	notRunning: "Could not create the reminder: Maestro could not be reached.",
	timedOut: "Could not create the reminder: Maestro did not answer in time.",
	failed: "Could not create the reminder.",
};
export const REMINDERS_OPEN_SUMMARIES = {
	denied:
		"Could not open Reminders: macOS denied access to Reminders. " +
		grantSentence("Reminders", "Automation > Reminders"),
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

/** Reminders' half of the shared Maestro client (utils/maestro.ts), which explains why it exists. */
async function ask(action: string, payload: Record<string, unknown> = {}): Promise<any> {
	return askMaestro("reminders", action, payload, REMINDERS_SUMMARIES);
}

/**
 * Probe Reminders access. Returns the access state; converts a denial into an actionable message but
 * never masks a non-permission failure (that is re-thrown).
 */
async function requestRemindersAccess(): Promise<{
	hasAccess: boolean;
	message: string;
}> {
	try {
		await ask("lists");
		return { hasAccess: true, message: "Reminders access is granted." };
	} catch (error) {
		if (error instanceof ToolFailure && error.code === "permission_denied") {
			return { hasAccess: false, message: REMINDERS_SUMMARIES.denied };
		}
		throw error;
	}
}

/**
 * The single reusable scan seam: every reminder, or one list's, optionally narrowed to those whose name
 * or notes contain `search`. `listNotFound` is returned rather than thrown, because asking for a list
 * that is not there is a fact about the request and the caller words it better than a code can.
 */
async function scan(opts: {
	search?: string | null;
	listId?: string | null;
}): Promise<{ items: Reminder[]; listNotFound: boolean }> {
	const body = await ask("scan", {
		search: opts.search ?? null,
		listId: opts.listId ?? null,
	});
	return {
		items: (body.items ?? []) as Reminder[],
		listNotFound: body.listNotFound === true,
	};
}

/** All reminder lists (id + name). A denial throws; an empty store returns []. */
async function getAllLists(): Promise<ReminderList[]> {
	const body = await ask("lists");
	return (body.lists ?? []) as ReminderList[];
}

/** Every reminder across every list. Denial throws; an empty store returns []. */
async function getAllReminders(): Promise<Reminder[]> {
	return (await scan({})).items;
}

/** Reminders whose name or body contains `searchText` (case-insensitive). Denial throws. */
async function searchReminders(searchText: string): Promise<Reminder[]> {
	if (!searchText || searchText.trim() === "") return [];
	return (await scan({ search: searchText })).items;
}

/**
 * Bring the Reminders app forward and report the best name match for `searchText`.
 *
 * This one still rides Apple Events, and should: opening the app IS the request, EventKit cannot do it,
 * and `activate()` is a single event that returns immediately. The MATCH comes from the fast path above,
 * so nothing here walks the store.
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
 * account's default list is used. `notes` and `dueDate` (ISO string) are optional. Returns the created
 * reminder read back from the store, not what we asked for, because the two differ when the store
 * normalises something and the person should be told what is really there.
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
	const body = await ask("create", {
		name,
		listName: listName ?? null,
		notes: notes ?? null,
		dueDate: dueDate ?? null,
	});
	return body.reminder as Reminder;
}

/**
 * Reminders in the list identified by `listId`. `props` is accepted for dispatcher compatibility; the
 * full standard reminder shape is always returned. A denial throws; an unknown list id is a real fault
 * (bad input) and throws rather than masquerading as an empty list.
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
