import { type Page } from "@playwright/test";

const FIXED_NOW_ISO = "2026-02-10T12:00:00.000Z";

export async function applyVisualStabilizers(page: Page) {
  await page.addInitScript(({ fixedNowIso }) => {
    const fixedTs = new Date(fixedNowIso).valueOf();
    const RealDate = Date;

    class FixedDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          super(fixedTs);
          return;
        }
        if (args.length === 1) {
          super(args[0] as string | number | Date);
          return;
        }
        if (args.length === 2) {
          super(args[0] as number, args[1] as number);
          return;
        }
        if (args.length === 3) {
          super(args[0] as number, args[1] as number, args[2] as number);
          return;
        }
        if (args.length === 4) {
          super(args[0] as number, args[1] as number, args[2] as number, args[3] as number);
          return;
        }
        if (args.length === 5) {
          super(args[0] as number, args[1] as number, args[2] as number, args[3] as number, args[4] as number);
          return;
        }
        if (args.length === 6) {
          super(
            args[0] as number,
            args[1] as number,
            args[2] as number,
            args[3] as number,
            args[4] as number,
            args[5] as number
          );
          return;
        }
        super(
          args[0] as number,
          args[1] as number,
          args[2] as number,
          args[3] as number,
          args[4] as number,
          args[5] as number,
          args[6] as number
        );
      }

      static now() {
        return fixedTs;
      }
    }

    FixedDate.parse = RealDate.parse;
    FixedDate.UTC = RealDate.UTC;
    (window as Window & { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor;

    const style = document.createElement("style");
    style.setAttribute("data-testid", "visual-stabilizer-style");
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0ms !important;
        animation-delay: 0ms !important;
        transition-duration: 0ms !important;
        transition-delay: 0ms !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }
    `;
    document.head.appendChild(style);
  }, { fixedNowIso: FIXED_NOW_ISO });
}

export async function gotoPath(page: Page, href: string) {
  await page.goto(href);
  await page.waitForLoadState("domcontentloaded");
}

export async function openTopic(page: Page, topicName: string) {
  const topicExpand = page.getByRole("button", { name: `Expand topic ${topicName}`, exact: true }).first();
  const topicCollapse = page.getByRole("button", { name: `Collapse topic ${topicName}`, exact: true }).first();
  if (await topicCollapse.isVisible().catch(() => false)) return;
  await topicExpand.click();
}

export async function openTask(page: Page, taskName: string) {
  const taskExpand = page.getByRole("button", { name: `Expand task ${taskName}`, exact: true }).first();
  const taskCollapse = page.getByRole("button", { name: `Collapse task ${taskName}`, exact: true }).first();
  if (await taskCollapse.isVisible().catch(() => false)) return;
  await taskExpand.click();
}
