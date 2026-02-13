import { expect, test } from "@playwright/test";

const runRealPortalE2E = process.env.REAL_PORTAL_E2E === "1";
const describeReal = runRealPortalE2E ? test.describe : test.describe.skip;

describeReal("Portal Real Backend Smoke", () => {
  test("chatui 可通过真实后端完成一次对话闭环", async ({ page }) => {
    test.setTimeout(90_000);

    const prompt = `phase20-real-smoke-${Date.now()}`;

    await page.goto("/");

    await expect(page.getByRole("heading", { name: /ChatUI/i })).toBeVisible();

    const composer = page.getByPlaceholder("输入消息，Enter 发送，Shift+Enter 换行");
    await expect(composer).toBeEnabled({ timeout: 30_000 });

    await composer.fill(prompt);
    await page.getByRole("button", { name: "发送" }).click();

    await expect(page.locator(".bubble-user pre").last()).toContainText(prompt, {
      timeout: 20_000,
    });

    const assistantBubble = page.locator(".bubble-assistant pre").last();
    await expect(assistantBubble).toContainText("[scripted:codex-app-server]", {
      timeout: 60_000,
    });
    await expect(assistantBubble).toContainText(prompt, {
      timeout: 60_000,
    });

    await expect(page.locator(".run-chip")).toContainText("succeeded", {
      timeout: 60_000,
    });
  });
});
