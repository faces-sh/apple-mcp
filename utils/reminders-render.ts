/**
 * TURNING REMINDERS INTO THE TEXT THE MODEL READS.
 *
 * Its own module, and not a few lines inside the dispatch switch, because the bug it fixes was invisible
 * exactly while it lived there: the handler put reminders in a top-level `reminders` field and wrote
 * `Found 50 lists and 1217 reminders.` into `content`. An MCP client reads `content` and NOTHING else, so
 * the model got a count of things it could not see and no way to reach them. Nobody noticed for as long
 * as the operation never returned at all (#499). Out here it is a pure function of its input, so a test
 * can hold it to the one thing that matters: every reminder that went in comes out.
 */

/** A due date a person reads, not an ISO string. Absent when there is no due date. */
export function remindersDue(dueDate?: string | null): string {
	if (!dueDate) return "";
	const at = new Date(dueDate);
	return Number.isNaN(at.getTime()) ? "" : ` (due ${at.toLocaleString()})`;
}

/**
 * ONE reminder in full, for `search` and `listById`, where the caller asked about a few specific things
 * and the notes are the point. The index deliberately does not use this.
 */
export function remindersDetail(r: {
	name: string;
	id?: string;
	body?: string;
	completed?: boolean;
	dueDate?: string | null;
	listName?: string;
}): string {
	return (
		`${r.name}${remindersDue(r.dueDate)}${r.completed ? " [done]" : ""}\n` +
		`List: ${r.listName || "Unknown"}\n` +
		(r.body ? `Notes: ${r.body}\n` : "") +
		`ID: ${r.id ?? "unknown"}`
	);
}

/**
 * The whole store as an INDEX: every list, every reminder, one line each, grouped by list.
 *
 * Nothing is hidden and nothing is truncated, so "it is not in here" is a fact rather than a maybe. What
 * keeps that affordable is that a reminder's name IS the reminder; the notes are the extra, and they are
 * one `search` away. 1,217 reminders come to roughly 60KB this way, against 2.3MB if every note came too.
 *
 * TO DO COMES FIRST, within each list and in the header count, because that is what somebody asking
 * "what are my reminders" means. Done ones stay, marked, because dropping them would make this the
 * silent truncation it is meant to replace.
 */
export function remindersIndex(
	lists: { id: string; name: string }[],
	all: {
		name: string;
		id?: string;
		body?: string;
		completed?: boolean;
		dueDate?: string | null;
		listName?: string;
	}[],
): string {
	const todo = all.filter((r) => !r.completed).length;
	const header =
		`${lists.length} lists, ${all.length} reminders: ${todo} to do, ${all.length - todo} done. ` +
		"Names only. For a reminder's notes, search for it by name.";

	const byList = new Map<string, typeof all>();
	for (const r of all) {
		const key = r.listName || "Unknown";
		const bucket = byList.get(key);
		if (bucket) bucket.push(r);
		else byList.set(key, [r]);
	}

	const line = (r: (typeof all)[number]) =>
		`- ${r.completed ? "[done] " : ""}${r.name}${remindersDue(r.dueDate)}`;

	const sections = lists.map((l) => {
		const mine = byList.get(l.name) ?? [];
		byList.delete(l.name);
		const open = mine.filter((r) => !r.completed);
		const done = mine.filter((r) => r.completed);
		const body = mine.length
			? [...open, ...done].map(line).join("\n")
			: "(empty)";
		return `## ${l.name}  [ID: ${l.id}]\n${body}`;
	});

	// Anything whose list we could not match by name still gets printed. An index that quietly dropped
	// rows would be lying in exactly the way this rewrite exists to stop.
	for (const [name, mine] of byList) {
		sections.push(`## ${name}\n${mine.map(line).join("\n")}`);
	}

	return `${header}\n\n${sections.join("\n\n")}`;
}

