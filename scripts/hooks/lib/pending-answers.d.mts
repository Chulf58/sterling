export const PENDING_ANSWERS_REL: string;
export function entryFromClaude(stdin: unknown, now?: string): object | null;
export function entryFromOpenCode(call: unknown, now?: string): object | null;
export function readPendingAnswers(root: string): any[];
export function appendPendingAnswer(root: string, entry: object): boolean;
export function resolvePendingAnswers(root: string, ids: string[]): string[];
export function pendingAnswersNotice(root: string): string;
