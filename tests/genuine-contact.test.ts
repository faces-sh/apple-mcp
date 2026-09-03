import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENUINE_CONTACT } from "../utils/message";

// THE FEEDBACK LOOP THIS CLOSES, which took six failed sends and six crashes of the user's Messages app
// to see. Every message row counted as "in touch", including our OWN undelivered ones:
//
//   send to a dead landline -> fails (is_sent = 0, error = 22)
//   that row makes the dead handle the most recently seen on the machine
//   resolveRecipient ranks by recency, so it starts PREFERRING the dead number
//   unusedNumberFor sees history there, so it stops refusing
//   the next send goes to the same dead number and fails again
//
// Each failure made the wrong answer look more right. Run against real SQLite, because the rule is SQL
// and a rule nobody executes is a rule nobody has checked.
describe("what counts as having been in touch", () => {
	const dir = mkdtempSync(join(tmpdir(), "genuine-"));
	const db = join(dir, "t.db");
	const sql = (q: string) => execFileSync("sqlite3", [db, q], { encoding: "utf8" }).trim();

	sql(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
	     CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INT, item_type INT,
	                           is_from_me INT, is_sent INT, error INT, date INT);
	     INSERT INTO handle VALUES (1,'+15551110000'),(2,'(604) 730-4051'),(3,'+15552220000');
	     -- 1: a real incoming message
	     INSERT INTO message VALUES (10,1,0,0,0,0,100);
	     -- 2: FIVE of our own failed sends, exactly the dead landline's real shape
	     INSERT INTO message VALUES (20,2,0,1,0,22,200),(21,2,0,1,0,22,201),(22,2,0,1,0,22,202),
	                               (23,2,0,1,0,22,203),(24,2,0,1,0,22,204);
	     -- 3: one of ours that genuinely left
	     INSERT INTO message VALUES (30,3,0,1,1,0,300);`);

	const inTouch = () => sql(`SELECT h.id FROM message m JOIN handle h ON h.ROWID=m.handle_id
	                           WHERE m.item_type=0 AND ${GENUINE_CONTACT} GROUP BY h.id ORDER BY h.id`)
		.split("\n").filter(Boolean);

	test("our own FAILED sends are not evidence a number works", () => {
		expect(inTouch()).not.toContain("(604) 730-4051");
	});

	test("a message they sent us counts", () => {
		expect(inTouch()).toContain("+15551110000");
	});

	test("one of ours that genuinely left counts", () => {
		expect(inTouch()).toContain("+15552220000");
	});

	test("and the dead number is not merely ranked last, it is absent", () => {
		expect(inTouch().length).toBe(2);
		rmSync(dir, { recursive: true, force: true });
	});
});
