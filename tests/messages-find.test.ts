/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";

process.env.APPLE_MCP_APP_NAME = "Maestro";

/**
 * Finding a conversation you did not memorise the phone number of.
 *
 * WHY THESE EXIST. Asked to reply to "the last message from Caroline", the server could not do it by any
 * route. `read` refuses a name ("Caroline is not a usable phone number or email address"); `search`
 * answered "[not_supported] iMessage cannot do that, so nothing was searched"; and the only listing verb
 * was `unread`, which on that Mac returned five of seventy-one unread marketing texts from ten days
 * earlier while the message meant had arrived that afternoon and been read. Contacts was then asked for
 * "Caroline", matched a different one by name, and returned an address with no messages at all.
 *
 * The sqlite boundary is stubbed: what is under test is the SQL we ask for and what we do with the rows,
 * which is where every one of those failures lived.
 */

let rows: unknown[] = [];
let lastSql = "";
let lastOptions: any;

// Spread the real module and override ONLY execFile: replacing it wholesale hides `execFileSync`, which
// something else here imports, and the failure reads as a syntax error in an unrelated file.
const realChildProcess = await import("node:child_process");
mock.module("node:child_process", () => ({
	...realChildProcess,
	execFile: (
		_cmd: string,
		args: string[],
		optionsOrCb: any,
		maybeCb?: (e: unknown, r: { stdout: string; stderr: string }) => void,
	) => {
		const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb!;
		lastOptions = typeof optionsOrCb === "function" ? undefined : optionsOrCb;
		lastSql = args[args.length - 1] ?? "";
		// `access` probes the file; anything else is a query.
		cb(null, { stdout: JSON.stringify(rows), stderr: "" });
	},
}));
const realFsPromises = await import("node:fs/promises");
mock.module("node:fs/promises", () => ({ ...realFsPromises, access: async () => undefined }));
const { default: message } = await import("../utils/message");

/** A typedstream record, as Messages actually stores a body. */
function attributed(text: string): string {
	const body = Buffer.from(text, "utf8");
	return Buffer.concat([Buffer.from("streamtyped", "utf8"),
		Buffer.from([0x2b, body.length]), body]).toString("hex").toUpperCase();
}

describe("recent conversations", () => {
	test("lists who has been talking to you, read or not", async () => {
		rows = [{ handle: "+33617846836", body: attributed("Bonjour"), is_hex: 1, from_me: 0,
			date: "2026-09-02 15:47:13" }];
		const [first] = await message.recentConversations(5);
		expect(first!.handle).toBe("+33617846836");
		expect(first!.lastMessage).toBe("Bonjour");
		expect(first!.fromMe).toBe(false);
	});

	// THE BUG THIS REPLACES: `unread` was the only listing verb, so a message already read was invisible.
	test("does not filter on unread", async () => {
		rows = [];
		await message.recentConversations(5);
		expect(lastSql).not.toContain("is_read");
	});

	// ONE ROW PER PERSON. Twenty messages from one thread is not twenty things to choose between.
	test("asks for one row per conversation", async () => {
		rows = [];
		await message.recentConversations(5);
		expect(lastSql).toContain("GROUP BY handle_id");
	});

	test("puts a name to the number when Contacts knows one", async () => {
		rows = [{ handle: "+33617846836", body: "hi", is_hex: 0, from_me: 0, date: "2026-09-02 15:47:13" }];
		const named = await message.recentConversations(
			5, async () => new Map([["+33617846836", "Caroline Dubois"]]));
		expect(named[0]!.name).toBe("Caroline Dubois");
	});

	// A NAME IS A NICETY. Contacts can be denied (it commonly is, since nothing in Maestro asked for it
	// until today), and the handles are still the answer.
	test("still lists the conversations when Contacts refuses", async () => {
		rows = [{ handle: "+33617846836", body: "hi", is_hex: 0, from_me: 0, date: "x" }];
		const out = await message.recentConversations(5, async () => { throw new Error("denied"); });
		expect(out[0]!.handle).toBe("+33617846836");
		expect(out[0]!.name).toBeUndefined();
	});
});

describe("searching what was said", () => {
	test("finds a message by its words", async () => {
		rows = [
			{ sender: "+33617846836", body: attributed("c'est la rentrée demain"), is_hex: 1, from_me: 0,
				date: "2026-09-02 15:47:13" },
			{ sender: "+15105793963", body: attributed("nothing to do with it"), is_hex: 1, from_me: 0,
				date: "2026-09-01 10:00:00" },
		];
		const { messages: hits } = await message.searchMessages("rentrée", 5);
		expect(hits.length).toBe(1);
		expect(hits[0]!.sender).toBe("+33617846836");
	});

	test("matches whatever the case", async () => {
		rows = [{ sender: "+1", body: attributed("Bonjour CAROLINE"), is_hex: 1, from_me: 0, date: "x" }];
		expect((await message.searchMessages("caroline", 5)).messages.length).toBe(1);
	});

	// MEASURED: of 44,758 messages on a real Mac, 63 had `text` and 44,688 were attributedBody only. So
	// the body has to be decoded before it can be matched, and a `text LIKE` prefilter would find nothing.
	test("searches the bodies it has to decode, not just the text column", async () => {
		rows = [{ sender: "+1", body: attributed("only in the blob"), is_hex: 1, from_me: 0, date: "x" }];
		expect((await message.searchMessages("only in the blob", 5)).messages.length).toBe(1);
		expect(lastSql).not.toContain("LIKE");
	});

	// The concrete thing that broke first: 3,000 rows of hex is ~2.9MB into a 1MB default, and it came
	// back as a bare "could not search" three retries deep with the real cause nowhere in the message.
	test("asks for a buffer big enough for the rows it requested", async () => {
		rows = [];
		await message.searchMessages("x", 5);
		expect(lastOptions?.maxBuffer).toBeGreaterThan(4 * 1024 * 1024);
	});

	test("stops at the limit asked for", async () => {
		rows = Array.from({ length: 20 }, (_, i) => ({
			sender: `+${i}`, body: attributed("same word"), is_hex: 1, from_me: 0, date: "x" }));
		expect((await message.searchMessages("same word", 3)).messages.length).toBe(3);
	});

	test("an empty query searches for nothing rather than everything", async () => {
		rows = [{ sender: "+1", body: attributed("anything"), is_hex: 1, from_me: 0, date: "x" }];
		expect((await message.searchMessages("   ", 5)).messages).toEqual([]);
	});
	// THE DEFECT A PERSON FOUND BY WATCHING A RUN GO IN CIRCLES. "Shivani Hamilton" was one literal
	// string, so it matched only those two words adjacent and in that order, and a thread full of both
	// came back empty while "Shivani" alone found four.
	test("a query is AND over its words, in any order", async () => {
		rows = [
			{ sender: "+1", body: attributed("Perfect. Shivani can you send the invite so Hamilton is synced?"),
				is_hex: 1, from_me: 0, date: "x" },
			{ sender: "+2", body: attributed("Nice to see you today Shivani"), is_hex: 1, from_me: 0, date: "y" },
		];
		const { messages } = await message.searchMessages("Shivani Hamilton", 5);
		expect(messages.length).toBe(1);
		expect(messages[0]!.sender).toBe("+1");
	});

	test("accents fold, so rentree finds rentrée", async () => {
		rows = [{ sender: "+1", body: attributed("c'est la rentrée"), is_hex: 1, from_me: 0, date: "x" }];
		expect((await message.searchMessages("rentree", 5)).messages.length).toBe(1);
	});

	// MEASURED on a real Mac: scanning 1,200 rows found 0 matches for "meeting" and scanning all 30,132
	// found 232, for 160ms more. The ceiling hid 232 messages and the answer said "No messages found".
	test("scans far past the recent handful", async () => {
		rows = [];
		await message.searchMessages("x", 5);
		expect(lastSql).toMatch(/LIMIT\s+(\d{5,})/);
	});

	// AND WHEN IT DOES STOP SHORT, IT SAYS SO. An empty answer is only an answer when somebody looked.
	test("reports the reach when the scan hit its ceiling", async () => {
		rows = Array.from({ length: 50_000 }, (_, i) => ({
			sender: "+1", body: attributed("unrelated"), is_hex: 1, from_me: 0, date: `2020-01-01 00:00:0${i % 10}` }));
		const { messages, coverage } = await message.searchMessages("nothing here", 5);
		expect(messages.length).toBe(0);
		expect(coverage.bounded).toBe(true);
		expect(coverage.scanned).toBe(50_000);
	});

	test("and does not claim a ceiling it never reached", async () => {
		rows = [{ sender: "+1", body: attributed("something"), is_hex: 1, from_me: 0, date: "x" }];
		const { coverage } = await message.searchMessages("absent", 5);
		expect(coverage.bounded).toBe(false);
	});

	test("a hit carries the thread it came out of", async () => {
		rows = [{ sender: "+1", chat_id: 417, body: attributed("found me"), is_hex: 1, from_me: 0, date: "x" }];
		const { messages } = await message.searchMessages("found me", 5);
		expect(messages[0]!.chatId).toBe(417);
	});
});
