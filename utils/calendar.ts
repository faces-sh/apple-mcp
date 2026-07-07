import { run } from "@jxa/run";
import { PermissionError, isPermissionDenial } from "./native";
import { runEventKit, type Recurrence } from "./eventkit";

// All calendar data access goes through the native EventKit helper (see utils/eventkit.ts for
// why: speed, one indexed query per window, recurrence). The only Apple Events call left in this
// module is activating the Calendar app for `open` — EventKit reads databases, it cannot bring an
// app forward.

// Default look-ahead windows (days) when the caller does not pin a date range.
const LIST_WINDOW_DAYS = 7;
const SEARCH_WINDOW_DAYS = 30;
// When locating an event to update/delete by TITLE (not id) without a pinned range, look this far
// ahead from now. Callers can widen/shift the window (incl. into the past) via fromDate/toDate.
const MUTATE_WINDOW_DAYS = 30;

/** The shape index.ts consumes. startDate/endDate are local-time ISO-8601 strings. */
export interface CalEvent {
	id: string;
	title: string;
	startDate: string;
	endDate: string;
	location?: string | null;
	calendarName: string;
	notes?: string | null;
	/** Human-readable repeat rule when the event recurs, e.g. "every week". */
	recurrence?: string;
}

/** A lightweight reference to an event, used when a locate matches more than one candidate. */
export interface CalEventRef {
	id: string;
	title: string;
	start: string;
}

/** Options to locate one event for update/delete: by stable `eventId`, or by `title` within a
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
	recurrence?: Recurrence;
}

interface MutationResult {
	success: boolean;
	message: string;
	eventId?: string;
	/** Populated when a title locate matched multiple events; the caller should re-issue with an id. */
	candidates?: CalEventRef[];
}

/** What the helper returns for update/delete/locate ops. */
type HelperMutation =
	| { ok: true; changed?: string[]; event: CalEvent }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "ambiguous"; candidates: CalEventRef[] };

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

/** Probe Calendar access. A denial becomes an actionable message; any other failure re-throws. */
async function requestCalendarAccess(): Promise<{
	hasAccess: boolean;
	message: string;
}> {
	try {
		const now = Date.now();
		await runEventKit<CalEvent[]>("calendar", "list", {
			fromMs: now,
			toMs: now + 1,
			limit: 1,
		});
		return { hasAccess: true, message: "Calendar access is granted." };
	} catch (error) {
		if (error instanceof PermissionError) {
			return { hasAccess: false, message: error.message };
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
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
	return runEventKit<CalEvent[]>("calendar", "list", {
		fromMs,
		toMs,
		limit: Math.max(1, limit),
	});
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
	if (needle === "") return [];
	const { fromMs, toMs } = resolveWindow(fromDate, toDate, SEARCH_WINDOW_DAYS);
	return runEventKit<CalEvent[]>("calendar", "search", {
		text: needle,
		fromMs,
		toMs,
		limit: Math.max(1, limit),
	});
}

/**
 * Open the Calendar app focused on the event with `eventId`. Reports honestly: success only when
 * the event actually exists; a clear "not found" otherwise. A denial throws.
 */
async function openEvent(
	eventId: string,
): Promise<{ success: boolean; message: string }> {
	const id = (eventId ?? "").trim();
	if (id === "") {
		return { success: false, message: "An event ID is required to open an event." };
	}

	const found = await runEventKit<CalEvent | { ok: false; reason: string }>(
		"calendar",
		"get",
		{ eventId: id },
	);
	if ("ok" in found && found.ok === false) {
		return { success: false, message: `No event found with ID "${id}".` };
	}
	const event = found as CalEvent;

	try {
		await run(() => {
			Application("Calendar").activate();
			return true;
		});
	} catch (error) {
		if (isPermissionDenial(error)) {
			throw new PermissionError(
				"Automation access to Calendar is not granted, so the app cannot be brought forward.",
			);
		}
		throw error instanceof Error ? error : new Error(String(error));
	}

	return {
		success: true,
		message: event.title ? `Opened Calendar at "${event.title}".` : "Opened Calendar at the event.",
	};
}

/**
 * Create a new calendar event. Validates inputs locally, then saves through EventKit. An unknown
 * target calendar is an honest {success:false}; a TCC denial throws PermissionError.
 */
async function createEvent(
	title: string,
	startDate: string,
	endDate: string,
	location?: string,
	notes?: string,
	isAllDay = false,
	calendarName?: string,
	recurrence?: Recurrence,
	allowDuplicate?: boolean,
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
		const event = await runEventKit<CalEvent>("calendar", "create", {
			title: title.trim(),
			startMs: start.getTime(),
			endMs: end.getTime(),
			isAllDay: !!isAllDay,
			calendarName,
			location,
			notes,
			recurrence,
			allowDuplicate,
		});
		const repeats = event.recurrence ? `, repeating ${event.recurrence}` : "";
		return {
			success: true,
			message: `Event "${event.title}" created in "${event.calendarName}"${repeats}.`,
			eventId: event.id,
		};
	} catch (error) {
		if (error instanceof PermissionError) throw error;
		return {
			success: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Build the "no event matched / ambiguous" message shared by update + delete. */
function describeLocate(locator: LocateOptions): string {
	if (locator.eventId && locator.eventId.trim() !== "") {
		return `with ID "${locator.eventId.trim()}"`;
	}
	return `titled "${(locator.title ?? "").trim()}" in the given window`;
}

/** Resolve the locator into the helper's payload fields, validating that one exists. */
function locatorPayload(locator: LocateOptions): Record<string, unknown> | null {
	const hasId = !!locator.eventId && locator.eventId.trim() !== "";
	const hasTitle = !!locator.title && locator.title.trim() !== "";
	if (!hasId && !hasTitle) return null;
	if (hasId) {
		return { eventId: locator.eventId!.trim() };
	}
	const { fromMs, toMs } = resolveWindow(locator.fromDate, locator.toDate, MUTATE_WINDOW_DAYS);
	return { title: locator.title!.trim(), fromMs, toMs };
}

/** Map a helper not_found/ambiguous outcome to the caller-facing MutationResult. */
function mutationFailure(
	result: Exclude<HelperMutation, { ok: true }>,
	locator: LocateOptions,
	verb: "update" | "delete",
): MutationResult {
	if (result.reason === "not_found") {
		return { success: false, message: `No event found ${describeLocate(locator)}.` };
	}
	return {
		success: false,
		message:
			`Multiple events match the title "${(locator.title ?? "").trim()}". ` +
			`Re-issue ${verb} with a specific eventId.`,
		candidates: result.candidates,
	};
}

/**
 * Update an existing event: rename (newTitle), move in time (newStartDate/newEndDate), relocate
 * (newLocation), re-note (newNotes), or set a repeat rule (recurrence). Locate the event by stable
 * `eventId` or by `title` within a window (default now .. +30d; widen via fromDate/toDate). At
 * least one new value is required. A title that matches multiple events returns the candidates
 * instead of guessing. On a recurring event the change applies from the located occurrence onward.
 */
async function updateEvent(
	locator: LocateOptions,
	changes: EventUpdate,
): Promise<MutationResult> {
	const locate = locatorPayload(locator);
	if (!locate) {
		return {
			success: false,
			message: "Provide an eventId or a title to identify the event to update.",
		};
	}

	if (changes.newTitle !== undefined && changes.newTitle.trim() === "") {
		return { success: false, message: "newTitle cannot be empty." };
	}

	const anyChange =
		changes.newTitle !== undefined ||
		changes.newStartDate !== undefined ||
		changes.newEndDate !== undefined ||
		changes.newLocation !== undefined ||
		changes.newNotes !== undefined ||
		changes.recurrence !== undefined;
	if (!anyChange) {
		return {
			success: false,
			message:
				"Nothing to update. Provide at least one of newTitle, newStartDate, newEndDate, newLocation, newNotes, or recurrence.",
		};
	}

	let newStartMs: number | undefined;
	let newEndMs: number | undefined;
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
	// We can only cross-validate when BOTH ends are being set.
	if (newStartMs !== undefined && newEndMs !== undefined && newEndMs <= newStartMs) {
		return { success: false, message: "newEndDate must be after newStartDate." };
	}

	const result = await runEventKit<HelperMutation>("calendar", "update", {
		...locate,
		newTitle: changes.newTitle?.trim(),
		newStartMs,
		newEndMs,
		newLocation: changes.newLocation,
		newNotes: changes.newNotes,
		recurrence: changes.recurrence,
	});

	if (!result.ok) return mutationFailure(result, locator, "update");

	const fields = result.changed?.length ? result.changed.join(", ") : "nothing";
	return {
		success: true,
		message: `Updated "${result.event.title}" in "${result.event.calendarName}" (${fields}).`,
		eventId: result.event.id,
	};
}

/**
 * Delete an event located by stable `eventId` or by `title` within a window (default now .. +30d;
 * widen via fromDate/toDate). A title that matches multiple events returns the candidates instead
 * of deleting the wrong one (safety: never guess on a destructive op). On a recurring event the
 * delete applies from the located occurrence onward.
 */
async function deleteEvent(locator: LocateOptions): Promise<MutationResult> {
	const locate = locatorPayload(locator);
	if (!locate) {
		return {
			success: false,
			message: "Provide an eventId or a title to identify the event to delete.",
		};
	}

	const result = await runEventKit<HelperMutation>("calendar", "delete", locate);
	if (!result.ok) return mutationFailure(result, locator, "delete");

	return {
		success: true,
		message: result.event.title
			? `Deleted "${result.event.title}" from "${result.event.calendarName}".`
			: `Deleted the event from "${result.event.calendarName}".`,
		eventId: result.event.id,
	};
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
