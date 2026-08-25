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

// Reminders, contacts and calendar are read by MAESTRO now, through EventKit and the Contacts framework,
// so for those three the boundary under test is the loopback call rather than the Apple Event. Same rule,
// one layer out: ask ONCE for what you need, and never once per item.
process.env.MAESTRO_CONTACTS_URL = "http://127.0.0.1:0/contacts";
process.env.MAESTRO_CONTACTS_SECRET = "test";
process.env.MAESTRO_CALENDAR_URL = "http://127.0.0.1:0/calendar";
process.env.MAESTRO_CALENDAR_SECRET = "test";

/** What Maestro answers next, and every ask, so a test can count the crossings. */
let askImpl: (body: any) => unknown = () => {
	throw new Error("no Maestro implementation set for this test");
};
let askCalls: { action: string; body: any }[] = [];

const askingMaestro = (async (_url: any, init: any) => {
	const body = JSON.parse(init.body);
	askCalls.push({ action: body.action, body });
	return {
		status: 200,
		text: async () => JSON.stringify({ ok: "true", ...(askImpl(body) as object) }),
	};
}) as unknown as typeof fetch;
globalThis.fetch = askingMaestro;

const calendar = (await import("../utils/calendar")).default;
const contacts = (await import("../utils/contacts")).default;
const notes = (await import("../utils/notes")).default;

beforeEach(() => {
	runCalls = [];
	askCalls = [];
	// Reinstated every time, so a test that installs its own answer cannot leak into the next one.
	globalThis.fetch = askingMaestro;
});

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 5, 1);
const iso = (ms: number) => new Date(ms).toISOString();

describe("the calendar window is asked for once, and reported honestly", () => {
	// THE BUG THIS USED TO PIN DOWN. The scan filled `limit` one calendar at a time and stopped as soon
	// as it was full, so "the next 5 events" meant "5 events out of whichever calendars came first". On
	// a real account it answered with five French public holidays while a work calendar holding earlier
	// meetings in the same window was never opened.
	//
	// That property now lives in Swift, where the sorting does: see `CalendarOrderTests.swift`, which
	// fails with exactly the old symptom if the cut is taken before the sort. It is NOT tested twice.
	// What is still on this side of the wire is everything below: one ask per call, the window that was
	// asked for, and a short answer that says it is short.
	const EVENTS = [
		{ id: "1", title: "board meeting", startDate: iso(BASE), endDate: iso(BASE + 3600_000),
			calendarName: "Work" },
		{ id: "2", title: "standup", startDate: iso(BASE + DAY), endDate: iso(BASE + DAY + 3600_000),
			calendarName: "Work" },
	];

	test("one call is ONE ask, with the window and the limit on it", async () => {
		askImpl = () => ({ events: EVENTS, total: 2 });
		const got = await calendar.getEvents(5, iso(BASE), iso(BASE + 7 * DAY));

		expect(askCalls.length).toBe(1);
		expect(askCalls[0].action).toBe("events");
		expect(askCalls[0].body.from).toBe(iso(BASE));
		expect(askCalls[0].body.to).toBe(iso(BASE + 7 * DAY));
		expect(askCalls[0].body.limit).toBe(5);
		expect(got.map((e) => e.title)).toEqual(["board meeting", "standup"]);
	});

	test("the order Maestro sent is the order returned, untouched", async () => {
		// Re-sorting here would be a second opinion about the same question, and the two would disagree
		// the first time one of them changed.
		askImpl = () => ({ events: [EVENTS[1], EVENTS[0]], total: 2 });
		const got = await calendar.getEvents(5);
		expect(got.map((e) => e.title)).toEqual(["standup", "board meeting"]);
	});

	test("a limit that cut the answer is SAID, not implied", async () => {
		askImpl = () => ({ events: [EVENTS[0]], total: 34 });
		await calendar.getEvents(1);
		expect(calendar.truncation()).toEqual({ shown: 1, total: 34 });
	});

	test("an answer that was not cut says nothing", async () => {
		askImpl = () => ({ events: EVENTS, total: 2 });
		await calendar.getEvents(10);
		expect(calendar.truncation()).toBeNull();
	});

	test("a search with no text is a search that was never made", async () => {
		let thrown: unknown;
		try {
			await calendar.searchEvents("   ");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ToolFailure);
		expect((thrown as ToolFailure).code).toBe("bad_request");
		expect(askCalls.length).toBe(0);
	});

	test("an empty window is empty, and is still only one ask", async () => {
		askImpl = () => ({ events: [], total: 0 });
		expect(await calendar.getEvents(5)).toEqual([]);
		expect(askCalls.length).toBe(1);
	});

	test("a failed read FAILS rather than reporting an empty diary", async () => {
		globalThis.fetch = (async () => ({
			status: 200,
			text: async () =>
				JSON.stringify({ ok: "false", code: "permission_denied", reason: "no calendar access" }),
		})) as unknown as typeof fetch;

		let thrown: unknown;
		try {
			await calendar.getEvents(5);
		} catch (error) {
			thrown = error;
		}
		// Denied is not empty is not broke. An empty diary is a thing somebody might act on.
		expect(thrown).toBeInstanceOf(ToolFailure);
		expect((thrown as ToolFailure).code).toBe("permission_denied");
	});
});

describe("a batch of handles is ONE read of the address book", () => {
	// THE BUG THIS PINS DOWN. `unread` mapped over the messages and asked for a contact name per
	// message, and nothing here caches, so every message read the whole address book on its own. Two
	// unread messages measured 305.9s, of which the sqlite query that finds them was 0.05s: the entire
	// call was two address books being read to put two names on two lines.
	//
	// The read moved into Maestro, so a crossing is now a loopback ask rather than an Apple Event. The
	// property is unchanged and so is the arithmetic: one read for the batch, not one per handle.
	const CARDS = [
		{ id: "A:ABPerson", name: "Ada Lovelace", emails: ["ada@example.com"], phones: [] },
		{ id: "B:ABPerson", name: "Bruno Rossi", emails: [], phones: ["+39 333 1234567"] },
		{ id: "C:ABPerson", name: "Chidi Anagonye",
			emails: ["chidi@example.com", "CHIDI@work.example"], phones: ["+1 (415) 555-0142"] },
		{ id: "D:ABPerson", name: "Nobody Useful", emails: [], phones: [] },
	];
	const HANDLES = [
		"ada@example.com",
		"+393331234567",
		"+14155550142",
		"CHIDI@WORK.EXAMPLE",
		"+15550009999",
		"nobody@example.com",
	];

	test("six handles cost one crossing, and resolve to the right people", async () => {
		askImpl = () => ({ cards: CARDS });
		const resolved = await contacts.namesForHandles(HANDLES);

		expect(askCalls.length).toBe(1);
		expect(askCalls[0].action).toBe("all");
		expect(resolved.get("ada@example.com")).toBe("Ada Lovelace");
		expect(resolved.get("+393331234567")).toBe("Bruno Rossi");
		expect(resolved.get("+14155550142")).toBe("Chidi Anagonye");
		expect(resolved.get("CHIDI@WORK.EXAMPLE")).toBe("Chidi Anagonye");
		expect(resolved.has("+15550009999")).toBe(false);
		expect(resolved.has("nobody@example.com")).toBe(false);
	});

	test("the batch answers exactly what asking one at a time answered, at a sixth of the cost",
		async () => {
			askImpl = () => ({ cards: CARDS });
			const resolved = await contacts.namesForHandles(HANDLES);
			const batchCrossings = askCalls.length;

			askCalls = [];
			for (const handle of HANDLES) {
				const one = await contacts.findContactByPhone(handle);
				expect(one).toBe(resolved.get(handle) ?? null);
			}
			// The parity check above is the point; this is what it used to COST to get it.
			expect(askCalls.length).toBe(HANDLES.length);
			expect(batchCrossings).toBe(1);
		});

	test("no handles worth resolving never opens Contacts", async () => {
		askImpl = () => ({ cards: CARDS });
		const resolved = await contacts.namesForHandles(["", "   "]);
		expect(resolved.size).toBe(0);
		expect(askCalls.length).toBe(0);
	});

	test("a card with neither a number nor an address is not a contact anyone can be told about",
		async () => {
			// It is still IN the address book, and `getAllContacts` still returns it, because a name
			// with nothing attached answers "do I know a Nobody Useful". What it cannot be is the answer
			// to a HANDLE, because there is no handle on it to match.
			askImpl = () => ({ cards: CARDS });
			expect((await contacts.getAllContacts()).map((c) => c.name)).toContain("Nobody Useful");

			askCalls = [];
			askImpl = () => ({ cards: CARDS });
			const all = await contacts.getAllNumbers();
			expect(Object.keys(all)).toEqual(["Bruno Rossi", "Chidi Anagonye"]);
		});

	test("a search is one read of the book, whatever it is asked", async () => {
		// The version this replaces handed each search term to Contacts as its own `whose` query, so a
		// two-word name cost three round trips. One fetch of 1,645 cards takes 0.79s, which is less than
		// one of those cost, so the filtering came home.
		askImpl = () => ({ cards: CARDS });
		const found = await contacts.findContacts("Chidi Anagonye");
		expect(askCalls.length).toBe(1);
		expect(found.map((c) => c.name)).toEqual(["Chidi Anagonye"]);
	});

	test("the whole query outranks a single word of it", async () => {
		askImpl = () => ({
			cards: [
				{ id: "1", name: "Rossi Catering", emails: ["hi@rossi.example"], phones: [] },
				...CARDS,
			],
		});
		const found = await contacts.findContacts("Bruno Rossi");
		// "Bruno Rossi" matches one card; "Rossi" alone also matches the caterer. Somebody who typed
		// the full name gets that person first.
		expect(found[0].name).toBe("Bruno Rossi");
		expect(found.map((c) => c.name)).toContain("Rossi Catering");
	});

	test("a denial from Maestro is a denial here, in its own words", async () => {
		askImpl = () => {
			throw new Error("unused");
		};
		globalThis.fetch = (async () => ({
			status: 200,
			text: async () =>
				JSON.stringify({
					ok: "false",
					code: "permission_denied",
					reason: "Maestro does not have permission to read your contacts.",
				}),
		})) as unknown as typeof fetch;

		let thrown: unknown;
		try {
			await contacts.getAllContacts();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ToolFailure);
		// Denied is not empty. An empty address book and a refused one are different facts, and the
		// code travels whole rather than being re-worded on the way through.
		expect((thrown as ToolFailure).code).toBe("permission_denied");
		expect((thrown as ToolFailure).summary).toContain("permission");
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
