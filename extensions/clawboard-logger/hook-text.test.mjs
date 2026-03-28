import test from "node:test";
import assert from "node:assert/strict";

import { extractNestedText } from "./hook-text.js";

test("extractNestedText walks common hook payload shapes", () => {
  assert.equal(
    extractNestedText({
      content: [
        { text: "alpha" },
        { value: "beta" },
        { message: { output_text: "gamma" } },
      ],
    }),
    "alpha\nbeta\ngamma",
  );
});

test("extractNestedText stops at the depth guard", () => {
  const deepValue = {
    content: {
      content: {
        content: {
          content: {
            content: {
              text: "too deep",
            },
          },
        },
      },
    },
  };
  assert.equal(extractNestedText(deepValue), undefined);
});
