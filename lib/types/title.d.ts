/**
 * Model-backed title generation for `/rename`.
 *
 * The generator reads the current session log (direct user messages plus
 * assembled assistant replies), trims that transcript into the configured
 * byte budget, and issues one auxiliary `session-title` model call. It never
 * writes session events itself: the command layer commits the returned text
 * through `ctx.sessionTitle.rename`, which owns the durable `session/title`
 * event.
 * @module dsh-rename/title
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ResolvedConfig } from './config.ts';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-rename': {
            kind: 'dsh-rename';
        };
    }
}
/** One bounded conversation entry framed for the title model. */
export interface TranscriptEntry {
    /** Speaker role, restricted to the two entries collected from the log. */
    readonly role: 'user' | 'assistant';
    /** Exact visible text from the source message, possibly truncated. */
    readonly text: string;
}
/**
 * Join the visible text blocks of one message content list.
 * Reasoning blocks are excluded on purpose: they are auxiliary work, and a
 * session title should name visible conversation state. Unknown future block
 * types fall through without throwing because `ContentBlock` is
 * merge-extensible.
 * @param content - frozen message content blocks.
 * @returns one trimmed line-separated text, or an empty string.
 */
export declare function textOfContent(content: readonly ContentBlock[]): string;
/**
 * Collect the human-visible conversation from the session log in log order.
 * Only direct human prompts (`source.kind === 'user'`) and assistant replies
 * are collected; synthetic context messages and raw chunks stay out.
 * @param session - exact live session being named.
 * @returns non-empty text-bearing entries, oldest first.
 */
export declare function collectTranscriptEntries(session: Session): TranscriptEntry[];
/**
 * Fit collected entries into the framing byte budget.
 * Whole oldest entries are dropped first so the model keeps the latest work;
 * when one oversized entry remains, its text is truncated on code-point
 * boundaries (with an ellipsis) until the framed JSON fits.
 * @param entries - collected transcript, oldest first.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns bounded transcript that fits when JSON-framed.
 */
export declare function fitTranscript(entries: readonly TranscriptEntry[], maxBytes: number): TranscriptEntry[];
/**
 * Generate one normalized title from the current session transcript.
 * @param ctx - context exposing the LLM service.
 * @param config - resolved deployment policy.
 * @param session - exact live session being named.
 * @param signal - caller cancellation (typically the slash-command UI request).
 * @returns non-empty normalized title text.
 */
export declare function generateSessionTitle(ctx: Context, config: ResolvedConfig, session: Session, signal: AbortSignal): Promise<string>;
//# sourceMappingURL=title.d.ts.map