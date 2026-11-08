import { describe, it, expect } from "vitest";
import {
  verifyTransfer,
  formatUnits,
  usdtToBaseUnits,
  hexToBigInt,
  topicToAddress,
  isValidTxHash,
  usdtAmountWithTag,
  freeUsdtAmounts,
  provesClaim,
  type RpcReceipt,
} from "./crypto-verify-policy";
import { USDT_BSC_CONTRACT, TRANSFER_TOPIC } from "./crypto-config";

const WALLET = "0x1111111111111111111111111111111111111111";
const SENDER = "0x2222222222222222222222222222222222222222";

/** A 32-byte topic holding a 20-byte address, right-aligned and zero-padded. */
function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** 18-decimal amount as a 32-byte hex data word. */
function amountData(usdt: string): string {
  return `0x${usdtToBaseUnits(Number(usdt)).toString(16).padStart(64, "0")}`;
}

function receipt(overrides: Partial<RpcReceipt> = {}): RpcReceipt {
  return {
    status: "0x1",
    blockNumber: "0x64", // 100
    logs: [
      {
        address: USDT_BSC_CONTRACT,
        topics: [TRANSFER_TOPIC, addressTopic(SENDER), addressTopic(WALLET)],
        data: amountData("2"),
      },
    ],
    ...overrides,
  };
}

const baseInput = {
  currentBlock: 200,
  walletAddress: WALLET,
  amountExpected: 2,
  confirmations: 15,
  // Mined an hour after the subscription opened, submitted a minute later.
  blockTimestamp: Date.parse("2026-11-01T11:00:00Z") / 1000,
  subscriptionOpenedAt: new Date("2026-11-01T10:00:00Z"),
  submittedAt: new Date("2026-11-01T11:01:00Z"),
  maxAgeDays: 7,
};

describe("verifyTransfer — the happy path", () => {
  it("accepts the right token, amount and recipient", () => {
    const result = verifyTransfer({ ...baseInput, receipt: receipt() });
    expect(result.ok).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.amountUsdt).toBe("2");
    expect(result.senderAddress).toBe(SENDER.toLowerCase());
  });

  it("sums several transfers in one transaction", () => {
    // A batching contract or a splitting wallet can emit more than one.
    // Crediting only the first would under-count a payment that did arrive.
    const log = (amount: string) => ({
      address: USDT_BSC_CONTRACT,
      topics: [TRANSFER_TOPIC, addressTopic(SENDER), addressTopic(WALLET)],
      data: amountData(amount),
    });
    const result = verifyTransfer({
      ...baseInput,
      receipt: receipt({ logs: [log("1"), log("1")] }),
    });
    expect(result.ok).toBe(true);
    expect(result.amountUsdt).toBe("2");
  });
});

describe("verifyTransfer — the token must be real USDT", () => {
  it("refuses a lookalike token at a different contract", () => {
    // The attack this exists to stop: anyone can deploy a token on BSC called
    // "USDT" with Tether's logo. Only the contract address identifies it.
    const result = verifyTransfer({
      ...baseInput,
      receipt: receipt({
        logs: [
          {
            address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            topics: [TRANSFER_TOPIC, addressTopic(SENDER), addressTopic(WALLET)],
            data: amountData("2"),
          },
        ],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("no_matching_transfer");
  });

  it("refuses a non-Transfer event from the real contract", () => {
    const result = verifyTransfer({
      ...baseInput,
      receipt: receipt({
        logs: [
          {
            address: USDT_BSC_CONTRACT,
            topics: ["0x" + "ab".repeat(32), addressTopic(SENDER), addressTopic(WALLET)],
            data: amountData("2"),
          },
        ],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("no_matching_transfer");
  });
});

describe("verifyTransfer — the recipient must be us", () => {
  it("refuses a transfer to someone else's wallet", () => {
    const result = verifyTransfer({
      ...baseInput,
      receipt: receipt({
        logs: [
          {
            address: USDT_BSC_CONTRACT,
            topics: [
              TRANSFER_TOPIC,
              addressTopic(SENDER),
              addressTopic("0x9999999999999999999999999999999999999999"),
            ],
            data: amountData("2"),
          },
        ],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("no_matching_transfer");
  });

  it("matches our wallet whatever the case of the configured address", () => {
    // EVM addresses are case-insensitive apart from the EIP-55 checksum. A log
    // topic arrives lowercased; an env value may be checksummed.
    const result = verifyTransfer({
      ...baseInput,
      walletAddress: WALLET.toUpperCase().replace("0X", "0x"),
      receipt: receipt(),
    });
    expect(result.ok).toBe(true);
  });
});

describe("verifyTransfer — state and finality", () => {
  it("refuses a reverted transaction", () => {
    const result = verifyTransfer({ ...baseInput, receipt: receipt({ status: "0x0" }) });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("tx_failed");
  });

  it("refuses a transaction that is not confirmed enough", () => {
    // Success is not finality: BSC reorgs, and a transfer undone after we
    // activated is a subscription nobody paid for.
    const result = verifyTransfer({ ...baseInput, currentBlock: 105, receipt: receipt() });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("insufficient_confirmations");
    expect(result.confirmationsSeen).toBe(6);
  });

  it("accepts exactly the required confirmations", () => {
    const result = verifyTransfer({ ...baseInput, currentBlock: 114, receipt: receipt() });
    expect(result.confirmationsSeen).toBe(15);
    expect(result.ok).toBe(true);
  });
});

function paying(usdt: string): RpcReceipt {
  return receipt({
    logs: [
      {
        address: USDT_BSC_CONTRACT,
        topics: [TRANSFER_TOPIC, addressTopic(SENDER), addressTopic(WALLET)],
        data: amountData(usdt),
      },
    ],
  });
}

describe("verifyTransfer — the amount identifies the student", () => {
  it("accepts exactly the amount owed, tag included", () => {
    const result = verifyTransfer({
      ...baseInput,
      amountExpected: "2.0037",
      receipt: paying("2.0037"),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses another student's transfer, however real it is", () => {
    // Student B copies A's hash from an explorer. A's tag is not B's.
    const result = verifyTransfer({
      ...baseInput,
      amountExpected: "2.0081",
      receipt: paying("2.0037"),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("amount_too_low");
  });

  it("sends an overpayment to review rather than accepting it", () => {
    // Anyone could otherwise claim a stranger's larger payment.
    const result = verifyTransfer({
      ...baseInput,
      amountExpected: "2.0037",
      receipt: paying("7.0099"),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("amount_not_exact");
    // Recorded, so an admin can see what arrived and decide.
    expect(result.amountUsdt).toBe("7.0099");
  });
});

describe("usdtAmountWithTag", () => {
  it("adds a tag of under ten cents", () => {
    expect(usdtAmountWithTag(2, 37)).toBe("2.0037");
    expect(usdtAmountWithTag(7, 999)).toBe("7.0999");
  });

  it("keeps a fractional price exact", () => {
    expect(usdtAmountWithTag(4.99, 1)).toBe("4.9901");
  });
});

describe("freeUsdtAmounts", () => {
  it("never offers an amount another subscription holds", () => {
    const free = freeUsdtAmounts(2, new Set(["2.0037"]));
    expect(free).not.toContain("2.0037");
    expect(free).toHaveLength(998);
  });

  it("is empty when every amount is held", () => {
    const all = new Set(freeUsdtAmounts(2, new Set()));
    expect(freeUsdtAmounts(2, all)).toEqual([]);
  });
});

describe("verifyTransfer — the transaction's age", () => {
  it("refuses a transfer from before the subscription existed", () => {
    const result = verifyTransfer({
      ...baseInput,
      blockTimestamp: Date.parse("2026-11-01T09:00:00Z") / 1000,
      receipt: receipt(),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("tx_too_old");
  });

  it("allows a few minutes of clock drift around the subscription opening", () => {
    const result = verifyTransfer({
      ...baseInput,
      blockTimestamp: Date.parse("2026-11-01T09:58:00Z") / 1000,
      receipt: receipt(),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a transfer past the age limit, even on an old open subscription", () => {
    const result = verifyTransfer({
      ...baseInput,
      subscriptionOpenedAt: new Date("2026-01-01T00:00:00Z"),
      blockTimestamp: Date.parse("2026-10-20T00:00:00Z") / 1000,
      receipt: receipt(),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("tx_too_old");
  });
});

describe("verifyTransfer — the hold on the amount", () => {
  const minedAt = Date.parse("2026-11-03T12:00:00Z");
  const held = {
    ...baseInput,
    receipt: receipt(),
    blockTimestamp: minedAt / 1000,
    subscriptionOpenedAt: new Date("2026-11-01T10:00:00Z"),
    submittedAt: new Date(minedAt + 60_000),
  };

  it("refuses a transfer mined after the hold ended, when the amount may be someone else's", () => {
    const r = verifyTransfer({ ...held, amountHeldUntil: new Date("2026-11-03T10:00:00Z") });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("amount_hold_expired");
  });

  it("accepts a transfer mined inside the hold, however late it is submitted", () => {
    const r = verifyTransfer({
      ...held,
      amountHeldUntil: new Date("2026-11-03T13:00:00Z"),
      submittedAt: new Date("2026-11-06T12:00:00Z"),
    });
    expect(r.ok).toBe(true);
  });

  it("allows a few minutes of clock drift at the end of the hold", () => {
    const r = verifyTransfer({ ...held, amountHeldUntil: new Date(minedAt - 60_000) });
    expect(r.ok).toBe(true);
  });

  it("does not apply to a subscription with no recorded hold", () => {
    expect(verifyTransfer({ ...held, amountHeldUntil: null }).ok).toBe(true);
  });
});

describe("verifyTransfer — a transaction that cannot match says so at once", () => {
  it("reports the wrong amount before waiting on confirmations", () => {
    const r = verifyTransfer({
      ...baseInput,
      receipt: receipt(),
      amountExpected: "2.0037",
      currentBlock: 101,
    });
    expect(r.failure).toBe("amount_too_low");
  });

  it("still waits on confirmations when the amount is right", () => {
    const r = verifyTransfer({ ...baseInput, receipt: receipt(), currentBlock: 101 });
    expect(r.failure).toBe("insufficient_confirmations");
    expect(r.amountUsdt).toBe("2");
  });
});

describe("provesClaim", () => {
  it("is true for a verified transfer and for one only short of confirmations", () => {
    expect(provesClaim(verifyTransfer({ ...baseInput, receipt: receipt() }))).toBe(true);
    expect(
      provesClaim(verifyTransfer({ ...baseInput, receipt: receipt(), currentBlock: 101 })),
    ).toBe(true);
  });

  it("is false for a transfer of a different amount", () => {
    expect(
      provesClaim(verifyTransfer({ ...baseInput, receipt: receipt(), amountExpected: "2.0037" })),
    ).toBe(false);
  });

  it("is false for a transfer outside the hold", () => {
    const r = verifyTransfer({
      ...baseInput,
      receipt: receipt(),
      amountHeldUntil: new Date(baseInput.subscriptionOpenedAt.getTime() + 1000),
    });
    expect(provesClaim(r)).toBe(false);
  });
});

describe("18 decimals, not 6", () => {
  it("converts whole USDT to base units at 10^18", () => {
    // TRC-20 and ERC-20 USDT use 6 decimals. Reading a BEP-20 amount with 6
    // would misread $2.00 by a factor of a trillion.
    expect(usdtToBaseUnits(2)).toBe(2_000_000_000_000_000_000n);
  });

  it("round-trips a fractional amount without floating point drift", () => {
    expect(formatUnits(usdtToBaseUnits(2.01))).toBe("2.01");
    expect(formatUnits(usdtToBaseUnits(0.1))).toBe("0.1");
  });

  it("handles amounts far beyond Number.MAX_SAFE_INTEGER", () => {
    // 10^18 alone exceeds it; anything that routes an amount through a double
    // loses the low digits of every transfer.
    const raw = 123_456_789_000_000_000_000n;
    expect(formatUnits(raw)).toBe("123.456789");
  });
});

describe("hex helpers", () => {
  it("reads an address out of a padded topic", () => {
    expect(topicToAddress(addressTopic(WALLET))).toBe(WALLET.toLowerCase());
  });

  it("treats an empty data word as zero", () => {
    expect(hexToBigInt("0x")).toBe(0n);
    expect(hexToBigInt("")).toBe(0n);
  });
});

describe("isValidTxHash", () => {
  it("accepts a 32-byte hex hash", () => {
    expect(isValidTxHash(`0x${"a".repeat(64)}`)).toBe(true);
  });

  it("refuses a TRON hash, which has no 0x prefix", () => {
    // The commonest mistake: a student paying from a TRC-20 wallet. Caught
    // here with a clear message rather than queued for an admin who also
    // cannot help.
    expect(isValidTxHash("b".repeat(64))).toBe(false);
  });

  it("refuses a truncated or overlong hash", () => {
    expect(isValidTxHash(`0x${"a".repeat(63)}`)).toBe(false);
    expect(isValidTxHash(`0x${"a".repeat(65)}`)).toBe(false);
  });
});
