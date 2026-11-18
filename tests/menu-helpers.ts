import { expect, type Locator, type Page } from '@playwright/test';

export const choiceMenu = (scope: Page | Locator, label: string) => scope.locator(`[data-choice=${JSON.stringify(label)}]`);

export async function chooseMenu(scope: Page | Locator, label: string, value: string) {
  const menu = choiceMenu(scope, label);
  await menu.locator('.subkeyframe-trigger').click();
  await menu.locator(`[data-choice-option=${JSON.stringify(value)}]`).click();
  await expect(menu.locator('.subkeyframe-panel')).toHaveCount(0);
}

export async function expectChoiceCount(scope: Page | Locator, label: string, count: number) {
  const menu = choiceMenu(scope, label);
  await menu.locator('.subkeyframe-trigger').click();
  await expect(menu.locator('[data-choice-option]')).toHaveCount(count);
  await menu.locator('.subkeyframe-back').click();
}
