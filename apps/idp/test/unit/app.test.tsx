import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/client/app";

describe("<App />", () => {
  it("renders the product name", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "flare-idp" }),
    ).toBeInTheDocument();
  });
});
