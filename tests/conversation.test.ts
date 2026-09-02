import { describe, expect, test } from "bun:test";
import { conversationsNamed, conversationsWith, namesAsked } from "../utils/conversation";

// Pure half first: what a person names when they name the people in a thread.
describe("the names in a request", () => {
	test("splits the ways people join names", () => {
		expect(namesAsked("Shivani and Hamilton")).toEqual(["Shivani", "Hamilton"]);
		expect(namesAsked("Shivani, Hamilton")).toEqual(["Shivani", "Hamilton"]);
		expect(namesAsked("Shivani & Hamilton")).toEqual(["Shivani", "Hamilton"]);
	});

	// A TWO-WORD NAME IS ONE NAME. Splitting on the space would turn "Mary Jane" into two people who
	// share no thread, and the answer would be a confident "no conversation holds them together".
	test("a two-word name stays one name", () => {
		expect(namesAsked("Mary Jane")).toEqual(["Mary Jane"]);
		expect(namesAsked("John")).toEqual(["John"]);
	});
});

// The query half needs the database, so it is driven through a stubbed sqlite3 like the other suites.
describe("finding a conversation by who is in it", () => {
	test("a group is found by every person in it, and the newest wins", async () => {
		const fixture = [
			{ chat_id: 417, guid: "any;+;g417", style: 43, title: null, participants: "+1408|+1510",
				from_me: 0, body: "recent one", is_hex: 0, date: "2026-09-02 21:27:39" },
			{ chat_id: 359, guid: "any;+;g359", style: 43, title: null, participants: "+1347|+1408|+1510",
				from_me: 0, body: "older one", is_hex: 0, date: "2026-08-01 10:00:00" },
			{ chat_id: 54, guid: "any;-;g54", style: 45, title: null, participants: "+3367",
				from_me: 1, body: "somebody else", is_hex: 0, date: "2026-09-02 21:46:07" },
		];
		const rows = async () => fixture;
		// Two people, each reachable at one handle: both groups hold them, the 1:1 does not.
		const both = await conversationsWith([["+1408"], ["+1510"]], rows);
		expect(both.map((c) => c.chatId)).toEqual([417, 359]);
		expect(both[0]!.isGroup).toBe(true);
		// A person reachable at EITHER of two handles still matches on the one the chat holds.
		const either = await conversationsWith([["+9999", "+1408"], ["+1510"]], rows);
		expect(either.map((c) => c.chatId)).toEqual([417, 359]);
		// Somebody who is in no thread with them matches nothing.
		expect(await conversationsWith([["+1408"], ["+0000"]], rows)).toEqual([]);
	});
});

// THE LEAK, found by driving the real app. Contacts matches loosely, so looking up "Troy Conrad
// Therrien" also returned the card for "Linda Therrien". The old code poured every matching card's
// handles into ONE set, so a chat holding either person matched: asking for the owner's own
// conversation opened his mother's, and a send would have delivered to her.
describe("a name means ONE person, never a pile of them", () => {
	const fixture = [
		{ chat_id: 9, guid: "any;-;g9", style: 45, title: null, participants: "+linda",
			from_me: 0, body: "from mum", is_hex: 0, date: "2026-09-01 19:04:05" },
		{ chat_id: 8, guid: "any;-;g8", style: 45, title: null, participants: "+troy",
			from_me: 0, body: "note to self", is_hex: 0, date: "2026-08-01 10:00:00" },
	];
	const rows = async () => fixture;

	test("two people sharing a surname is a QUESTION, not a merge", async () => {
		const resolveOne = async () => ({
			kind: "several" as const,
			candidates: [
				{ name: "Troy Conrad Therrien", handles: ["+troy"], lastSeen: "2026-08-01" },
				{ name: "Linda Therrien", handles: ["+linda"], lastSeen: "2026-09-01" },
			],
		});
		const found: any = await conversationsNamed("Troy Conrad Therrien", resolveOne, rows);
		expect(found.kind).toBe("several-people");
		expect(found.candidates.map((c: any) => c.name)).toContain("Linda Therrien");
	});

	test("and an unambiguous name opens only that person's thread", async () => {
		const resolveOne = async () => ({ kind: "one" as const, name: "Troy", handles: ["+troy"] });
		const found: any = await conversationsNamed("Troy Conrad Therrien", resolveOne, rows);
		expect(found.kind).toBe("one");
		expect(found.conversation.chatId).toBe(8);
		expect(found.others.length).toBe(0);
	});
});
