import { run } from "@jxa/run";
import { ToolFailure, grantSentence, throwAppleFailure } from "./native";
import { ask as askMaestro } from "./maestro";

// CALENDAR IS NOT SCRIPTED ANY MORE. Maestro reads the same store through EventKit, and this asks.
//
// Calendar was never as broken as reminders. It answered, in about 4.6 seconds for a seven-day window,
// which is survivable rather than impossible. What made it worth moving is that the seconds went on the
// wrong thing entirely, and the old comment here explains why better than a new one could: what Calendar
// charges for over Apple Events is the EVENT, not the round trip, roughly 24ms per event per property,
// whether or not the event is one you wanted. So the window had to be walked in slices, with a cap, a
// truncation note, and a warning that the latency DRIFTS so badly (15.8s and 10.7s for the identical
// read, minutes apart) that nothing could be tuned against it.
//
// EventKit can be asked the question directly (`predicateForEvents(withStart:end:calendars:)`), so the
// whole window is one indexed query and all of that machinery stops existing:
//
//     7 days, scripted     4.59s        7 days, Maestro     0.04s
//     30 days, scripted    2.91s        +-1 year, Maestro   0.05s, 83 events
//
// `openEvent` still rides Apple Events, and should: bringing the app forward IS the request, and EventKit
// cannot do it. Finding the event first is a lookup, so that part moved too.

// Default look-ahead windows (days) when the caller does not pin a date range.
const LIST_WINDOW_DAYS = 7;
const SEARCH_WINDOW_DAYS = 30;

export const CALENDAR_SUMMARIES = {
	denied:
		"Could not read your calendar: macOS denied access to Calendar. " +
		grantSentence("Calendars", "Automation > Calendar"),
	notRunning: "Could not read your calendar: the Calendar app could not be reached.",
	timedOut: "Could not read your calendar: Calendar did not answer in time.",
	failed: "Could not read your calendar.",
};
export const CALENDAR_OPEN_SUMMARIES = {
	denied:
		"Could not open the event: macOS denied access to Calendar. " +
		grantSentence("Calendars", "Automation > Calendar"),
	notRunning: "Could not open the event: the Calendar app could not be reached.",
	timedOut: "Could not open the event: Calendar did not answer in time.",
	failed: "Could not open the event.",
};
export const CALENDAR_CREATE_SUMMARIES = {
	denied:
		"Could not create the event: macOS denied access to Calendar. " +
		grantSentence("Calendars", "Automation > Calendar"),
	notRunning: "Could not create the event: the Calendar app could not be reached.",
	timedOut: "Could not create the event: Calendar did not answer in time.",
	failed: "Could not create the event.",
};

/** The shape index.ts consumes. startDate/endDate are ISO-8601 strings. */
export interface CalEvent {
	id: string;
	title: string;
	startDate: string;
	endDate: string;
	location?: string | null;
	calendarName: string;
	notes?: string | null;
}

/** Parse an ISO date argument, throwing a precise error on garbage rather than silently widening. */
function parseDate(value: string, label: string): Date {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) {
		throw new ToolFailure(
			"bad_request",
			`Could not use the dates given: "${value}" is not a valid ${label}. ` +
				"Use ISO-8601 (e.g. 2026-06-21 or 2026-06-21T14:30:00Z).",
		);
	}
	return d;
}

/** Resolve the [from, to] window in epoch-ms from optional ISO bounds + a default look-ahead. */
function resolveWindow(
	fromDate: string | undefined,
	toDate: string | undefined,
	defaultDays: number,
): { fromMs: number; toMs: number } {
	const now = new Date();
	const from = fromDate ? parseDate(fromDate, "fromDate") : now;

	let to: Date;
	if (toDate) {
		to = parseDate(toDate, "toDate");
	} else {
		to = new Date(from.getTime());
		to.setDate(to.getDate() + defaultDays);
	}

	if (to.getTime() < from.getTime()) {
		throw new ToolFailure(
			"bad_request",
			"Could not use the dates given: toDate is earlier than fromDate.",
		);
	}
	return { fromMs: from.getTime(), toMs: to.getTime() };
}

/** Calendar's half of the shared Maestro client (utils/maestro.ts), which explains why it exists. */
async function ask(action: string, payload: Record<string, unknown> = {}): Promise<any> {
	return askMaestro("calendar", action, payload, CALENDAR_SUMMARIES);
}

/** Probe Calendar access. Returns access state; never masks a non-permission failure. */
async function requestCalendarAccess(): Promise<{
	hasAccess: boolean;
	message: string;
}> {
	try {
		await ask("calendars");
		return { hasAccess: true, message: "Calendar access is granted." };
	} catch (error) {
		if (error instanceof ToolFailure && error.code === "permission_denied") {
			return { hasAccess: false, message: CALENDAR_SUMMARIES.denied };
		}
		throw error;
	}
}

/** How many events the window really held, when a limit shortened the answer. Null when it did not. */
export let lastWindowTotal: { shown: number; total: number } | null = null;

async function windowEvents(
	fromMs: number,
	toMs: number,
	limit: number,
	search: string,
): Promise<CalEvent[]> {
	const body = await ask("events", {
		from: new Date(fromMs).toISOString(),
		to: new Date(toMs).toISOString(),
		search: search || null,
		limit: Math.max(0, limit),
	});
	const events = (body.events ?? []) as CalEvent[];
	const total = typeof body.total === "number" ? body.total : events.length;
	// A limit that shortened the answer is SAID, never implied: "10 of 34" and "10" are different facts,
	// and the second one invites somebody to conclude there were ten.
	lastWindowTotal = total > events.length ? { shown: events.length, total } : null;
	return events;
}

/**
 * Events in a date window. Defaults to today .. +7 days.
 * Returns [] only for an authorized-but-empty window; a denial throws.
 */
async function getEvents(
	limit = 10,
	fromDate?: string,
	toDate?: string,
): Promise<CalEvent[]> {
	const { fromMs, toMs } = resolveWindow(fromDate, toDate, LIST_WINDOW_DAYS);
	return windowEvents(fromMs, toMs, Math.max(1, limit), "");
}

/**
 * Search events whose title/location/notes contain `searchText` within a date window.
 * Defaults to today .. +30 days. Returns [] only for an authorized-but-empty result; denial throws.
 */
async function searchEvents(
	searchText: string,
	limit = 10,
	fromDate?: string,
	toDate?: string,
): Promise<CalEvent[]> {
	const needle = (searchText ?? "").trim();
	if (needle === "") {
		// An empty needle is not a search that found nothing, it is a search that was never made.
		throw new ToolFailure(
			"bad_request",
			"Could not search your calendar: no search text was given.",
		);
	}
	const { fromMs, toMs } = resolveWindow(fromDate, toDate, SEARCH_WINDOW_DAYS);
	return windowEvents(fromMs, toMs, Math.max(1, limit), needle);
}

/**
 * Bring the Calendar app forward on an event.
 *
 * The LOOKUP moved to Maestro and the activate() stayed here, which is the same split reminders uses:
 * finding a thing belongs where the index is, opening an app is what Apple Events are for. Scripting the
 * lookup meant reading every uid in every calendar, one column per calendar, hit or miss.
 */
async function openEvent(eventId: string): Promise<{ message: string }> {
	const id = (eventId ?? "").trim();
	if (id === "") {
		throw new ToolFailure(
			"bad_request",
			"Could not open the event: no event ID was given.",
		);
	}

	// Throws not_found when the id matches nothing, so reaching the next line means there is something
	// to open. Opening nothing is a failure of what was asked, not a successful open.
	const body = await askMaestro("calendar", "event", { id }, CALENDAR_OPEN_SUMMARIES);
	const found = body.event as CalEvent;

	try {
		await run(() => {
			Application("Calendar").activate();
			return true;
		});
	} catch (error) {
		throwAppleFailure(error, CALENDAR_OPEN_SUMMARIES);
	}

	return { message: `Opened Calendar. Found event: ${found.title}` };
}

/**
 * Create an event. `startDate`/`endDate` are ISO strings; `calendarName` picks a writable calendar and
 * a name that matches none is a FAULT rather than an invitation to invent one. Returns the event read
 * back from the store.
 */
async function createEvent(
	title: string,
	startDate: string,
	endDate: string,
	location?: string,
	notes?: string,
	isAllDay = false,
	calendarName?: string,
): Promise<{ message: string; eventId: string }> {
	if (!title || title.trim() === "") {
		throw new ToolFailure(
			"bad_request",
			"Could not create the event: no title was given.",
		);
	}
	if (!startDate || !endDate) {
		throw new ToolFailure(
			"bad_request",
			"Could not create the event: a start and an end time are both needed.",
		);
	}
	// Parsed HERE as well as in Maestro, so a bad date is refused in the calendar's own words before it
	// becomes a round trip.
	parseDate(startDate, "startDate");
	parseDate(endDate, "endDate");

	const body = await askMaestro("calendar", "create", {
		title,
		start: startDate,
		end: endDate,
		location: location ?? null,
		notes: notes ?? null,
		isAllDay,
		calendarName: calendarName ?? null,
	}, CALENDAR_CREATE_SUMMARIES);

	const made = body.event as CalEvent;
	return {
		message: `Created "${made.title}" in "${made.calendarName}".`,
		eventId: made.id,
	};
}

const calendar = {
	truncation: () => lastWindowTotal,
	searchEvents,
	openEvent,
	getEvents,
	createEvent,
	requestCalendarAccess,
};

export default calendar;
