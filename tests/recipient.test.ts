import { describe, expect, test } from "bun:test";
import { looksLikeHandle, resolveRecipient } from "../utils/recipient";
import { sendableHandle } from "../utils/phone";

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

// THE NUMBER THEY ACTUALLY MESSAGE FROM. A card holds every number a person has ever had, in the order
// somebody typed them in years ago. A real reply to somebody's mother went to the first one, a landline
// that has never carried a message; her actual thread, 7,754 messages of it, is on another number.
// Messages accepted it, opened a new empty chat for the dead number, and marked it error 22.
describe("which of one person's handles to use", () => {
	test("the one with the most recent traffic comes first", () => {
		const cards = [{ name: "Linda Therrien", phones: ["(604) 730-4051", "+16046571752"], emails: [] }];
		const seen = new Map([["+16046571752", "2026-09-01 19:04:05"]]);
		const r = resolveRecipient(cards, seen);
		expect(r.kind).toBe("one");
		expect((r as any).handles[0]).toBe("+16046571752");
	});

	test("a dead number is ordered last, never dropped", () => {
		const cards = [{ name: "Linda", phones: ["(604) 730-4051", "+16046571752"], emails: [] }];
		const seen = new Map([["+16046571752", "2026-09-01 19:04:05"]]);
		expect((resolveRecipient(cards, seen) as any).handles).toContain("(604) 730-4051");
	});

	// The ten-years-ago case must survive: somebody with no history is still reachable at their number.
	test("somebody who has never messaged keeps their handles in card order", () => {
		const cards = [{ name: "Nobody", phones: ["+1555", "+1666"], emails: [] }];
		const r = resolveRecipient(cards, new Map());
		expect(r.kind).toBe("one");
		expect((r as any).handles).toEqual(["+1555", "+1666"]);
	});
});

// NEVER HAND MESSAGES A FORMATTED NUMBER. Sending to "(604) 730-4051" made it open a new chat whose
// identifier is that literal string, mark the message error 22, and crash one second later in IMCore
// sorting its chats. Twice, on the two sends that used that spelling, and never on an E.164 one.
describe("the spelling a send hands to Messages", () => {
	// THE BUG THIS REPLACES, which I shipped and which reached a real person's thread. The first version
	// parsed a bare national number against the MAC'S region. On a machine in Paris, the Canadian home
	// number "(604) 730-4051" became "+336047304051" and a message went to France.
	test("a bare national number is NEVER given a country", () => {
		const before = process.env.APPLE_REGION;
		process.env.APPLE_REGION = "FR";
		try {
			expect(sendableHandle("(604) 730-4051")).toBe("(604) 730-4051");
			expect(sendableHandle("604-730-4051")).toBe("604-730-4051");
		} finally {
			if (before === undefined) delete process.env.APPLE_REGION;
			else process.env.APPLE_REGION = before;
		}
	});

	test("a number that states its country is tidied to E.164", () => {
		expect(sendableHandle("+1 (604) 657-1752")).toBe("+16046571752");
		expect(sendableHandle("+16046571752")).toBe("+16046571752");
	});

	// Reformatting one of these turns a working recipient into an unreachable one.
	test("an email, a short code or a carrier name is left alone", () => {
		expect(sendableHandle("troyth@gmail.com")).toBe("troyth@gmail.com");
		expect(sendableHandle("Free Mobile")).toBe("Free Mobile");
	});
});


// EVERY FIXTURE HERE WRITES THE CARD NUMBER THE WAY REAL CONTACTS WRITES IT, which is as the person
// TYPED it. The previous version of this suite used "+16046571752", byte-identical to chat.db's key, so
// the lookup could not miss and the test passed while the code was inert on every real machine. An
// adversarial review found it: card values come from CNPhoneNumber.stringValue and keep their
// punctuation, chat.db stores E.164, and nothing normalised between them.
describe("ranking handles the way real Contacts spells them", () => {
	const SEEN = new Map([["+16046571752", "2026-09-02 19:04:05"], ["+15551110000", "2019-01-01 00:00:00"]]);

	test("a formatted card number still finds its history", () => {
		const r = resolveRecipient(
			[{ name: "Linda Therrien", phones: ["(604) 730-4051", "+1 (604) 657-1752"], emails: [] }], SEEN);
		expect(r.kind).toBe("one");
		// The ORDER is the assertion: the number with history first, the landline after it.
		expect((r as any).handles).toEqual(["+1 (604) 657-1752", "(604) 730-4051"]);
	});

	// The worst outcome the old bug allowed: every candidate tied at "", so one person was picked with
	// kind "one" and no question asked, and it was whoever happened to be typed without punctuation.
	test("two people are a QUESTION, not a silent pick of the tidily-typed one", () => {
		const r = resolveRecipient([
			{ name: "Linda Therrien", phones: ["+1 (604) 657-1752"], emails: [] },
			{ name: "Melinda Gates", phones: ["+15551110000"], emails: [] }], SEEN);
		expect(r.kind).toBe("several");
	});
});
