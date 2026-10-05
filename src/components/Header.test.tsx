import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Header } from "./Header";

const base = {
    onToggleSidebar: () => {},
    title: "All Songs",
    search: "",
    onSearchChange: () => {},
};

describe("Header search toggle", () => {
    it("shows the magnifier toggle and the (CSS-collapsed) field", () => {
        render(<Header {...base} />);
        expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
        // Field is always in the DOM (desktop shows it; mobile CSS hides it).
        expect(screen.getByRole("searchbox", { name: "Search" })).toBeInTheDocument();
        // No clear button while the field is empty and unopened.
        expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    });

    it("expands on toggle and marks the header search-open", () => {
        const { container } = render(<Header {...base} />);
        fireEvent.click(screen.getByRole("button", { name: "Search" }));
        expect(container.querySelector(".header.search-open")).not.toBeNull();
        expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
    });

    it("focuses the field when expanded via the toggle", () => {
        render(<Header {...base} />);
        fireEvent.click(screen.getByRole("button", { name: "Search" }));
        expect(screen.getByRole("searchbox", { name: "Search" })).toHaveFocus();
    });

    it("clears the query when the clear button is pressed", () => {
        const onSearchChange = vi.fn();
        render(<Header {...base} search="beat" onSearchChange={onSearchChange} />);
        fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
        expect(onSearchChange).toHaveBeenCalledWith("");
    });
});

describe("Header layout toggle", () => {
    it("is absent by default (not an Artists/Albums view)", () => {
        render(<Header {...base} />);
        expect(screen.queryByRole("button", { name: "Grid view" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "List view" })).not.toBeInTheDocument();
    });

    it("marks the active layout and calls onChange when the other is clicked", () => {
        const onChange = vi.fn();
        render(<Header {...base} layoutToggle={{ value: "grid", onChange }} />);
        expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "false");

        fireEvent.click(screen.getByRole("button", { name: "List view" }));
        expect(onChange).toHaveBeenCalledWith("list");
    });
});
