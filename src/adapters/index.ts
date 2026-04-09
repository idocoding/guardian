import { PythonAdapter } from "./python-adapter.js";
import { TypeScriptAdapter } from "./typescript-adapter.js";
import { JavaAdapter } from "./java-adapter.js";
import { GoAdapter } from "./go-adapter.js";
import { CSharpAdapter } from "./csharp-adapter.js";
import { Lean4Adapter } from "./lean4-adapter.js";
import { runAdapter } from "./runner.js";

export { PythonAdapter, TypeScriptAdapter, JavaAdapter, GoAdapter, CSharpAdapter, Lean4Adapter, runAdapter };

export const ADAPTERS = [PythonAdapter, TypeScriptAdapter, JavaAdapter, GoAdapter, CSharpAdapter, Lean4Adapter];

export function getAdapterForFile(file: string) {
  for (const adapter of ADAPTERS) {
    if (adapter.fileExtensions.some(ext => file.endsWith(ext))) {
      return adapter;
    }
  }
  return null;
}
