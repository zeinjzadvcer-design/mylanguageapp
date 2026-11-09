import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  batches: [] as Array<Array<{ id: number; key: string }>>,
  remove: vi.fn<(key: string) => Promise<void>>(),
  deleteRow: vi.fn(),
  storage: { configured: true },
}));

vi.mock("./storage", () => ({
  storage: {
    get configured() {
      return h.storage.configured;
    },
    remove: h.remove,
  },
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  // The subquery is built through the same chain, so only `limit` is a read.
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => h.batches.shift() ?? [],
  };
  return {
    ...actual,
    db: {
      select: () => chain,
      delete: () => ({ where: async () => h.deleteRow() }),
    },
  };
});

import { deleteExpiredRecordings } from "./recording-retention";

const batchOf = (count: number, startId = 1) =>
  Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    key: `recordings/${startId + i}.webm`,
  }));

describe("deleteExpiredRecordings", () => {
  beforeEach(() => {
    h.batches = [];
    h.remove.mockReset().mockResolvedValue(undefined);
    h.deleteRow.mockReset();
    h.storage.configured = true;
  });

  it("removes each file and its row", async () => {
    h.batches = [batchOf(2)];
    await expect(deleteExpiredRecordings()).resolves.toBe(2);
    expect(h.remove.mock.calls.map(([key]) => key)).toEqual([
      "recordings/1.webm",
      "recordings/2.webm",
    ]);
    expect(h.deleteRow).toHaveBeenCalledTimes(2);
  });

  it("keeps the row when the file could not be removed, so the next sweep retries", async () => {
    h.batches = [batchOf(2)];
    h.remove.mockRejectedValueOnce(new Error("storage is down"));
    await expect(deleteExpiredRecordings()).resolves.toBe(1);
    expect(h.deleteRow).toHaveBeenCalledTimes(1);
  });

  it("keeps going through a backlog larger than one batch", async () => {
    h.batches = [batchOf(200), batchOf(3, 201)];
    await expect(deleteExpiredRecordings()).resolves.toBe(203);
  });

  it("stops rather than spinning when a full batch cannot be removed", async () => {
    h.batches = [batchOf(200), batchOf(200), batchOf(200)];
    h.remove.mockRejectedValue(new Error("storage is down"));
    await expect(deleteExpiredRecordings()).resolves.toBe(0);
    expect(h.remove).toHaveBeenCalledTimes(200);
  });

  it("does nothing when storage is not configured, so no file is orphaned", async () => {
    h.storage.configured = false;
    h.batches = [batchOf(2)];
    await expect(deleteExpiredRecordings()).resolves.toBe(0);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.deleteRow).not.toHaveBeenCalled();
  });
});
