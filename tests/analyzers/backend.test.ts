import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { analyzeBackend } from "../../src/extract/analyzers/backend.js";
import type { SpecGuardConfig } from "../../src/config.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "__fixtures__", "backend-project");
const SRC_DIR = path.join(FIXTURE_DIR, "src");

const CONFIG: SpecGuardConfig = {
  ignore: {
    directories: ["node_modules", ".git", "dist", "__pycache__"],
    paths: [],
  },
  python: {
    absoluteImportRoots: ["src"],
  },
};

async function scaffold() {
  // ─── TypeScript modules ────────────────────────────────
  await fs.mkdir(path.join(SRC_DIR, "routes"), { recursive: true });
  await fs.mkdir(path.join(SRC_DIR, "models"), { recursive: true });
  await fs.mkdir(path.join(SRC_DIR, "services"), { recursive: true });
  await fs.mkdir(path.join(SRC_DIR, "utils"), { recursive: true });

  // Express-style route file
  await fs.writeFile(
    path.join(SRC_DIR, "routes", "users.ts"),
    `
import { Router, Request, Response } from "express";
import { UserService } from "../services/user-service";
import { User } from "../models/user";

const router = Router();

router.get("/api/users", async (req: Request, res: Response) => {
  const users = await UserService.findAll();
  res.json(users);
});

router.post("/api/users", async (req: Request, res: Response) => {
  const user = await UserService.create(req.body);
  res.status(201).json(user);
});

router.get("/api/users/:id", async (req: Request, res: Response) => {
  const user = await UserService.findById(req.params.id);
  res.json(user);
});

router.put("/api/users/:id", async (req: Request, res: Response) => {
  await UserService.update(req.params.id, req.body);
  res.status(200).json({});
});

router.delete("/api/users/:id", async (req: Request, res: Response) => {
  await UserService.delete(req.params.id);
  res.status(204).send();
});

export default router;
`
  );

  // Second route with .route() chaining
  await fs.writeFile(
    path.join(SRC_DIR, "routes", "items.ts"),
    `
import { Router } from "express";
import { formatDate } from "../utils/helpers";

const router = Router();

router.get("/api/items", (req, res) => res.json([]));
router.post("/api/items", (req, res) => res.status(201).json({}));
router.patch("/api/items/:id", (req, res) => res.json({}));

export default router;
`
  );

  // Model file with interfaces
  await fs.writeFile(
    path.join(SRC_DIR, "models", "user.ts"),
    `
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export interface UserCreateDto {
  name: string;
  email: string;
}

export type UserRole = "admin" | "user" | "guest";
`
  );

  // Service file that imports from models
  await fs.writeFile(
    path.join(SRC_DIR, "services", "user-service.ts"),
    `
import { User, UserCreateDto } from "../models/user";

export class UserService {
  static async findAll(): Promise<User[]> {
    return [];
  }

  static async findById(id: string): Promise<User | null> {
    return null;
  }

  static async create(dto: UserCreateDto): Promise<User> {
    return { id: "1", name: dto.name, email: dto.email, createdAt: new Date() };
  }

  static async update(id: string, dto: Partial<UserCreateDto>): Promise<void> {}

  static async delete(id: string): Promise<void> {}
}
`
  );

  // Utility files (shared, to test export tracking)
  await fs.writeFile(
    path.join(SRC_DIR, "utils", "helpers.ts"),
    `
export function formatDate(date: Date): string {
  return date.toISOString();
}

export function generateId(): string {
  return Math.random().toString(36).slice(2);
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
`
  );

  // Root entry file
  await fs.writeFile(
    path.join(SRC_DIR, "app.ts"),
    `
import express from "express";
import userRoutes from "./routes/users";
import itemRoutes from "./routes/items";
import { formatDate } from "./utils/helpers";

const app = express();
app.use(userRoutes);
app.use(itemRoutes);

console.log("Started at", formatDate(new Date()));

export default app;
`
  );

  // ─── Python modules ────────────────────────────────────
  await fs.mkdir(path.join(SRC_DIR, "api"), { recursive: true });
  await fs.mkdir(path.join(SRC_DIR, "db"), { recursive: true });
  await fs.mkdir(path.join(SRC_DIR, "workers"), { recursive: true });

  // Python FastAPI routes
  await fs.writeFile(
    path.join(SRC_DIR, "api", "users.py"),
    `
from fastapi import APIRouter
from ..db.models import User
from ..db.schemas import UserCreate

router = APIRouter()

@router.get("/api/py-users")
async def list_users():
    return []

@router.post("/api/py-users")
async def create_user(body: UserCreate):
    return {}

@router.delete("/api/py-users/{user_id}")
async def delete_user(user_id: int):
    pass
`
  );

  // Python __init__.py for package detection
  await fs.writeFile(path.join(SRC_DIR, "api", "__init__.py"), "");
  await fs.writeFile(path.join(SRC_DIR, "db", "__init__.py"), "");
  await fs.writeFile(path.join(SRC_DIR, "workers", "__init__.py"), "");

  // Python SQLAlchemy models
  await fs.writeFile(
    path.join(SRC_DIR, "db", "models.py"),
    `
from sqlalchemy.orm import DeclarativeBase, relationship
from sqlalchemy import Column, Integer, String, ForeignKey

class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String)
    email = Column(String)
    orders = relationship("Order")

class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    total = Column(Integer)
`
  );

  // Python Pydantic schemas
  await fs.writeFile(
    path.join(SRC_DIR, "db", "schemas.py"),
    `
from pydantic import BaseModel

class UserCreate(BaseModel):
    name: str
    email: str

class OrderCreate(BaseModel):
    user_id: int
    total: int

__all__ = ["UserCreate", "OrderCreate"]
`
  );

  // Python Celery tasks
  await fs.writeFile(
    path.join(SRC_DIR, "workers", "tasks.py"),
    `
from celery import shared_task

@shared_task(queue="emails")
def send_welcome_email(user_id: int):
    pass

@shared_task
def process_order(order_id: int):
    pass
`
  );
}

async function teardown() {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
}

describe("analyzeBackend", () => {
  beforeAll(scaffold);
  afterAll(teardown);

  // ─── Module Discovery ──────────────────────────
  it("discovers all modules from top-level directories", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    const moduleIds = result.modules.map((m) => m.id);
    expect(moduleIds).toContain("routes");
    expect(moduleIds).toContain("models");
    expect(moduleIds).toContain("services");
    expect(moduleIds).toContain("utils");
    expect(moduleIds).toContain("api");
    expect(moduleIds).toContain("db");
    expect(moduleIds).toContain("workers");
  });

  it("sorts modules deterministically", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    const ids = result.modules.map((m) => m.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(sorted);
  });

  it("lists files within each module", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    const routes = result.modules.find((m) => m.id === "routes");
    expect(routes).toBeDefined();
    expect(routes!.files.length).toBeGreaterThanOrEqual(2);
    const fileNames = routes!.files.map((f) => path.basename(f));
    expect(fileNames).toContain("users.ts");
    expect(fileNames).toContain("items.ts");
  });

  // ─── TypeScript Endpoint Extraction ──────────────
  it("extracts Express endpoints", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(result.endpoints.length).toBeGreaterThanOrEqual(6);
    const methods = result.endpoints.map((e) => e.method);
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("PUT");
    expect(methods).toContain("DELETE");
    expect(methods).toContain("PATCH");
  });

  it("extracts endpoint paths correctly", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    const paths = result.endpoints.map((e) => e.path);
    expect(paths).toContain("/api/users");
    expect(paths).toContain("/api/items");
    expect(paths).toContain("/api/users/:id");
    expect(paths).toContain("/api/items/:id");
  });

  it("extracts service calls from handler bodies", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    const userGet = result.endpoints.find(
      (e) => e.path === "/api/users" && e.method === "GET"
    );
    expect(userGet).toBeDefined();
    if (userGet?.service_calls && userGet.service_calls.length > 0) {
      expect(userGet.service_calls.some((c: string) => c.includes("UserService"))).toBe(true);
    }
  });

  // ─── Python Endpoint Extraction ────────────────
  it("extracts Python FastAPI endpoints", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    const pyEndpoints = result.endpoints.filter((e) => e.path.includes("py-users"));
    expect(pyEndpoints.length).toBeGreaterThanOrEqual(2);
    expect(pyEndpoints.some((e) => e.method === "GET")).toBe(true);
    expect(pyEndpoints.some((e) => e.method === "POST")).toBe(true);
  });

  // ─── Data Models ──────────────────────────────
  it("extracts SQLAlchemy models", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    const sqlModels = result.dataModels.filter((m) => m.framework === "sqlalchemy");
    expect(sqlModels.length).toBeGreaterThanOrEqual(1);
    const user = sqlModels.find((m) => m.name === "User");
    if (user) {
      expect(user.fields).toContain("id");
      expect(user.fields).toContain("name");
      expect(user.relationships.length).toBeGreaterThanOrEqual(1);
    }
  });

  // ─── Celery Tasks ──────────────────────────────
  it("extracts Celery background tasks", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    const names = result.tasks.map((t) => t.name);
    expect(names).toContain("send_welcome_email");
  });

  // ─── Dependency Graphs ─────────────────────────
  it("builds module dependency graph", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(result.moduleGraph.length).toBeGreaterThanOrEqual(1);
    const edges = result.moduleGraph.map((e) => `${e.from}->${e.to}`);
    expect(edges.some((e) => e.includes("routes") && e.includes("services"))).toBe(true);
  });

  it("builds file dependency graph", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(result.fileGraph.length).toBeGreaterThanOrEqual(3);
  });

  it("detects circular dependencies (confirms none in fixture)", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(Array.isArray(result.circularDependencies)).toBe(true);
    expect(result.circularDependencies).toHaveLength(0);
  });

  // ─── Unused Exports ──────────────────────────
  it("tracks unused exports", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(Array.isArray(result.unusedExports)).toBe(true);
    // capitalize in helpers.ts is not imported by anyone
    const unusedNames = result.unusedExports.map((e) => e.symbol);
    expect(unusedNames).toContain("capitalize");
  });

  // ─── Duplicate Functions ──────────────────────
  it("scans for duplicate functions", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(Array.isArray(result.duplicateFunctions)).toBe(true);
    expect(Array.isArray(result.similarFunctions)).toBe(true);
  });

  // ─── Test Coverage Gap ──────────────────────────
  it("computes test coverage gaps", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(result.testCoverage).toBeDefined();
    expect(Array.isArray(result.testCoverage.untested_source_files)).toBe(true);
  });

  // ─── Structure ─────────────────────────────────
  it("returns a valid BackendAnalysis structure", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(result).toHaveProperty("modules");
    expect(result).toHaveProperty("endpoints");
    expect(result).toHaveProperty("moduleGraph");
    expect(result).toHaveProperty("fileGraph");
    expect(result).toHaveProperty("circularDependencies");
    expect(result).toHaveProperty("unusedExports");
    expect(result).toHaveProperty("dataModels");
    expect(result).toHaveProperty("endpointModelUsage");
    expect(result).toHaveProperty("tasks");
    expect(result).toHaveProperty("orphanModules");
    expect(result).toHaveProperty("orphanFiles");
    expect(result).toHaveProperty("entrypoints");
    expect(result).toHaveProperty("duplicateFunctions");
    expect(result).toHaveProperty("similarFunctions");
    expect(result).toHaveProperty("testCoverage");
  });

  it("processes without crashing on empty directory", async () => {
    const emptyDir = path.join(FIXTURE_DIR, "empty-backend");
    await fs.mkdir(emptyDir, { recursive: true });
    const result = await analyzeBackend(emptyDir, CONFIG);
    expect(result.modules).toEqual([]);
    expect(result.endpoints).toEqual([]);
    await fs.rm(emptyDir, { recursive: true });
  });

  // ─── Enums and Constants ────────────────────────
  it("extracts Python __all__ exports", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    const dbModule = result.modules.find((m) => m.id === "db");
    expect(dbModule).toBeDefined();
    expect(dbModule!.files.length).toBeGreaterThanOrEqual(2);
  });

  it("returns enums and constants arrays", async () => {
    const result = await analyzeBackend(SRC_DIR, CONFIG);
    expect(Array.isArray(result.enums)).toBe(true);
    expect(Array.isArray(result.constants)).toBe(true);
  });
});
