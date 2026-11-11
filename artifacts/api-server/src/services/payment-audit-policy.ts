/**
 * What goes into the payment settings history, and what needs a password.
 *
 * No database here, so every rule can be tested directly.
 */

export type ChangeKind = "added" | "changed" | "removed";

export interface FieldChange {
  field: string;
  change: ChangeKind;
}

/**
 * Changing these decides where crypto payments go, and a crypto payment to the
 * saved address activates with nobody looking. A signed-in browser left open,
 * or a stolen session cookie, is not enough: the admin types their password.
 *
 * The QR is here as well as the address. Students pay to whatever the QR
 * holds, so a swapped QR sends money elsewhere just the same.
 */
const PASSWORD_FIELDS: ReadonlySet<string> = new Set(["cryptoWalletAddress", "cryptoQrMediaId"]);

export function needsPassword(fields: readonly string[]): boolean {
  return fields.some((field) => PASSWORD_FIELDS.has(field));
}

const blank = (value: unknown) => value === null || value === undefined || value === "";

/**
 * Which of `fields` actually changed between `before` and `after`, and how.
 *
 * Only the field names and the kind of change come out — never a value. A
 * field sent with the value it already had is not a change, so saving a form
 * twice does not fill the history.
 */
export function fieldChanges(
  before: Readonly<Record<string, unknown>> | undefined,
  after: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (!(field in after)) continue;
    const was = before?.[field];
    const now = after[field];
    if (blank(was) && blank(now)) continue;
    if (blank(was)) changes.push({ field, change: "added" });
    else if (blank(now)) changes.push({ field, change: "removed" });
    else if (String(was) !== String(now)) changes.push({ field, change: "changed" });
  }
  return changes;
}
