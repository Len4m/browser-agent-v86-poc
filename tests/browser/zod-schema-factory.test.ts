import assert from "node:assert/strict";
import test from "node:test";
import { zodSchemaFactory as z } from "../../src/browser/chat/provider/ai-sdk/zod-schema-factory";

test("the browser schema facade supports every operation used by tool definitions", () => {
  const schema = z.object({
    enabled: z.boolean(),
    label: z.string().describe("label").optional(),
    retries: z.number().nullable(),
    tags: z.array(z.string()),
  }).passthrough();

  const result = schema.safeParse({ enabled: true, retries: null, tags: ["safe"], extra: "preserved" });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.extra, "preserved");

  assert.equal(schema.safeParse({ enabled: "yes", retries: null, tags: [] }).success, false);
});
