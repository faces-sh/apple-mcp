import { describe, expect, test } from "bun:test";
import {
	remindersDetail,
	remindersIndex,
} from "../utils/reminders-render";

// These guard ONE thing, and it is the thing that was broken: what the model can actually see.
//
// `reminders list` used to answer `Found 50 lists and 1217 reminders.` and put the reminders in a
// top-level `reminders` field on the MCP result. Nothing reads that field. The model was handed a count
// of things it could not see, with no route to any of them, and it looked like a working tool for as
// long as the operation never returned at all (#499).
//
// So every test below asserts on CONTENT, never on a count, because a count is exactly what the broken
// version produced. Verified by restoring the bug: `remindersIndex` replaced with the old
// `Found ${lists.length} lists and ${all.length} reminders.` fails 5 of these; the current one passes all.

const LISTS = [
	{ id: "L1", name: "Tasks" },
	{ id: "L2", name: "Groceries" },
	{ id: "L3", name: "Empty" },
];

const REMINDERS = [
	{ name: "Call the accountant", id: "R1", listName: "Tasks", completed: false,
	  dueDate: "2026-09-01T09:00:00Z", body: "about the 2025 return" },
	{ name: "File the return", id: "R2", listName: "Tasks", completed: true },
	{ name: "Milk", id: "R3", listName: "Groceries", completed: false },
	{ name: "Orphan", id: "R4", listName: "A list that is gone", completed: false },
];

describe("remindersIndex", () => {
	const text = remindersIndex(LISTS, REMINDERS);

	test("names every reminder, because a count is not an answer", () => {
		for (const r of REMINDERS) expect(text).toContain(r.name);
	});

	test("names every list, with the id listById needs", () => {
		for (const l of LISTS) {
			expect(text).toContain(l.name);
			expect(text).toContain(`[ID: ${l.id}]`);
		}
	});

	test("a reminder whose list is missing is still printed, never dropped", () => {
		// An index that silently loses rows is the failure this rewrite exists to stop: it turns
		// "it is not in your reminders" into a guess.
		expect(text).toContain("Orphan");
	});

	test("says how many are still to do, and marks the done ones", () => {
		expect(text).toContain("3 to do");
		expect(text).toContain("1 done");
		expect(text).toContain("[done] File the return");
	});

	test("to do comes before done inside a list", () => {
		expect(text.indexOf("Call the accountant")).toBeLessThan(text.indexOf("File the return"));
	});

	test("shows a due date a person reads, not an ISO string", () => {
		expect(text).toContain("due ");
		expect(text).not.toContain("2026-09-01T09:00:00Z");
	});

	test("an empty list is shown as empty rather than omitted", () => {
		expect(text).toContain("Empty");
		expect(text).toContain("(empty)");
	});

	test("the index carries names, not notes, so a big store stays affordable", () => {
		// The notes are one `search` away and the header says so. 1,217 reminders with every note
		// would be the 2.3MB mistake notes just had (#504).
		expect(text).not.toContain("about the 2025 return");
		expect(text).toContain("search for it by name");
	});
});

describe("remindersDetail", () => {
	test("carries the notes, which is what search is for", () => {
		const one = remindersDetail(REMINDERS[0]);
		expect(one).toContain("Call the accountant");
		expect(one).toContain("Notes: about the 2025 return");
		expect(one).toContain("List: Tasks");
		expect(one).toContain("ID: R1");
	});

	test("a reminder with no notes says nothing about notes", () => {
		expect(remindersDetail(REMINDERS[2])).not.toContain("Notes:");
	});

	test("marks a completed reminder", () => {
		expect(remindersDetail(REMINDERS[1])).toContain("[done]");
	});
});
