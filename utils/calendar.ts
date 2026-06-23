import { run } from "@jxa/run";
import { PermissionError, isPermissionDenial } from "./native";

// We drive Calendar through JXA (@jxa/run) rather than by interpolating user input into an
// AppleScript source string. JXA returns REAL JS objects/arrays (so there is no "parse the string
// return as an array" bug the upstream module shipped), and EVERY user-controlled value (search text,
// title, dates, ids, calendar name, location, notes) is passed as a serialized *argument* to the
// script — never spliced into source — so there is no script-injection surface. JXA still rides Apple
// Events, so the Automation (kTCCServiceAppleEvents) permission applies: a denial surfaces as a thrown
// error which we convert to PermissionError (denied ≠ empty ≠ broke).
//
// Mutation discipline (measured cost): we NEVER read a property back off an event we just
// created/updated/deleted — a read on a freshly-mutated item forces a store/iCloud round-trip that
// blocks for seconds. We return the values we SET (and values captured BEFORE the mutation), not
// values re-read afterward. Locating an event is done with Calendar's server-side `whose` predicate
// (one round-trip) with a bounded full-scan fallback; we never read name()/summary()/uid() across an
// entire store per item.

// Maximum events to scan in a single pass (guards against pathological calendars / wide windows).
const MAX_SCAN = 1000;

// Default look-ahead windows (days) when the caller does not pin a date range.
const LIST_WINDOW_DAYS = 7;
const SEARCH_WINDOW_DAYS = 30;
// When locating an event to update/delete by TITLE (not uid) without a pinned range, look this far
// ahead from now. Callers can widen/shift the window (incl. into the past) via fromDate/toDate.
const MUTATE_WINDOW_DAYS = 30;

const CALENDAR_DENIED =
	"Calendar access is not granted. In System Settings ▸ Privacy & Security, grant access to " +
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

/** A lightweight reference to an event, used when a locate matches more than one candidate. */
export interface CalEventRef {
	id: string;
	title: string;
	start: string;
}

/** Options to locate one event for update/delete: by stable `eventId` (uid), or by `title` within a
 *  date window. eventId wins when both are supplied. */
export interface LocateOptions {
	eventId?: string;
	title?: string;
	fromDate?: string;
	toDate?: string;
}

/** Mutable fields for update. Every field is optional; only provided fields are written. A provided
 *  empty string for location/notes CLEARS that field (distinct from `undefined` = leave untouched). */
export interface EventUpdate {
	newTitle?: string;
	newStartDate?: string;
	newEndDate?: string;
	newLocation?: string;
	newNotes?: string;
}

interface MutationResult {
	success: boolean;
	message: string;
	eventId?: string;
	/** Populated when a title locate matched multiple events; the caller should re-issue with an id. */
	candidates?: CalEventRef[];
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

				// Do NOT read ev.uid() back: a property read on a just-created event forces an expensive
				// store/iCloud round-trip (seconds). cal.name() is an existing object → cheap.
				return { calendarName: cal.name() };
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
			| { calendarName: string }
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
		};
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(CALENDAR_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/** Args handed to the locate-and-apply JXA script. Strings use "" (not undefined) so the serialized
 *  source can branch on them; nullable mutation fields use `null` for "leave untouched". */
interface LocateApplyArgs {
	mode: "update" | "delete";
	eventId: string;
	title: string;
	titleLower: string;
	fromMs: number;
	toMs: number;
	cap: number;
	newSummary: string | null;
	newLocation: string | null;
	newDescription: string | null;
	newStartMs: number | null;
	newEndMs: number | null;
}

type LocateApplyResult =
	| { ok: true; id: string; title: string; calendarName: string; changed: string[] }
	| { error: "not_found" }
	| { error: "ambiguous"; candidates: CalEventRef[] };

/**
 * The single, shared locate-and-act primitive behind both `update` and `delete`. Finding an event is
 * identical for both operations, so it lives here once: locate by stable uid (server-side
 * `whose`, bounded full-scan fallback) OR by title within a window, then either mutate the located
 * event's properties in place or delete it — all inside ONE JXA round-trip, so the located event
 * handle never has to cross the @jxa/run boundary.
 *
 * Honesty rules:
 *  - A uid that matches nothing → {error:"not_found"}.
 *  - A title that matches MORE THAN ONE event → {error:"ambiguous", candidates} (never guess which to
 *    rename/move/delete; the caller re-issues with a specific eventId).
 *  - On success we return values captured BEFORE the mutation (or the values we just SET) — we never
 *    read a property back off the mutated/deleted event.
 */
async function locateAndApply(args: LocateApplyArgs): Promise<LocateApplyResult> {
	return (await run((a: LocateApplyArgs) => {
		const C = Application("Calendar");
		const byUid = a.eventId !== "";

		let target: any = null;
		let matchedCalName = "";
		let matchedId = "";
		let matchedTitle = "";
		const matched: {
			ev: any;
			id: string;
			title: string;
			startMs: number;
			calName: string;
		}[] = [];
		let scanned = 0;

		const cals = C.calendars();
		for (
			let ci = 0;
			ci < cals.length && (!byUid || !target) && scanned < a.cap;
			ci++
		) {
			try {
				const cal = cals[ci];
				const calName = cal.name();

				if (byUid) {
					let m: unknown[];
					try {
						m = (cal.events as any).whose({ uid: { _equals: a.eventId } })();
					} catch (_predicateUnsupported) {
						m = [];
					}
					if (m.length === 0) {
						// Bounded manual scan for the uid in this calendar.
						const evs = cal.events();
						for (let ei = 0; ei < evs.length && scanned < a.cap; ei++) {
							scanned++;
							try {
								if ((evs[ei] as any).uid() === a.eventId) {
									m = [evs[ei]];
									break;
								}
							} catch (_badEvent) {
								// skip unreadable event
							}
						}
					}
					if (m.length > 0) {
						target = m[0];
						matchedCalName = calName;
						matchedId = a.eventId;
						try {
							matchedTitle = (target as any).summary() || "";
						} catch (_noTitle) {
							matchedTitle = "";
						}
						break;
					}
				} else {
					const from = new Date(a.fromMs);
					const to = new Date(a.toMs);
					let evs: unknown[];
					try {
						evs = (cal.events as any)
							.whose({
								_and: [
									{ summary: { _contains: a.title } },
									{ startDate: { _greaterThanEquals: from } },
									{ startDate: { _lessThanEquals: to } },
								],
							})();
					} catch (_predicateUnsupported) {
						try {
							evs = cal.events();
						} catch (_badEnum) {
							evs = [];
						}
					}

					for (let ei = 0; ei < evs.length && scanned < a.cap; ei++) {
						scanned++;
						try {
							const ev = evs[ei] as any;
							const start = ev.startDate();
							const startMs = start ? start.getTime() : NaN;
							if (
								!Number.isNaN(startMs) &&
								(startMs < a.fromMs || startMs > a.toMs)
							) {
								continue;
							}
							const summary = ev.summary() || "";
							if (summary.toLowerCase().indexOf(a.titleLower) === -1) continue;
							matched.push({
								ev,
								id: ev.uid(),
								title: summary,
								startMs: Number.isNaN(startMs) ? 0 : startMs,
								calName,
							});
						} catch (_badEvent) {
							// skip an individual unreadable event
						}
					}
				}
			} catch (_badCalendar) {
				// skip a calendar we can't enumerate; a real TCC denial would have thrown above
			}
		}

		if (byUid) {
			if (!target) return { error: "not_found" };
		} else {
			if (matched.length === 0) return { error: "not_found" };
			if (matched.length > 1) {
				return {
					error: "ambiguous",
					candidates: matched.slice(0, 10).map((mm) => ({
						id: mm.id,
						title: mm.title,
						start: mm.startMs ? new Date(mm.startMs).toISOString() : "",
					})),
				};
			}
			target = matched[0].ev;
			matchedCalName = matched[0].calName;
			matchedId = matched[0].id;
			matchedTitle = matched[0].title;
		}

		if (a.mode === "delete") {
			C.delete(target);
			// matchedId/matchedTitle/matchedCalName were all captured BEFORE the delete.
			return {
				ok: true,
				id: matchedId,
				title: matchedTitle,
				calendarName: matchedCalName,
				changed: [],
			};
		}

		// Update: write only the provided fields. Setting a property mutates the store directly; we do
		// NOT read anything back afterward.
		const changed: string[] = [];
		if (a.newSummary !== null) {
			(target as any).summary = a.newSummary;
			changed.push("title");
		}
		if (a.newLocation !== null) {
			(target as any).location = a.newLocation;
			changed.push("location");
		}
		if (a.newDescription !== null) {
			(target as any).description = a.newDescription;
			changed.push("notes");
		}
		if (a.newStartMs !== null) {
			(target as any).startDate = new Date(a.newStartMs);
			changed.push("start");
		}
		if (a.newEndMs !== null) {
			(target as any).endDate = new Date(a.newEndMs);
			changed.push("end");
		}

		return {
			ok: true,
			id: matchedId,
			// Report the new title if we set one, else the pre-mutation title (no read-back).
			title: a.newSummary !== null ? a.newSummary : matchedTitle,
			calendarName: matchedCalName,
			changed,
		};
	}, args)) as LocateApplyResult;
}

/** Build the "no event matched / ambiguous" message shared by update + delete. */
function describeLocate(locator: LocateOptions): string {
	if (locator.eventId && locator.eventId.trim() !== "") {
		return `with ID "${locator.eventId.trim()}"`;
	}
	return `titled "${(locator.title ?? "").trim()}" in the given window`;
}

/**
 * Update an existing event: rename (newTitle), move in time (newStartDate/newEndDate), relocate
 * (newLocation), or re-note (newNotes). Locate the event by stable `eventId` (uid) or by `title`
 * within a window (default now .. +30d; widen via fromDate/toDate). At least one new value is
 * required. A title that matches multiple events returns the candidates instead of guessing. A TCC
 * denial throws PermissionError. No properties are read back after the write.
 */
async function updateEvent(
	locator: LocateOptions,
	changes: EventUpdate,
): Promise<MutationResult> {
	const hasId = !!locator.eventId && locator.eventId.trim() !== "";
	const hasTitle = !!locator.title && locator.title.trim() !== "";
	if (!hasId && !hasTitle) {
		return {
			success: false,
			message: "Provide an eventId or a title to identify the event to update.",
		};
	}

	const newSummaryRaw = changes.newTitle;
	if (newSummaryRaw !== undefined && newSummaryRaw.trim() === "") {
		return { success: false, message: "newTitle cannot be empty." };
	}

	const anyChange =
		changes.newTitle !== undefined ||
		changes.newStartDate !== undefined ||
		changes.newEndDate !== undefined ||
		changes.newLocation !== undefined ||
		changes.newNotes !== undefined;
	if (!anyChange) {
		return {
			success: false,
			message:
				"Nothing to update. Provide at least one of newTitle, newStartDate, newEndDate, newLocation, or newNotes.",
		};
	}

	let newStartMs: number | null = null;
	let newEndMs: number | null = null;
	try {
		if (changes.newStartDate !== undefined) {
			newStartMs = parseDate(changes.newStartDate, "newStartDate").getTime();
		}
		if (changes.newEndDate !== undefined) {
			newEndMs = parseDate(changes.newEndDate, "newEndDate").getTime();
		}
	} catch (error) {
		return {
			success: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
	// We can only cross-validate when BOTH ends are being set; we never read the untouched side back.
	if (newStartMs !== null && newEndMs !== null && newEndMs <= newStartMs) {
		return { success: false, message: "newEndDate must be after newStartDate." };
	}

	const { fromMs, toMs } = hasId
		? { fromMs: 0, toMs: 0 }
		: resolveWindow(locator.fromDate, locator.toDate, MUTATE_WINDOW_DAYS);

	try {
		const result = await locateAndApply({
			mode: "update",
			eventId: hasId ? locator.eventId!.trim() : "",
			title: hasTitle ? locator.title!.trim() : "",
			titleLower: hasTitle ? locator.title!.trim().toLowerCase() : "",
			fromMs,
			toMs,
			cap: MAX_SCAN,
			newSummary: changes.newTitle !== undefined ? changes.newTitle.trim() : null,
			newLocation: changes.newLocation !== undefined ? changes.newLocation : null,
			newDescription: changes.newNotes !== undefined ? changes.newNotes : null,
			newStartMs,
			newEndMs,
		});

		if ("error" in result) {
			if (result.error === "not_found") {
				return {
					success: false,
					message: `No event found ${describeLocate(locator)}.`,
				};
			}
			return {
				success: false,
				message:
					`Multiple events match the title "${(locator.title ?? "").trim()}". ` +
					"Re-issue update with a specific eventId.",
				candidates: result.candidates,
			};
		}

		const fields = result.changed.length ? result.changed.join(", ") : "nothing";
		return {
			success: true,
			message: `Updated "${result.title}" in "${result.calendarName}" (${fields}).`,
			eventId: result.id,
		};
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(CALENDAR_DENIED);
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * Delete an event located by stable `eventId` (uid) or by `title` within a window (default now ..
 * +30d; widen via fromDate/toDate). A title that matches multiple events returns the candidates
 * instead of deleting the wrong one (safety: never guess on a destructive op). A TCC denial throws
 * PermissionError.
 */
async function deleteEvent(locator: LocateOptions): Promise<MutationResult> {
	const hasId = !!locator.eventId && locator.eventId.trim() !== "";
	const hasTitle = !!locator.title && locator.title.trim() !== "";
	if (!hasId && !hasTitle) {
		return {
			success: false,
			message: "Provide an eventId or a title to identify the event to delete.",
		};
	}

	const { fromMs, toMs } = hasId
		? { fromMs: 0, toMs: 0 }
		: resolveWindow(locator.fromDate, locator.toDate, MUTATE_WINDOW_DAYS);

	try {
		const result = await locateAndApply({
			mode: "delete",
			eventId: hasId ? locator.eventId!.trim() : "",
			title: hasTitle ? locator.title!.trim() : "",
			titleLower: hasTitle ? locator.title!.trim().toLowerCase() : "",
			fromMs,
			toMs,
			cap: MAX_SCAN,
			newSummary: null,
			newLocation: null,
			newDescription: null,
			newStartMs: null,
			newEndMs: null,
		});

		if ("error" in result) {
			if (result.error === "not_found") {
				return {
					success: false,
					message: `No event found ${describeLocate(locator)}.`,
				};
			}
			return {
				success: false,
				message:
					`Multiple events match the title "${(locator.title ?? "").trim()}". ` +
					"Re-issue delete with a specific eventId.",
				candidates: result.candidates,
			};
		}

		return {
			success: true,
			message: result.title
				? `Deleted "${result.title}" from "${result.calendarName}".`
				: `Deleted the event from "${result.calendarName}".`,
			eventId: result.id,
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
	updateEvent,
	deleteEvent,
	requestCalendarAccess,
};

export default calendar;
