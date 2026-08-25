import { describe, expect, test } from "bun:test";
import { showing } from "../utils/showing";

// The same bug four times in one week, in four unrelated places, and never a size problem:
//
//     notes list       1,000 of 3,152, silently
//     contacts list       252 of 1,645, silently
//     mail search          10 of about 201, silently
//     messages unread      10 of 70, silently
//
// Each answered truthfully about the rows it held and said nothing about the rows it stopped at. These
// tests are about the difference between those two, which is the whole point of the helper.
//
// Verified against the broken version first: `Found ${shown} ${noun}:`, which is exactly what shipped,
// fails ALL SEVEN.

describe("showing", () => {
	test("a partial answer ADMITS it, and gives the real number", () => {
		const line = showing(10, 70, "unread message(s)");
		expect(line).toContain("Showing 10 of 70");
		// The way out belongs in the sentence, or a caller who learns it was cut has nowhere to go.
		expect(line).toContain("limit");
	});

	test("a complete answer does not pretend there is more", () => {
		const line = showing(4, 4, "unread message(s)");
		expect(line).toBe("4 unread message(s):");
		expect(line).not.toContain("Showing");
		expect(line).not.toContain("limit");
	});

	test("nothing found is an answer, not a failure", () => {
		const line = showing(0, 0, "unread message(s)");
		expect(line).toBe("No unread message(s).");
		// Nothing about permissions: an empty inbox is a fact, and hedging invites a reader to treat it
		// as a problem it is not.
		expect(line).not.toMatch(/permission|denied|error/i);
	});

	test("a total smaller than the page never reads as a bug in us", () => {
		// A broken or racing count must not produce "showing 10 of 4".
		expect(showing(10, 4, "unread message(s)")).toBe("10 unread message(s):");
	});

	test("a total of zero with rows in hand is still not a lie", () => {
		// countUnread returns 0 when it could not count, deliberately, so that path must degrade to the
		// plain form rather than claiming there are none.
		expect(showing(3, 0, "unread message(s)")).toBe("3 unread message(s):");
	});

	test("the subject can be named, for a search that has one", () => {
		expect(showing(2, 9, "results", 'matching "invoices"'))
			.toContain('Showing 2 of 9 results matching "invoices"');
		expect(showing(0, 0, "results", 'matching "invoices"'))
			.toBe('No results matching "invoices".');
	});

	test("at the ceiling it does NOT tell you to ask for more", () => {
		// `messages` clamps at 50. On a Mac with 70 unread, "ask for more with limit" would send somebody
		// to request 100 and receive 50 again. Naming a way out that does not exist is the same fault as
		// the silent cap, one level up.
		const line = showing(50, 70, "unread message(s)", "", 50);
		expect(line).toContain("Showing 50 of 70");
		expect(line).toContain("50 is the most this can return at once");
		expect(line).not.toContain("Ask for more");
	});

	test("below the ceiling it still offers the limit", () => {
		const line = showing(10, 70, "unread message(s)", "", 50);
		expect(line).toContain("Ask for more with limit");
	});

	test("one is one", () => {
		expect(showing(1, 1, "unread message(s)")).toBe("1 unread message(s):");
	});
});
