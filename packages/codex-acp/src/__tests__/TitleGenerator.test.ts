import {describe, expect, it} from "vitest";

import {shouldGenerateSessionTitle} from "../TitleGenerator";

describe("workflow title-generation fence", () => {
    it("keeps interactive sessions eligible while excluding engine-stamped workflow sessions", () => {
        expect(shouldGenerateSessionTitle(undefined)).toBe(true);
        expect(shouldGenerateSessionTitle({theme: "dark"})).toBe(true);
        expect(shouldGenerateSessionTitle({runId: "mthm2pfn-30qvj2"})).toBe(false);
    });

    it("does not mistake malformed or empty metadata for an engine run", () => {
        expect(shouldGenerateSessionTitle(null)).toBe(true);
        expect(shouldGenerateSessionTitle([])).toBe(true);
        expect(shouldGenerateSessionTitle({runId: ""})).toBe(true);
        expect(shouldGenerateSessionTitle({runId: 7})).toBe(true);
    });
});
