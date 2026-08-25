import { run } from "@jxa/run";
import {
	ToolFailure,
	grantSentence,
	isPermissionDenial,
	throwAppleFailure,
} from "./native";
import { rawBody } from "./failure";

// We drive Calendar through JXA (@jxa/run) rather than by interpolating user input into an
// AppleScript source string. JXA returns REAL JS objects/arrays (so there is no "parse the string
// return as an array" bug the upstream module shipped), and EVERY user-controlled value (search text,
// title, dates, ids, calendar name, location, notes) is passed as a serialized *argument* to the
// script — never spliced into source — so there is no script-injection surface. JXA still rides Apple
// Events, so the Automation (kTCCServiceAppleEvents) permission applies: a denial surfaces as a thrown
// error which we convert to a typed ToolFailure (Faces charter #2: denied is not empty is not broke).

// Maximum events to read details for in a single pass (guards against pathological calendars).
const MAX_SCAN = 1000;

/** Set when a scan stopped at MAX_SCAN before it had filled the caller's limit. Read by the caller so
 *  a short answer can say it is short. Null when the cap did not bite. */
export let lastWindowTruncation: { examined: number } | null = null;

// CALENDAR IS NOT NOTES, AND THIS WAS MEASURED BEFORE IT WAS WRITTEN.
//
// Everywhere else in this server the fix for a slow read is to ask the collection for one property in
// one Apple Event (`Notes.notes.plaintext()` returns 3.5 MB of note bodies in 0.24s, against ~1s PER
// NOTE one at a time). Calendar does not behave that way. Measured against this Mac's 315 events:
//
//     cal.events.summary() on a 107-event calendar      ~2.2s   ONE bulk event
//     C.calendars.events.startDate(), all 7 at once      8.0s   ONE bulk event, 315 events
//     per-calendar events.startDate(), seven of them     7.5s   SEVEN bulk events, same 315
//
// Those last two are the tell: asking once and asking seven times cost the same, so what Calendar
// charges for is the EVENT, not the round trip. It is roughly 24ms per event to read one property
// whichever way you ask, and a bulk column pays that for every event in the calendar whether or not
// the event is wanted. So pulling six bulk columns per calendar (42 Apple Events, 50.2s measured over
// this account) is SLOWER than reading six properties off the handful of events actually in the
// window. Bulk is used for exactly the reads that have to touch every event anyway: the calendar
// names, and every event's start time.
//
// Calendar's latency also DRIFTS, badly: the same 6-property read of the same 20 events measured 15.8s
// and 10.7s minutes apart, and one probe put a single property read at 21ms where another put it at
// 147ms. Anything tuned against one run of this app is tuned against noise, which is why there is no
// threshold or heuristic anywhere below, and why the before/after numbers in the commit come from
// alternating the old scan and the new one inside a single run.

// Default look-ahead windows (days) when the caller does not pin a date range.
const LIST_WINDOW_DAYS = 7;
const SEARCH_WINDOW_DAYS = 30;

// The one sentence each outcome puts on line 1 of the envelope. It says WHAT DID NOT HAPPEN, and for
// a denial it also NAMES the permission that is missing and the app to enable it for.
//
// Naming it is not inventing a remedy. Only this server can tell a denied Automation grant from a
// denied Contacts one, so nothing upstream could reconstruct that sentence, and dropping it deletes it
// rather than moving it somewhere better. What stays out is anything we would be guessing: no "then
// try again", no theory about why the grant is missing.
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

/** Probe Calendar access. Returns access state; never masks a non-permission failure. */
async function requestCalendarAccess(): Promise<{
	hasAccess: boolean;
	message: string;
}> {
	try {
		await run(() => Application("Calendar").name());
		return { hasAccess: true, message: "Calendar access is granted." };
	} catch (error) {
		if (isPermissionDenial(error)) {
			return { hasAccess: false, message: CALENDAR_SUMMARIES.denied };
		}
		// Not a denial, so this probe cannot answer the question it was asked. Surface it rather than
		// reporting "no access" for something that was never about access.
		throwAppleFailure(error, CALENDAR_SUMMARIES);
	}
}

/** Where one event in the window sits: which calendar, which index in it, and when it starts. */
type WindowSlot = { ci: number; ei: number; startMs: number };

/** What pass 1 found, plus the bookkeeping that tells an empty diary from an unreadable one. */
type WindowScan = {
	calendarNames: string[];
	slots: WindowSlot[];
	visited: number;
	skippedCalendars: number;
	firstError: string;
};

/**
 * PASS 1, WHERE AND NOT WHAT. One bulk read of every event's start time per calendar, which is the one
 * read that has to touch every event anyway.
 *
 * It replaces the `whose` date predicate and its enumeration fallback. The predicate cost the same
 * (Calendar evaluates it event by event on its own side, ~25ms an event either way) and the JS window
 * check had to re-check its answer regardless, so two code paths were being maintained for one result.
 *
 * A genuine TCC denial throws at `Application("Calendar")` before the loop, so it propagates rather
 * than being swallowed by the per-calendar guard.
 */
async function findWindow(fromMs: number, toMs: number): Promise<WindowScan> {
	const scan = (await run(
		(args: { fromMs: number; toMs: number }) => {
			// ONE event for every calendar's name, rather than one per calendar.
			const C = Application("Calendar");
			const calendarNames = C.calendars.name() as string[];
			const slots: { ci: number; ei: number; startMs: number }[] = [];
			let visited = 0;
			let skippedCalendars = 0;
			let firstError = "";

			for (let ci = 0; ci < calendarNames.length; ci++) {
				visited++;
				try {
					const starts = C.calendars[ci].events.startDate() as (Date | null)[];
					for (let ei = 0; ei < starts.length; ei++) {
						const d = starts[ei];
						const ms = d && typeof d.getTime === "function" ? d.getTime() : NaN;
						if (Number.isNaN(ms) || ms < args.fromMs || ms > args.toMs) continue;
						slots.push({ ci, ei, startMs: ms });
					}
				} catch (badCalendar) {
					// Skip a calendar we can't enumerate; a real TCC denial would have thrown above.
					// Counted, because a window where EVERY calendar threw is a broken read, and
					// returning "no events" for it would report the fault as the user's empty diary.
					skippedCalendars++;
					if (!firstError) firstError = String(badCalendar);
				}
			}
			return { calendarNames, slots, visited, skippedCalendars, firstError };
		},
		{ fromMs, toMs },
	)) as WindowScan;

	if (scan.visited > 0 && scan.skippedCalendars === scan.visited) {
		throw new ToolFailure(
			"applescript_error",
			`Could not read your calendar: all ${scan.visited} calendars failed to read.`,
			rawBody(scan.firstError),
		);
	}
	return scan;
}

/**
 * PASS 2, WHAT, for as far along the given order as the answer needs. Six property reads on an event
 * that is going to be returned, four on one a search rejects, and none at all on the rest.
 *
 * `slots` arrives in the order the answer should come back in, and the result keeps that order.
 */
async function readSlots(
	slots: WindowSlot[],
	calendarNames: string[],
	fromMs: number,
	toMs: number,
	limit: number,
	search: string,
): Promise<CalEvent[]> {
	const read = (await run(
		(args: {
			slots: WindowSlot[];
			calendarNames: string[];
			fromMs: number;
			toMs: number;
			limit: number;
			search: string;
		}) => {
			const C = Application("Calendar");
			const out: {
				id: string;
				title: string;
				startDate: string;
				endDate: string;
				location: string | null;
				calendarName: string;
				notes: string | null;
			}[] = [];

			for (let k = 0; k < args.slots.length && out.length < args.limit; k++) {
				const slot = args.slots[k];
				try {
					const ev = C.calendars[slot.ci].events[slot.ei] as any;

					// Read the start again off the event itself rather than trusting the index pass 1
					// handed over: if the calendar changed in between, every field returned here still
					// describes ONE event, and the window is re-checked against what it now says.
					const start = ev.startDate();
					const startMs = start ? start.getTime() : NaN;
					if (Number.isNaN(startMs) || startMs < args.fromMs || startMs > args.toMs) continue;

					const title = ev.summary() || "";
					const location = ev.location() || null;
					// Calendar event notes live in the `description` property (there is no
					// `notes` property on a Calendar event).
					const notes = ev.description() || null;

					if (args.search) {
						const hay = (
							title +
							" " +
							(location || "") +
							" " +
							(notes || "")
						).toLowerCase();
						if (hay.indexOf(args.search) === -1) continue;
					}

					const end = ev.endDate();
					out.push({
						id: ev.uid(),
						title,
						startDate: start.toISOString(),
						endDate: end ? end.toISOString() : "",
						location,
						calendarName: args.calendarNames[slot.ci],
						notes,
					});
				} catch (_badEvent) {
					// Skip an individual unreadable event; do not abort the whole scan.
				}
			}
			return { items: out };
		},
		{ slots, calendarNames, fromMs, toMs, limit, search },
	)) as { items: CalEvent[] };

	return read.items;
}

/**
 * Every event in the account whose START falls in [fromMs, toMs], optionally filtered by a
 * (pre-lowercased) substring across title/location/notes, IN START ORDER, cut to `limit`.
 *
 * THE WHOLE WINDOW FIRST, THEN SORTED, THEN CUT, and the sort lives here rather than inside a JXA
 * script so it can be tested without a Mac. This used to fill `limit` calendar by calendar and stop,
 * so "the next 5 events" meant "5 events from whichever calendars come first". On this Mac, asking for
 * the next 5 over a year answered with five events from ONE calendar, in that calendar's own storage
 * order (07:00 listed after 12:30 on the same day), and never opened the others at all. The window
 * belongs to the account, not to a calendar.
 */
async function scanWindow(
	fromMs: number,
	toMs: number,
	limit: number,
	search: string,
): Promise<CalEvent[]> {
	const { calendarNames, slots } = await findWindow(fromMs, toMs);

	slots.sort((a, b) => a.startMs - b.startMs);
	// The cap bounds the DETAIL reads, and it cannot change a list answer: the events are already in
	// start order, so the first MAX_SCAN of them contain the first `limit` of them. It can only bite on
	// a search whose matches all sit past the cap, and when it does, the caller says so.
	const considered = slots.slice(0, MAX_SCAN);
	if (considered.length === 0) {
		lastWindowTruncation = null;
		return [];
	}

	const items = await readSlots(considered, calendarNames, fromMs, toMs, limit, search);
	lastWindowTruncation =
		slots.length > considered.length && items.length < limit
			? { examined: considered.length }
			: null;
	return items;
}

/**
 * List calendar events in a date window. Defaults to today .. +7 days.
 * Returns [] only for an authorized-but-empty window; a permission denial throws.
 */
async function getEvents(
	limit = 10,
	fromDate?: string,
	toDate?: string,
): Promise<CalEvent[]> {
	const { fromMs, toMs } = resolveWindow(fromDate, toDate, LIST_WINDOW_DAYS);
	try {
		return await scanWindow(fromMs, toMs, Math.max(1, limit), "");
	} catch (error) {
		throwAppleFailure(error, CALENDAR_SUMMARIES);
	}
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
	const needle = (searchText ?? "").trim().toLowerCase();
	if (needle === "") {
		// An empty needle is not a search that found nothing, it is a search that was never made.
		throw new ToolFailure(
			"bad_request",
			"Could not search your calendar: no search text was given.",
		);
	}

	const { fromMs, toMs } = resolveWindow(fromDate, toDate, SEARCH_WINDOW_DAYS);
	try {
		return await scanWindow(fromMs, toMs, Math.max(1, limit), needle);
	} catch (error) {
		throwAppleFailure(error, CALENDAR_SUMMARIES);
	}
}

/**
 * Open the Calendar app focused on the event with `eventId` (its stable uid). Reports honestly:
 * returns only when the event actually exists, and throws `not_found` otherwise. A denial throws too.
 */
async function openEvent(eventId: string): Promise<{ message: string }> {
	const id = (eventId ?? "").trim();
	if (id === "") {
		throw new ToolFailure(
			"bad_request",
			"Could not open the event: no event ID was given.",
		);
	}

	try {
		const found = (await run(
			(args: { id: string }) => {
				const C = Application("Calendar");
				// ONE event for every calendar's name, then ONE for every uid in a calendar. The uid
				// scan used to run only as a fallback when the `whose` predicate found nothing, which
				// is precisely what happens for an id that does not exist, and it read the uid off one
				// event at a time: a miss walked up to 1,000 events one Apple Event each. Reading the
				// column costs one event per calendar whether it hits or misses.
				const calNames = C.calendars.name();
				let skippedCalendars = 0;
				let firstError = "";
				for (let ci = 0; ci < calNames.length; ci++) {
					try {
						const uids = C.calendars[ci].events.uid() as string[];
						const index = uids.indexOf(args.id);
						if (index < 0) continue;

						const ev = C.calendars[ci].events[index] as any;
						let title = "";
						try {
							title = ev.summary() || "";
						} catch (_noTitle) {
							// title is best-effort
						}
						C.activate();
						return {
							found: true,
							title,
							skippedCalendars,
							firstError,
							visited: calNames.length,
						};
					} catch (badCalendar) {
						// Skip a calendar we can't enumerate, but count it: "no event with that ID"
						// must not be how a calendar we could not open at all gets reported.
						skippedCalendars++;
						if (!firstError) firstError = String(badCalendar);
					}
				}
				return {
					found: false,
					title: "",
					skippedCalendars,
					firstError,
					visited: calNames.length,
				};
			},
			{ id },
		)) as {
			found: boolean;
			title: string;
			skippedCalendars: number;
			firstError: string;
			visited: number;
		};

		if (found.visited > 0 && found.skippedCalendars === found.visited) {
			throw new ToolFailure(
				"applescript_error",
				`Could not open the event: all ${found.visited} calendars failed to read.`,
				rawBody(found.firstError),
			);
		}
		if (!found.found) {
			throw new ToolFailure(
				"not_found",
				`Could not open the event: no event has the ID "${id}".`,
			);
		}
		return {
			message: found.title
				? `Opened Calendar at "${found.title}".`
				: "Opened Calendar at the event.",
		};
	} catch (error) {
		throwAppleFailure(error, CALENDAR_OPEN_SUMMARIES);
	}
}

/**
 * Create a new calendar event. Validates inputs locally, then pushes the event via JXA. EVERY failure
 * throws a typed ToolFailure: a bad argument, a TCC denial, an unknown target calendar.
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
			"Could not create the event: a start date and an end date are both required.",
		);
	}

	// parseDate throws a bad_request ToolFailure of its own, naming the field and the bad value.
	const start = parseDate(startDate, "startDate");
	const end = parseDate(endDate, "endDate");

	if (!isAllDay && end.getTime() <= start.getTime()) {
		throw new ToolFailure(
			"bad_request",
			"Could not create the event: the end date is not after the start date.",
		);
	}

	try {
		const result = (await run(
			(args: {
				title: string;
				startMs: number;
				endMs: number;
				location: string;
				notes: string;
				isAllDay: boolean;
				calendarName: string;
			}) => {
				const C = Application("Calendar");

				let cal: any = null;
				if (args.calendarName) {
					try {
						const named = C.calendars.byName(args.calendarName);
						named.name(); // force resolution; throws if it doesn't exist
						cal = named;
					} catch (_notFound) {
						cal = null;
					}
					if (!cal) return { error: "calendar_not_found" };
				} else {
					const all = C.calendars();
					if (all.length === 0) return { error: "no_calendars" };
					cal = all[0];
				}

				const props: {
					summary: string;
					startDate: Date;
					endDate: Date;
					alldayEvent: boolean;
					location?: string;
					description?: string;
				} = {
					summary: args.title,
					startDate: new Date(args.startMs),
					endDate: new Date(args.endMs),
					alldayEvent: args.isAllDay,
				};
				if (args.location) props.location = args.location;
				if (args.notes) props.description = args.notes;

				const ev = C.Event(props);
				cal.events.push(ev);

				return { uid: ev.uid(), calendarName: cal.name() };
			},
			{
				title: title.trim(),
				startMs: start.getTime(),
				endMs: end.getTime(),
				location: location ?? "",
				notes: notes ?? "",
				isAllDay: !!isAllDay,
				calendarName: calendarName ?? "",
			},
		)) as
			| { uid: string; calendarName: string }
			| { error: "calendar_not_found" | "no_calendars" };

		if ("error" in result) {
			if (result.error === "calendar_not_found") {
				throw new ToolFailure(
					"not_found",
					`Could not create the event: there is no calendar named "${calendarName}".`,
				);
			}
			throw new ToolFailure(
				"not_found",
				"Could not create the event: there are no calendars to create it in.",
			);
		}

		return {
			message: `Event "${title.trim()}" created in "${result.calendarName}".`,
			eventId: result.uid,
		};
	} catch (error) {
		throwAppleFailure(error, CALENDAR_CREATE_SUMMARIES);
	}
}

const calendar = {
	truncation: () => lastWindowTruncation,
	searchEvents,
	openEvent,
	getEvents,
	createEvent,
	requestCalendarAccess,
};

export default calendar;
