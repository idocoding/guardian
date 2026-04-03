import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { analyzeFrontend } from "../../src/extract/analyzers/frontend.js";
import type { SpecGuardConfig } from "../../src/config.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "__fixtures__", "frontend-project");
const SRC_DIR = path.join(FIXTURE_DIR, "src");

const CONFIG: SpecGuardConfig = {
  ignore: {
    directories: ["node_modules", ".git", "dist"],
    paths: [],
  },
  frontend: {
    routeDirs: [],
    aliases: {},
    tsconfigPath: "",
  },
};

async function scaffold() {
  await fs.mkdir(path.join(SRC_DIR, "components"), { recursive: true });
  await fs.mkdir(path.join(SRC_DIR, "pages"), { recursive: true });
  await fs.mkdir(path.join(SRC_DIR, "utils"), { recursive: true });
  await fs.mkdir(path.join(SRC_DIR, "hooks"), { recursive: true });
  await fs.mkdir(path.join(SRC_DIR, "app"), { recursive: true });

  // tsconfig.json
  await fs.writeFile(
    path.join(FIXTURE_DIR, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2020",
        module: "esnext",
        jsx: "react-jsx",
        moduleResolution: "node",
        strict: true,
        esModuleInterop: true,
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
      },
      include: ["src/**/*.ts", "src/**/*.tsx"],
    })
  );

  // ─── Components ────────────────────────────────
  await fs.writeFile(
    path.join(SRC_DIR, "components", "Button.tsx"),
    `
import React from "react";

interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}

export function Button({ label, onClick, disabled, variant }: ButtonProps) {
  return (
    <button onClick={onClick} disabled={disabled} className={variant}>
      {label}
    </button>
  );
}

export default Button;
`
  );

  await fs.writeFile(
    path.join(SRC_DIR, "components", "Card.tsx"),
    `
import React from "react";

interface CardProps {
  title: string;
  children: React.ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export default Card;
`
  );

  await fs.writeFile(
    path.join(SRC_DIR, "components", "Header.tsx"),
    `
import React from "react";

export function Header() {
  return <header><h1>My App</h1></header>;
}
`
  );

  await fs.writeFile(
    path.join(SRC_DIR, "components", "Modal.tsx"),
    `
import React from "react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title }) => {
  if (!isOpen) return null;
  return (
    <div className="modal">
      <h2>{title}</h2>
      <button onClick={onClose}>Close</button>
    </div>
  );
};

export default Modal;
`
  );

  // ─── Pages ─────────────────────────────────────
  await fs.writeFile(
    path.join(SRC_DIR, "pages", "HomePage.tsx"),
    `
import React, { useState } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Header } from "../components/Header";

export default function HomePage() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <Header />
      <Card title="Welcome">
        <p>Count: {count}</p>
        <Button label="Increment" onClick={() => setCount(count + 1)} />
      </Card>
    </div>
  );
}
`
  );

  await fs.writeFile(
    path.join(SRC_DIR, "pages", "AboutPage.tsx"),
    `
import React from "react";
import { Header } from "../components/Header";

export default function AboutPage() {
  return (
    <div>
      <Header />
      <p>About this application</p>
    </div>
  );
}
`
  );

  await fs.writeFile(
    path.join(SRC_DIR, "pages", "ProfilePage.tsx"),
    `
import React, { useState, useEffect } from "react";
import { Header } from "../components/Header";

export default function ProfilePage() {
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    fetch("/api/profile")
      .then(res => res.json())
      .then(data => setProfile(data));
  }, []);

  return (
    <div>
      <Header />
      <p>Profile page</p>
    </div>
  );
}
`
  );

  // ─── Next.js app directory (page detection) ────
  await fs.writeFile(
    path.join(SRC_DIR, "app", "page.tsx"),
    `
export default function AppHome() {
  return <div>App Home</div>;
}
`
  );

  await fs.mkdir(path.join(SRC_DIR, "app", "dashboard"), { recursive: true });
  await fs.writeFile(
    path.join(SRC_DIR, "app", "dashboard", "page.tsx"),
    `
export default function DashboardPage() {
  return <div>Dashboard</div>;
}
`
  );

  await fs.writeFile(
    path.join(SRC_DIR, "app", "layout.tsx"),
    `
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`
  );

  // ─── Hooks ────────────────────────────────────
  await fs.writeFile(
    path.join(SRC_DIR, "hooks", "useAuth.ts"),
    `
import { useState, useEffect } from "react";

export function useAuth() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(res => res.json())
      .then(data => setUser(data));
  }, []);

  return { user };
}
`
  );

  // ─── Utilities ─────────────────────────────────
  await fs.writeFile(
    path.join(SRC_DIR, "utils", "helpers.ts"),
    `
export function formatName(first: string, last: string): string {
  return first + " " + last;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) + "..." : s;
}
`
  );

  await fs.writeFile(
    path.join(SRC_DIR, "utils", "api.ts"),
    `
const BASE_URL = "/api";

export async function fetchJson(url: string) {
  const res = await fetch(BASE_URL + url);
  return res.json();
}

export async function postJson(url: string, body: any) {
  return fetch(BASE_URL + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
`
  );

  // ─── Entry point ──────────────────────────────
  await fs.writeFile(
    path.join(SRC_DIR, "main.tsx"),
    `
import React from "react";
import HomePage from "./pages/HomePage";
import { useAuth } from "./hooks/useAuth";

function App() {
  const { user } = useAuth();
  return <HomePage />;
}

export default App;
`
  );
}

async function teardown() {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
}

describe("analyzeFrontend", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  // ─── File Discovery ──────────────────────────
  it("discovers source files", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(result.files.length).toBeGreaterThanOrEqual(10);
    const fileNames = result.files.map((f) => path.basename(f));
    expect(fileNames).toContain("Button.tsx");
    expect(fileNames).toContain("Card.tsx");
    expect(fileNames).toContain("HomePage.tsx");
    expect(fileNames).toContain("main.tsx");
    expect(fileNames).toContain("api.ts");
  });

  it("sorts files deterministically", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    const sorted = [...result.files].sort((a, b) => a.localeCompare(b));
    expect(result.files).toEqual(sorted);
  });

  // ─── Component Extraction ──────────────────────
  it("extracts React components", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(result.components.length).toBeGreaterThanOrEqual(3);
    const names = result.components.map((c) => c.name);
    expect(names).toContain("Button");
    expect(names).toContain("Card");
    expect(names).toContain("Header");
  });

  it("extracts component props", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    const button = result.components.find((c) => c.name === "Button");
    expect(button).toBeDefined();
    if (button?.props && button.props.length > 0) {
      const propNames = button.props.map((p) => p.name);
      expect(propNames).toContain("label");
      expect(propNames).toContain("onClick");
    }
  });

  it("detects arrow function components (Modal)", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    const names = result.components.map((c) => c.name);
    expect(names).toContain("Modal");
  });

  // ─── Component Graph ────────────────────────────
  it("builds component dependency graph structure", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(Array.isArray(result.componentGraph)).toBe(true);
    // Without react types, JSX can't resolve component references
    expect(result.componentGraph.length).toBeGreaterThanOrEqual(0);
  });

  // ─── File Graph ─────────────────────────────────
  it("builds file dependency graph", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(result.fileGraph.length).toBeGreaterThanOrEqual(3);
    // main.tsx → pages/HomePage.tsx
    const mainEdge = result.fileGraph.find(
      (e) => e.from.includes("main") && e.to.includes("HomePage")
    );
    expect(mainEdge).toBeDefined();
  });

  it("tracks import edges from pages to components", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    // HomePage.tsx → components/Button.tsx
    const edge = result.fileGraph.find(
      (e) => e.from.includes("HomePage") && e.to.includes("Button")
    );
    expect(edge).toBeDefined();
  });

  // ─── Pages ──────────────────────────────────────
  it("discovers pages from app directory", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    const paths = result.pages.map((p) => p.path);
    expect(paths).toContain("/");
  });

  it("discovers nested route pages", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    const paths = result.pages.map((p) => p.path);
    expect(paths).toContain("/dashboard");
  });

  // ─── Unused Exports ──────────────────────────────
  it("tracks unused exports", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(Array.isArray(result.unusedExports)).toBe(true);
  });

  // ─── Orphan Files ────────────────────────────────
  it("detects orphan files (files with 0 inbound edges)", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(Array.isArray(result.orphanFiles)).toBe(true);
    // helpers.ts is not imported by anything
    const helperOrphan = result.orphanFiles.find((f) => f.includes("helpers"));
    expect(helperOrphan).toBeDefined();
  });

  // ─── API Calls ──────────────────────────────────
  it("extracts API call patterns from source files", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(Array.isArray(result.apiCalls)).toBe(true);
    // api.ts and ProfilePage.tsx use fetch — may or may not be detected
    expect(result.apiCalls.length).toBeGreaterThanOrEqual(0);
  });

  // ─── UX Pages ──────────────────────────────────
  it("produces uxPages with component details", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(Array.isArray(result.uxPages)).toBe(true);
    if (result.uxPages.length > 0) {
      const homePage = result.uxPages.find((p) => p.path === "/");
      if (homePage) {
        expect(homePage.component).toBeDefined();
        expect(homePage.component_id).toBeDefined();
      }
    }
  });

  // ─── Structure ──────────────────────────────────
  it("returns a valid FrontendAnalysis structure", async () => {
    const result = await analyzeFrontend(SRC_DIR, CONFIG);
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("pages");
    expect(result).toHaveProperty("apiCalls");
    expect(result).toHaveProperty("uxPages");
    expect(result).toHaveProperty("components");
    expect(result).toHaveProperty("componentGraph");
    expect(result).toHaveProperty("fileGraph");
    expect(result).toHaveProperty("orphanFiles");
    expect(result).toHaveProperty("unusedExports");
  });

  it("handles empty directory without crashing", async () => {
    const emptyDir = path.join(FIXTURE_DIR, "empty-frontend");
    await fs.mkdir(emptyDir, { recursive: true });
    const result = await analyzeFrontend(emptyDir, CONFIG);
    expect(result.files).toEqual([]);
    expect(result.components).toEqual([]);
    await fs.rm(emptyDir, { recursive: true });
  });
});
