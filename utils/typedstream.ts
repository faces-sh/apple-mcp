/**
 * An `attributedBody` blob, read rather than guessed at.
 *
 * WHAT WAS THERE BEFORE. `decodeAttributedBody` took the hex, ran `Buffer.toString()` over it as UTF-8,
 * and then matched XML-ish patterns (`/NSString">(.*?)</`) that a typedstream does not contain. What came
 * back was the binary reinterpreted as text: on a real machine a message read
 * `https://s.sumup.com/77ojrn_q��iI/����`. That decoder knew the artefact
 * well enough to have a cleanup rule for it, `.replace(/\s*iI\s*[A-Z]\s*$/, "")`, which is the tell: it
 * was deleting the evidence of its own misreading rather than reading the format.
 *
 * THE LAYOUT IS FIXED, so it is read. A string is `+` (0x2B), then a LENGTH, then that many bytes of
 * UTF-8. A length under 128 is one byte; 0x81 means the next two bytes are the length little-endian, 0x82
 * the next three.
 *
 * This is a port of `Resources/voiceprint/bin/vp_imessage_fetch.py`, which reads the same blobs for the
 * voiceprint corpus and is covered by that suite. Two readers of one format is one too many already; the
 * intent is that the Python one comes here rather than a third appearing.
 */

/** Every string in the archive, in the order they appear. */
export function typedstreamStrings(blob: Buffer): string[] {
	const out: string[] = [];
	let i = 0;
	const n = blob.length;
	while (i < n) {
		const plus = blob.indexOf(0x2b, i);
		if (plus === -1 || plus + 1 >= n) break;
		let j = plus + 1;
		let length = blob[j]!;
		j += 1;
		if (length === 0x81) {
			length = blob.readUInt16LE(j);
			j += 2;
		} else if (length === 0x82) {
			length = blob[j]! | (blob[j + 1]! << 8) | (blob[j + 2]! << 16);
			j += 3;
		} else if (length >= 0x80) {
			i = plus + 1;
			continue;
		}
		if (length <= 0 || j + length > n) {
			i = plus + 1;
			continue;
		}
		const slice = blob.subarray(j, j + length);
		const text = slice.toString("utf8");
		// A mis-framed length decodes to replacement characters; that is not a string we found, it is a
		// place we guessed wrong, and passing it on is how the corruption reached the person.
		if (text && !text.includes("�")) out.push(text);
		i = j + length;
	}
	return out;
}

/** Tokens the archive uses to describe ITSELF, never something a person wrote. */
const ARCHIVE_TOKENS = [
	"$classname", "$classes", "$archiver", "NSAttributedString", "NSMutableString",
	"NSDictionary", "NSObject", "NSValue", "NSNumber", "NSString", "streamtyped",
	// Every attribute run names itself, and an audio message's transcript arrives surrounded by these.
	"__kIM",
];

/** Whether a string is the archive talking about itself. */
export function isBookkeeping(text: string): boolean {
	const t = text.trim();
	if (!t) return true;
	if (ARCHIVE_TOKENS.some((token) => t.includes(token))) return true;
	// An attachment's transfer id: `at_0_82F848B5-4D8C-4271-9226-F24FDA501B95`. Never prose, and it sits
	// right beside the transcript on every audio message.
	if (/^at_\d+_[0-9A-Fa-f-]{8,}$/.test(t)) return true;
	if (/^[0-9A-Fa-f-]{16,}$/.test(t)) return true;   // a bare GUID
	return false;
}

/**
 * The message out of a typedstream: the first string that is not the archive's own bookkeeping.
 *
 * ALL OF THEM, NOT THE FIRST RAW ONE. A plain message has one string; anything with formatting has
 * several, because every attribute RUN names itself in the same table. An audio message is the case that
 * matters: the transcript IS the text, and it arrives surrounded by `__kIMFileTransferGUIDAttributeName`
 * and a transfer GUID, so reading the first string returns an attribute name and rejecting attribute
 * names naively drops the transcript.
 */
export function typedstreamText(blob: Buffer): string | undefined {
	for (const candidate of typedstreamStrings(blob)) {
		if (!isBookkeeping(candidate)) return candidate;
	}
	return undefined;
}
