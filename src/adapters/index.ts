import { PythonAdapter } from "./python-adapter.js";
import { TypeScriptAdapter } from "./typescript-adapter.js";
import { JavaAdapter } from "./java-adapter.js";
import { GoAdapter } from "./go-adapter.js";
import { CSharpAdapter } from "./csharp-adapter.js";
import { runAdapter } from "./runner.js";

export { PythonAdapter, TypeScriptAdapter, JavaAdapter, GoAdapter, CSharpAdapter, runAdapter };

export const ADAPTERS = [PythonAdapter, TypeScriptAdapter, JavaAdapter, GoAdapter, CSharpAdapter];

export function getAdapterForFile(file: string) {
  for (const adapter of ADAPTERS) {
    if (adapter.fileExtensions.some(ext => file.endsWith(ext))) {
      return adapter;
    }
  }
  return null;
}
