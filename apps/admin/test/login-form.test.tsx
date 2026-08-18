import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginForm } from "../src/components/login-form";
import { initI18n } from "../src/i18n";

describe("admin login feedback", () => {
  it("shows the real retry interval when login is rate limited", async () => {
    await initI18n("en-US");
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));

    render(
      <LoginForm
        onAuthenticated={vi.fn()}
        onLogin={vi.fn(async () => ({
          authenticated: false,
          error: "rate_limited",
          retryAfterSeconds: 900
        } as const))}
      />
    );

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Too many login attempts. Try again in 900 seconds.")).toBeTruthy();
  });

  it("recovers the submit button when the login callback rejects", async () => {
    await initI18n("en-US").then((i18n) => i18n.changeLanguage("en-US"));
    render(
      <LoginForm
        onAuthenticated={vi.fn()}
        onLogin={vi.fn(async () => { throw new TypeError("network unavailable"); })}
      />
    );
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Unable to reach the Admin API. Try again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Log in" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });
});
