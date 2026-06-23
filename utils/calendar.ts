import { run } from "@jxa/run";
import { PermissionError, isPermissionDenial } from "./native";

// We drive Calendar through JXA (@jxa/run) rather than by interpolating user input into an
// AppleScript source string. JXA returns REAL JS objects/arrays (so there is no "parse the string
// return as an array" bug the upstream module shipped), and EVERY user-controlled value (search text,
// title, dates, ids, calendar name, location, notes) is passed as a serialized *argument* to the
// script — never spliced into source — so there is no script-injection surface. JXA still rides Apple
// Events, so the Automation (kTCCServiceAppleEvents) permission applies: a denial surfaces as a thrown
// error which we convert to PermissionError (Faces charter #2: denied ≠ empty ≠ broke).

// Maximum events to scan in a single pass (guards against pathological calendars / wide windows).
const MAX_SCAN = 1000;

// Default look-ahead windows (days) when the caller does not pin a date range.
const LIST_WINDOW_DAYS = 7;
const SEARCH_WINDOW_DAYS = 30;

const CALENDAR_DENIED =
	"Calendar access is not granted. In System Settings ▸ Privacy & Security, grant Faced access to " +
	"Calendars (and Automation ▸ Calendar), then try again.";

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
		throw new Error(
			`Invalid ${label} "${value}". Use ISO-8601 (e.g. 2026-06-21 or 2026-06-21T14:30:00Z).`,
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
		throw new Error("toDate must not be earlier than fromDate.");
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
			return { hasAccess: false, message: CALENDAR_DENIED };
		}
		throw error instanceof Error ? error : new Error(String(error));
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
 * (not swallowed by the per-item guards) and is converted to a PermissionError by the caller.
 */
async function scanWindow(
	fromMs: number,
	toMs: number,
	limit: number,
	search: string,
): Promise<CalEvent[]> {
	const events = (await run(
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

			const cals = C.calendars();
			for (let ci = 0; ci < cals.length && out.length < args.limit; ci++) {
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
				} catch (_badCalendar) {
					// Skip a calendar we can't enumerate; a real TCC denial would have thrown above.
				}
			}
			return out;
		},
		{ fromMs, toMs, limit, search, cap: MAX_SCAN },
	)) as CalEvent[];

	return events;
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
		if (isPermissionDenial(error)) throw new PermissionError(CALENDAR_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
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
	if (needle === "") return [];

	const { fromMs, toMs } = resolveWindow(fromDate, toDate, SEARCH_WINDOW_DAYS);
	try {
		return await scanWindow(fromMs, toMs, Math.max(1, limit), needle);
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(CALENDAR_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * Open the Calendar app focused on the event with `eventId` (its stable uid). Reports honestly:
 * success only when the event actually exists; a clear "not found" otherwise. A denial throws.
 */
async function openEvent(
	eventId: string,
): Promise<{ success: boolean; message: string }> {
	const id = (eventId ?? "").trim();
	if (id === "") {
		return { success: false, message: "An event ID is required to open an event." };
	}

	try {
		const found = (await run(
			(args: { id: string; cap: number }) => {
				const C = Application("Calendar");
				const cals = C.calendars();
				let scanned = 0;
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
							return { found: true, title };
						}
					} catch (_badCalendar) {
						// skip a calendar we can't enumerate
					}
				}
				return { found: false, title: "" };
			},
			{ id, cap: MAX_SCAN },
		)) as { found: boolean; title: string };

		if (!found.found) {
			return { success: false, message: `No event found with ID "${id}".` };
		}
		return {
			success: true,
			message: found.title
				? `Opened Calendar at "${found.title}".`
				: "Opened Calendar at the event.",
		};
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(CALENDAR_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * Create a new calendar event. Validates inputs locally, then pushes the event via JXA. On a TCC
 * denial it throws PermissionError; an unknown target calendar is an honest {success:false}.
 */
async function createEvent(
	title: string,
	startDate: string,
	endDate: string,
	location?: string,
	notes?: string,
	isAllDay = false,
	calendarName?: string,
): Promise<{ success: boolean; message: string; eventId?: string }> {
	if (!title || title.trim() === "") {
		return { success: false, message: "Event title cannot be empty." };
	}
	if (!startDate || !endDate) {
		return { success: false, message: "Start date and end date are required." };
	}

	let start: Date;
	let end: Date;
	try {
		start = parseDate(startDate, "startDate");
		end = parseDate(endDate, "endDate");
	} catch (error) {
		return {
			success: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}

	if (!isAllDay && end.getTime() <= start.getTime()) {
		return { success: false, message: "End date must be after start date." };
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
				return {
					success: false,
					message: `Calendar "${calendarName}" was not found.`,
				};
			}
			return {
				success: false,
				message: "No calendars are available to create the event in.",
			};
		}

		return {
			success: true,
			message: `Event "${title.trim()}" created in "${result.calendarName}".`,
			eventId: result.uid,
		};
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(CALENDAR_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
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
