import { ToolFailure } from "./native";

/**
 * ASKING MAESTRO TO READ AN APPLE STORE.
 *
 * Three of the five apps here are not scripted any more: reminders, contacts and calendar have real
 * frameworks behind them (EventKit, Contacts), and Maestro calls those directly. This is the one client
 * they share, rather than three near-identical fetch blocks that would drift apart the first time one of
 * them learned something.
 *
 * It has to be Maestro doing the reading rather than this process: a TCC grant attaches to a process, and
 * Maestro is the process the user granted. A helper would key its own grant, which is how you get a
 * correctly-granted app whose contacts still fail.
 *
 * There is NO fallback to the scripted path when the door is missing, and that is the point rather than
 * an omission. Those paths are not merely slower: reminders never returned at all, and contacts quietly
 * answered with 252 of 1,645 cards. "Falling back" to either would trade a clear failure for a wrong
 * answer, which is the worse of the two by a distance. When there is no door, say so.
 */

/** The sentences a caller supplies for its own store, so a failure reads in that store's words. */
export interface Summaries {
	denied: string;
	notRunning: string;
	timedOut: string;
	failed: string;
}

/** Where each store's door is, and the header its secret is presented under. */
const DOORS = {
	reminders: { url: "MAESTRO_REMINDERS_URL", secret: "MAESTRO_REMINDERS_SECRET",
		header: "x-reminders-secret", noun: "reminders" },
	contacts: { url: "MAESTRO_CONTACTS_URL", secret: "MAESTRO_CONTACTS_SECRET",
		header: "x-contact-secret", noun: "contacts" },
	calendar: { url: "MAESTRO_CALENDAR_URL", secret: "MAESTRO_CALENDAR_SECRET",
		header: "x-calendar-secret", noun: "calendar" },
} as const;

export type Door = keyof typeof DOORS;

export async function ask(
	door: Door,
	action: string,
	payload: Record<string, unknown>,
	summaries: Summaries,
): Promise<any> {
	const cfg = DOORS[door];
	const url = (process.env[cfg.url] ?? "").trim();
	const secret = (process.env[cfg.secret] ?? "").trim();

	if (!url || !secret) {
		throw new ToolFailure(
			"app_not_running",
			`Your ${cfg.noun} can only be read inside Maestro, which reads the store directly. ` +
				"There is no second way to do it that works.",
		);
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", [cfg.header]: secret },
			body: JSON.stringify({ action, ...payload }),
		});
	} catch (error) {
		throw new ToolFailure("app_not_running", `${summaries.notRunning} (${String(error)})`);
	}

	const text = await response.text();
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		// The whole body, verbatim, because a door that answered something we cannot parse is a fault
		// worth seeing in full rather than a summary of our disappointment.
		throw new ToolFailure(
			"internal_error",
			`Maestro answered something that is not a ${cfg.noun} answer.`,
			`HTTP ${response.status}\n${text}`,
		);
	}

	if (body?.ok !== "true" && body?.ok !== true) {
		// The code and the sentence travel WHOLE from Maestro, so a denial reads in the same words as
		// every other denial and nothing is re-worded on the way through.
		throw new ToolFailure(body?.code ?? "internal_error", body?.reason ?? summaries.failed);
	}
	return body;
}
