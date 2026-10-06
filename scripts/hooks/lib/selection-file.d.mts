export function selectionFilePath(root: string, host?: string): string;
export function writeSelectionFile(root: string, type: string, recordId: string, at: string): void;
export function takeSelectionFile(root: string): { type: string; record_id: string; at: string } | undefined;
