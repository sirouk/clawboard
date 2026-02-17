import { ZodError } from "zod";

type ValidationDetail = {
  loc: (string | number)[];
  msg: string;
  type: string;
};

export const toFastApiDetail = (error: ZodError): ValidationDetail[] =>
  error.issues.map((issue) => ({
    loc: ["body", ...issue.path.map((segment) => String(segment))],
    msg: issue.message,
    type: issue.code
  }));

export const missingCompatibilityContentDetail = (): ValidationDetail[] => [
  {
    loc: ["body", "content"],
    msg: "Field required",
    type: "missing"
  }
];
