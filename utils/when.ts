/**
 * A moment a person named, in the units chat.db stores.
 *
 * `message.date` is NANOSECONDS since the Apple epoch (2001-01-01 UTC), which is the single most
 * error-prone thing in this codebase: the delivery check once compared unix seconds against an
 * apple-epoch threshold, was off by 978,307,200, and silently admitted all 21,140 outgoing messages
 * ever sent. So the conversion lives in ONE pure function with tests, and nothing else does arithmetic
 * on a date.
 *
 * LOCAL TIME, because a person asking for "July" means their July. `new Date("2026-07-01")` is UTC
 * midnight, which in Paris is 02:00 on the 1st and in Los Angeles is 17:00 on the 30th of June: the
 * same query would silently cover different days depending on where the Mac is. The parts are read out
 * and handed to the Date constructor, which is local by definition.
 */
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

export const APPLE_EPOCH_SECONDS = 978_307_200;

/**
 * `2026-07-01`, or `2026-07-01 14:30`, as apple-epoch nanoseconds. `null` when it cannot be read.
 *
 * A DATE WITH NO TIME MEANS THE WHOLE DAY. As a start that is midnight; as an END it is the last
 * instant of that day, because "until 31 July" plainly includes the 31st. Getting that backwards
 * silently drops a day from every range a person asks for.
 */
export function instantOf(value: string | undefined, edge: "start" | "end" = "start"): number | null {
	const m = SHAPE.exec((value ?? "").trim());
	if (!m) return null;
	const [, y, mo, d, hh, mi, ss] = m;
	const dateOnly = hh === undefined;
	const at = new Date(
		Number(y), Number(mo) - 1, Number(d),
		dateOnly ? (edge === "end" ? 23 : 0) : Number(hh),
		dateOnly ? (edge === "end" ? 59 : 0) : Number(mi ?? 0),
		dateOnly ? (edge === "end" ? 59 : 0) : Number(ss ?? 0),
		dateOnly && edge === "end" ? 999 : 0,
	);
	if (Number.isNaN(at.getTime())) return null;
	// A real date the calendar does not have ("2026-02-31") rolls over in the Date constructor. Reject
	// it rather than answer about the 3rd of March.
	if (at.getFullYear() !== Number(y) || at.getMonth() !== Number(mo) - 1
		|| at.getDate() !== Number(d)) return null;
	return Math.round((at.getTime() / 1000 - APPLE_EPOCH_SECONDS) * 1e9);
}

/**
 * The `AND ...` clause for a period, or "" when neither end was given or readable.
 *
 * AN UNREADABLE DATE IS IGNORED, NEVER APPLIED. Narrowing to nothing on a typo would answer "they never
 * wrote", which is the false negative this whole file is built against. Ignoring it returns the
 * ordinary recent handful instead, which is wrong in a way the reader can see.
 */
export function periodClause(column: string, since?: string, until?: string): string {
	const from = instantOf(since, "start");
	const to = instantOf(until, "end");
	const parts: string[] = [];
	if (from !== null) parts.push(`${column} >= ${from}`);
	if (to !== null) parts.push(`${column} <= ${to}`);
	return parts.length ? ` AND ${parts.join(" AND ")}` : "";
}

/** Whether a period was actually understood, for saying so in the answer. */
export function periodSaid(since?: string, until?: string): string {
	const from = instantOf(since, "start") !== null ? since!.trim() : undefined;
	const to = instantOf(until, "end") !== null ? until!.trim() : undefined;
	if (from && to) return ` between ${from} and ${to}`;
	if (from) return ` since ${from}`;
	if (to) return ` up to ${to}`;
	return "";
}
