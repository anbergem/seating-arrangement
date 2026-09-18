import { expect, test } from "./fixtures";

const UNINVITED_EMAIL = "uninvited@example.invalid";
const UNINVITED_PASSWORD = "uninvited-password";

test("an uninvited signed-in user cannot self-admit through organization routes", async ({
  baseURL,
  browser,
  ownerPage,
  reset,
}) => {
  void reset;
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    const registered = await page.request.post("/_agent-native/auth/register", {
      data: { email: UNINVITED_EMAIL, password: UNINVITED_PASSWORD },
    });
    expect([200, 409]).toContain(registered.status());
    const loggedIn = await page.request.post("/_agent-native/auth/login", {
      data: { email: UNINVITED_EMAIL, password: UNINVITED_PASSWORD },
    });
    expect(loggedIn.status()).toBe(200);

    for (const pathname of [
      "/_agent-native/org",
      "/_agent-native/org/",
      "/_agent-native/org/unmatched-framework-tail",
      "/_agent-native/org/join-by-domain",
    ]) {
      const response = await page.request.post(pathname, {
        data: { name: "Unauthorized Organization", orgId: "org_acme" },
      });
      expect(response.status(), `${pathname}: ${await response.text()}`).toBe(
        403,
      );
    }

    const ownerCreate = await ownerPage.request.post("/_agent-native/org", {
      data: { name: "Owner Cannot Self-Create" },
    });
    expect(ownerCreate.status()).toBe(403);

    const me = await page.request.get("/_agent-native/org/me");
    expect(me.status()).toBe(200);
    const body = (await me.json()) as {
      orgId?: string | null;
      orgs?: unknown[];
    };
    expect(body.orgId).toBeNull();
    expect(body.orgs).toEqual([]);

    const list = await page.request.get("/_agent-native/actions/list-events");
    expect(list.status()).toBe(403);
    const create = await page.request.post(
      "/_agent-native/actions/create-event",
      {
        data: {
          name: "Unauthorized event",
          startsAt: "2026-12-24T18:00:00.000Z",
        },
      },
    );
    expect(create.status()).toBe(403);

    await page.goto("/settings");
    await page.getByRole("tab", { name: "Organization" }).click();
    await expect(page.getByText("Organization access required")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /create organization/i }),
    ).toHaveCount(0);

    const invitation = await ownerPage.request.post(
      "/_agent-native/org/invitations",
      { data: { email: UNINVITED_EMAIL, role: "member" } },
    );
    expect(invitation.status(), await invitation.text()).toBe(200);
    await page.reload();
    const accept = page.getByRole("button", {
      name: "Accept invitation to Acme Services",
    });
    await expect(accept).toBeVisible();
    await accept.click();
    await expect(accept).toHaveCount(0);
    const acceptedAccess = await page.request.get(
      "/_agent-native/actions/list-events",
    );
    expect(acceptedAccess.status()).toBe(200);
    const removed = await ownerPage.request.delete(
      `/_agent-native/org/members/${encodeURIComponent(UNINVITED_EMAIL)}`,
      { data: {} },
    );
    expect(removed.status(), await removed.text()).toBe(200);
  } finally {
    await context.close();
  }
});

test("a signed-out caller remains unauthenticated and invitation membership still works", async ({
  baseURL,
  browser,
  ownerPage,
  outsiderPage,
}) => {
  const anonymous = await browser.newContext({ baseURL });
  try {
    const response = await anonymous.request.post("/_agent-native/org", {
      data: { name: "Anonymous Organization" },
    });
    expect(response.status()).toBe(401);
  } finally {
    await anonymous.close();
  }

  const invitation = await ownerPage.request.post(
    "/_agent-native/org/invitations",
    { data: { email: "outsider@example.invalid", role: "member" } },
  );
  expect(invitation.status(), await invitation.text()).toBe(200);
  const invited = (await invitation.json()) as { id?: string };
  const invitationId = invited.id;
  expect(invitationId).toBeTruthy();

  const accepted = await outsiderPage.request.post(
    `/_agent-native/org/invitations/${invitationId}/accept`,
    { data: {} },
  );
  expect(accepted.status(), await accepted.text()).toBe(200);
  const switched = await outsiderPage.request.put("/_agent-native/org/switch", {
    data: { orgId: "org_other" },
  });
  expect(switched.status(), await switched.text()).toBe(200);
  const ownJobs = await outsiderPage.request.get(
    "/_agent-native/actions/list-events",
  );
  expect(ownJobs.status()).toBe(200);
  const removed = await ownerPage.request.delete(
    `/_agent-native/org/members/${encodeURIComponent("outsider@example.invalid")}`,
    { data: {} },
  );
  expect(removed.status(), await removed.text()).toBe(200);
});

test("an owner cannot enable email-domain auto-join, and the control is not offered", async ({
  ownerPage,
}) => {
  // A non-empty allowed_domain makes the framework admit every new signup at
  // that domain, which is self-admission by another route. The server refuses
  // the write; the Team page does not show a control that cannot work.
  const setDomain = await ownerPage.request.put("/_agent-native/org/domain", {
    data: { domain: "example.invalid" },
  });
  expect(setDomain.status(), await setDomain.text()).toBe(403);

  const me = await ownerPage.request.get("/_agent-native/org/me");
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { allowedDomain?: string | null };
  expect(body.allowedDomain ?? null).toBeNull();

  await ownerPage.goto("/settings");
  await ownerPage.getByRole("tab", { name: "Organization" }).click();
  await expect(ownerPage.getByText("Email domain auto-join")).toBeHidden();

  // Organization switching, the other PUT on this prefix, still works.
  const switched = await ownerPage.request.put("/_agent-native/org/switch", {
    data: { orgId: "org_acme" },
  });
  expect(switched.status(), await switched.text()).toBe(200);
});
