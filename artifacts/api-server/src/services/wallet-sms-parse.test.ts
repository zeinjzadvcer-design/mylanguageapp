import { describe, it, expect } from "vitest";
import {
  ingestTokenDigest,
  ingestTokenMatches,
  isTrustedServiceCenter,
  parseAllowedServiceCenters,
} from "./wallet-sms-policy";

describe("companion app token", () => {
  it("stores a digest, not the token", () => {
    const stored = ingestTokenDigest("secret-token");
    expect(stored).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stored).not.toContain("secret-token");
  });

  it("matches the token it was made from", () => {
    expect(ingestTokenMatches("secret-token", ingestTokenDigest("secret-token"))).toBe(true);
  });

  it("refuses any other token", () => {
    expect(ingestTokenMatches("guess", ingestTokenDigest("secret-token"))).toBe(false);
    expect(ingestTokenMatches("", ingestTokenDigest("secret-token"))).toBe(false);
  });

  it("still accepts a token stored before hashing, so the phone keeps working", () => {
    expect(ingestTokenMatches("old-plain-token", "old-plain-token")).toBe(true);
    expect(ingestTokenMatches("guess", "old-plain-token")).toBe(false);
  });

  it("does not accept the stored digest itself as a token", () => {
    const stored = ingestTokenDigest("secret-token");
    expect(ingestTokenMatches(stored, stored)).toBe(false);
  });
});

describe("SMS centre check", () => {
  const allowed = parseAllowedServiceCenters("+963 933 000001, 963933000002");

  it("reads a comma-separated list, digits only", () => {
    expect(allowed).toEqual(["963933000001", "963933000002"]);
  });

  it("is off when nothing is configured", () => {
    expect(parseAllowedServiceCenters(undefined)).toEqual([]);
    expect(isTrustedServiceCenter(null, [])).toBe(true);
    expect(isTrustedServiceCenter("+1555", [])).toBe(true);
  });

  it("accepts a listed centre however it is formatted", () => {
    expect(isTrustedServiceCenter("+963933000001", allowed)).toBe(true);
  });

  it("refuses an unlisted centre", () => {
    expect(isTrustedServiceCenter("+15550001111", allowed)).toBe(false);
  });

  it("refuses a message that reports no centre once a list is set", () => {
    expect(isTrustedServiceCenter(null, allowed)).toBe(false);
  });
});
import {
  parseConfirmationSms,
  parseAllowedSenders,
  isTrustedSender,
  toAsciiDigits,
} from "./wallet-sms-policy";

/**
 * The message Syriatel actually sends, as reported by the merchant:
 *
 *     تم استلام مبلغ 1 ل.س بنجاح. رقم العملية هو x
 *
 * Its wording is Syriatel's and undocumented, so these tests pin the two
 * values that matter and deliberately do not pin the words around them.
 */
describe("parseConfirmationSms — the real message", () => {
  it("reads the amount and operation number", () => {
    const result = parseConfirmationSms(
      "تم استلام مبلغ 250000 ل.س بنجاح. رقم العملية هو 600123456789",
    );
    expect(result.amountSyp).toBe("250000");
    expect(result.operationNumber).toBe("600123456789");
  });

  it("reads an amount of 1, as in the message we were shown", () => {
    const result = parseConfirmationSms(
      "تم استلام مبلغ 1 ل.س بنجاح. رقم العملية هو 600999888777",
    );
    expect(result.amountSyp).toBe("1");
    expect(result.operationNumber).toBe("600999888777");
  });
});

describe("parseConfirmationSms — tolerating a reworded message", () => {
  it("does not require the word هو before the number", () => {
    // Syriatel can reword at will. Anchoring on «رقم العملية» and taking the
    // digits that follow survives a colon, or nothing at all, in between.
    expect(
      parseConfirmationSms("تم استلام مبلغ 5000 ل.س. رقم العملية: 600111222333")
        .operationNumber,
    ).toBe("600111222333");
    expect(
      parseConfirmationSms("تم استلام مبلغ 5000 رقم العملية 600111222333").operationNumber,
    ).toBe("600111222333");
  });

  it("survives extra text before and after", () => {
    const result = parseConfirmationSms(
      "عميلنا العزيز، تم استلام مبلغ 300000 ل.س بنجاح في حسابك. رقم العملية هو 600555444333. شكراً لك.",
    );
    expect(result.amountSyp).toBe("300000");
    expect(result.operationNumber).toBe("600555444333");
  });

  it("strips thousands separators — 25,000 and 25000 are one payment", () => {
    expect(parseConfirmationSms("تم استلام مبلغ 25,000 ل.س رقم العملية 6001").amountSyp).toBe(
      "25000",
    );
  });

  it("reads Arabic-Indic digits, which a handset may deliver instead", () => {
    const result = parseConfirmationSms(
      "تم استلام مبلغ ٢٥٠٠٠٠ ل.س بنجاح. رقم العملية هو ٦٠٠١٢٣٤٥٦٧٨٩",
    );
    expect(result.amountSyp).toBe("250000");
    expect(result.operationNumber).toBe("600123456789");
  });
});

describe("parseConfirmationSms — failing visibly", () => {
  it("returns nulls rather than throwing on an unrelated message", () => {
    // A null is the signal that the format changed and an admin should look.
    // Throwing here would lose the message instead of storing it for replay.
    const result = parseConfirmationSms("رصيدك الحالي 1000 ل.س");
    expect(result.operationNumber).toBeNull();
  });

  it("returns nulls on an empty message", () => {
    expect(parseConfirmationSms("")).toEqual({
      operationNumber: null,
      amountSyp: null,
    });
  });

  it("does not mistake a short number for an operation number", () => {
    // Four digits is the floor; anything shorter is likelier a date or an
    // amount caught by a reworded template than an operation reference.
    expect(
      parseConfirmationSms("مبلغ 100 ل.س رقم العملية 12").operationNumber,
    ).toBeNull();
  });

  it("reads the amount even when the operation number is unreadable", () => {
    // Partial parses are kept: the amount alone still tells an admin reviewing
    // an unmatched payment what arrived.
    const result = parseConfirmationSms("تم استلام مبلغ 7500 ل.س بنجاح.");
    expect(result.amountSyp).toBe("7500");
    expect(result.operationNumber).toBeNull();
  });
});

describe("isTrustedSender", () => {
  const allowed = parseAllowedSenders("Syriatel, Syriatel Cash");

  it("accepts a listed sender, ignoring case and spacing", () => {
    expect(isTrustedSender("SYRIATEL", allowed)).toBe(true);
    expect(isTrustedSender(" Syriatel Cash ", allowed)).toBe(true);
  });

  it("refuses a student's number and a lookalike name", () => {
    expect(isTrustedSender("+963944123456", allowed)).toBe(false);
    expect(isTrustedSender("Syriatel-Offers", allowed)).toBe(false);
  });

  it("refuses a message with no sender", () => {
    expect(isTrustedSender(null, allowed)).toBe(false);
  });

  it("defaults to Syriatel when nothing is configured", () => {
    expect(parseAllowedSenders(undefined)).toEqual(["syriatel"]);
  });
});

describe("toAsciiDigits", () => {
  it("normalises Arabic-Indic and Persian digits, so one number compares equal", () => {
    expect(toAsciiDigits("٦٠٠١٢٣")).toBe("600123");
    expect(toAsciiDigits("۶۰۰۱۲۳")).toBe("600123");
    expect(toAsciiDigits("600123")).toBe("600123");
  });
});

describe("parseConfirmationSms — only money received counts", () => {
  it("ignores an outgoing transfer, whose number the other party also knows", () => {
    const result = parseConfirmationSms(
      "تم تحويل مبلغ 250000 ل.س بنجاح. رقم العملية هو 600123456789",
    );
    expect(result.operationNumber).toBeNull();
    expect(result.amountSyp).toBeNull();
  });
});

describe("parseConfirmationSms — amounts are never floats", () => {
  it("returns the amount as a string, so no precision is lost on the way", () => {
    const result = parseConfirmationSms("تم استلام مبلغ 1234567.89 ل.س رقم العملية 600123456");
    expect(typeof result.amountSyp).toBe("string");
    expect(result.amountSyp).toBe("1234567.89");
  });

  it("rejects an unparseable amount rather than reporting NaN", () => {
    expect(parseConfirmationSms("تم استلام مبلغ ... ل.س رقم العملية 600123456").amountSyp).toBeNull();
  });
});

/**
 * The ordering that the old unique index broke.
 *
 * A student pays, the SMS lands, and only then do they open the app and type
 * the operation number in. On arrival the message matches nothing, so it is
 * stored unmatched — and it MUST remain re-ingestable and matchable, because
 * refusing the redelivery burned the number and stranded a real payment.
 */
describe("an SMS is evidence, not a spent payment", () => {
  it("parses the same message identically however many times it arrives", () => {
    const text = "تم استلام مبلغ 572 ل.س بنجاح. رقم العملية هو 600123456789";
    const first = parseConfirmationSms(text);
    const second = parseConfirmationSms(text);

    expect(second).toEqual(first);
    expect(second.operationNumber).toBe("600123456789");
    expect(second.amountSyp).toBe("572");
  });
});
