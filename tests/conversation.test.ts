import { describe, expect, test } from "bun:test";
import { conversationsWith, namesAsked } from "../utils/conversation";

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
			{ chat_id: 417, style: 43, title: null, participants: "+1408|+1510",
				from_me: 0, body: "recent one", is_hex: 0, date: "2026-09-02 21:27:39" },
			{ chat_id: 359, style: 43, title: null, participants: "+1347|+1408|+1510",
				from_me: 0, body: "older one", is_hex: 0, date: "2026-08-01 10:00:00" },
			{ chat_id: 54, style: 45, title: null, participants: "+3367",
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
