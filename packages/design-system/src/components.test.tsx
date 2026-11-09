import { render, screen, fireEvent } from "@testing-library/react";
import { Avatar, Banner, Button, Card, EmptyState, Select, SevBadge, SourceChip, StatusBadge, Table, Tabs, Input, initials, SEVERITY_META } from "./index";

describe("SevBadge", () => {
  it("renders label and a distinct shape per severity", () => {
    const shapes = new Set(Object.values(SEVERITY_META).map((m) => m.shape));
    expect(shapes.size).toBe(5);
    const { container } = render(<SevBadge severity="SEV_2" />);
    expect(screen.getByText("SEV-2")).toBeInTheDocument();
    expect(container.querySelector(".mk.tri")).not.toBeNull();
  });
  it("only SEV-1 gets the hot style", () => {
    const { container, rerender } = render(<SevBadge severity="SEV_1" hot />);
    expect(container.querySelector(".sev.hot")).not.toBeNull();
    rerender(<SevBadge severity="SEV_3" hot />);
    expect(container.querySelector(".sev.hot")).toBeNull();
  });
});

describe("StatusBadge", () => {
  it("uses text and shape, not just color", () => {
    const { container } = render(<StatusBadge status="ACKNOWLEDGED" short />);
    expect(screen.getByText("Ack'd")).toBeInTheDocument();
    expect(container.querySelector(".mk.ring")).not.toBeNull();
  });
});

describe("Button", () => {
  it("maps variants and defaults to type=button", () => {
    render(<Button variant="primary">Acknowledge</Button>);
    const b = screen.getByRole("button", { name: "Acknowledge" });
    expect(b).toHaveClass("btn", "pri");
    expect(b).toHaveAttribute("type", "button");
  });
});

describe("Tabs", () => {
  it("switches panels on click and arrow keys", () => {
    render(<Tabs label="t" items={[{ id: "a", label: "A", content: "pa" }, { id: "b", label: "B", count: 3, content: "pb" }]} />);
    expect(screen.getByText("pa")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /B/ }));
    expect(screen.getByRole("tab", { name: /B/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /B/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "A" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Table", () => {
  it("renders headers and rows", () => {
    render(<Table caption="x" rows={[{ id: "1", n: "one" }]} rowKey={(r) => r.id} columns={[{ key: "n", header: "Name", cell: (r) => r.n }]} />);
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "one" })).toBeInTheDocument();
  });
});

describe("misc components", () => {
  it("Select is labelled", () => {
    render(<Select label="Sev" options={[{ value: "", label: "Any" }]} />);
    expect(screen.getByLabelText("Sev")).toBeInTheDocument();
  });
  it("Input is labelled", () => {
    render(<Input label="Search" hideLabel />);
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
  });
  it("Card, Banner, EmptyState, Avatar, SourceChip render", () => {
    render(
      <>
        <Card title="Why it fired">body</Card>
        <Banner tone="amber" action={<a href="#m">Map</a>}>unmapped</Banner>
        <EmptyState title="No open incidents." />
        <Avatar name="Haeun Kim" />
        <SourceChip source="CONSOLE" />
      </>,
    );
    expect(screen.getByRole("heading", { name: "Why it fired" })).toBeInTheDocument();
    expect(screen.getByText("unmapped")).toBeInTheDocument();
    expect(screen.getByText("No open incidents.")).toBeInTheDocument();
    expect(screen.getByText("HK")).toBeInTheDocument();
    expect(screen.getByText("CONSOLE")).toHaveClass("src", "console");
  });
  it("initials", () => {
    expect(initials("Haeun Kim")).toBe("HK");
    expect(initials("everyone")).toBe("EV");
    expect(initials("")).toBe("–");
  });
});
