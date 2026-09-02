import { describe, expect, test } from "bun:test";
import { looksLikeHandle, resolveRecipient } from "../utils/recipient";

/**
 * Turning "Caroline" into a conversation.
 *
 * The failure this replaces: asked to reply to Caroline, the server refused a name outright, so the
 * caller asked Contacts, which matched a DIFFERENT Caroline by name and returned an address with no
 * messages at all. The right Caroline had texted that afternoon from a French mobile.
 */

const seen = (pairs: [string, string][]) => new Map(pairs);

describe("which person a name means", () => {
	// THE TEN-YEARS-AGO CASE, and why recency must be a tie-breaker and never a filter. One card is the
	// only person it can be, whether or not they have ever texted.
	test("one matching card wins however cold the thread is", () => {
		const r = resolveRecipient([{ name: "Aunt Val", phones: ["+15551234567"], emails: [] }], seen([]));
		expect(r).toEqual({ kind: "one", name: "Aunt Val", handles: ["+15551234567"] });
	});

	// THE CAROLINE CASE. Two people share a name; the one who has actually been in touch is meant.
	test("when a name is shared, who has been in touch decides", () => {
		const r = resolveRecipient(
			[{ name: "Caroline Smith", phones: [], emails: ["cgs2132@columbia.edu"] },
			 { name: "Caroline Dubois", phones: ["+33617846836"], emails: [] }],
			seen([["+33617846836", "2026-09-02 15:47:13"]]),
		);
		expect(r).toEqual({ kind: "one", name: "Caroline Dubois", handles: ["+33617846836"] });
	});

	// AND IT REFUSES TO GUESS when several have been in touch: picking one silently is how the wrong
	// Caroline got picked in the first place.
	test("two people both in touch is a question, not a coin toss", () => {
		const r = resolveRecipient(
			[{ name: "Caroline Smith", phones: ["+1555"], emails: [] },
			 { name: "Caroline Dubois", phones: ["+33617846836"], emails: [] }],
			seen([["+1555", "2026-08-01 10:00:00"], ["+33617846836", "2026-09-02 15:47:13"]]),
		);
		expect(r.kind).toBe("several");
		// Most recent first, so whoever asks is offered the likeliest one at the top.
		expect((r as any).candidates[0].name).toBe("Caroline Dubois");
	});

	test("several with none in touch still asks, and offers them all", () => {
		const r = resolveRecipient(
			[{ name: "John Smith", phones: ["+1"], emails: [] },
			 { name: "John Smithson", phones: ["+2"], emails: [] }],
			seen([]),
		);
		expect(r.kind).toBe("several");
		expect((r as any).candidates.length).toBe(2);
	});

	// THE RULE THAT MATTERS MOST. No card is NOT "no messages from them": most handles have no card, so
	// she may be sitting in the thread list as a bare number. The caller must say something else.
	test("no matching card is unknown, never a denial", () => {
		expect(resolveRecipient([], seen([["+16058177188", "2026-09-02 15:47:13"]])))
			.toEqual({ kind: "unknown" });
	});

	// DENIED IS NOT EMPTY. Told Contacts was denied, "nobody is called that" states a fact about a book
	// never opened, and sends the person looking for a contact instead of a permission. Seen for real:
	// Contacts was ungranted on the machine this was first tried on, so every name looked like a
	// stranger. The caller must be able to tell the two apart, so the resolver reports them apart.
	test("a resolution that could not read Contacts is its own answer", () => {
		// `resolveRecipient` is only ever given cards it HAS; the caller reports `cannot-ask` when the
		// read itself failed. This pins the two kinds as distinct so neither collapses into the other.
		const denied: import("../utils/recipient").Resolution = { kind: "cannot-ask" };
		const empty: import("../utils/recipient").Resolution = { kind: "unknown" };
		expect(denied.kind).not.toBe(empty.kind);
	});

	test("a card with no handles at all cannot be messaged", () => {
		expect(resolveRecipient([{ name: "Ghost", phones: [], emails: [] }], seen([])))
			.toEqual({ kind: "unknown" });
	});

	test("a person's newest handle decides their recency", () => {
		const r = resolveRecipient(
			[{ name: "A", phones: ["+1", "+2"], emails: [] }, { name: "B", phones: ["+3"], emails: [] }],
			seen([["+1", "2026-01-01 00:00:00"], ["+2", "2026-09-02 00:00:00"], ["+3", "2026-05-01 00:00:00"]]),
		);
		expect(r.kind).toBe("several");
		expect((r as any).candidates[0].name).toBe("A");
	});
});

describe("telling a handle from a name", () => {
	test("a number or an address needs no resolving", () => {
		for (const h of ["+33617846836", "605-817-7188", "(605) 817 7188", "cgs2132@columbia.edu"]) {
			expect(looksLikeHandle(h)).toBe(true);
		}
	});

	test("a name is a name", () => {
		for (const n of ["Caroline", "Caroline Dubois", "Aunt Val", "", "   "]) {
			expect(looksLikeHandle(n)).toBe(false);
		}
	});

	// A short-code sender like "SumUp" or "38951" is a handle, not somebody to look up: five digits is
	// the line, because a name never is.
	test("a numeric short code is a handle", () => {
		expect(looksLikeHandle("38951")).toBe(true);
	});
});
