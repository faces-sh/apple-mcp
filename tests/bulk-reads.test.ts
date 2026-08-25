/// <reference types="bun" />
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { ToolFailure } from "../utils/failure";

// These tests are about the SHAPE of the reads this server makes, not about any particular Mac.
//
// Everything below the JXA boundary is mocked, so what is under test is exactly what a bug lived in:
// how many times we cross that boundary, and what we do with what comes back. The rule these enforce
// is one sentence long: ask a COLLECTION for a property once, never an item for its property n times.
// The Apple apps charge per Apple Event, not per byte, so the difference between the two shapes is the
// difference between 0.44s and ~3,400s on a real note store.

process.env.APPLE_MCP_APP_NAME = "Maestro";

/** What the next `run` call returns, and every call's arguments, so a test can count the crossings. */
let runImpl: (fn: unknown, args?: any) => unknown = () => {
	throw new Error("no run implementation set for this test");
};
let runCalls: { args: any }[] = [];

mock.module("@jxa/run", () => ({
	run: async (fn: unknown, args?: any) => {
		runCalls.push({ args });
		return runImpl(fn, args);
	},
}));

const calendar = (await import("../utils/calendar")).default;
const contacts = (await import("../utils/contacts")).default;
const notes = (await import("../utils/notes")).default;

beforeEach(() => {
	runCalls = [];
});

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 5, 1);
const iso = (ms: number) => new Date(ms).toISOString();

describe("the next events come from the whole account, in time order", () => {
	// THE BUG THIS PINS DOWN. The scan used to fill `limit` one calendar at a time and stop as soon as
	// it was full, so "the next 5 events" meant "5 events out of whichever calendars happen to come
	// first". On a real account that answered with five French public holidays while a work calendar
	// with earlier meetings in the same window was never opened at all.
	//
	// Pass 1 hands back slots in calendar order, which is why the sort in `scanWindow` is the fix and
	// why deleting that one line brings the bug back: the first calendar fills the answer again.
	function twoCalendars() {
		// Calendar 0 holds the LATE events, calendar 1 the early ones, and neither is internally sorted.
		const slots = [
			{ ci: 0, ei: 0, startMs: BASE + 40 * DAY },
			{ ci: 0, ei: 1, startMs: BASE + 42 * DAY },
			{ ci: 0, ei: 2, startMs: BASE + 41 * DAY },
			{ ci: 1, ei: 0, startMs: BASE + 2 * DAY },
			{ ci: 1, ei: 1, startMs: BASE + 1 * DAY },
		];
		let passTwo: any = null;
		runImpl = (_fn, args) => {
			if (runCalls.length === 1) {
				return {
					calendarNames: ["Holidays", "Work"],
					slots,
					visited: 2,
					skippedCalendars: 0,
					firstError: "",
				};
			}
			passTwo = args;
			return {
				items: args.slots.slice(0, args.limit).map((s: any) => ({
					id: `e${s.ci}-${s.ei}`,
					title: `event ${s.ci}-${s.ei}`,
					startDate: iso(s.startMs),
					endDate: iso(s.startMs + 3600000),
					location: null,
					calendarName: args.calendarNames[s.ci],
					notes: null,
				})),
			};
		};
		return { get passTwo() { return passTwo; } };
	}

	test("two events asked for are the two EARLIEST, from the calendar listed second", async () => {
		twoCalendars();
		const events = await calendar.getEvents(2, iso(BASE), iso(BASE + 365 * DAY));

		expect(events.map((e) => e.calendarName)).toEqual(["Work", "Work"]);
		expect(events.map((e) => e.startDate)).toEqual([
			iso(BASE + 1 * DAY),
			iso(BASE + 2 * DAY),
		]);
	});

	test("the details are read in time order, so a cut anywhere is still the earliest n", async () => {
		const probe = twoCalendars();
		await calendar.getEvents(2, iso(BASE), iso(BASE + 365 * DAY));

		const order = probe.passTwo.slots.map((s: any) => s.startMs);
		expect(order).toEqual([...order].sort((a: number, b: number) => a - b));
		// And within one calendar too: 42 days out must not be read before 41.
		expect(order).toEqual([
			BASE + 1 * DAY,
			BASE + 2 * DAY,
			BASE + 40 * DAY,
			BASE + 41 * DAY,
			BASE + 42 * DAY,
		]);
	});

	test("finding the window is ONE crossing per pass, not one per event", async () => {
		twoCalendars();
		await calendar.getEvents(2, iso(BASE), iso(BASE + 365 * DAY));
		// One to find where the events are, one to read what they say. Five events in the window.
		expect(runCalls.length).toBe(2);
	});

	test("an empty window never opens the second pass at all", async () => {
		runImpl = () => ({
			calendarNames: ["Holidays"],
			slots: [],
			visited: 1,
			skippedCalendars: 0,
			firstError: "",
		});
		const events = await calendar.getEvents(5, iso(BASE), iso(BASE + DAY));
		expect(events).toEqual([]);
		expect(runCalls.length).toBe(1);
	});
});

describe("a batch of handles is ONE read of the address book", () => {
	// THE BUG THIS PINS DOWN. `unread` mapped over the messages and asked for a contact name per
	// message, and nothing here caches, so every message read the whole address book over Apple Events
	// on its own. Two unread messages measured 305.9s, of which the sqlite query that finds them was
	// 0.05s: the entire call was two address books being read to put two names on two lines.
	const BOOK = {
		ids: ["A:ABPerson", "B:ABPerson", "C:ABPerson", "D:ABPerson"],
		names: ["Ada Lovelace", "Bruno Rossi", "Chidi Anagonye", "Nobody Useful"],
		emails: [["ada@example.com"], [], ["chidi@example.com", "CHIDI@work.example"], []],
		phones: [[], ["+39 333 1234567"], ["+1 (415) 555-0142"], []],
	};
	const HANDLES = [
		"ada@example.com",
		"+393331234567",
		"+14155550142",
		"CHIDI@WORK.EXAMPLE",
		"+15550009999",
		"nobody@example.com",
	];

	test("six handles cost one crossing, and resolve to the right people", async () => {
		runImpl = () => BOOK;
		const resolved = await contacts.namesForHandles(HANDLES);

		expect(runCalls.length).toBe(1);
		expect(resolved.get("ada@example.com")).toBe("Ada Lovelace");
		expect(resolved.get("+393331234567")).toBe("Bruno Rossi");
		expect(resolved.get("+14155550142")).toBe("Chidi Anagonye");
		expect(resolved.get("CHIDI@WORK.EXAMPLE")).toBe("Chidi Anagonye");
		expect(resolved.has("+15550009999")).toBe(false);
		expect(resolved.has("nobody@example.com")).toBe(false);
	});

	test("the batch answers exactly what asking one at a time answered, at a sixth of the cost",
		async () => {
			runImpl = () => BOOK;
			const resolved = await contacts.namesForHandles(HANDLES);
			const batchCrossings = runCalls.length;

			runCalls = [];
			for (const handle of HANDLES) {
				const one = await contacts.findContactByPhone(handle);
				expect(one).toBe(resolved.get(handle) ?? null);
			}
			// The parity check above is the point; this is what it used to COST to get it.
			expect(runCalls.length).toBe(HANDLES.length);
			expect(batchCrossings).toBe(1);
		});

	test("no handles worth resolving never opens Contacts", async () => {
		runImpl = () => BOOK;
		const resolved = await contacts.namesForHandles(["", "   "]);
		expect(resolved.size).toBe(0);
		expect(runCalls.length).toBe(0);
	});

	test("a card with neither a number nor an address is not a contact anyone can be told about",
		async () => {
			runImpl = () => BOOK;
			const all = await contacts.getAllNumbers();
			expect(Object.keys(all)).toEqual(["Bruno Rossi", "Chidi Anagonye"]);
		});

	test("columns that disagree FAIL, rather than filing one person's number under another's name",
		async () => {
			// A card added between two of the four reads shifts everything after it by one. Reporting
			// that is worse than reporting nothing: it is a wrong fact about somebody's address book.
			runImpl = () => ({
				ids: BOOK.ids,
				names: BOOK.names,
				emails: BOOK.emails,
				phones: [...BOOK.phones, ["+15555555555"]],
			});
			let thrown: unknown;
			try {
				await contacts.getAllNumbers();
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(ToolFailure);
			expect((thrown as ToolFailure).code).toBe("applescript_error");
			expect((thrown as ToolFailure).summary).toContain("changed while it was being read");
			expect((thrown as ToolFailure).body).toContain("4, 4, 4, 5");
		});
});

describe("notes are read a column at a time", () => {
	const STORE = {
		names: ["Shopping", "Epsilon plan", "Untitled", null],
		bodies: [
			"Shopping\nmilk, EPSILON brand oats",
			"Epsilon plan\nship it",
			"a note with no title",
			"orphaned body",
		],
	};

	test("a search matches on the title OR the body, case-insensitively, in one crossing", async () => {
		runImpl = () => STORE;
		const hits = await notes.findNote("epsilon");

		expect(runCalls.length).toBe(1);
		expect(hits.map((n) => n.name)).toEqual(["Shopping", "Epsilon plan"]);
		expect(notes.truncation()).toBeNull();
	});

	test("a title Notes could not give us is still a note", async () => {
		runImpl = () => STORE;
		const all = await notes.getAllNotes();
		expect(all.length).toBe(4);
		expect(all[3].name).toBe("Untitled Note");
		expect(all[3].content).toBe("orphaned body");
	});

	test("columns that disagree FAIL, rather than pairing one note's title with another's body",
		async () => {
			runImpl = () => ({ names: STORE.names, bodies: STORE.bodies.slice(0, 3) });
			let thrown: unknown;
			try {
				await notes.getAllNotes();
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(ToolFailure);
			expect((thrown as ToolFailure).code).toBe("applescript_error");
			expect((thrown as ToolFailure).summary).toContain("changed while it was being read");
		});

	test("a folder scan reads five columns, whatever the folder holds", async () => {
		const created = Date.UTC(2026, 0, 1);
		const modified = Date.UTC(2026, 0, 2);
		runImpl = () => ({
			found: true,
			names: ["One", "Two"],
			bodies: ["first", "second"],
			created: [created, null],
			modified: [modified, null],
		});
		const result = await notes.getNotesFromFolder("Claude");

		expect(runCalls.length).toBe(1);
		expect(result.success).toBe(true);
		expect(result.notes?.map((n) => n.name)).toEqual(["One", "Two"]);
		expect(result.notes?.[0].creationDate?.toISOString()).toBe(iso(created));
		expect(result.notes?.[1].modificationDate).toBeUndefined();
	});

	test("a folder that does not exist is said, not thrown", async () => {
		runImpl = () => ({ found: false, names: [], bodies: [], created: [], modified: [] });
		const result = await notes.getNotesFromFolder("Nope");
		expect(result.success).toBe(false);
		expect(result.message).toContain('"Nope" not found');
	});
});
