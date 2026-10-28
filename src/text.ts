/**
 * Split long Markdown into Discord-safe message chunks.
 *
 * Discord rejects messages over 2000 characters. We use a lower limit to leave
 * room for closing and reopening fenced code blocks.
 */
export function splitDiscordMessage(content: string, limit = 1_900): string[] {
	const normalized = content.replace(/\r\n/g, "\n");
	if (normalized.length === 0) return [];
	if (normalized.length <= limit) return [normalized];

	const hardLimit = Math.max(64, limit - 64);
	const lines = normalized.split("\n").flatMap((line) => {
		if (line.length <= hardLimit) return [line];
		const parts: string[] = [];
		for (let index = 0; index < line.length; index += hardLimit) {
			parts.push(line.slice(index, index + hardLimit));
		}
		return parts;
	});

	const chunks: string[] = [];
	let buffer: string[] = [];
	let bufferLength = 0;
	let openFence: string | null = null;

	const flush = (final: boolean) => {
		if (buffer.length === 0) return;
		const chunk = buffer.join("\n");
		if (final) {
			chunks.push(openFence ? `${chunk}\n\`\`\`` : chunk);
			buffer = [];
			bufferLength = 0;
			return;
		}
		chunks.push(openFence ? `${chunk}\n\`\`\`` : chunk);
		buffer = openFence ? [openFence] : [];
		bufferLength = openFence ? openFence.length : 0;
	};

	for (const line of lines) {
		const separator = buffer.length === 0 ? 0 : 1;
		if (bufferLength + separator + line.length > limit && buffer.length > 0) {
			flush(false);
		}

		buffer.push(line);
		bufferLength += (buffer.length === 1 ? 0 : 1) + line.length;

		const fence = line.match(/^\s*(`{3,}|~{3,})/);
		if (fence) {
			const marker = fence[1]!;
			if (!openFence) {
				openFence = marker;
			} else if (
				marker[0] === openFence[0] &&
				marker.length >= openFence.length
			) {
				openFence = null;
			}
		}
	}

	flush(true);

	// A reopen marker can become an empty trailing chunk when content ends on a fence.
	return chunks.filter((chunk) => chunk.trim().length > 0);
}

export function summarizeText(content: string, maxLength = 80): string {
	const singleLine = content.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}
