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

// Maximum events to scan in a single pass (guards against pathological calendars / wide windows).
const MAX_SCAN = 1000;

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

/**
 * Bounded scan of every calendar for events whose START falls in [fromMs, toMs], optionally filtered
 * by a (pre-lowercased) substring across title/location/notes. Returns up to `limit` events.
 *
 * Performance: we ask Calendar to pre-filter with a `whose` date predicate (fast); if a calendar
 * rejects the predicate we fall back to enumerating its events, and JS re-checks the window either
 * way. Each calendar and each event is guarded so one unreadable item can't abort the whole scan.
 * A genuine TCC denial throws at `Application("Calendar")` BEFORE the loop, so it propagates here
 * (not swallowed by the per-item guards) and is converted to a ToolFailure by the caller.
 */
async function scanWindow(
	fromMs: number,
	toMs: number,
	limit: number,
	search: string,
): Promise<CalEvent[]> {
	const scan = (await run(
		(args: {
			fromMs: number;
			toMs: number;
			limit: number;
			search: string;
			cap: number;
		}) => {
			const C = Application("Calendar");
			const from = new Date(args.fromMs);
			const to = new Date(args.toMs);
			const out: {
				id: string;
				title: string;
				startDate: string;
				endDate: string;
				location: string | null;
				calendarName: string;
				notes: string | null;
			}[] = [];
			let scanned = 0;
			let visited = 0;
			let skippedCalendars = 0;
			let firstError = "";

			const cals = C.calendars();
			for (let ci = 0; ci < cals.length && out.length < args.limit; ci++) {
				visited++;
				try {
					const cal = cals[ci];
					const calName = cal.name();

					// Prefer Calendar's own date predicate; fall back to a full enumeration if the
					// `whose` query is rejected (the JS window check below makes both paths correct).
					let evs: unknown[];
					try {
						evs = (cal.events as any)
							.whose({
								_and: [
									{ startDate: { _greaterThanEquals: from } },
									{ startDate: { _lessThanEquals: to } },
								],
							})();
					} catch (_predicateUnsupported) {
						evs = cal.events();
					}

					for (
						let ei = 0;
						ei < evs.length && out.length < args.limit && scanned < args.cap;
						ei++
					) {
						scanned++;
						try {
							const ev = evs[ei] as any;

							const start = ev.startDate();
							const end = ev.endDate();
							const startMs = start ? start.getTime() : NaN;
							// Window filter on start time (covers the full-enumeration fallback).
							if (!Number.isNaN(startMs) && (startMs < args.fromMs || startMs > args.toMs)) {
								continue;
							}

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

							out.push({
								id: ev.uid(),
								title,
								startDate: start ? start.toISOString() : "",
								endDate: end ? end.toISOString() : "",
								location,
								calendarName: calName,
								notes,
							});
						} catch (_badEvent) {
							// Skip an individual unreadable event; do not abort the whole scan.
						}
					}
				} catch (badCalendar) {
					// Skip a calendar we can't enumerate; a real TCC denial would have thrown above.
					// Counted, because a window where EVERY calendar threw is a broken read, and
					// returning "no events" for it would report the fault as the user's empty diary.
					skippedCalendars++;
					if (!firstError) firstError = String(badCalendar);
				}
			}
			return { items: out, visited, skippedCalendars, firstError };
		},
		{ fromMs, toMs, limit, search, cap: MAX_SCAN },
	)) as {
		items: CalEvent[];
		visited: number;
		skippedCalendars: number;
		firstError: string;
	};

	if (scan.visited > 0 && scan.skippedCalendars === scan.visited) {
		throw new ToolFailure(
			"applescript_error",
			`Could not read your calendar: all ${scan.visited} calendars failed to read.`,
			rawBody(scan.firstError),
		);
	}
	return scan.items;
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
			(args: { id: string; cap: number }) => {
				const C = Application("Calendar");
				const cals = C.calendars();
				let scanned = 0;
				let skippedCalendars = 0;
				let firstError = "";
				for (let ci = 0; ci < cals.length; ci++) {
					try {
						const cal = cals[ci];

						let matches: unknown[];
						try {
							matches = (cal.events as any)
								.whose({ uid: { _equals: args.id } })();
						} catch (_predicateUnsupported) {
							matches = [];
						}

						if (matches.length === 0) {
							// Fallback: bounded manual scan for the uid in this calendar.
							const evs = cal.events();
							for (
								let ei = 0;
								ei < evs.length && scanned < args.cap;
								ei++
							) {
								scanned++;
								try {
									if ((evs[ei] as any).uid() === args.id) {
										matches = [evs[ei]];
										break;
									}
								} catch (_badEvent) {
									// skip unreadable event
								}
							}
						}

						if (matches.length > 0) {
							const ev = matches[0] as any;
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
								visited: cals.length,
							};
						}
					} catch (badCalendar) {
						// Skip a calendar we can't enumerate, but count it: "no event with that ID"
						// must not be how a calendar we could not open at all gets reported.
						skippedCalendars++;
						if (!firstError) firstError = String(badCalendar);
					}
				}
				return { found: false, title: "", skippedCalendars, firstError, visited: cals.length };
			},
			{ id, cap: MAX_SCAN },
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
	searchEvents,
	openEvent,
	getEvents,
	createEvent,
	requestCalendarAccess,
};

export default calendar;
