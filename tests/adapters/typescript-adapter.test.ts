import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { TypeScriptAdapter, runAdapter } from "../../src/adapters/index.js";
import Parser from "tree-sitter";

describe("TypeScript Adapter", () => {
  it("registry exposes a TypeScript adapter with correct extensions", () => {
    expect(TypeScriptAdapter).toBeDefined();
    expect(TypeScriptAdapter.fileExtensions).toContain(".ts");
    expect(TypeScriptAdapter.fileExtensions).toContain(".tsx");
  });

  it("extracts Express router.get/post/delete endpoints", () => {
    const source = `
import { Router } from "express";
const router = Router();
router.get("/api/users", (req, res) => { res.json([]); });
router.post("/api/users", (req, res) => { res.status(201).json({}); });
router.delete("/api/users/:id", (req, res) => { res.status(204).send(); });
export default router;
`;
    const result = runAdapter(TypeScriptAdapter, "routes.ts", source);
    expect(result.endpoints.length).toBeGreaterThanOrEqual(3);

    const methods = result.endpoints.map((e) => e.method.toUpperCase());
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("DELETE");
  });

  it("extracts endpoint paths correctly", () => {
    const source = `
import { Router } from "express";
const router = Router();
router.get("/api/health", (req, res) => res.json({ ok: true }));
`;
    const result = runAdapter(TypeScriptAdapter, "health.ts", source);
    expect(result.endpoints.length).toBeGreaterThanOrEqual(1);
    const paths = result.endpoints.map((e) => e.path);
    expect(paths).toContain("/api/health");
  });

  it("handles TypeScript interfaces gracefully (may or may not extract as models)", () => {
    const source = `
export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Post {
  id: string;
  title: string;
  body: string;
  authorId: string;
}
`;
    const result = runAdapter(TypeScriptAdapter, "models.ts", source);
    // The TS adapter's Tree-sitter query targets class declarations,
    // not plain interfaces. This test validates no crash occurs.
    expect(result).toBeDefined();
    expect(Array.isArray(result.models)).toBe(true);
  });

  it("returns empty results for an empty file", () => {
    const result = runAdapter(TypeScriptAdapter, "empty.ts", "");
    expect(result.endpoints).toEqual([]);
    expect(result.models).toEqual([]);
  });

  it("does not crash on malformed TypeScript", () => {
    const source = `
export function broken( {
  // missing closing paren and brace
`;
    const result = runAdapter(TypeScriptAdapter, "broken.ts", source);
    // Should not throw; results may be empty or partial
    expect(result).toBeDefined();
  });

  it("extracts React components", () => {
    const source = `
import React from 'react';

export function Button({ label, onClick }: { label: string, onClick: () => void }) {
  return <button onClick={onClick}>{label}</button>;
}

export const Card = ({ title }: { title: string }) => {
  return <div className="card">{title}</div>;
}

class Header extends React.Component {
  render() {
    return <header>Home</header>;
  }
}
`;
    const parser = new Parser();
    parser.setLanguage((TypeScriptAdapter as any).language);
    const tree = parser.parse(source);

    const result = TypeScriptAdapter.extract!("test.tsx", source, tree.rootNode);
    expect(result.components.length).toBeGreaterThanOrEqual(1);
    const names = result.components.map((c) => c.name);
    expect(names).toContain("Button");
  });

  it("extracts describe and test string blocks", () => {
    const source = `
      describe("UserService", () => {
        it("returns user id", () => {});
        test("throws 404 on null", () => {});
      });
    `;
    const parser = new Parser();
    parser.setLanguage((TypeScriptAdapter as any).language);
    const tree = parser.parse(source);

    const result = TypeScriptAdapter.extract!("mock.test.ts", source, tree.rootNode);
    expect(result.tests).toBeDefined();
    expect(result.tests.length).toBe(2);
    
    expect(result.tests[0].suite_name).toBe("UserService");
    expect(result.tests[0].test_name).toBe("returns user id");
    
    expect(result.tests[1].suite_name).toBe("UserService");
    expect(result.tests[1].test_name).toBe("throws 404 on null");
  });
});
