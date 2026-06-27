import { customAlphabet } from "nanoid";

const draftId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
const internalId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 20);

export function newDraftId(): string {
  return draftId();
}

export function newInternalId(): string {
  return internalId();
}
