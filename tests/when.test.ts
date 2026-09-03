import { describe, expect, test } from "bun:test";
import { APPLE_EPOCH_SECONDS, instantOf, periodClause, periodSaid } from "../utils/when";

const back = (ns: number) => new Date((ns / 1e9 + APPLE_EPOCH_SECONDS) * 1000);

// chat.db stores NANOSECONDS since 2001-01-01, which is the most error-prone unit in this codebase: the
// delivery check once compared unix seconds against an apple-epoch threshold, was off by 978,307,200,
// and admitted all 21,140 outgoing messages ever sent. So the conversion lives in one place, tested.
describe("a moment a person named", () => {
	test("a date is that day, in the reader's own timezone", () => {
		const d = back(instantOf("2026-07-01")!);
		expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 6, 1]);
		expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
	});

	// `new Date("2026-07-01")` is UTC midnight: 02:00 in Paris, and the 30th of JUNE in Los Angeles. The
	// same question would cover different days depending on where the Mac is.
	test("it is local midnight, not UTC midnight", () => {
		const d = back(instantOf("2026-07-01")!);
		expect(d.getHours()).toBe(0);
		expect(d.getDate()).toBe(1);
	});

	// "until 31 July" plainly includes the 31st. Getting this backwards silently drops a day from every
	// range anybody asks for, and the loss is invisible in the answer.
	test("a bare date used as an END means the whole of that day", () => {
		const d = back(instantOf("2026-07-31", "end")!);
		expect(d.getDate()).toBe(31);
		expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([23, 59, 59]);
	});

	test("a time is honoured exactly, at either edge", () => {
		for (const edge of ["start", "end"] as const) {
			const d = back(instantOf("2026-07-01 14:30", edge)!);
			expect([d.getHours(), d.getMinutes()]).toEqual([14, 30]);
		}
	});

	// A date the calendar does not have rolls over in the Date constructor: "2026-02-31" becomes the 3rd
	// of March. Answering about a different day is worse than not answering.
	test("a date that does not exist is refused, not rolled over", () => {
		expect(instantOf("2026-02-31")).toBeNull();
		expect(instantOf("2026-13-01")).toBeNull();
	});

	test("anything unreadable is null, so the caller can ignore it", () => {
		for (const junk of ["", "not-a-date", "last tuesday", "07/01/2026", undefined]) {
			expect(instantOf(junk)).toBeNull();
		}
	});
});

describe("the period a query covers", () => {
	test("both ends, one end, or neither", () => {
		expect(periodClause("m.date", "2026-07-01", "2026-07-31")).toMatch(/>=.*AND.*<=/s);
		expect(periodClause("m.date", "2026-07-01")).toMatch(/>=/);
		expect(periodClause("m.date", undefined, "2026-07-31")).toMatch(/<=/);
		expect(periodClause("m.date")).toBe("");
	});

	// Narrowing to nothing on a typo would answer "they never wrote", which is the false negative this
	// whole codebase is built against. An unreadable date is ignored instead, which is visibly wrong.
	test("an unreadable date is IGNORED, never applied", () => {
		expect(periodClause("m.date", "last tuesday")).toBe("");
		expect(periodClause("m.date", "2026-07-01", "garbage")).toMatch(/>=/);
		expect(periodClause("m.date", "2026-07-01", "garbage")).not.toMatch(/<=/);
	});

	test("and the answer only claims a period it actually understood", () => {
		expect(periodSaid("2026-07-01", "2026-07-31")).toBe(" between 2026-07-01 and 2026-07-31");
		expect(periodSaid("2026-07-01")).toBe(" since 2026-07-01");
		expect(periodSaid(undefined, "2026-07-31")).toBe(" up to 2026-07-31");
		expect(periodSaid("last tuesday")).toBe("");
	});
});
