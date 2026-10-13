/** Post-settlement errors cannot make a saved variant disappear. */
export function shouldRestoreRerollFallback(info: {entryId?:string;error?:string;aborted?:boolean}, savedReplyAfterInput = false): boolean {
 return !info.entryId && !savedReplyAfterInput;
}
