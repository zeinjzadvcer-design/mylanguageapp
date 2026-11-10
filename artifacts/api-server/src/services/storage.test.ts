import { describe, it, expect } from "vitest";
import {
  recordingKey,
  curriculumKey,
  ALLOWED_AUDIO_TYPES,
  ALLOWED_CMS_TYPES,
  isRegistrableCurriculumKey,
} from "./storage";
import { canReadAsset } from "./media";

describe("recordingKey", () => {
  it("puts the owner's id in the path so ownership is visible from the key", () => {
    expect(recordingKey(42, "audio/webm")).toMatch(/^recordings\/42\//);
  });

  it("uses the extension for the declared content type", () => {
    expect(recordingKey(1, "audio/webm")).toMatch(/\.webm$/);
    expect(recordingKey(1, "audio/mp4")).toMatch(/\.m4a$/);
    expect(recordingKey(1, "audio/mpeg")).toMatch(/\.mp3$/);
  });

  it("falls back to .bin rather than trusting an unknown type in the path", () => {
    expect(recordingKey(1, "application/x-evil")).toMatch(/\.bin$/);
  });

  it("never repeats a key for the same user and type", () => {
    const keys = new Set(Array.from({ length: 200 }, () => recordingKey(7, "audio/webm")));
    expect(keys.size).toBe(200);
  });

  it("groups by month so a bucket listing stays navigable", () => {
    expect(recordingKey(3, "audio/webm")).toMatch(/^recordings\/3\/\d{4}-\d{2}\//);
  });
});

describe("curriculumKey", () => {
  it("keeps a readable slug of the original filename", () => {
    expect(curriculumKey("audio/mpeg", "Unit 3 — Reading.mp3")).toMatch(/^curriculum\/unit-3-reading-/);
  });

  it("strips characters that would change the meaning of a path", () => {
    // Nothing usable survives the slug here, so it falls back to "asset" —
    // what matters is that the traversal cannot reach the key.
    const key = curriculumKey("audio/mpeg", "../../etc/passwd");
    expect(key).not.toContain("..");
    expect(key.split("/")).toHaveLength(2);
    expect(key.startsWith("curriculum/")).toBe(true);
  });

  it("keeps a slug when the name has usable characters around the separators", () => {
    const key = curriculumKey("audio/mpeg", "lesson 4/intro clip.mp3");
    expect(key).toMatch(/^curriculum\/lesson-4-intro-clip-/);
    expect(key.split("/")).toHaveLength(2);
  });

  it("survives a name with nothing usable left in it", () => {
    expect(curriculumKey("image/png", "???.png")).toMatch(/^curriculum\/asset-/);
  });

  it("survives no name at all", () => {
    expect(curriculumKey("image/png", null)).toMatch(/^curriculum\/asset-/);
  });

  it("caps the slug so a pathological filename cannot bloat the key", () => {
    const key = curriculumKey("audio/mpeg", "a".repeat(500) + ".mp3");
    expect(key.length).toBeLessThan(120);
  });
});

describe("allowed content types", () => {
  it("accepts what a browser microphone actually produces", () => {
    // Chrome and Firefox emit webm/opus; Safari emits mp4/aac.
    expect(ALLOWED_AUDIO_TYPES["audio/webm"]).toBeDefined();
    expect(ALLOWED_AUDIO_TYPES["audio/mp4"]).toBeDefined();
  });

  it("does not let a student upload executables or documents as a recording", () => {
    for (const type of ["application/javascript", "text/html", "application/pdf", "image/png"]) {
      expect(ALLOWED_AUDIO_TYPES[type]).toBeUndefined();
    }
  });

  it("lets staff upload images and video that students may not", () => {
    expect(ALLOWED_CMS_TYPES["image/png"]).toBeDefined();
    expect(ALLOWED_CMS_TYPES["video/mp4"]).toBeDefined();
    expect(ALLOWED_AUDIO_TYPES["image/png"]).toBeUndefined();
  });

  it("still refuses executables from staff", () => {
    expect(ALLOWED_CMS_TYPES["application/javascript"]).toBeUndefined();
    expect(ALLOWED_CMS_TYPES["text/html"]).toBeUndefined();
  });
});

describe("canReadAsset", () => {
  const student = { userId: 10, role: "student" };
  const otherStudent = { userId: 11, role: "student" };
  const contentManager = { userId: 99, role: "content_manager" };
  const admin = { userId: 98, role: "admin" };

  it("lets any signed-in user play curriculum material", () => {
    expect(canReadAsset({ ownerUserId: null }, student)).toBe(true);
    expect(canReadAsset({ ownerUserId: null }, otherStudent)).toBe(true);
  });

  it("lets a student play their own recording", () => {
    expect(canReadAsset({ ownerUserId: 10 }, student)).toBe(true);
  });

  it("does not let a student play another student's recording", () => {
    expect(canReadAsset({ ownerUserId: 10 }, otherStudent)).toBe(false);
  });

  it("lets only those who mark work play a student's recording", () => {
    expect(canReadAsset({ ownerUserId: 10 }, contentManager)).toBe(false);
    expect(canReadAsset({ ownerUserId: 10 }, admin)).toBe(true);
  });

  it("refuses a viewer with no role at all", () => {
    expect(canReadAsset({ ownerUserId: 10 }, { userId: 11, role: undefined })).toBe(false);
  });

  it("refuses an unrecognised role rather than defaulting to allow", () => {
    expect(canReadAsset({ ownerUserId: 10 }, { userId: 11, role: "superuser" })).toBe(false);
  });
});

describe("isRegistrableCurriculumKey", () => {
  it.each(["audio/lesson-1.mp3", "curriculum/listening-intro.mp3", "images/a_b.png"])(
    "accepts %s",
    (key) => {
      expect(isRegistrableCurriculumKey(key)).toBe(true);
    },
  );

  it.each([
    "payments/receipt/7/1700000000000-ab12cd34.jpg",
    "payments/qr/1/1700000000000-ab12cd34.png",
    "recordings/7/2026-11/0b6c.webm",
    "Payments/receipt/7/x.jpg",
    "/payments/receipt/7/x.jpg",
    "curriculum/../payments/receipt/7/x.jpg",
    "audio//x.mp3",
    "./audio/x.mp3",
    "audio/x.mp3?x=1",
    "",
  ])("refuses %s", (key) => {
    expect(isRegistrableCurriculumKey(key)).toBe(false);
  });
});

describe("unowned media", () => {
  const anyone = { userId: 11, role: "student" };

  it("is public only for curriculum material and payment QR codes", () => {
    expect(canReadAsset({ ownerUserId: null, purpose: "curriculum" }, anyone)).toBe(true);
    expect(canReadAsset({ ownerUserId: null, purpose: "payment_qr" }, anyone)).toBe(true);
  });

  it("is never public for a receipt or a recording that lost its owner", () => {
    expect(canReadAsset({ ownerUserId: null, purpose: "payment_receipt" }, anyone)).toBe(false);
    expect(canReadAsset({ ownerUserId: null, purpose: "lesson_activity" }, anyone)).toBe(false);
  });
});
