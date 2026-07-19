import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
export const newNodeId = customAlphabet(alphabet, 10);
export const newId = customAlphabet(alphabet, 14);

export function nowIso(): string {
  return new Date().toISOString();
}
