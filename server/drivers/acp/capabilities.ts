import type { ProviderAdapter } from "../../contracts.ts";
import type { AcpSupport } from "./core.ts";

export function acpCapabilities(support: AcpSupport): ProviderAdapter["capabilities"] {
  // A bridge that drops session/new's mcpServers (support.mcp === false) is offered no MCP-class tools.
  const mcpCapable = support.mcp !== false;
  return {
    sessionModelSwitch: "unsupported",
    agentsMcp: mcpCapable,
    customMcp: mcpCapable,
    computerMcp: mcpCapable,
    composioMcp: mcpCapable,
    browserMcp: mcpCapable,
    dataMcp: mcpCapable, emailMcp: mcpCapable, deviceMcp: mcpCapable,
    images: support.images !== false,
    nativeImageInput: support.images === true,
    effortLevels: support.effortLevels,
    modelVariants: support.modelVariants === true,
    localComputerMcp: mcpCapable,
    contextReading: "meter",
    engineAdmission: true, ...(support.askTool ? { askTool: { kind: "native" as const, name: support.askTool } } : {}),
    ...(support.steer ? { queueing: true } : {}),
    strictResume: true,
  };
}
